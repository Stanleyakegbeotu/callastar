import { CALL_TIMINGS } from "@/lib/config";
import { logDiagnostic } from "@/lib/utils";
import type {
  CallRole,
  SignalDescription,
  SignalIceCandidate,
  SignalingProvider,
} from "@/services/signaling";

import { describeRtcReadiness } from "./rtcConfiguration";

/**
 * One peer connection, and every rule about how it is driven.
 *
 * The whole WebRTC protocol lives here: offer/answer, trickle ICE, glare
 * resolution, ICE restart, track replacement and teardown. React components
 * consume `onPhase` and `onRemoteStream` and never touch an RTCPeerConnection —
 * SDP handling scattered across components is how call apps end up with races
 * nobody can reproduce.
 *
 * Glare is resolved with the perfect-negotiation pattern. The roles are fixed
 * rather than negotiated: the host is polite and the guest is not, so when both
 * sides offer at once exactly one of them rolls back. Fixing it by role means
 * there is no tie to break at runtime.
 */

export type RtcConnectionPhase =
  /** Built, nothing negotiated. */
  | "new"
  /** Exchanging SDP and candidates. */
  | "negotiating"
  /** Media is flowing. */
  | "connected"
  /** Connectivity is genuinely degraded. Debounced — see below. */
  | "reconnecting"
  /** Unrecoverable within the retry budget. */
  | "failed"
  | "closed";

export interface RtcDiagnostics {
  phase: RtcConnectionPhase;
  connectionState: RTCPeerConnectionState | "unknown";
  iceConnectionState: RTCIceConnectionState | "unknown";
  /** How the media is actually travelling, once a pair is selected. */
  candidatePairType: "host" | "srflx" | "prflx" | "relay" | "unknown";
  /** True when the selected pair is a TURN relay. */
  usingRelay: boolean;
  iceRestarts: number;
  /** Whether this build could relay at all. Never claims more than is true. */
  relayReadiness: string;
}

export interface RtcCallEngineOptions {
  callAttemptId: string;
  /** Decides politeness. Host is polite, guest is not. */
  role: CallRole;
  signaling: SignalingProvider;
  configuration: RTCConfiguration;
  /** The remote participant's media, as one stream. */
  onRemoteStream: (stream: MediaStream) => void;
  onPhase: (phase: RtcConnectionPhase, detail?: string) => void;
  /** Called on every meaningful connection change. Diagnostics only. */
  onDiagnostics?: (diagnostics: RtcDiagnostics) => void;
}

function toWireCandidate(candidate: RTCIceCandidate): SignalIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

export class RtcCallEngine {
  private pc: RTCPeerConnection | null = null;
  private readonly remoteStream = new MediaStream();

  /** Held so a source swap replaces a track instead of renegotiating. */
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;

  /* ---- perfect negotiation bookkeeping ---- */
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswerPending = false;
  private readonly polite: boolean;

  /* ---- recovery ---- */
  private iceRestarts = 0;
  private restartTimer: number | null = null;
  private degradedTimer: number | null = null;

  private phase: RtcConnectionPhase = "new";
  private closed = false;
  /**
   * Candidates that arrived before a remote description existed.
   *
   * `addIceCandidate` throws without one, and with trickle ICE the first
   * candidates routinely beat the offer they belong to.
   */
  private pendingCandidates: SignalIceCandidate[] = [];

  constructor(private readonly options: RtcCallEngineOptions) {
    this.polite = options.role === "host";
  }

  get connectionPhase(): RtcConnectionPhase {
    return this.phase;
  }

  /**
   * Builds the connection and publishes the local tracks.
   *
   * Adding tracks fires `negotiationneeded`, so the offer is produced by the
   * normal negotiation path rather than by a separate hand-rolled one. The
   * transceivers are created here in a fixed order so both ends agree on the
   * m-line layout before anything is exchanged.
   */
  start(localStream: MediaStream | null): void {
    if (this.pc || this.closed) return;

    const pc = new RTCPeerConnection(this.options.configuration);
    this.pc = pc;

    pc.ontrack = (event) => {
      // One stream for the remote participant, whatever arrives on it.
      this.remoteStream.addTrack(event.track);
      event.track.onended = () => {
        try {
          this.remoteStream.removeTrack(event.track);
        } catch (error) {
          logDiagnostic("rtc-track-remove", error);
        }
      };
      this.options.onRemoteStream(this.remoteStream);
    };

    pc.onicecandidate = ({ candidate }) => {
      // The null candidate is end-of-gathering; the far end infers it.
      if (!candidate) return;
      void this.options.signaling
        .sendIceCandidate(this.options.callAttemptId, toWireCandidate(candidate))
        .catch((error: unknown) => logDiagnostic("rtc-send-candidate", error));
    };

    pc.onnegotiationneeded = () => {
      void this.negotiate();
    };

    pc.onconnectionstatechange = () => this.onConnectionStateChange();
    pc.oniceconnectionstatechange = () => this.onConnectionStateChange();

    if (localStream) this.publish(localStream);

    this.setPhase("negotiating");
  }

  /**
   * Publishes the local tracks, remembering each sender.
   *
   * `addTransceiver` rather than `addTrack` so a sender exists even for a track
   * the caller does not have yet — a camera that is off, or an uploaded source
   * that will be swapped in later. Without it, turning the camera on mid-call
   * would need a whole renegotiation.
   */
  private publish(stream: MediaStream): void {
    const pc = this.pc;
    if (!pc) return;

    const [audioTrack] = stream.getAudioTracks();
    const [videoTrack] = stream.getVideoTracks();

    if (audioTrack) {
      this.audioSender = pc.addTrack(audioTrack, stream);
    }
    if (videoTrack) {
      this.videoSender = pc.addTrack(videoTrack, stream);
    }
  }

  /**
   * Swaps the outgoing video without renegotiating.
   *
   * This is the seam a camera flip uses today, and the one FilterCore will use:
   * a transformed track is just another track on the same sender. Passing null
   * stops sending video while keeping the sender, so it can come back.
   */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    if (!this.videoSender) {
      // No video sender yet — this call started audio-only. Adding one is a real
      // renegotiation, which `negotiationneeded` will drive.
      if (track) this.videoSender = pc.addTrack(track);
      return;
    }

    try {
      await this.videoSender.replaceTrack(track);
    } catch (error) {
      logDiagnostic("rtc-replace-video", error);
    }
  }

  async replaceAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    if (!this.audioSender) {
      if (track) this.audioSender = pc.addTrack(track);
      return;
    }

    try {
      await this.audioSender.replaceTrack(track);
    } catch (error) {
      logDiagnostic("rtc-replace-audio", error);
    }
  }

  /* ------------------------------------------------------------ negotiation */

  private async negotiate(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    try {
      this.makingOffer = true;
      // No argument: the browser produces whatever is correct for the current
      // signalling state, which is what makes rollback safe.
      await pc.setLocalDescription();
      const description = pc.localDescription;
      if (!description?.type) return;
      await this.options.signaling.sendDescription(this.options.callAttemptId, {
        type: description.type,
        sdp: description.sdp ?? "",
      });
    } catch (error) {
      logDiagnostic("rtc-negotiate", error);
    } finally {
      this.makingOffer = false;
    }
  }

  /** An SDP from the other side. The whole of glare resolution is here. */
  async handleDescription(description: SignalDescription): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    const readyForOffer =
      !this.makingOffer && (pc.signalingState === "stable" || this.settingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;

    // Both sides offered at once. The impolite side keeps its own offer and
    // discards the incoming one; the polite side rolls back and accepts.
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      this.settingRemoteAnswerPending = description.type === "answer";
      await pc.setRemoteDescription(description);
      this.settingRemoteAnswerPending = false;

      await this.flushPendingCandidates();

      if (description.type === "offer") {
        await pc.setLocalDescription();
        const local = pc.localDescription;
        if (local?.type) {
          await this.options.signaling.sendDescription(this.options.callAttemptId, {
            type: local.type,
            sdp: local.sdp ?? "",
          });
        }
      }
    } catch (error) {
      this.settingRemoteAnswerPending = false;
      logDiagnostic("rtc-handle-description", error);
    }
  }

  async handleIceCandidate(candidate: SignalIceCandidate): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    // Nothing to attach a candidate to yet: hold it for the description.
    if (!pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      // Expected for candidates belonging to an offer we deliberately ignored.
      if (!this.ignoreOffer) logDiagnostic("rtc-add-candidate", error);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];

    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        if (!this.ignoreOffer) logDiagnostic("rtc-add-candidate-queued", error);
      }
    }
  }

  /* -------------------------------------------------------------- recovery */

  private onConnectionStateChange(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;

    const state = pc.connectionState;

    if (state === "connected") {
      this.clearDegradedTimers();
      this.iceRestarts = 0;
      this.setPhase("connected");
      void this.reportDiagnostics();
      return;
    }

    if (state === "disconnected") {
      // ICE flickers through `disconnected` on a normal network change. Saying
      // "Reconnecting…" for 200ms would be a lie, so both the message and the
      // restart wait to see whether it settles on its own.
      this.armDegradedTimer();
      this.armRestartTimer();
      return;
    }

    if (state === "failed") {
      this.clearDegradedTimers();
      if (this.iceRestarts < CALL_TIMINGS.maxIceRestarts) {
        this.setPhase("reconnecting");
        this.restartIce();
        return;
      }
      // The budget is spent. Ending honestly beats retrying forever.
      this.setPhase("failed", "Unable to restore the call.");
      return;
    }

    if (state === "closed") {
      this.setPhase("closed");
    }
  }

  private armDegradedTimer(): void {
    if (this.degradedTimer !== null) return;
    this.degradedTimer = window.setTimeout(() => {
      this.degradedTimer = null;
      if (this.pc?.connectionState === "disconnected") this.setPhase("reconnecting");
    }, CALL_TIMINGS.reconnectDebounceMs);
  }

  private armRestartTimer(): void {
    if (this.restartTimer !== null) return;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.pc?.connectionState !== "disconnected") return;
      if (this.iceRestarts >= CALL_TIMINGS.maxIceRestarts) {
        this.setPhase("failed", "Unable to restore the call.");
        return;
      }
      this.restartIce();
    }, CALL_TIMINGS.iceRestartAfterMs);
  }

  private clearDegradedTimers(): void {
    if (this.degradedTimer !== null) {
      window.clearTimeout(this.degradedTimer);
      this.degradedTimer = null;
    }
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /**
   * Gathers fresh candidates on the existing connection.
   *
   * `restartIce()` is the modern path; older Safari needs an offer with
   * `iceRestart`. Either way the peer connection survives, so the tracks, the
   * senders and the call timer all continue.
   */
  restartIce(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;

    this.iceRestarts += 1;
    this.setPhase("reconnecting");

    if (typeof pc.restartIce === "function") {
      pc.restartIce();
      return;
    }

    void (async () => {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        await this.options.signaling.sendDescription(this.options.callAttemptId, {
          type: offer.type,
          sdp: offer.sdp ?? "",
        });
      } catch (error) {
        logDiagnostic("rtc-ice-restart", error);
      }
    })();
  }

  /* ----------------------------------------------------------- diagnostics */

  /**
   * How the media is actually travelling, read from the selected candidate pair.
   *
   * The stats dictionaries are typed locally: `RTCIceCandidateStats` is not in
   * this TypeScript lib, and `selected` is a non-standard field some browsers use
   * instead of `nominated`.
   */
  private async readCandidatePairType(): Promise<RtcDiagnostics["candidatePairType"]> {
    interface PairStats {
      type: string;
      state?: string;
      nominated?: boolean;
      selected?: boolean;
      localCandidateId?: string;
    }
    interface CandidateStats {
      type: string;
      id: string;
      candidateType?: string;
    }

    const pc = this.pc;
    if (!pc) return "unknown";

    try {
      const stats = await pc.getStats();
      let localCandidateId: string | undefined;

      stats.forEach((entry) => {
        const pair = entry as unknown as PairStats;
        if (pair.type !== "candidate-pair" || pair.state !== "succeeded") return;
        if (pair.nominated !== true && pair.selected !== true) return;
        localCandidateId = pair.localCandidateId;
      });

      if (!localCandidateId) return "unknown";

      let found: RtcDiagnostics["candidatePairType"] = "unknown";
      stats.forEach((entry) => {
        const candidate = entry as unknown as CandidateStats;
        if (candidate.type !== "local-candidate" || candidate.id !== localCandidateId) return;
        if (
          candidate.candidateType === "host" ||
          candidate.candidateType === "srflx" ||
          candidate.candidateType === "prflx" ||
          candidate.candidateType === "relay"
        ) {
          found = candidate.candidateType;
        }
      });
      return found;
    } catch (error) {
      logDiagnostic("rtc-stats", error);
      return "unknown";
    }
  }

  private async reportDiagnostics(): Promise<void> {
    const report = this.options.onDiagnostics;
    if (!report) return;

    const candidatePairType = await this.readCandidatePairType();

    report({
      phase: this.phase,
      connectionState: this.pc?.connectionState ?? "unknown",
      iceConnectionState: this.pc?.iceConnectionState ?? "unknown",
      candidatePairType,
      usingRelay: candidatePairType === "relay",
      iceRestarts: this.iceRestarts,
      relayReadiness: describeRtcReadiness().summary,
    });
  }

  /* -------------------------------------------------------------- teardown */

  private setPhase(phase: RtcConnectionPhase, detail?: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase, detail);
  }

  /**
   * Releases everything this engine owns.
   *
   * Idempotent, because a hangup and an unmount routinely both arrive — and
   * under StrictMode they arrive twice. The local tracks are NOT stopped here:
   * they belong to `useLocalMedia`, which owns the camera for the whole call and
   * is the one place allowed to switch the indicator off.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearDegradedTimers();
    this.pendingCandidates = [];

    const pc = this.pc;
    this.pc = null;
    this.audioSender = null;
    this.videoSender = null;

    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch (error) {
        logDiagnostic("rtc-close", error);
      }
    }

    // Only the remote tracks, which this engine received and therefore owns.
    for (const track of this.remoteStream.getTracks()) {
      track.stop();
      this.remoteStream.removeTrack(track);
    }

    this.phase = "closed";
    this.options.onPhase("closed");
  }
}
