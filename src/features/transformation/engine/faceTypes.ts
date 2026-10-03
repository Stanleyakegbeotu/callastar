/**
 * CallaStar's own face-tracking contract.
 *
 * Deliberately not MediaPipe's object shapes. Everything downstream — the
 * smoother, the calibrator, the renderer — reads these types, so replacing or
 * upgrading the tracker is a change to one wrapper rather than to every consumer.
 * MediaPipe's result objects also carry provider-owned memory and optional
 * fields that differ by model build; normalising once, at the boundary, keeps
 * that out of the engine.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The blendshapes this pipeline actually uses, by MediaPipe category name.
 *
 * A face landmarker emits 52. Naming the handful that drive the transformation
 * keeps the rest out of the hot path and documents what the renderer will
 * respond to, rather than implying all 52 are wired.
 */
export const TRACKED_BLENDSHAPES = [
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "jawOpen",
  "mouthSmileLeft",
  "mouthSmileRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
] as const;

export type TrackedBlendshape = (typeof TRACKED_BLENDSHAPES)[number];

/** Every blendshape score the model returned, by category name, 0..1. */
export type BlendshapeScores = Readonly<Partial<Record<string, number>>>;

/**
 * Geometry derived from the landmarks, kept apart from them on purpose.
 *
 * The raw landmarks are the model's output and stay untouched. These are this
 * pipeline's interpretation of them — head pose, openness, scale — and will be
 * consumed by the smoother and the calibrator. Keeping them separate means a
 * later change to how yaw is computed cannot quietly corrupt the landmarks, and
 * nothing renderer-specific is baked in at tracking time.
 */
export interface DerivedFaceGeometry {
  /** Normalised centre of the face, in the same 0..1 space as the landmarks. */
  center: Point3;
  /** Interocular distance, normalised. A stable proxy for apparent face size. */
  scale: number;
  /** Radians. Positive yaw is the head turning to the subject's left. */
  yaw: number;
  /** Radians. Positive pitch is looking DOWN (measured; see `rigidFaceMotion.ts`). */
  pitch: number;
  /** Radians. Positive roll is the head tilting to the subject's right. */
  roll: number;
  /** 0 closed, 1 open. Averaged across both eyes. */
  eyeOpenness: number;
  eyeOpennessLeft: number;
  eyeOpennessRight: number;
  /** 0 closed, 1 wide. */
  mouthOpenness: number;
  /** Axis-aligned bounds of the face, normalised. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export type FaceTrackingStatus =
  /** A face was found with usable landmarks. */
  | "tracked"
  /** Inference ran and found nothing. Not an error. */
  | "no-face"
  /** Inference did not run: the tracker was busy, disposed, or the frame stale. */
  | "skipped";

export interface FaceTrackingResult {
  /** Camera-frame sequence assigned by TrackingScheduler. */
  frameId?: number;
  timestampMs: number;
  status: FaceTrackingStatus;
  detected: boolean;
  /**
   * 0..1, derived from landmark presence and geometry plausibility.
   *
   * MediaPipe's face landmarker does not return a per-face score in this build,
   * so this is computed rather than reported — see `estimateConfidence`.
   */
  confidence: number;
  /** 478 normalised landmarks when tracked; empty otherwise. */
  landmarks: readonly Point3[];
  blendshapes: BlendshapeScores;
  /**
   * Column-major 4x4 from the model, when the build provides it.
   *
   * Preferred over landmark-derived angles for head pose because it is what the
   * model actually solved for; `derived` falls back to landmarks when absent.
   */
  facialTransformationMatrix: readonly number[] | null;
  derived: DerivedFaceGeometry | null;
}

export const NO_FACE_RESULT: Omit<FaceTrackingResult, "timestampMs"> = {
  status: "no-face",
  detected: false,
  confidence: 0,
  landmarks: [],
  blendshapes: {},
  facialTransformationMatrix: null,
  derived: null,
};
