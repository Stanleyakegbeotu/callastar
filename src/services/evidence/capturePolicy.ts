export interface CaptureEligibility {
  sessionMatches: boolean;
  liveMode: boolean;
  callType: string;
  callStatus: string;
  rtcPhase: string;
  hasLocalVideo: boolean;
  hasHost: boolean;
  hasStartedAt: boolean;
}

export function evidencePlanType(access: { planId: string; planName: string } | null): "free_trial" | "plus" | "pro" | "subscription" {
  if (!access) return "free_trial";
  const plan = `${access.planId} ${access.planName}`.toLowerCase();
  if (plan.includes("plus")) return "plus";
  if (plan.includes("pro")) return "pro";
  return "subscription";
}

export function shouldCaptureCallEvidence(input: CaptureEligibility): boolean {
  return input.sessionMatches && input.liveMode && input.callType === "video" && input.callStatus === "active" &&
    input.rtcPhase === "connected" && input.hasLocalVideo && input.hasHost && input.hasStartedAt;
}

export function boundedEvidenceSize(width: number, height: number, maxWidth = 1280, maxHeight = 720) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const claimedSessions = new Set<string>();
export function claimEvidenceSession(sessionId: string, storage?: Pick<Storage, "getItem" | "setItem">): boolean {
  if (claimedSessions.has(sessionId)) return false;
  const key = `callastar:evidence-captured:${sessionId}`;
  try { if (storage?.getItem(key)) return false; } catch { /* module guard is still active */ }
  claimedSessions.add(sessionId);
  try { storage?.setItem(key, "attempted"); } catch { /* database unique key remains authoritative */ }
  return true;
}
