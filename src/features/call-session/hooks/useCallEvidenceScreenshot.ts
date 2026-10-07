import { useEffect, useRef } from "react";
import { logDiagnostic } from "@/lib/utils";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { callEvidenceRepository } from "@/services/evidence/repository";
import { captureCallVideoComposition } from "@/services/evidence/capture";
import { claimEvidenceSession, evidencePlanType, shouldCaptureCallEvidence } from "@/services/evidence/capturePolicy";
import type { BeginEvidenceInput, EvidencePlanType } from "@/services/evidence/types";
import type { CallSessionState } from "@/state/callSessionReducer";

function isOngoing(status: string) { return status === "active" || status === "reconnecting"; }
function withTerminalMetadata(input: BeginEvidenceInput, current: CallSessionState): BeginEvidenceInput {
  if (isOngoing(current.status)) return { ...input, callStatus: current.status };
  const endedAt = current.endedAt ?? Date.now();
  return {
    ...input,
    callStatus: current.status,
    endedAt: new Date(endedAt).toISOString(),
    durationSeconds: current.startedAt === null ? null : Math.max(0, Math.floor((endedAt - current.startedAt) / 1000)),
    terminationReason: current.failureReason ?? current.error,
  };
}

export function useCallEvidenceScreenshot(options: {
  session: CallSessionState;
  sessionMatches: boolean;
  liveMode: boolean;
  rtcConnected: boolean;
  localStream: MediaStream | null;
}) {
  const { session, sessionMatches, liveMode, rtcConnected, localStream } = options;
  const latestSession = useRef(session);
  const lastGateDiagnostic = useRef("");
  latestSession.current = session;
  const latestConnected = useRef(rtcConnected);
  latestConnected.current = rtcConnected;
  const { id, status, type, callId, host, caller, startedAt, answeredAt, sessionCreatedAt, endedAt, failureReason, error } = session;

  useEffect(() => {
    const eligible = shouldCaptureCallEvidence({
      sessionMatches,
      liveMode,
      callType: type,
      callStatus: status,
      rtcPhase: rtcConnected ? "connected" : "disconnected",
      hasLocalVideo: Boolean(localStream?.getVideoTracks().length),
      hasHost: Boolean(host),
      hasStartedAt: startedAt !== null,
    });
    if (sessionMatches && type === "video" && ["active", "reconnecting"].includes(status) && !eligible) {
      const reasons = [
        !liveMode && "not_live_webrtc_call",
        !rtcConnected && "rtc_not_connected",
        !localStream?.getVideoTracks().length && "local_video_track_missing",
        !host && "host_missing",
        startedAt === null && "active_timestamp_missing",
      ].filter(Boolean);
      const key = `${id}:${status}:${reasons.join(",")}`;
      if (lastGateDiagnostic.current !== key) {
        lastGateDiagnostic.current = key;
        logDiagnostic("CALL_EVIDENCE_NOT_ARMED", { callSessionId: id, plan: evidencePlanType(session.access), callState: status, rtcState: rtcConnected ? "connected" : "not_connected", reasons });
      }
    }
    if (!eligible || !host || startedAt === null) return;

    const input: BeginEvidenceInput = {
      callSessionId: id,
      callId,
      hostId: host.id,
      hostName: host.displayName,
      callerName: caller.fullName,
      callerEmail: caller.email,
      consentAt: null,
      sessionStartedAt: new Date(sessionCreatedAt ?? startedAt).toISOString(),
      answeredAt: new Date(answeredAt ?? startedAt).toISOString(),
      packageId: session.access?.planId ?? null,
      packageName: session.access?.planName ?? null,
      planType: evidencePlanType(session.access),
      width: 0,
      height: 0,
      endedAt: null,
      durationSeconds: null,
      callStatus: status,
      terminationReason: null,
    };
    logDiagnostic("CALL_EVIDENCE_ARMED", { callSessionId: id, plan: input.planType, callState: status, rtcState: "connected" });

    let cancelled = false;
    let captureStarted = false;
    const timer = window.setTimeout(() => {
      if (cancelled || !claimEvidenceSession(id, typeof localStorage === "undefined" ? undefined : localStorage)) return;
      captureStarted = true;
      void (async () => {
        try {
          let captured: Awaited<ReturnType<typeof captureCallVideoComposition>> | null = null;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3 && !captured; attempt++) {
            if (!isOngoing(latestSession.current.status)) break;
            try {
              captured = await captureCallVideoComposition(localStream!, () => latestSession.current.id === id && latestSession.current.status === "active" && latestConnected.current);
            } catch (cause) {
              lastError = cause;
              logDiagnostic("CALL_EVIDENCE_VIDEO_NOT_READY", {
                callSessionId: id,
                attempt: attempt + 1,
                videos: [...document.querySelectorAll<HTMLVideoElement>(".live-call video")].map((video) => ({ readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight })),
                reason: cause instanceof Error ? cause.message : cause,
              });
              if (attempt < 2 && isOngoing(latestSession.current.status)) await new Promise((resolve) => window.setTimeout(resolve, 300));
            }
          }
          if (!captured) {
            const reason = !isOngoing(latestSession.current.status) ? "call_ended_before_video_ready" : lastError instanceof Error ? lastError.message : "video_not_ready_after_retries";
            const failed = await callEvidenceRepository.saveCaptureFailure(withTerminalMetadata(input, latestSession.current), reason);
            logDiagnostic("CALL_EVIDENCE_CAPTURE_FAILED", { callSessionId: id, reason });
            logDiagnostic("CALL_EVIDENCE_SAVED", { recordId: failed.id, status: failed.status });
            return;
          }

          logDiagnostic("CALL_EVIDENCE_VIDEO_READY", {
            callSessionId: id,
            videoWidth: captured.videoWidth,
            videoHeight: captured.videoHeight,
            readyState: captured.readyState,
          });
          logDiagnostic("CALL_EVIDENCE_CAPTURED", {
            callSessionId: id,
            blobSize: captured.blob.size,
            mimeType: captured.blob.type,
            dimensions: `${captured.width}x${captured.height}`,
          });
          productionDiagnostic("CALL_EVIDENCE_CAPTURED", { width: captured.width, height: captured.height, size: captured.blob.size });

          const latest = latestSession.current;
          productionDiagnostic("CALL_EVIDENCE_STAGE", { stage: "captured", width: captured.width, height: captured.height, size: captured.blob.size });
          let saved: Awaited<ReturnType<typeof callEvidenceRepository.saveLocal>>;
          try {
            productionDiagnostic("CALL_EVIDENCE_STAGE", { stage: "upload_started" });
            saved = await callEvidenceRepository.saveLocal({
              ...withTerminalMetadata(input, latest), width: captured.width, height: captured.height,
              blob: captured.blob, capturedAt: new Date().toISOString(),
            });
            productionDiagnostic("CALL_EVIDENCE_STAGE", { stage: "cloud_ready", success: true });
          } catch (uploadError) {
            const reason = uploadError instanceof Error ? uploadError.message : "upload_failed";
            productionDiagnostic("CALL_EVIDENCE_UPLOAD_FAILED", { kind: "upload" });
            productionDiagnostic("CALL_EVIDENCE_STAGE", { stage: "upload_failed", success: false });
            const failed = await callEvidenceRepository.saveCaptureFailure(withTerminalMetadata(input, latestSession.current), reason, "upload");
            logDiagnostic("CALL_EVIDENCE_UPLOAD_FAILED", { callSessionId: id, status: failed.status });
            return;
          }
          logDiagnostic("CALL_EVIDENCE_SAVED", { recordId: saved.record.id, created: saved.created });
          const endedDuringSave = latestSession.current;
          if (!isOngoing(endedDuringSave.status)) {
            const endMs = endedDuringSave.endedAt ?? Date.now();
            await callEvidenceRepository.finalizeLocal(id, {
              endedAt: new Date(endMs).toISOString(),
              durationSeconds: endedDuringSave.startedAt === null ? null : Math.max(0, Math.floor((endMs - endedDuringSave.startedAt) / 1000)),
              callStatus: endedDuringSave.status,
              terminationReason: endedDuringSave.failureReason ?? endedDuringSave.error,
            });
          }
        } catch (cause) {
          logDiagnostic("CALL_EVIDENCE_LOCAL_SAVE_FAILED", { callSessionId: id, error: cause });
          // Capture/storage failures are diagnostic only. They never touch call state.
        }
      })();
    }, 300);

    return () => {
      if (captureStarted) return;
      cancelled = true;
      window.clearTimeout(timer);
      const current = latestSession.current;
      if (current.id !== id || !current.answeredAt || !["ended", "failed", "declined", "no_answer"].includes(current.status)) return;
      if (!claimEvidenceSession(id, typeof localStorage === "undefined" ? undefined : localStorage)) return;
      const endedInput = withTerminalMetadata(input, current);
      void callEvidenceRepository.saveCaptureFailure(endedInput, "call_ended_before_stable_video_frame")
        .then((record) => logDiagnostic("CALL_EVIDENCE_SAVED", { recordId: record.id, status: record.status }))
        .catch((cause) => logDiagnostic("CALL_EVIDENCE_LOCAL_SAVE_FAILED", { callSessionId: id, error: cause }));
    };
  }, [answeredAt, callId, caller.email, caller.fullName, host, id, liveMode, localStream, rtcConnected, session.access, sessionCreatedAt, sessionMatches, startedAt, status, type]);

  useEffect(() => {
    if (!sessionMatches || !id || !["ended", "failed", "declined", "no_answer"].includes(status)) return;
    const endMs = endedAt ?? Date.now();
    const durationSeconds = startedAt === null ? null : Math.max(0, Math.floor((endMs - startedAt) / 1000));
    void callEvidenceRepository.finalizeLocal(id, {
      endedAt: new Date(endMs).toISOString(),
      durationSeconds,
      callStatus: status,
      terminationReason: failureReason ?? error ?? null,
    }).catch((cause) => logDiagnostic("CALL_EVIDENCE_LOCAL_FINALIZE_FAILED", { callSessionId: id, error: cause }));
  }, [endedAt, error, failureReason, id, sessionMatches, startedAt, status]);
}
