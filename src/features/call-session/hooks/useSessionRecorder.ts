import { useCallback, useEffect, useRef } from "react";

import { logDiagnostic } from "@/lib/utils";
import { callBackend } from "@/services/callBackend";
import type { CallEventMetadata, CallEventType } from "@/services/admin/types";
import type { CallSessionState } from "@/state/callSessionReducer";

/**
 * Persists the call lifecycle.
 *
 * Two rules make this safe to run inside React:
 *
 *  - Every write is keyed and remembered, so a StrictMode double effect, a
 *    re-render or a repeated status cannot append the same event twice.
 *  - Every write is fire-and-forget. Recording history must never be able to
 *    interrupt, delay or fail a call, so failures only reach the console.
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
}

export interface SessionRecorder {
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
}: SessionRecorderOptions): SessionRecorder {
  const applied = useRef(new Set<string>());
  const recorder = callBackend.sessions;

  /** Runs `work` at most once for this key, and never lets it throw. */
  const once = useCallback((key: string, work: () => Promise<void>) => {
    if (applied.current.has(key)) return;
    applied.current.add(key);
    void work().catch((error: unknown) => logDiagnostic("session-record", error));
  }, []);

  const { id, status, host, callId, caller, type, startedAt, endedAt, error, failureReason } = session;
  const remoteSourceKind = session.remoteSource.kind;
  const active = sessionMatches && recorder !== undefined && id !== "";

  // A new call attempt gets a fresh id, so the memory of what has been written
  // is per session rather than per component.
  useEffect(() => {
    applied.current = new Set<string>();
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
        await recorder.event(id, "session_created");
        await recorder.event(id, "permissions_granted", { callType: type });
        await recorder.event(id, "connecting");
      });
      return;
    }

    if (status === "ringing") {
      once(`${id}:ringing`, async () => {
        await recorder.transition(id, { status: "ringing", ringingAt: new Date().toISOString() });
        await recorder.event(id, "ringing");
      });
      return;
    }

    if (status === "active") {
      once(`${id}:active`, async () => {
        await recorder.transition(id, {
          status: "active",
          connectedAt: toIso(startedAt) ?? new Date().toISOString(),
          // Settled here rather than at selection time: a source only counts once
          // the call actually connected with it. An audio call has exactly one
          // way to be heard, so it needs nothing signalled to know this.
          sourceKind:
            type === "audio" ? "live-microphone" : remoteSourceKind === "uploaded-source" ? "uploaded-source" : "live-camera",
        });
        await recorder.event(id, "connected");
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
        });
        await recorder.event(id, event, durationSeconds === null ? undefined : { durationSeconds });
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
        await recorder.event(id, "call_declined");
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
        await recorder.event(id, "call_no_answer");
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
        await recorder.event(id, "failed");
      });
    }
  }, [active, caller, callId, endedAt, error, failureReason, host, id, once, recorder, remoteSourceKind, startedAt, status, type]);

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

  return { record };
}
