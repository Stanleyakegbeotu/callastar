import type { Point3 } from "./faceTypes";
import type { PoseDerivedGeometry, PoseLandmark, PoseTrackability } from "./poseTypes";

/**
 * Upper-body geometry from pose landmarks.
 *
 * Pure functions on plain arrays, for the same reason as the face geometry: this
 * is where an error surfaces as shoulders that drift the wrong way rather than
 * as a crash. The face milestone caught a silent axis inversion exactly here,
 * so every direction below is pinned by a test with a known sign.
 */

/**
 * MediaPipe's canonical pose topology (33 points).
 *
 * Only the upper body is named. Legs and feet stay in the raw result but drive
 * nothing: this pipeline transforms a head and shoulders, and deriving a knee
 * angle would be work nobody consumes.
 */
export const POSE_LANDMARKS = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftHip: 23,
  rightHip: 24,
} as const;

/**
 * Below this, a landmark is a guess rather than an observation.
 *
 * MediaPipe reports visibility for occluded or out-of-frame points; following
 * one is how an arm that left the picture drags a shoulder with it.
 */
export const MIN_VISIBILITY = 0.5;

function usable(point: PoseLandmark | undefined): point is PoseLandmark {
  if (!point) return false;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  // Visibility is optional: a build that does not report it is trusted, since
  // inventing a score would be worse than accepting the model's silence.
  return point.visibility === undefined || point.visibility >= MIN_VISIBILITY;
}

function midpoint(a: Point3, b: Point3): Point3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function toPoint(landmark: PoseLandmark): Point3 {
  return { x: landmark.x, y: landmark.y, z: landmark.z };
}

/**
 * Angle of the shoulder line.
 *
 * Positive when the subject's right shoulder sits lower in frame. MediaPipe's
 * "left" is the subject's left, which appears on the right of a non-mirrored
 * image — the sign convention is fixed by a test rather than by intuition.
 */
export function shoulderAngle(left: Point3, right: Point3): number {
  return Math.atan2(left.y - right.y, left.x - right.x);
}

export function shoulderWidth(left: Point3, right: Point3): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * How much of the upper body is usable this frame.
 *
 * Shoulders are the anchors that matter: without both, an upper-body transform
 * has nothing stable to sit on.
 */
export function assessTrackability(
  leftShoulder: PoseLandmark | undefined,
  rightShoulder: PoseLandmark | undefined,
  hipsUsable: boolean,
): PoseTrackability {
  const left = usable(leftShoulder);
  const right = usable(rightShoulder);

  if (left && right) return "tracked";
  // One shoulder still permits a reduced transform; the Studio will say so.
  if (left || right) return "partial";
  // Hips alone cannot anchor shoulders, but they do mean a person is present.
  return hipsUsable ? "partial" : "lost";
}

/** Mean visibility of the anchors actually used, or null when unreported. */
function meanVisibility(points: (PoseLandmark | undefined)[]): number | null {
  const scores = points
    .filter((point): point is PoseLandmark => point !== undefined)
    .map((point) => point.visibility)
    .filter((value): value is number => typeof value === "number");

  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/**
 * Everything the pipeline derives from one frame's pose.
 *
 * Returns geometry even when only part of the body is usable — a partial pose
 * is a normal state to report, not a failure to throw on.
 */
export function derivePoseGeometry(landmarks: readonly PoseLandmark[]): PoseDerivedGeometry | null {
  if (landmarks.length === 0) return null;

  const rawLeftShoulder = landmarks[POSE_LANDMARKS.leftShoulder];
  const rawRightShoulder = landmarks[POSE_LANDMARKS.rightShoulder];
  const rawLeftHip = landmarks[POSE_LANDMARKS.leftHip];
  const rawRightHip = landmarks[POSE_LANDMARKS.rightHip];

  const leftShoulder = usable(rawLeftShoulder) ? toPoint(rawLeftShoulder) : null;
  const rightShoulder = usable(rawRightShoulder) ? toPoint(rawRightShoulder) : null;
  const hipsUsable = usable(rawLeftHip) && usable(rawRightHip);

  const trackability = assessTrackability(rawLeftShoulder, rawRightShoulder, hipsUsable);

  const shoulderCenter = leftShoulder && rightShoulder ? midpoint(leftShoulder, rightShoulder) : null;
  const width = leftShoulder && rightShoulder ? shoulderWidth(leftShoulder, rightShoulder) : 0;
  const angle = leftShoulder && rightShoulder ? shoulderAngle(leftShoulder, rightShoulder) : 0;

  const hipCenter =
    hipsUsable && rawLeftHip && rawRightHip ? midpoint(toPoint(rawLeftHip), toPoint(rawRightHip)) : null;

  const torsoCenter = shoulderCenter && hipCenter ? midpoint(shoulderCenter, hipCenter) : null;
  const torsoScale =
    shoulderCenter && hipCenter ? Math.hypot(shoulderCenter.x - hipCenter.x, shoulderCenter.y - hipCenter.y) : null;

  /*
   * Torso lean: an approximation, and only ever that.
   *
   * Two-dimensional landmarks cannot separate a lean from a twist. This is the
   * tilt of the shoulder-centre-to-hip-centre line away from vertical, which
   * reads a lean honestly and a rotation not at all. Measured from vertical so
   * upright is zero rather than a right angle.
   */
  const torsoLean =
    shoulderCenter && hipCenter
      ? Math.atan2(shoulderCenter.x - hipCenter.x, Math.abs(hipCenter.y - shoulderCenter.y) || 1e-6)
      : null;

  return {
    leftShoulder,
    rightShoulder,
    shoulderCenter,
    shoulderWidth: width,
    shoulderAngle: angle,
    torsoCenter,
    torsoScale,
    torsoLean,
    trackability,
    visibility: meanVisibility([rawLeftShoulder, rawRightShoulder]),
  };
}
