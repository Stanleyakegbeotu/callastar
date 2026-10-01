import {
  ACCEPTANCE_ENVELOPE,
  assessStability,
  median,
  medianPoint,
  type StabilityAssessment,
  type StabilityQuantity,
} from "./calibrationStatistics";
import {
  CALIBRATION_PROFILE_VERSION,
  type CalibrationFailure,
  type CalibrationMode,
  type CalibrationPhase,
  type CalibrationQuality,
  type CalibrationWarning,
  type FrameRejection,
  type TransformationCalibrationProfile,
} from "./calibrationTypes";
import type { FaceTrackingResult, Point3 } from "./faceTypes";
import type { PoseTrackingResult } from "./poseTypes";
import type { CameraFacing } from "./studioCamera";
import { canonicalFaceLandmarks, localBrowHeights } from './faceLocalGeometry';
import { eyeOpenness, jawDisplacement, mouthOpenness, mouthCornerLift } from './faceGeometry';
import { measureBinocularGaze } from './eyeGaze';

/**
 * Capturing a neutral baseline.
 *
 * Fed from the frames the M4 scheduler already produces — no second inference
 * pass, no extra model, no worker. Everything here is arithmetic over results
 * that existed anyway, which is why calibration costs effectively nothing.
 *
 * The shape of the problem: a single frame is not a neutral pose. A blink, a
 * swallow, or one frame where the model lost an eyebrow would all become
 * permanent if the baseline came from one sample. So a short window is
 * collected, each frame is admitted or refused on stated conditions, the window
 * is checked for whether the operator actually held still, and the baseline is
 * the median of what survived.
 */

/**
 * How long a window is.
 *
 * Both conditions must be met, deliberately: a frame count alone would finish
 * in 200ms on a fast machine running at 60fps, and an elapsed time alone would
 * accept three frames on a slow one. Neither assumes a frame rate.
 */
/** Refusals caused by WHERE the head is, not by tracking failing to see it. */
const POSITION_REJECTIONS: readonly FrameRejection[] = [
  "too-far", "too-close", "head-angled", "head-pitched", "head-tilted", "face-near-edge",
];

export const COLLECTION = {
  /** Enough samples for a median to mean something. */
  minFrames: 12,
  /** ~1.2s. Long enough to be a pose, short enough not to feel like a scan. */
  minDurationMs: 1200,
  /** Stop here even if frames are still arriving: more adds nothing. */
  maxFrames: 60,
  /** The rolling window used to decide the operator is holding still. */
  stabilityWindow: 10,
  /**
   * Give up after this. A person who cannot get a usable window in twenty
   * seconds needs different advice, not more waiting.
   */
  timeoutMs: 20_000,
  /**
   * Consecutive refusals that abandon a part-collected window.
   *
   * One or two refused frames mid-collection is a blink. A run of them is the
   * operator having moved, and the samples already taken no longer describe
   * where they are now.
   */
  maxConsecutiveRejections: 8,
} as const;

/** One admitted frame. Held only until the baseline is computed, then dropped. */
interface Sample {
  timestampMs: number;
  faceCenter: Point3;
  faceScale: number;
  yaw: number;
  pitch: number;
  roll: number;
  eyeOpenness: number;
  eyeLeft: number;
  eyeRight: number;
  smileLeft: number;
  smileRight: number;
  browHeights: [number, number, number] | null;
  mouthOpenness: number;
  jawDisplacement: number;
  eyeGaze: { left: { x: number; y: number }; right: { x: number; y: number } } | null;
  expression: {
    blinkLeft: number; blinkRight: number; jawOpen: number;
    smileLeft: number; smileRight: number; browInnerUp: number;
    browOuterUpLeft: number; browOuterUpRight: number;
  };
  shoulderCenter: Point3 | null;
  shoulderWidth: number | null;
  shoulderAngle: number | null;
  torsoCenter: Point3 | null;
  torsoScale: number | null;
  torsoLean: number | null;
}

export interface CalibrationCollectorState {
  phase: CalibrationPhase;
  mode: CalibrationMode;
  /** 0..1 across the collection window, for the progress ring. */
  progress: number;
  acceptedFrames: number;
  rejectedFrames: number;
  /** Why frames are currently being refused. Drives the on-screen guidance. */
  rejection: FrameRejection | null;
  rejectionCounts: Partial<Record<FrameRejection, number>>;
  stability: StabilityAssessment | null;
  profile: TransformationCalibrationProfile | null;
  failure: CalibrationFailure | null;
  /** With `failure === "out-of-position"`: the refusal that dominated the window. */
  failureRejection?: FrameRejection | null;
  /** True when a full calibration failed only because the shoulders were absent. */
  faceOnlyAvailable: boolean;
}

export interface CalibrationContext {
  cameraFacing: CameraFacing;
  trackingWidth: number;
  trackingHeight: number;
  mirrored: boolean;
}

function finite(...values: (number | null | undefined)[]): boolean {
  return values.every((value) => typeof value === "number" && Number.isFinite(value));
}

function finitePoint(point: Point3 | null | undefined): point is Point3 {
  return !!point && finite(point.x, point.y, point.z);
}

export class CalibrationCollector {
  private phase: CalibrationPhase = "idle";
  private mode: CalibrationMode = "full";
  private samples: Sample[] = [];
  private startedAt = 0;
  private accepted = 0;
  private rejected = 0;
  private consecutiveRejections = 0;
  private rejection: FrameRejection | null = null;
  private pendingRejection: FrameRejection | null = null;
  private pendingFrames = 0;
  private rejectionCounts: Partial<Record<FrameRejection, number>> = {};
  private stability: StabilityAssessment | null = null;
  private profile: TransformationCalibrationProfile | null = null;
  private failure: CalibrationFailure | null = null;
  private failureRejection: FrameRejection | null = null;
  private sawFace = false;
  private sawPose = false;
  private context: CalibrationContext | null = null;

  getState(): CalibrationCollectorState {
    return {
      phase: this.phase,
      mode: this.mode,
      progress: this.computeProgress(),
      acceptedFrames: this.accepted,
      rejectedFrames: this.rejected,
      rejection: this.rejection,
      rejectionCounts: { ...this.rejectionCounts },
      stability: this.stability,
      profile: this.profile,
      failure: this.failure,
      failureRejection: this.failureRejection,
      // Only worth offering once we know a face is trackable and the shoulders
      // are not — otherwise it is a worse calibration for no reason.
      faceOnlyAvailable: this.failure === "pose-unavailable",
    };
  }

  get isRunning(): boolean {
    return (
      this.phase === "waiting-for-stable-tracking" ||
      this.phase === "collecting" ||
      this.phase === "evaluating"
    );
  }

  /**
   * Begins a capture. Always from an explicit operator action.
   *
   * Never automatically after the camera starts: a calibration nobody asked for
   * captures whatever pose somebody happened to be in while reaching for the
   * mouse.
   */
  start(mode: CalibrationMode, context: CalibrationContext, nowMs: number): void {
    this.phase = "waiting-for-stable-tracking";
    this.mode = mode;
    this.context = context;
    this.samples = [];
    this.startedAt = nowMs;
    this.accepted = 0;
    this.rejected = 0;
    this.consecutiveRejections = 0;
    this.rejection = null;
    this.pendingRejection = null;
    this.pendingFrames = 0;
    this.rejectionCounts = {};
    this.stability = null;
    this.profile = null;
    this.failure = null;
    this.failureRejection = null;
    this.sawFace = false;
    this.sawPose = false;
  }

  cancel(): void {
    if (!this.isRunning) return;
    this.phase = "failed";
    this.failure = "cancelled";
    this.samples = [];
  }

  /** Drops the baseline. Used by the flip and recalibrate paths. */
  clear(): void {
    this.phase = "idle";
    this.samples = [];
    this.profile = null;
    this.failure = null;
    this.failureRejection = null;
    this.stability = null;
    this.rejection = null;
    this.rejectionCounts = {};
    this.accepted = 0;
    this.rejected = 0;
  }

  /**
   * One frame from the scheduler.
   *
   * Returns true when the state changed in a way the UI should see. Called on
   * every tracking update while a capture is running, and ignored otherwise —
   * so the frame loop pays nothing when calibration is idle.
   */
  accept(face: FaceTrackingResult | null, pose: PoseTrackingResult | null, nowMs: number): boolean {
    if (!this.isRunning) return false;

    if (nowMs - this.startedAt > COLLECTION.timeoutMs) {
      this.fail(this.diagnoseTimeout());
      return true;
    }

    const rejection = this.screen(face, pose);
    // Admission is immediate; only presentation is debounced. Bad frames never
    // enter the neutral baseline while guidance waits for confirmation.
    if (rejection === this.pendingRejection) this.pendingFrames++;
    else { this.pendingRejection = rejection; this.pendingFrames = 1; }
    if (this.pendingFrames >= 3) this.rejection = rejection;
    if (rejection) {
      this.rejected += 1;
      this.consecutiveRejections += 1;
      this.rejectionCounts[rejection] = (this.rejectionCounts[rejection] ?? 0) + 1;

      // A run of refusals mid-collection means the operator moved, and the
      // samples already taken no longer describe where they are.
      if (this.phase === "collecting" && this.consecutiveRejections >= COLLECTION.maxConsecutiveRejections) {
        this.samples = [];
        this.phase = "waiting-for-stable-tracking";
      }
      return true;
    }

    this.consecutiveRejections = 0;
    this.accepted += 1;
    this.samples.push(this.toSample(face!, pose, nowMs));

    if (this.phase === "waiting-for-stable-tracking") {
      // Only the most recent frames decide whether they are holding still now.
      if (this.samples.length > COLLECTION.stabilityWindow) this.samples.shift();
      if (this.samples.length < COLLECTION.stabilityWindow) return true;

      this.stability = this.measureStability(this.samples);
      if (!this.stability.stable) {
        // Keep watching. The window slides, so steadying up is picked up on the
        // next frame rather than needing a fresh start.
        return true;
      }

      /*
       * The already-stable window is carried into the collection rather than
       * thrown away. It is exactly the thing being asked for, and discarding it
       * would add a second of waiting for nothing.
       */
      this.phase = "collecting";
      return true;
    }

    // Collecting.
    if (this.samples.length > COLLECTION.maxFrames) this.samples.shift();
    this.stability = this.measureStability(this.samples.slice(-COLLECTION.stabilityWindow));

    const elapsed = nowMs - this.samples[0]!.timestampMs;
    if (this.samples.length >= COLLECTION.minFrames && elapsed >= COLLECTION.minDurationMs) {
      this.evaluate(nowMs);
    }
    return true;
  }

  /** Whether one frame may join the window, and if not, why. */
  private screen(face: FaceTrackingResult | null, pose: PoseTrackingResult | null): FrameRejection | null {
    if (!face || !face.detected || !face.derived) return "no-face";
    this.sawFace = true;
    // Shoulders are seen whether or not this frame's HEAD is acceptable. Noted
    // only after the head checks, a tilted head made a full calibration report
    // "could not see both shoulders" with both shoulders in frame.
    if (pose?.derived?.trackability === "tracked") this.sawPose = true;

    if (face.confidence < ACCEPTANCE_ENVELOPE.minConfidence) return "low-confidence";

    const derived = face.derived;
    if (!finitePoint(derived.center) || !finite(derived.scale, derived.yaw, derived.pitch, derived.roll)) {
      // Never average garbage. One NaN would poison every downstream number.
      return "invalid-geometry";
    }

    if (derived.scale < ACCEPTANCE_ENVELOPE.minFaceScale) return "too-far";
    if (derived.scale > ACCEPTANCE_ENVELOPE.maxFaceScale) return "too-close";

    if (Math.abs(derived.pitch) > ACCEPTANCE_ENVELOPE.maxPitch) return "head-pitched";
    if (Math.abs(derived.yaw) > ACCEPTANCE_ENVELOPE.maxYaw) return "head-angled";
    if (Math.abs(derived.roll) > ACCEPTANCE_ENVELOPE.maxRoll) return "head-tilted";

    const margin = ACCEPTANCE_ENVELOPE.edgeMargin;
    if (
      derived.center.x < margin ||
      derived.center.x > 1 - margin ||
      derived.center.y < margin ||
      derived.center.y > 1 - margin
      || derived.bounds.minX < 0 || derived.bounds.maxX > 1
      || derived.bounds.minY < 0 || derived.bounds.maxY > 1
    ) {
      return "face-near-edge";
    }

    // Face-only asks nothing of the shoulders, by the operator's own choice.
    if (this.mode === "face-only") return null;

    const trackability = pose?.derived?.trackability;
    if (!pose?.detected || !trackability || trackability === "lost") return "no-pose";
    if (trackability === "partial") return "partial-pose";

    return null;
  }

  private toSample(face: FaceTrackingResult, pose: PoseTrackingResult | null, nowMs: number): Sample {
    const derived = face.derived!;
    const posed = pose?.derived ?? null;
    const local = canonicalFaceLandmarks(face.landmarks, derived,
      this.context!.trackingWidth / this.context!.trackingHeight);
    const hasMesh = local.length >= 468;

    return {
      timestampMs: nowMs,
      faceCenter: derived.center,
      faceScale: derived.scale,
      yaw: derived.yaw,
      pitch: derived.pitch,
      roll: derived.roll,
      eyeOpenness: derived.eyeOpenness,
      eyeLeft: hasMesh ? eyeOpenness(local, 'left') : derived.eyeOpennessLeft,
      eyeRight: hasMesh ? eyeOpenness(local, 'right') : derived.eyeOpennessRight,
      smileLeft: hasMesh ? mouthCornerLift(local, 'left') : 0,
      smileRight: hasMesh ? mouthCornerLift(local, 'right') : 0,
      browHeights: localBrowHeights(local),
      mouthOpenness: hasMesh ? mouthOpenness(local) : derived.mouthOpenness,
      jawDisplacement: hasMesh ? jawDisplacement(local) : 0,
      eyeGaze: hasMesh ? measureBinocularGaze(local) : null,
      expression: {
        blinkLeft: face.blendshapes.eyeBlinkLeft ?? 1 - derived.eyeOpennessLeft,
        blinkRight: face.blendshapes.eyeBlinkRight ?? 1 - derived.eyeOpennessRight,
        jawOpen: face.blendshapes.jawOpen ?? derived.mouthOpenness,
        smileLeft: face.blendshapes.mouthSmileLeft ?? 0,
        smileRight: face.blendshapes.mouthSmileRight ?? 0,
        browInnerUp: face.blendshapes.browInnerUp ?? 0,
        browOuterUpLeft: face.blendshapes.browOuterUpLeft ?? 0,
        browOuterUpRight: face.blendshapes.browOuterUpRight ?? 0,
      },
      shoulderCenter: finitePoint(posed?.shoulderCenter) ? posed!.shoulderCenter : null,
      shoulderWidth: finite(posed?.shoulderWidth) ? posed!.shoulderWidth : null,
      shoulderAngle: finite(posed?.shoulderAngle) ? posed!.shoulderAngle : null,
      torsoCenter: finitePoint(posed?.torsoCenter) ? posed!.torsoCenter : null,
      torsoScale: finite(posed?.torsoScale) ? posed!.torsoScale : null,
      torsoLean: finite(posed?.torsoLean) ? posed!.torsoLean : null,
    };
  }

  private measureStability(samples: readonly Sample[]): StabilityAssessment {
    const shoulderCentres = samples.map((sample) => sample.shoulderCenter).filter(finitePoint);
    const numbers = (pick: (sample: Sample) => number | null): number[] =>
      samples.map(pick).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const quantities: Partial<Record<StabilityQuantity, readonly number[]>> = {
      faceCenterX: samples.map((sample) => sample.faceCenter.x),
      faceCenterY: samples.map((sample) => sample.faceCenter.y),
      faceScale: samples.map((sample) => sample.faceScale),
      yaw: samples.map((sample) => sample.yaw),
      pitch: samples.map((sample) => sample.pitch),
      roll: samples.map((sample) => sample.roll),
    };

    // Shoulder quantities are simply absent in a face-only capture, and absent
    // is not the same as perfectly steady — `assessStability` skips them.
    if (shoulderCentres.length >= 2) {
      quantities.shoulderCenterX = shoulderCentres.map((point) => point.x);
      quantities.shoulderCenterY = shoulderCentres.map((point) => point.y);
    }
    const widths = numbers((sample) => sample.shoulderWidth);
    if (widths.length >= 2) quantities.shoulderWidth = widths;
    const angles = numbers((sample) => sample.shoulderAngle);
    if (angles.length >= 2) quantities.shoulderAngle = angles;

    return assessStability(quantities);
  }

  private evaluate(nowMs: number): void {
    this.phase = "evaluating";

    const samples = this.samples;
    const context = this.context!;
    const stability = this.measureStability(samples);
    this.stability = stability;

    if (!stability.stable) {
      // The window filled but the operator never settled. Keep watching rather
      // than averaging a movement.
      this.phase = "waiting-for-stable-tracking";
      this.samples = samples.slice(-COLLECTION.stabilityWindow);
      return;
    }

    const faceCenter = medianPoint(samples.map((sample) => sample.faceCenter));
    const faceScale = median(samples.map((sample) => sample.faceScale));
    const yaw = median(samples.map((sample) => sample.yaw));
    const pitch = median(samples.map((sample) => sample.pitch));
    const roll = median(samples.map((sample) => sample.roll));

    if (!faceCenter || faceScale === null || yaw === null || pitch === null || roll === null) {
      this.fail("no-face");
      return;
    }

    const shoulderCentres = samples.map((sample) => sample.shoulderCenter).filter(finitePoint);
    const shoulderCenter = shoulderCentres.length > 0 ? medianPoint(shoulderCentres) : null;
    const shoulderWidth = median(
      samples.map((sample) => sample.shoulderWidth).filter((value): value is number => value !== null),
    );
    const shoulderAngle = median(
      samples.map((sample) => sample.shoulderAngle).filter((value): value is number => value !== null),
    );
    const torsoCentres = samples.map((sample) => sample.torsoCenter).filter(finitePoint);
    const torsoCenter = torsoCentres.length > 0 ? medianPoint(torsoCentres) : null;
    const torsoScale = median(
      samples.map((sample) => sample.torsoScale).filter((value): value is number => value !== null),
    );
    const torsoLean = median(
      samples.map((sample) => sample.torsoLean).filter((value): value is number => value !== null),
    );

    const poseAvailable = shoulderCenter !== null && shoulderWidth !== null;
    const warnings = this.deriveWarnings({
      faceCenter,
      yaw,
      pitch,
      shoulderCenter,
      shoulderWidth,
      poseAvailable,
      stabilityScore: stability.score,
    });

    this.profile = {
      version: CALIBRATION_PROFILE_VERSION,
      createdAt: nowMs,
      mode: this.mode,
      cameraFacing: context.cameraFacing,
      face: {
        center: faceCenter,
        scale: faceScale,
        yaw,
        pitch,
        roll,
        // Recorded, not subtracted. See `relativeMotion.ts`.
        neutralEyeOpenness: median(samples.map((sample) => sample.eyeOpenness)) ?? 0,
        neutralEyeOpennessLeft: median(samples.map(s => s.eyeLeft)) ?? 0,
        neutralEyeOpennessRight: median(samples.map(s => s.eyeRight)) ?? 0,
        neutralSmileLeft: median(samples.map(s => s.smileLeft)) ?? 0,
        neutralSmileRight: median(samples.map(s => s.smileRight)) ?? 0,
        neutralBrowHeights: samples.every(s => s.browHeights) ? [0, 1, 2].map(i => median(samples.map(s => s.browHeights![i]!)) ?? 0) as [number, number, number] : undefined,
        neutralMouthOpenness: median(samples.map((sample) => sample.mouthOpenness)) ?? 0,
        neutralJawDisplacement: median(samples.map((sample) => sample.jawDisplacement)) ?? 0,
        neutralEyeGaze: samples.filter((sample) => sample.eyeGaze !== null).length >= Math.ceil(samples.length * 0.7)
          ? {
              left: {
                x: median(samples.filter((sample) => sample.eyeGaze).map((sample) => sample.eyeGaze!.left.x)) ?? 0,
                y: median(samples.filter((sample) => sample.eyeGaze).map((sample) => sample.eyeGaze!.left.y)) ?? 0,
              },
              right: {
                x: median(samples.filter((sample) => sample.eyeGaze).map((sample) => sample.eyeGaze!.right.x)) ?? 0,
                y: median(samples.filter((sample) => sample.eyeGaze).map((sample) => sample.eyeGaze!.right.y)) ?? 0,
              },
            }
          : undefined,
        expressionNeutral: {
          blinkLeft: median(samples.map((sample) => sample.expression.blinkLeft)) ?? 0,
          blinkRight: median(samples.map((sample) => sample.expression.blinkRight)) ?? 0,
          jawOpen: median(samples.map((sample) => sample.expression.jawOpen)) ?? 0,
          smileLeft: median(samples.map((sample) => sample.expression.smileLeft)) ?? 0,
          smileRight: median(samples.map((sample) => sample.expression.smileRight)) ?? 0,
          browInnerUp: median(samples.map((sample) => sample.expression.browInnerUp)) ?? 0,
          browOuterUpLeft: median(samples.map((sample) => sample.expression.browOuterUpLeft)) ?? 0,
          browOuterUpRight: median(samples.map((sample) => sample.expression.browOuterUpRight)) ?? 0,
        },
      },
      pose: { shoulderCenter, shoulderWidth, shoulderAngle, torsoCenter, torsoScale, torsoLean },
      trackingSpace: {
        width: context.trackingWidth,
        height: context.trackingHeight,
        mirrorMode: context.mirrored ? "mirrored" : "direct",
      },
      quality: {
        faceAvailable: true,
        poseAvailable,
        frameCount: samples.length,
        stabilityScore: stability.score,
        quality: gradeCalibration({
          poseAvailable,
          stabilityScore: stability.score,
          frameCount: samples.length,
          mode: this.mode,
          warningCount: warnings.length,
        }),
        warnings,
      },
    };

    this.phase = "ready";
    // The samples have done their job. Nothing frame-by-frame survives.
    this.samples = [];
  }

  private deriveWarnings(input: {
    faceCenter: Point3;
    yaw: number;
    pitch: number;
    shoulderCenter: Point3 | null;
    shoulderWidth: number | null;
    poseAvailable: boolean;
    stabilityScore: number;
  }): CalibrationWarning[] {
    const warnings: CalibrationWarning[] = [];

    if (!input.poseAvailable) warnings.push("upper-body-unavailable");

    if (input.shoulderCenter && input.shoulderWidth !== null) {
      const half = input.shoulderWidth / 2;
      // A shoulder already at the frame edge will leave it the moment they move.
      if (input.shoulderCenter.x - half < 0.02 || input.shoulderCenter.x + half > 0.98) {
        warnings.push("shoulders-outside-frame");
      }
    }

    // ~15° and ~11°: a neutral this angled still calibrates, but every later
    // delta is measured from a head that was not facing the camera.
    if (Math.abs(input.yaw) > 0.26 || Math.abs(input.pitch) > 0.2) warnings.push("head-strongly-angled");

    if (input.stabilityScore < 0.6) warnings.push("tracking-unstable");

    const centre = input.faceCenter;
    if (centre.x < 0.2 || centre.x > 0.8 || centre.y < 0.15 || centre.y > 0.85) warnings.push("face-near-edge");

    return warnings;
  }

  /** A timeout means different things depending on what was seen. */
  private diagnoseTimeout(): CalibrationFailure {
    if (!this.sawFace) return "no-face";
    // A head held steadily OUTSIDE the envelope is not unsteady, and is not a
    // shoulder problem either: say which way. Checked first, because fixing
    // the head is what the operator has to do next either way.
    const seen = this.accepted + this.rejected;
    let dominant: FrameRejection | null = null;
    for (const reason of POSITION_REJECTIONS) {
      const count = this.rejectionCounts[reason] ?? 0;
      if (count * 2 >= seen && count > (dominant ? this.rejectionCounts[dominant] ?? 0 : 0)) dominant = reason;
    }
    if (dominant) {
      this.failureRejection = dominant;
      return "out-of-position";
    }
    if (this.mode === "full" && !this.sawPose) return "pose-unavailable";
    return "unstable";
  }

  private fail(failure: CalibrationFailure): void {
    this.phase = "failed";
    this.failure = failure;
    this.samples = [];
  }

  private computeProgress(): number {
    if (this.phase === "ready") return 1;
    if (this.phase !== "collecting" && this.phase !== "evaluating") return 0;
    if (this.samples.length === 0) return 0;

    // Whichever condition is further from being met, since both must be.
    const elapsed = this.samples[this.samples.length - 1]!.timestampMs - this.samples[0]!.timestampMs;
    const byFrames = this.samples.length / COLLECTION.minFrames;
    const byTime = elapsed / COLLECTION.minDurationMs;
    return Math.max(0, Math.min(1, Math.min(byFrames, byTime)));
  }
}

/**
 * Calibration quality, from conditions rather than a score alone.
 *
 * `limited` is not a soft failure — it is a usable baseline that will drive
 * head motion and nothing else, and it says so wherever it appears.
 */
export function gradeCalibration(input: {
  poseAvailable: boolean;
  stabilityScore: number;
  frameCount: number;
  mode: CalibrationMode;
  warningCount: number;
}): CalibrationQuality {
  if (input.mode === "face-only" || !input.poseAvailable) return "limited";
  if (input.stabilityScore < 0.5) return "limited";

  if (input.stabilityScore >= 0.7 && input.frameCount >= 20 && input.warningCount === 0) return "excellent";
  return "good";
}
