import { useCallback, useEffect, useRef, useState } from "react";

import { callDiagnostic, callError } from "@/lib/callDiagnostics";
import { RtcCallEngine, type RtcConnectionPhase, type RtcDiagnostics } from "@/services/rtc/RtcCallEngine";
import { rtcConfigurationProvider } from "@/services/rtc/rtcConfiguration";
import { signalingProvider, type CallRole, type ServerMessage } from "@/services/signaling";

/**
 * One peer connection for one call attempt, wired to signalling.
 *
 * Shared by the guest and the host deliberately. The WebRTC protocol is
 * identical on both sides — only politeness differs, and that is a parameter —
 * so having each side carry its own copy would be two places for the same race
 * to be fixed in one of them.
 *
 * The screens never see an RTCPeerConnection. They get a remote MediaStream, a
 * phase, and three functions.
 */

export interface RtcSessionOptions {
  /** Empty until the call has been authorised; nothing starts before then. */
  callAttemptId: string;
  role: CallRole;
  /**
   * The local tracks to publish. The engine starts when this and `active` are
   * both ready, so the first negotiation already carries both sides' media
   * rather than needing a second round to add it.
   */
  localStream: MediaStream | null;
  /** False tears the session down; true with a stream builds it. */
  active: boolean;
  onPhase?: (phase: RtcConnectionPhase, detail?: string) => void;
  onDiagnostics?: (diagnostics: RtcDiagnostics) => void;
}

export interface RtcSession {
  remoteStream: MediaStream | null;
  phase: RtcConnectionPhase;
  /** True once a remote track has actually arrived. */
  hasRemoteMedia: boolean;
  /** Swaps the outgoing camera without renegotiating. */
  replaceVideoTrack: (track: MediaStreamTrack | null) => Promise<void>;
  /** Releases the peer connection. Local tracks belong to whoever opened them. */
  close: () => void;
}

export function useRtcSession({
  callAttemptId,
  role,
  localStream,
  active,
  onPhase,
  onDiagnostics,
}: RtcSessionOptions): RtcSession {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [phase, setPhase] = useState<RtcConnectionPhase>("new");
  const [hasRemoteMedia, setHasRemoteMedia] = useState(false);

  const engineRef = useRef<RtcCallEngine | null>(null);
  /**
   * Which attempt the current engine belongs to.
   *
   * This is what makes the effect below idempotent under StrictMode: a second
   * mount sees an engine already built for this attempt and does not build
   * another, and a NEW attempt id is what legitimately replaces one.
   */
  const builtFor = useRef<string>("");

  /**
   * Signals that arrived before the engine existed.
   *
   * With trickle ICE the first candidates routinely beat the description they
   * belong to, and on the host side a guest's offer can beat the camera
   * permission dialog being answered. Dropping either would stall a negotiation
   * that was about to succeed.
   */
  const pending = useRef<ServerMessage[]>([]);

  // Callbacks through a ref so a parent re-rendering cannot rebuild the engine.
  const callbacks = useRef({ onPhase, onDiagnostics });
  callbacks.current = { onPhase, onDiagnostics };

  const deliver = useCallback((message: ServerMessage) => {
    const engine = engineRef.current;
    if (!engine) {
      pending.current.push(message);
      return;
    }
    if (message.type === "webrtc.description") {
      void engine.handleDescription(message.description);
      return;
    }
    if (message.type === "webrtc.ice_candidate") {
      void engine.handleIceCandidate(message.candidate);
    }
  }, []);

  /**
   * Subscribed for the whole time this hook is mounted, not just while the engine
   * exists — that is the point of the buffer above.
   */
  useEffect(() => {
    if (!callAttemptId) return undefined;

    return signalingProvider.subscribe({
      onMessage: (message) => {
        if (message.type !== "webrtc.description" && message.type !== "webrtc.ice_candidate") return;
        // Messages for a different call must never reach this peer connection.
        if (message.callAttemptId !== callAttemptId) return;
        deliver(message);
      },
    });
  }, [callAttemptId, deliver]);

  useEffect(() => {
    if (!active || !callAttemptId || !localStream) return undefined;
    // Already built for this attempt: a re-render or a StrictMode remount must
    // not open a second peer connection.
    if (builtFor.current === callAttemptId && engineRef.current) return undefined;

    let disposed = false;
    builtFor.current = callAttemptId;

    void (async () => {
      const configuration = await rtcConfigurationProvider.getConfiguration();
      if (disposed) return;

      const engine = new RtcCallEngine({
        callAttemptId,
        role,
        signaling: signalingProvider,
        configuration,
        onRemoteStream: (stream) => {
          setRemoteStream(stream);
          setHasRemoteMedia(stream.getTracks().length > 0);
        },
        onPhase: (next, detail) => {
          setPhase(next);
          callbacks.current.onPhase?.(next, detail);
        },
        onDiagnostics: (diagnostics) => callbacks.current.onDiagnostics?.(diagnostics),
      });

      engineRef.current = engine;
      callDiagnostic("rtc-start", { role, callType: undefined });

      try {
        engine.start(localStream);
      } catch (error) {
        callError("rtc-start", error, { role });
      }

      // Anything that arrived while we were fetching the configuration.
      const queued = pending.current;
      pending.current = [];
      for (const message of queued) deliver(message);
    })();

    return () => {
      disposed = true;
    };
  }, [active, callAttemptId, deliver, localStream, role]);

  /** Tears down when the call is over, or when the attempt is replaced. */
  useEffect(() => {
    if (active) return;
    const engine = engineRef.current;
    if (!engine) return;

    engineRef.current = null;
    builtFor.current = "";
    pending.current = [];
    engine.close();
    setRemoteStream(null);
    setHasRemoteMedia(false);
  }, [active]);

  // Leaving the screen for any reason releases the connection.
  useEffect(() => {
    return () => {
      engineRef.current?.close();
      engineRef.current = null;
      builtFor.current = "";
      pending.current = [];
    };
  }, []);

  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    await engineRef.current?.replaceVideoTrack(track);
  }, []);

  const close = useCallback(() => {
    engineRef.current?.close();
    engineRef.current = null;
    builtFor.current = "";
    pending.current = [];
  }, []);

  return { remoteStream, phase, hasRemoteMedia, replaceVideoTrack, close };
}
