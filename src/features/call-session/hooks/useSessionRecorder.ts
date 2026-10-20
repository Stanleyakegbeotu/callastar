import { useCallback, useEffect, useRef } from "react";

import { logDiagnostic } from "@/lib/utils";
import { callBackend } from "@/services/callBackend";
import type { CallEventMetadata, CallEventType } from "@/services/admin/types";
import type { CallSessionState } from "@/state/callSessionReducer";
import { markCustomerTrialConsumed } from "@/services/support/customerState";
import { config } from "@/lib/config";

/**
 * Persists the call lifecycle.
 *
 * Two rules make this safe to run inside React:
 *
 *  - Every write is keyed and remembered, so a StrictMode double effect, a
 *    re-render or a repeated status cannot append the same event twice.
 *  - Lifecycle transitions are ordered. Activation is an authorization write:
 *    failure stops an unconfirmed call. Diagnostic events are independent and
 *    cannot delay activation or finalization.
 *
 * The record is created when the call starts connecting, which is after the
 * caller granted devices — someone who opened the Call ID dialog and walked
 * away never appears in the CRM.
 */
interface SessionRecorderOptions {
  session: CallSessionState;
  sessionMatches: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** False until the caller actually holds a camera or microphone. */
  mediaReady: boolean;
  sourceReady?: boolean;
  sourceCompletionRequired?: boolean;
  onAuthorizationFailure?: () => void;
}

export interface SessionRecorder {
  completeSource: () => Promise<void>;
  /**
   * Append one event to this call's timeline, at most once for a given key.
   *
   * For things that happen to a call without changing its status — the
   * subscription checkpoint above all. Same guarantees as everything else here:
   * written once, and never able to fail a call.
   */
  record: (key: string, type: CallEventType, metadata?: CallEventMetadata) => void;
}

function toIso(epochMs: number | null): string | undefined {
  return epochMs === null ? undefined : new Date(epochMs).toISOString();
}

export function useSessionRecorder({
  session,
  sessionMatches,
  micEnabled,
  cameraEnabled,
  mediaReady,
  sourceReady = true,
  sourceCompletionRequired = false,
  onAuthorizationFailure,
}: SessionRecorderOptions): SessionRecorder {
  const applied = useRef(new Set<string>());
  const recorder = callBackend.sessions;
  const queue = useRef(Promise.resolve());
  const completing = useRef(false);
  const latestId = useRef(session.id); latestId.current = session.id;
  const failure = useRef(onAuthorizationFailure); failure.current = onAuthorizationFailure;

  /** Runs `work` at most once for this key, and never lets it throw. */
  const once = useCallback((key: string, work: () => Promise<void>) => {
    if (applied.current.has(key)) return;
    applied.current.add(key);
    const sequential = /:(create|ringing|active|ended|cancelled|declined|no_answer|failed)$/.test(key);
    const pending = (sequential ? queue.current.then(work) : work()).catch((error: unknown) => {
      logDiagnostic("session-record", error);
      if (key === `${latestId.current}:active` && config.callBackend === "supabase") failure.current?.();
    });
    if (sequential) queue.current = pending;
  }, []);

  const { id, status, host, callId, caller, type, startedAt, endedAt, error, failureReason } = session;
  const remoteSourceKind = session.remoteSource.kind;
  const active = sessionMatches && recorder !== undefined && id !== "";

  // A new call attempt gets a fresh id, so the memory of what has been written
  // is per session rather than per component.
  useEffect(() => {
    applied.current = new Set<string>();
    queue.current = Promise.resolve();
    completing.current = false;
  }, [id]);

  useEffect(() => {
    if (!active || !recorder || !host) return;

    if (status === "connecting") {
      once(`${id}:create`, async () => {
        await recorder.create({
          id,
          profileId: host.id,
          profileName: host.displayName,
          // The code as dialled: regenerating it later must not rewrite history.
          callIdSnapshot: callId,
          callType: type,
          caller: { fullName: caller.fullName, email: caller.email, phone: caller.phone },
        });
        void recorder.event(id, "session_created").catch((cause: unknown) => logDiagnostic("session-event", cause));
        void recorder.event(id, "permissions_granted", { callType: type }).catch((cause: unknown) => logDiagnostic("session-event", cause));
        void recorder.event(id, "connecting").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    if (status === "ringing") {
      once(`${id}:ringing`, async () => {
        await recorder.transition(id, { status: "ringing", ringingAt: new Date().toISOString() });
        void recorder.event(id, "ringing").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    if (status === "active" && sourceReady) {
      once(`${id}:active`, async () => {
        await recorder.transition(id, {
          status: "active",
          connectedAt: toIso(startedAt) ?? new Date().toISOString(),
          // Settled here rather than at selection time: a source only counts once
          // the call actually connected with it. An audio call has exactly one
          // way to be heard, so it needs nothing signalled to know this.
          sourceKind:
            type === "audio" ? "live-microphone" : sourceCompletionRequired || remoteSourceKind === "uploaded-source" ? "uploaded-source" : "live-camera",
        });
        if (!sourceCompletionRequired && config.callBackend === "supabase" && host.mode !== "free" && !session.access) {
          markCustomerTrialConsumed(caller.email, toIso(startedAt) ?? new Date().toISOString());
        }
        void recorder.event(id, "connected").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    if (status === "ended") {
      // A call that never connected was cancelled, not completed, and it has no
      // duration to report.
      const connected = startedAt !== null;
      const durationSeconds =
        connected && endedAt !== null ? Math.max(0, Math.floor((endedAt - startedAt) / 1000)) : null;
      const finalStatus = connected ? "ended" : "cancelled";
      const event: CallEventType = connected ? "ended" : "cancelled";

      once(`${id}:${finalStatus}`, async () => {
        await recorder.transition(id, {
          status: finalStatus,
          endedAt: toIso(endedAt) ?? new Date().toISOString(),
          durationSeconds,
          failureCode: session.endReason ?? "USER_ENDED",
        });
        void recorder.event(id, event, durationSeconds === null ? undefined : { durationSeconds }).catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    /**
     * A call the host turned down.
     *
     * Its own outcome rather than a cancellation: the operator chose, and history
     * has to say which. It never connected, so it has no duration.
     */
    if (status === "declined") {
      once(`${id}:declined`, async () => {
        await recorder.transition(id, {
          status: "declined",
          endedAt: toIso(endedAt) ?? new Date().toISOString(),
          durationSeconds: null,
        });
        void recorder.event(id, "call_declined").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    /** Rang out. Also never connected, so also no duration. */
    if (status === "no_answer") {
      once(`${id}:no_answer`, async () => {
        await recorder.transition(id, {
          status: "no_answer",
          endedAt: toIso(endedAt) ?? new Date().toISOString(),
          durationSeconds: null,
        });
        void recorder.event(id, "call_no_answer").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
      return;
    }

    if (status === "failed") {
      once(`${id}:failed`, async () => {
        await recorder.transition(id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          // A classified code, never a raw exception: this is shown in the
          // dashboard, and `failureReason` is already a closed set.
          failureCode: failureReason ?? (error ? "call_failed" : null),
        });
        void recorder.event(id, "failed").catch((cause: unknown) => logDiagnostic("session-event", cause));
      });
    }
  }, [active, caller, callId, endedAt, error, failureReason, host, id, once, recorder, remoteSourceKind, session.access, session.endReason, sourceReady, sourceCompletionRequired, startedAt, status, type]);

  useEffect(() => {
    if (!active || !sourceCompletionRequired || !["connecting", "ringing", "active"].includes(status) || !recorder?.renew) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (completing.current) return;
      void recorder.renew!(id).catch((error: unknown) => {
        logDiagnostic("reservation-renewal", error);
        if (!stopped && !completing.current) failure.current?.();
      });
    }, 20000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, id, recorder, sourceCompletionRequired, status]);

  // Persist natural completion before rendering a successful ending. Waiting on
  // the lifecycle queue also covers a short source ending during activation.
  const completeSource = useCallback(async () => {
    if (!active || !recorder || status !== "active" || !sourceReady) throw new Error("Source is not active");
    const key = `${id}:ended`;
    if (applied.current.has(key)) return;
    completing.current = true;
    applied.current.add(key);
    const pending = queue.current.then(async () => {
      await recorder.transition(id, {
        status: "ended", endedAt: new Date().toISOString(),
        durationSeconds: startedAt === null ? null : Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        failureCode: "SOURCE_VIDEO_ENDED",
      });
      if (config.callBackend === "supabase" && host?.mode !== "free" && !session.access) {
        markCustomerTrialConsumed(caller.email, new Date().toISOString());
      }
      void recorder.event(id, "ended").catch((error: unknown) => logDiagnostic("session-event", error));
    });
    queue.current = pending.catch(() => { applied.current.delete(key); });
    await pending;
  }, [active, caller.email, host?.mode, id, recorder, session.access, sourceReady, startedAt, status]);

  /**
   * Control events. Skipped until the caller actually holds devices, so the
   * initial state of each toggle is never mistaken for someone pressing it.
   */
  const previousMic = useRef<boolean | null>(null);
  const previousCamera = useRef<boolean | null>(null);

  useEffect(() => {
    if (!active || !recorder || !mediaReady) return;

    if (previousMic.current === null) {
      previousMic.current = micEnabled;
      return;
    }
    if (previousMic.current === micEnabled) return;

    previousMic.current = micEnabled;
    const type: CallEventType = micEnabled ? "microphone_unmuted" : "microphone_muted";
    void recorder.event(id, type).catch((error: unknown) => logDiagnostic("session-record", error));
  }, [active, id, mediaReady, micEnabled, recorder]);

  useEffect(() => {
    if (!active || !recorder || !mediaReady) return;

    if (previousCamera.current === null) {
      previousCamera.current = cameraEnabled;
      return;
    }
    if (previousCamera.current === cameraEnabled) return;

    previousCamera.current = cameraEnabled;
    const type: CallEventType = cameraEnabled ? "camera_enabled" : "camera_disabled";
    void recorder.event(id, type).catch((error: unknown) => logDiagnostic("session-record", error));
  }, [active, cameraEnabled, id, mediaReady, recorder]);

  const record = useCallback(
    (key: string, type: CallEventType, metadata?: CallEventMetadata) => {
      if (!active || !recorder) return;
      once(`${id}:${key}`, () => recorder.event(id, type, metadata));
    },
    [active, id, once, recorder],
  );

  return { record, completeSource };
}
