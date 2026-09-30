import type { Point3 } from "./faceTypes";

/**
 * CallaStar's own pose-tracking contract.
 *
 * Same boundary as the face tracker: nothing above this sees a MediaPipe object.
 * That matters more here than for the face, because the pose result carries
 * segmentation masks that own WASM memory — letting those leak into the engine
 * would make their lifetime everybody's problem.
 */

/** A landmark with MediaPipe's per-point visibility, where the build supplies it. */
export interface PoseLandmark extends Point3 {
  /**
   * 0..1, from the model. Absent in builds that do not report it — this is
   * never invented, per the rule against fabricating a confidence the model
   * did not give.
   */
  visibility?: number;
}

/**
 * How usable this frame's upper body is.
 *
 * A person whose shoulders have drifted out of frame is not a failure — it is a
 * normal thing to be told about, and the Studio will turn it into "move back
 * slightly so your shoulders are visible". Collapsing it into an error would
 * make an ordinary moment look like a crash.
 */
export type PoseTrackability =
  /** Both shoulders usable: upper-body transformation is safe. */
  | "tracked"
  /** One shoulder, or weak torso anchors. Reduced confidence, still usable. */
  | "partial"
  /** Not enough anchors for a stable upper body. */
  | "lost";

export type PoseTrackingStatus = "tracked" | "no-pose" | "skipped";

/**
 * The upper-body geometry this pipeline reasons about.
 *
 * Normalised throughout — nothing here is in output pixels, because the render
 * resolution is deliberately independent of the tracking resolution.
 */
export interface PoseDerivedGeometry {
  leftShoulder: Point3 | null;
  rightShoulder: Point3 | null;
  /** Midpoint of the shoulders; the primary anchor for the source's torso. */
  shoulderCenter: Point3 | null;
  /** Normalised distance between shoulders. A proxy for apparent body size. */
  shoulderWidth: number;
  /** Radians. Positive when the subject's right shoulder is lower. */
  shoulderAngle: number;
  /** Midpoint of shoulders and hips, when hips are visible. */
  torsoCenter: Point3 | null;
  /** Shoulder-to-hip distance. Null when hips are not usable. */
  torsoScale: number | null;
  /**
   * Radians, and an APPROXIMATION.
   *
   * Two-dimensional landmarks cannot give true torso rotation; this is the tilt
   * of the shoulder-centre-to-hip-centre line, which reads a lean well and a
   * twist poorly. Documented as approximate because the renderer must not treat
   * it as a solved angle.
   */
  torsoLean: number | null;
  trackability: PoseTrackability;
  /** Mean visibility of the anchors actually used, or null when unreported. */
  visibility: number | null;
}

/**
 * A segmentation mask, described rather than held.
 *
 * MediaPipe's mask objects own WASM memory and must be closed. The tracker
 * closes them within the inference call and reports only these facts, so no
 * provider-owned resource escapes into the engine to be leaked per frame.
 * Actually using a mask will mean copying the pixels out deliberately, in a
 * later milestone with OpenCV.
 */
export interface SegmentationInfo {
  available: boolean;
  width: number | null;
  height: number | null;
  /** What the mask holds, as reported by the runtime. */
  representation: string | null;
}

export interface PoseTrackingResult {
  timestampMs: number;
  status: PoseTrackingStatus;
  detected: boolean;
  /** 33 normalised landmarks when tracked; empty otherwise. */
  landmarks: readonly PoseLandmark[];
  /** Metric 3D landmarks, origin at the hips, where the build provides them. */
  worldLandmarks: readonly PoseLandmark[];
  segmentation: SegmentationInfo;
  derived: PoseDerivedGeometry | null;
}

export const NO_POSE_RESULT: Omit<PoseTrackingResult, "timestampMs"> = {
  status: "no-pose",
  detected: false,
  landmarks: [],
  worldLandmarks: [],
  segmentation: { available: false, width: null, height: null, representation: null },
  derived: null,
};
