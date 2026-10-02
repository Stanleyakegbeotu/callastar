import type { EyeControlFrame } from "../engine/eyeControls";
import type { CanonicalHeadPose, TrackerSample } from "./trackerProvider";

export interface HybridFlags { enabled: boolean; poseAssist: boolean; reacquisitionAssist: boolean }
export const DEFAULT_HYBRID_FLAGS: Readonly<HybridFlags> = Object.freeze({ enabled: false, poseAssist: false, reacquisitionAssist: false });
export interface PrimaryControls { eyes: EyeControlFrame | null; pose: CanonicalHeadPose | null; detected: boolean; confidence: number }

/** Jeeliz can confirm a primary reacquisition, never create eye channels or
 * resurrect lost detailed geometry. Pose assistance stays gated pending an
 * empirically mapped, same-session comparison that demonstrates improvement.
 * No averaging of positions, scales, confidence definitions or Euler frames. */
export class HybridCoordinator {
  private global: TrackerSample | null = null;
  private confirmations = 0;
  constructor(readonly flags: HybridFlags = { ...DEFAULT_HYBRID_FLAGS }) {}
  observe(sample: TrackerSample): void {
    if (!this.flags.enabled || sample.provider !== 'jeeliz' || sample.stale) return;
    if (this.global && sample.timestamp <= this.global.timestamp) return;
    this.global = { ...sample, rawRotation: sample.rawRotation?.slice() as TrackerSample['rawRotation'] };
    this.confirmations = sample.detected && sample.confidence >= 0.8 ? this.confirmations + 1 : 0;
  }
  resolve(primary: PrimaryControls, now: number) {
    const fresh = !!this.global && now >= this.global.timestamp && now - this.global.timestamp <= 700 && (this.global.frameAgeMs === null || this.global.frameAgeMs <= 150);
    const active = this.flags.enabled && fresh;
    return {
      // Canonical renderer inputs remain MediaPipe's measured controls.
      ...primary,
      globalConfidence: active ? this.global!.confidence : null,
      reacquisitionConfirmed: active && this.flags.reacquisitionAssist && primary.detected && this.confirmations >= 2,
      poseAssistApplied: false,
      reason: !this.flags.enabled ? 'disabled' : this.flags.poseAssist ? 'pose assistance has not demonstrated improvement' : !fresh ? 'assistant stale or unavailable' : 'confirmation only',
    };
  }
  reset(): void { this.global = null; this.confirmations = 0; }
}
