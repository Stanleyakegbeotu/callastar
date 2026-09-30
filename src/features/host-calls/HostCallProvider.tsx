import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { callDiagnostic, callError } from "@/lib/callDiagnostics";
import { CALL_TIMINGS } from "@/lib/config";
import { hostCredentialProvider } from "@/services/signaling/hostCredentials";
import { useRtcSession } from "@/features/calls/hooks/useRtcSession";
import { useLocalMedia } from "@/features/call-session/hooks/useLocalMedia";
import { getCallDeviceClass, videoCallSupport } from "@/services/device/deviceCapability";
import { describeSourceOptions, type VideoSourceAvailability } from "@/services/videoSource/videoSourceProvider";
import {
  signalingProvider,
  type ServerMessage,
  type SignalingStatus,
  type VideoSourceKind,
} from "@/services/signaling";

import {
  hostCallReducer,
  hostIsBusy,
  initialHostCallState,
  type HostCallState,
} from "./state/hostCallReducer";

/**
 * The profile this browser tab is operating.
 *
 * Deliberately per tab rather than per account: an operator may have the
 * dashboard open on a laptop and CallaStar open on their phone, and those are
 * different capabilities — only the phone can answer a video call.
 */
export interface OperatedProfile {
  id: string;
  displayName: string;
  /** Normalised Call ID this socket answers for. */
  callIdKey: string;
  /** The profile's uploaded call source, if it has one. */
  callSourceAssetId: string | null;
}

export interface HostCallContextValue {
  state: HostCallState;
  profile: OperatedProfile | null;
  /** False when this build has no operator credential — see `config.ts`. */
  supported: boolean;
  /** Why live calling is unavailable in this build, for the operator to read. */
  unsupportedReason: string | null;
  socketStatus: SignalingStatus;
  /** True when a video call has arrived somewhere it cannot be answered. */
  mustAnswerOnMobile: boolean;
  sourceOptions: { liveCamera: VideoSourceAvailability; uploadedSource: VideoSourceAvailability } | null;

  startReceiving: (profile: OperatedProfile) => Promise<void>;
  stopReceiving: () => Promise<void>;
  answer: () => void;
  decline: () => void;
  chooseSource: (kind: VideoSourceKind) => void;
  hangup: () => void;
  dismissOutcome: () => void;

  /** The operator's own camera, and the caller's stream. */
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  hasRemoteMedia: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  canSwitchCamera: boolean;
  toggleMic: () => void;
  toggleCamera: () => void;
  switchCamera: () => Promise<void>;
}

const HostCallContext = createContext<HostCallContextValue | null>(null);

export function useHostCall(): HostCallContextValue {
  const value = useContext(HostCallContext);
  if (!value) throw new Error("useHostCall must be used inside HostCallProvider");
  return value;
}

/**
 * The operator's side of live calling, for the whole authenticated app.
 *
 * Mounted above the admin routes so a call arrives wherever the operator happens
 * to be — the overview, the media page, a support thread. Wiring incoming calls
 * into one profile page would mean an operator only hears the phone while
 * standing next to it.
 */
export function HostCallProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(hostCallReducer, initialHostCallState);
  const [profile, setProfile] = useState<OperatedProfile | null>(null);
  const [socketStatus, setSocketStatus] = useState<SignalingStatus>("idle");
  const [sourceOptions, setSourceOptions] = useState<HostCallContextValue["sourceOptions"]>(null);

  /**
   * The operator's own camera and microphone.
   *
   * Requested only when Live Camera is chosen for a specific call, never on
   * mounting the dashboard — an operator browsing the CRM must not have their
   * camera light come on.
   */
  const media = useLocalMedia(state.call?.callType ?? "video");
  const { request: requestMedia, stop: stopMedia } = media;

  const deviceClass = getCallDeviceClass();
  const canAnswerVideoHere = videoCallSupport().supported;

  /** A video call has arrived on a device that cannot answer video. */
  const mustAnswerOnMobile = state.call?.callType === "video" && !canAnswerVideoHere;

  /* --------------------------------------------------------- socket status */

  useEffect(() => {
    return signalingProvider.subscribe({
      onStatus: (status, detail) => {
        setSocketStatus(status);
        // Without a socket there is no presence to claim, whatever the operator
        // asked for. The reducer drops to offline and the UI says so.
        if (status === "failed" || status === "closed") {
          dispatch({ type: "SIGNALING_LOST", error: detail ?? null });
        }
      },
    });
  }, []);

  /* ------------------------------------------------------ incoming messages */

  const endSent = useRef(false);

  useEffect(() => {
    return signalingProvider.subscribe({
      onMessage: (message: ServerMessage) => {
        switch (message.type) {
          case "call.incoming":
            callDiagnostic("host-incoming", { callType: message.callType });
            dispatch({
              type: "INCOMING_CALL",
              call: {
                callAttemptId: message.callAttemptId,
                profileId: message.profileId,
                callType: message.callType,
                caller: message.caller,
                ringingSince: message.ringingSince,
                ringExpiresAt: message.ringExpiresAt,
              },
            });
            return;

          case "call.cancel":
            // The caller gave up. The incoming screen must clear at once, and the
            // reducer's phase guard is what stops a replayed message putting it
            // back afterwards.
            dispatch({ type: "CALLER_CANCELLED" });
            return;

          case "call.no_answer":
            dispatch({ type: "RING_TIMED_OUT" });
            return;

          case "presence.update":
            dispatch({ type: "PRESENCE_CONFIRMED", presence: message.presence });
            return;

          case "call.end":
            // The reason is preserved rather than flattened: an operator shown
            // "Network failed" for a subscription paywall would go looking for a
            // fault that does not exist.
            dispatch({
              type: "CALL_ENDED",
              outcome:
                message.reason === "subscription_required"
                  ? { kind: "subscription_required" }
                  : message.reason === "cancelled"
                    ? { kind: "cancelled" }
                    : message.reason === "connection_lost" || message.reason === "transport_closed"
                      ? { kind: "failed", reason: "rtc_connection_lost" }
                      : { kind: "ended", durationSeconds: null },
            });
            return;

          default:
            return;
        }
      },
    });
  }, []);

  /* ----------------------------------------------------------- the RTC side */

  /**
   * The host is the polite peer. Fixed by role rather than negotiated, so when
   * both sides move at once exactly one rolls back and there is no tie to break.
   */
  const rtc = useRtcSession({
    callAttemptId: state.call?.callAttemptId ?? "",
    role: "host",
    localStream: media.stream,
    active: state.phase === "connecting" || state.phase === "in_call",
    onPhase: (phase, detail) => {
      callDiagnostic("host-rtc", { phase, reason: detail ?? null });
      if (phase === "connected") {
        dispatch({ type: "CALL_CONNECTED" });
        const attempt = state.call?.callAttemptId;
        if (attempt) void signalingProvider.markConnected(attempt).catch(() => {});
        return;
      }
      if (phase === "failed") {
        dispatch({ type: "FAIL", reason: "rtc_connection_lost", error: "Unable to restore the call." });
      }
    },
  });

  /* -------------------------------------------------------------- presence */

  const startReceiving = useCallback(async (next: OperatedProfile) => {
    // The credential is asked for per profile, so the production provider can
    // scope it to what this operator may actually act for.
    const issued = await hostCredentialProvider.getCredential(next.id);
    if (!issued.ok) {
      dispatch({ type: "SIGNALING_LOST", error: issued.message });
      return;
    }

    setProfile(next);
    dispatch({ type: "SET_RECEIVE_CALLS", enabled: true });

    try {
      // `connect` joins an existing socket with the same credentials rather than
      // opening a competing one, so a re-render or a StrictMode double effect
      // does not produce two registrations.
      await signalingProvider.connect({
        role: "host",
        token: issued.credential.token,
        profileId: next.id,
        callIdKey: next.callIdKey,
      });
      await signalingProvider.setPresence(next.id, "available");
      callDiagnostic("host-available", { deviceClass });
    } catch (error) {
      callError("host-connect", error);
      dispatch({ type: "SIGNALING_LOST", error: "Could not connect to CallaStar." });
    }
  }, [deviceClass]);

  const stopReceiving = useCallback(async () => {
    dispatch({ type: "SET_RECEIVE_CALLS", enabled: false });
    const current = profile;
    try {
      if (current) await signalingProvider.setPresence(current.id, "offline");
      await signalingProvider.disconnect();
    } catch (error) {
      callError("host-disconnect", error);
    }
    dispatch({ type: "PRESENCE_CONFIRMED", presence: "offline" });
  }, [profile]);

  /* ------------------------------------------------------ answer / decline */

  const answer = useCallback(() => {
    const call = state.call;
    if (!call) return;

    // A video call cannot be answered from a device that cannot run one. The
    // product rule holds on both sides of the call, so this is refused here
    // rather than half-started and then abandoned.
    if (call.callType === "video" && !canAnswerVideoHere) return;

    dispatch({ type: "ANSWER" });
    void signalingProvider.acceptCall(call.callAttemptId).catch((error: unknown) => {
      callError("host-accept", error);
      dispatch({ type: "FAIL", reason: "signaling_unavailable", error: "Could not answer this call." });
    });

    /**
     * An audio call has nothing to choose.
     *
     * There is one way to be heard, so there is no source sheet and no deadline
     * to run: answering goes straight to connecting, and the microphone is
     * acquired by the effect below.
     */
    if (call.callType === "audio") {
      dispatch({ type: "START_CONNECTING" });
      return;
    }

    dispatch({ type: "OPEN_SOURCE_SELECTION", deadline: Date.now() + CALL_TIMINGS.sourceSelectionMs });
  }, [canAnswerVideoHere, state.call]);

  const decline = useCallback(() => {
    const call = state.call;
    if (!call) return;
    // Exactly once, and no peer connection is ever created for a declined call.
    void signalingProvider.declineCall(call.callAttemptId).catch((error: unknown) => callError("host-decline", error));
    dispatch({ type: "DECLINE" });
  }, [state.call]);

  /**
   * Which sources this profile can actually offer.
   *
   * Asked while the sheet opens so an unusable option is disabled with a reason,
   * rather than failing after the operator has already committed to it and the
   * caller is waiting.
   */
  useEffect(() => {
    if (state.phase !== "source_selection") {
      setSourceOptions(null);
      return;
    }
    let cancelled = false;
    void describeSourceOptions(profile?.callSourceAssetId ?? null).then((options) => {
      if (!cancelled) setSourceOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, [profile?.callSourceAssetId, state.phase]);

  /**
   * The source-selection deadline.
   *
   * Real, and short: the caller is already looking at "Connecting…", so nobody is
   * left holding a silent line for minutes.
   */
  useEffect(() => {
    if (state.phase !== "source_selection" || state.sourceDeadline === null) return undefined;

    const remaining = Math.max(0, state.sourceDeadline - Date.now());
    const timer = window.setTimeout(() => {
      const call = state.call;
      if (call) {
        void signalingProvider
          .endCall(call.callAttemptId, "source_selection_timeout")
          .catch((error: unknown) => callError("host-source-timeout", error));
      }
      dispatch({ type: "FAIL", reason: "source_unavailable", error: "The call timed out while choosing a source." });
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [state.call, state.phase, state.sourceDeadline]);

  const chooseSource = useCallback(
    (kind: VideoSourceKind) => {
      const call = state.call;
      if (!call) return;

      dispatch({ type: "SELECT_SOURCE", source: kind });

      /**
       * An uploaded source has to be reachable from the caller's device, and a
       * blob in this browser's IndexedDB is not. Rather than leaving the guest
       * looking at a frame that will never load, the choice is refused here and
       * the operator is told why.
       */
      if (kind === "uploaded-source") {
        const uploaded = sourceOptions?.uploadedSource;
        if (uploaded && !uploaded.available) {
          void signalingProvider
            .selectSource(call.callAttemptId, kind, profile?.callSourceAssetId ?? undefined)
            .catch(() => {});
          dispatch({
            type: "FAIL",
            reason: "source_unavailable",
            error:
              uploaded.reason === "not_uploaded"
                ? "This profile has no call source uploaded."
                : "Uploaded source isn't available for remote calls yet.",
          });
          return;
        }
      }

      void signalingProvider
        .selectSource(call.callAttemptId, kind, kind === "uploaded-source" ? (profile?.callSourceAssetId ?? undefined) : undefined)
        .catch((error: unknown) => callError("host-select-source", error));

      dispatch({ type: "START_CONNECTING" });
    },
    [profile?.callSourceAssetId, sourceOptions, state.call],
  );

  /**
   * Acquires the operator's camera once a live source is chosen.
   *
   * Keyed on the attempt so a re-render cannot ask twice, which is what keeps a
   * StrictMode double effect from opening two cameras.
   */
  const mediaFor = useRef<string>("");

  useEffect(() => {
    if (state.phase !== "connecting") return;
    const call = state.call;
    if (!call) return;
    // An audio call always uses the live microphone; a video call only needs a
    // device when the operator chose their own camera.
    const needsLocalMedia = call.callType === "audio" || state.selectedSource === "live-camera";
    if (!needsLocalMedia) return;
    if (mediaFor.current === call.callAttemptId) return;

    mediaFor.current = call.callAttemptId;

    void requestMedia().then((result) => {
      if (result.outcome === "granted" || result.outcome === "cancelled") return;
      // A denied camera must not leave the caller hanging. The call ends with a
      // reason the guest can be told honestly.
      void signalingProvider
        .endCall(call.callAttemptId, "hangup")
        .catch((error: unknown) => callError("host-media-denied", error));
      dispatch({
        type: "FAIL",
        reason: "permission_denied",
        error: "Camera or microphone access is blocked. Allow access and try again.",
      });
    });
  }, [requestMedia, state.call, state.phase, state.selectedSource]);

  /* -------------------------------------------------------------- hangup */

  const hangup = useCallback(() => {
    const call = state.call;
    if (call && !endSent.current) {
      endSent.current = true;
      void signalingProvider.endCall(call.callAttemptId, "hangup").catch((error: unknown) => callError("host-end", error));
    }
    dispatch({ type: "START_ENDING" });
    // The camera indicator goes out first, before anything is drawn.
    stopMedia();
    rtc.close();
    dispatch({
      type: "CALL_ENDED",
      outcome: {
        kind: "ended",
        durationSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : null,
      },
    });
  }, [rtc, state.call, state.startedAt, stopMedia]);

  /**
   * Releases the camera whenever no call needs it.
   *
   * This is what actually turns the operator's camera indicator off after a call,
   * whoever ended it and by whatever route.
   */
  useEffect(() => {
    if (hostIsBusy(state.phase)) return;
    mediaFor.current = "";
    endSent.current = false;
    stopMedia();
  }, [state.phase, stopMedia]);

  /** Returns presence to available once a call is finished. */
  useEffect(() => {
    if (state.phase !== "available" || !profile || !state.receiveCallsRequested) return;
    void signalingProvider.setPresence(profile.id, "available").catch(() => {});
  }, [profile, state.phase, state.receiveCallsRequested]);

  const value = useMemo<HostCallContextValue>(
    () => ({
      state,
      profile,
      supported: hostCredentialProvider.available,
      unsupportedReason: hostCredentialProvider.unavailableReason,
      socketStatus,
      mustAnswerOnMobile,
      sourceOptions,
      startReceiving,
      stopReceiving,
      answer,
      decline,
      chooseSource,
      hangup,
      dismissOutcome: () => dispatch({ type: "DISMISS_OUTCOME" }),
      localStream: media.stream,
      remoteStream: rtc.remoteStream,
      hasRemoteMedia: rtc.hasRemoteMedia,
      micEnabled: media.micEnabled,
      cameraEnabled: media.cameraEnabled,
      canSwitchCamera: media.canSwitchCamera,
      toggleMic: media.toggleMic,
      toggleCamera: media.toggleCamera,
      switchCamera: media.switchCamera,
    }),
    [
      answer,
      chooseSource,
      decline,
      hangup,
      media.cameraEnabled,
      media.canSwitchCamera,
      media.micEnabled,
      media.stream,
      media.switchCamera,
      media.toggleCamera,
      media.toggleMic,
      mustAnswerOnMobile,
      profile,
      rtc.hasRemoteMedia,
      rtc.remoteStream,
      socketStatus,
      sourceOptions,
      startReceiving,
      state,
      stopReceiving,
    ],
  );

  return <HostCallContext.Provider value={value}>{children}</HostCallContext.Provider>;
}

export default HostCallProvider;
