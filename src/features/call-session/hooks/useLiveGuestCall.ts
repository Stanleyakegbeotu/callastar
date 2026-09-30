import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";

import { callDiagnostic, callError } from "@/lib/callDiagnostics";
import { normalizeCallId } from "@/lib/callId";
import { CALL_TIMINGS } from "@/lib/config";
import { useRtcSession } from "@/features/calls/hooks/useRtcSession";
import { authorizeCall } from "@/services/signaling/callAuthorization";
import {
  signalingProvider,
  type CallEndReason,
  type ServerMessage,
} from "@/services/signaling";
import type { CallSessionAction, CallSessionState } from "@/state/callSessionReducer";
import type { CallFailureReason } from "@/types/call";

/**
 * The caller's side of a real call.
 *
 * Everything about the call protocol lives here: authorising the Call ID,
 * connecting the socket, sending the invitation, and reacting to what the other
 * phone does. The screens below it render `session.status` and call `cancel` or
 * `hangup`; none of them know that signalling exists.
 *
 * There is no timer standing in for a remote action. Ringing ends because the
 * host accepted, declined, or the service's ring deadline passed — never because
 * a `setTimeout` decided it was time. The one local timer is a defensive backstop
 * a few seconds behind the service's own deadline, for the case where the socket
 * dies without telling us; the service remains authoritative.
 */

export interface LiveGuestCall {
  remoteStream: MediaStream | null;
  /** True once a remote track has arrived, which is when video can be shown. */
  hasRemoteMedia: boolean;
  /** Give up while it is still ringing. */
  cancel: () => void;
  /** End a call that is up. */
  hangup: (reason?: CallEndReason) => void;
  /** Swaps the outgoing camera without renegotiating. */
  replaceVideoTrack: (track: MediaStreamTrack | null) => Promise<void>;
}

interface Options {
  session: CallSessionState;
  dispatch: Dispatch<CallSessionAction>;
  /** Owned by `useLocalMedia`; this hook publishes it but never opens or stops it. */
  localStream: MediaStream | null;
  /** False on the simulated path, so none of this runs there. */
  enabled: boolean;
  /** Told when a call-ending reason arrives, so history records the right thing. */
  onEndReason?: (reason: CallEndReason) => void;
}

/** Maps the service's end reasons onto the app's classified failures. */
function failureFor(reason: CallEndReason): CallFailureReason | null {
  switch (reason) {
    case "declined":
      return "call_declined";
    case "busy":
      return "host_busy";
    case "no_answer":
      return "ring_timeout";
    case "connection_lost":
    case "transport_closed":
      return "rtc_connection_lost";
    case "source_selection_timeout":
      return "source_unavailable";
    // A hangup, a cancellation and a subscription ending are not failures.
    default:
      return null;
  }
}

export function useLiveGuestCall({
  session,
  dispatch,
  localStream,
  enabled,
  onEndReason,
}: Options): LiveGuestCall {
  const { id: sessionId, callAttemptId, status, callId, caller, type: callType, host } = session;

  /**
   * The guest is the impolite peer, so it makes the offer. Fixed by role rather
   * than negotiated, which is what leaves no tie to break when both sides move
   * at once — see the perfect-negotiation notes in `RtcCallEngine`.
   */
  const rtc = useRtcSession({
    callAttemptId,
    role: "guest",
    localStream,
    // The peer connection is built once the host has committed to a source, so
    // the first negotiation already carries both sides' tracks.
    active:
      enabled &&
      (status === "accepted" ||
        status === "source_selection" ||
        status === "negotiating" ||
        status === "connecting" ||
        status === "active" ||
        status === "reconnecting"),
    onPhase: (phase, detail) => {
      callDiagnostic("guest-rtc", { phase, reason: detail ?? null });
      if (phase === "connected") {
        dispatch({ type: "CALL_CONNECTED" });
        // Lets the host retire its own connecting UI.
        void signalingProvider.markConnected(callAttemptId).catch(() => {});
        return;
      }
      if (phase === "reconnecting") {
        dispatch({ type: "CONNECTION_DEGRADED" });
        return;
      }
      if (phase === "failed") {
        dispatch({
          type: "FAIL_CALL",
          reason: "rtc_connection_lost",
          error: detail ?? "Unable to restore the call.",
        });
      }
    },
  });

  /**
   * Each stage runs at most once per attempt.
   *
   * Keyed by attempt id rather than by a boolean, so a genuinely new call is a
   * new key while a StrictMode double mount is not. This is the mechanism §116
   * asks for: lifecycle ownership, not a global flag.
   */
  const done = useRef<{ attempt: string; steps: Set<string> }>({ attempt: "", steps: new Set() });
  if (done.current.attempt !== sessionId) {
    done.current = { attempt: sessionId, steps: new Set() };
  }
  const once = useCallback((step: string, work: () => void) => {
    if (done.current.steps.has(step)) return;
    done.current.steps.add(step);
    work();
  }, []);

  /** Whether `call.end` has already gone out, so it is sent exactly once. */
  const endSent = useRef(false);
  useEffect(() => {
    endSent.current = false;
  }, [sessionId]);

  const [connecting, setConnecting] = useState(false);

  /* ------------------------------------------------ 1. authorise the Call ID */

  useEffect(() => {
    if (!enabled || status !== "resolving") return undefined;

    const controller = new AbortController();

    void authorizeCall(callId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      callDiagnostic("authorize", { status: result.state });

      if (result.state === "available") {
        dispatch({ type: "HOST_AVAILABLE", callAttemptId: result.callAttemptId });
        // The token authorises exactly this attempt and is kept out of state, so
        // it cannot reach history, a log or a re-render.
        tokenRef.current = result.token;
        return;
      }

      const name = host?.shortName ?? "This host";
      if (result.state === "busy") {
        dispatch({
          type: "FAIL_CALL",
          reason: "host_busy",
          error: `${name} is unavailable right now. Please try again shortly.`,
        });
        return;
      }
      if (result.state === "rate_limited") {
        dispatch({
          type: "FAIL_CALL",
          reason: "signaling_unavailable",
          error: "Too many attempts. Please wait a moment and try again.",
        });
        return;
      }
      if (result.state === "unreachable") {
        dispatch({
          type: "FAIL_CALL",
          reason: "signaling_unavailable",
          error: "We could not reach CallaStar. Check your connection and try again.",
        });
        return;
      }
      dispatch({
        type: "FAIL_CALL",
        reason: "host_offline",
        error: `${name} isn't available to receive calls right now.`,
      });
    });

    return () => controller.abort();
  }, [callId, dispatch, enabled, host?.shortName, status]);

  const tokenRef = useRef<string>("");

  /* ------------------------------------- 2. connect, then send the invitation */

  useEffect(() => {
    if (!enabled) return;
    // Devices first: a host is never rung before the caller can actually talk.
    if (status !== "requesting_permissions" || session.permission !== "granted") return;
    if (!callAttemptId || !tokenRef.current) return;

    once(`invite:${callAttemptId}`, () => {
      dispatch({ type: "START_INVITING" });

      void (async () => {
        try {
          await signalingProvider.connect({ role: "guest", token: tokenRef.current });
          await signalingProvider.inviteCall({
            callAttemptId,
            // The NORMALISED key, which is what the token's claim holds. Sending
            // the display form here would fail the token's scope check, and the
            // host would never be rung.
            callIdKey: normalizeCallId(callId),
            callType,
            // Name only. Email and phone belong in the session record, not on a
            // socket that another party receives.
            caller: { displayName: caller.fullName },
          });
          dispatch({ type: "START_RINGING" });
          callDiagnostic("invite-sent", { callType });
        } catch (error) {
          callError("invite", error);
          dispatch({
            type: "FAIL_CALL",
            reason: "signaling_unavailable",
            error: "We could not reach CallaStar. Check your connection and try again.",
          });
        }
      })();
    });
  }, [
    callAttemptId,
    callId,
    callType,
    caller.fullName,
    dispatch,
    enabled,
    once,
    session.permission,
    status,
  ]);

  /* --------------------------------------------- 3. react to the other phone */

  useEffect(() => {
    if (!enabled || !callAttemptId) return undefined;

    const handle = (message: ServerMessage) => {
      // Never act on a message belonging to a different call.
      if ("callAttemptId" in message && message.callAttemptId !== callAttemptId) return;

      switch (message.type) {
        case "call.accept":
          // Answered. The caller stops hearing a ring and starts seeing
          // "Connecting…" from here, even though the host has still to choose a
          // source — nobody should be left listening to a ring that is over.
          dispatch({ type: "CALL_ACCEPTED" });
          setConnecting(true);
          // An audio call has no source to choose, so there is nothing to wait
          // for: negotiation begins as soon as it is answered.
          if (callType === "audio") dispatch({ type: "START_NEGOTIATING" });
          return;

        case "call.decline":
          dispatch({ type: "CALL_DECLINED" });
          onEndReason?.("declined");
          return;

        case "call.no_answer":
          dispatch({ type: "CALL_NO_ANSWER" });
          onEndReason?.("no_answer");
          return;

        case "call.busy":
          dispatch({
            type: "FAIL_CALL",
            reason: "host_busy",
            error: `${host?.shortName ?? "This host"} is unavailable right now. Please try again shortly.`,
          });
          return;

        /**
         * The host committed to how they will appear. For a live camera that is
         * all the guest needs; for an uploaded source the service says whether it
         * can actually be delivered, and an unreachable one is reported honestly
         * rather than left loading forever.
         */
        case "call.source_ready":
          dispatch({
            type: "SET_REMOTE_SOURCE",
            source: {
              kind: message.sourceKind,
              playbackUrl: message.playbackUrl ?? null,
              unavailableReason: message.unavailableReason ?? null,
            },
          });
          if (message.unavailableReason) {
            dispatch({
              type: "FAIL_CALL",
              reason: "source_unavailable",
              error: "This host's call source isn't available for remote calls yet.",
            });
            return;
          }
          dispatch({ type: "START_NEGOTIATING" });
          return;

        case "call.end": {
          const failure = failureFor(message.reason);
          onEndReason?.(message.reason);
          if (failure) {
            dispatch({
              type: "FAIL_CALL",
              reason: failure,
              error:
                failure === "rtc_connection_lost"
                  ? "Unable to restore the call."
                  : "This call could not continue.",
            });
            return;
          }
          dispatch({ type: "END_CALL" });
          return;
        }

        case "error":
          // Only errors about this attempt are the call's business; a socket-level
          // refusal is reported through the status listener below.
          if (message.code === "host_offline" || message.code === "call_unavailable") {
            dispatch({
              type: "FAIL_CALL",
              reason: "host_offline",
              error: `${host?.shortName ?? "This host"} isn't available to receive calls right now.`,
            });
            return;
          }
          if (message.code === "host_busy") {
            dispatch({
              type: "FAIL_CALL",
              reason: "host_busy",
              error: `${host?.shortName ?? "This host"} is unavailable right now.`,
            });
          }
          return;

        default:
          return;
      }
    };

    return signalingProvider.subscribe({
      onMessage: handle,
      onStatus: (socketStatus, detail) => {
        // A socket that is refused or exhausted is the end of the call. A
        // `reconnecting` socket is not: media is peer-to-peer, so a conversation
        // can continue perfectly well while the socket comes back.
        if (socketStatus !== "failed") return;
        dispatch({
          type: "FAIL_CALL",
          reason: "signaling_unavailable",
          error: detail ?? "Lost connection to CallaStar.",
        });
      },
    });
  }, [callAttemptId, callType, dispatch, enabled, host?.shortName, onEndReason]);

  /* ------------------------------------------- 4. defensive ring backstop */

  /**
   * The service enforces the ring deadline on its own clock and is authoritative.
   * This exists only for the case where the socket dies silently, so it waits
   * several seconds LONGER than the service would — it must never be the one that
   * decides, or the two could disagree about the same call.
   */
  useEffect(() => {
    if (!enabled) return undefined;
    if (status !== "inviting" && status !== "ringing") return undefined;

    const timer = window.setTimeout(() => {
      callDiagnostic("ring-backstop", { status });
      dispatch({ type: "CALL_NO_ANSWER" });
    }, CALL_TIMINGS.ringTimeoutMs + 8_000);

    return () => window.clearTimeout(timer);
  }, [dispatch, enabled, status]);

  /* ----------------------------------------------- 5. source-selection wait */

  useEffect(() => {
    if (!enabled || !connecting) return undefined;
    // Video only: an audio call never enters a source-selection wait, so there is
    // no deadline for it to trip over.
    if (callType !== "video" || status !== "accepted") return undefined;

    // The host has a bounded window to choose. Past it, nobody is left holding a
    // silent line: a little longer than the host's own deadline so their screen
    // gets to fail first and say why.
    const timer = window.setTimeout(() => {
      dispatch({
        type: "FAIL_CALL",
        reason: "source_unavailable",
        error: "We couldn't connect this call. Please try again.",
      });
    }, CALL_TIMINGS.sourceSelectionMs + 5_000);

    return () => window.clearTimeout(timer);
  }, [callType, connecting, dispatch, enabled, status]);

  /* --------------------------------------------------------- 6. leaving */

  const sendEnd = useCallback(
    (reason: CallEndReason) => {
      if (endSent.current || !callAttemptId) return;
      endSent.current = true;
      void signalingProvider.endCall(callAttemptId, reason).catch((error: unknown) => {
        // The other side also learns this from the socket closing, so a failure
        // here must not stop us tearing down locally.
        callError("end-call", error);
      });
    },
    [callAttemptId],
  );

  const cancel = useCallback(() => {
    if (!callAttemptId) {
      dispatch({ type: "END_CALL" });
      return;
    }
    if (!endSent.current) {
      endSent.current = true;
      void signalingProvider.cancelCall(callAttemptId).catch((error: unknown) => callError("cancel", error));
    }
    dispatch({ type: "END_CALL" });
  }, [callAttemptId, dispatch]);

  const hangup = useCallback(
    (reason: CallEndReason = "hangup") => {
      sendEnd(reason);
      dispatch({ type: "END_CALL" });
    },
    [dispatch, sendEnd],
  );

  /**
   * Disconnects the socket once the call is over.
   *
   * A guest token is good for one attempt, so there is nothing left this socket
   * may do. The service closes it from its side too; doing it here as well means
   * a caller who stays on the ended screen is not holding a connection open.
   */
  useEffect(() => {
    if (!enabled) return;
    if (status !== "ended" && status !== "declined" && status !== "no_answer" && status !== "failed") return;
    void signalingProvider.disconnect().catch(() => {});
  }, [enabled, status]);

  return {
    remoteStream: rtc.remoteStream,
    hasRemoteMedia: rtc.hasRemoteMedia,
    cancel,
    hangup,
    replaceVideoTrack: rtc.replaceVideoTrack,
  };
}
