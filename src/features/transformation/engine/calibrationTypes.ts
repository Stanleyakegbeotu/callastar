import type { Point3 } from "./faceTypes";
import type { CameraFacing } from "./studioCamera";

/**
 * The calibrated baseline, and the contract everything downstream reads.
 *
 * Calibration exists because a raw yaw of 7° does not mean the operator turned
 * 7°. Their resting pose may already sit slightly angled, their camera may be
 * below eye level, and they may be sitting closer than the last person. Driving
 * a deformation from absolute landmarks would bake all of that into the output
 * permanently. Everything after this milestone is expressed RELATIVE to the
 * neutral captured here.
 *
 * This is CallaStar's own contract, not MediaPipe's. Nothing here is a
 * landmark, a mesh, an image or an embedding — see the privacy note below.
 */

/**
 * The calibration lifecycle.
 *
 * Deliberately its own machine, separate from `TransformationPhase`: the engine
 * can be running perfectly while calibration is idle, collecting or failed, and
 * a calibration failure must leave the models and the camera exactly where they
 * were. Also deliberately not a set of booleans — `collecting && !stable &&
 * !failed` is how a studio ends up averaging a window it already rejected.
 */
export type CalibrationPhase =
  /** Nothing captured, nothing running. */
  | "idle"
  /** Watching the operator, waiting for them to be still enough to start. */
  | "waiting-for-stable-tracking"
  /** Accumulating a usable window. */
  | "collecting"
  /** Computing the baseline from the window. */
  | "evaluating"
  /** A profile exists. */
  | "ready"
  /** Nothing was captured, and why. The engine is untouched. */
  | "failed";

/**
 * What the operator asked for.
 *
 * `full` needs face and both shoulders. `face-only` is offered when the
 * shoulders cannot be found — it is genuinely less, and is labelled as less
 * everywhere it appears.
 */
export type CalibrationMode = "full" | "face-only";

/**
 * How good the captured baseline is.
 *
 * Three named states, from measured conditions. Deliberately not a percentage:
 * a "94% confidence" on a screen implies a model produced it, and nothing here
 * did. `stabilityScore` is a number, but it is a stated formula over measured
 * dispersion, described where it is computed.
 */
export type CalibrationQuality = "excellent" | "good" | "limited";

/** Informational. None of these stop a calibration from being usable. */
export type CalibrationWarning =
  | "shoulders-outside-frame"
  | "head-strongly-angled"
  | "tracking-unstable"
  | "face-near-edge"
  | "upper-body-unavailable";

/** Why a calibration could not be captured. Each has its own recovery. */
export type CalibrationFailure =
  /** Never saw a usable face. */
  | "no-face"
  /** Saw a face, never both shoulders. The operator can retry face-only. */
  | "pose-unavailable"
  /** The operator never held still long enough. */
  | "unstable"
  /**
   * The operator held still, but outside the neutral envelope for most of the
   * window — tilted, turned, too close. `failureRejection` says which. Reported
   * as "unstable" before, which sent a steady, tilted person hunting a jitter.
   */
  | "out-of-position"
  /** Ran out of time before a usable window appeared. */
  | "timeout"
  /** The operator stopped it. */
  | "cancelled";

/** Why one frame was not collected. Drives the on-screen guidance. */
export type FrameRejection =
  | "no-face"
  | "low-confidence"
  | "invalid-geometry"
  | "too-far"
  | "too-close"
  | "head-angled"
  | "head-pitched"
  | "head-tilted"
  | "face-near-edge"
  | "no-pose"
  | "partial-pose";

export interface CalibrationFaceBaseline {
  /** Neutral face centre, normalised in tracking space. */
  center: Point3;
  /** Neutral interocular distance. The unit every translation is divided by. */
  scale: number;
  /** Radians. The operator's resting head orientation, not zero. */
  yaw: number;
  pitch: number;
  roll: number;
  /**
   * Resting expression, recorded but NOT subtracted.
   *
   * Someone with naturally narrow eyes has a lower resting openness, and
   * subtracting it would make their neutral face read as a permanent blink.
   * These are here so a later consumer can decide; the motion helper passes
   * expression through live. See `relativeMotion.ts`.
   */
  neutralEyeOpenness: number;
  neutralEyeOpennessLeft?: number;
  neutralEyeOpennessRight?: number;
  neutralSmileLeft?: number;
  neutralSmileRight?: number;
  neutralBrowHeights?: [number, number, number];
  neutralMouthOpenness: number;
  /** Neutral chin-to-nose proportion, used to separate jaw drop from pose. */
  neutralJawDisplacement?: number;
  /** Per-eye iris centre in canonical eye-local units. No landmarks are retained. */
  neutralEyeGaze?: { left: { x: number; y: number }; right: { x: number; y: number } };
  /** Compact median scores from the neutral capture. No landmarks or frames persist. */
  expressionNeutral?: {
    blinkLeft: number;
    blinkRight: number;
    jawOpen: number;
    smileLeft: number;
    smileRight: number;
    browInnerUp: number;
    browOuterUpLeft: number;
    browOuterUpRight: number;
  };
}

export interface CalibrationPoseBaseline {
  /** Every field is optional: a seated operator often has no visible hips. */
  shoulderCenter: Point3 | null;
  shoulderWidth: number | null;
  /** Radians. Resting shoulder tilt — very few people are level. */
  shoulderAngle: number | null;
  torsoCenter: Point3 | null;
  torsoScale: number | null;
  torsoLean: number | null;
}

export interface CalibrationTrackingSpace {
  /** The tracking frame at capture time, for the record. */
  width: number;
  height: number;
  /**
   * Whether the PREVIEW was mirrored.
   *
   * Recorded, not applied. All calibration and motion maths happen in the
   * unmirrored tracking space the models actually saw; mirroring stays a
   * display concern, exactly as in `coordinateMapping.ts`.
   */
  mirrorMode: "mirrored" | "direct";
}

export interface CalibrationQualityReport {
  faceAvailable: boolean;
  poseAvailable: boolean;
  /** Frames actually averaged into the baseline. */
  frameCount: number;
  /** 0..1 from measured dispersion. The formula is in `calibrationStatistics.ts`. */
  stabilityScore: number;
  quality: CalibrationQuality;
  warnings: CalibrationWarning[];
}

/**
 * Bumped when the meaning of a field changes.
 *
 * A stored profile from an older version must not be reinterpreted under new
 * rules — a yaw that meant one thing and now means another is exactly the class
 * of bug that took a milestone to find at the tracker layer.
 */
export const CALIBRATION_PROFILE_VERSION = 3;

/**
 * PRIVACY. This is the whole of what calibration keeps.
 *
 * Aggregated geometry and nothing else: no camera image, no frame-by-frame
 * landmark history, no pose history, no video, no identity embedding. The
 * samples that produced these numbers are discarded the moment the baseline is
 * computed, and nothing here is written to IndexedDB, localStorage, session
 * history or analytics — it lives in memory for the length of a Studio visit.
 */
export interface TransformationCalibrationProfile {
  version: number;
  createdAt: number;
  mode: CalibrationMode;
  cameraFacing: CameraFacing;
  face: CalibrationFaceBaseline;
  pose: CalibrationPoseBaseline;
  trackingSpace: CalibrationTrackingSpace;
  quality: CalibrationQualityReport;
}

/**
 * Why a baseline stopped being valid.
 *
 * Stated as a closed set because the invalidation rules are the part most
 * likely to be got wrong quietly: silently reusing a front-camera baseline on a
 * rear camera produces motion that is subtly, unfixably wrong.
 */
export type CalibrationInvalidation =
  /** Front to rear, or back: different mirror, optics and framing. */
  | "camera-facing-changed"
  /** The operator asked for a new baseline. */
  | "recalibration-requested"
  /** The Studio was torn down. */
  | "disposed";
