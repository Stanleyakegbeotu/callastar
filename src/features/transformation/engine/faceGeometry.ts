import type { BlendshapeScores, DerivedFaceGeometry, Point3 } from "./faceTypes";

/**
 * Turning 478 landmarks into the handful of numbers the pipeline reasons about.
 *
 * Pure functions on plain arrays, so every one of them is testable without a
 * browser, a model or a camera. That matters: this is the layer most likely to
 * be wrong in a way that only shows up as a subtly drifting face.
 *
 * Landmark indices are MediaPipe's canonical face mesh topology, which is fixed
 * across model versions — the same indices the published mesh diagrams use.
 */

/** Canonical indices, named so the arithmetic below reads as anatomy. */
export const FACE_LANDMARKS = {
  noseTip: 1,
  chin: 152,
  foreheadTop: 10,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  rightEyeOuter: 263,
  rightEyeInner: 362,
  leftEyeUpper: 159,
  leftEyeLower: 145,
  rightEyeUpper: 386,
  rightEyeLower: 374,
  mouthUpper: 13,
  mouthLower: 14,
  mouthLeft: 61,
  mouthRight: 291,
  leftCheek: 234,
  rightCheek: 454,
} as const;

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Head pose from the model's own 4x4, when it provided one.
 *
 * Preferred over landmark trigonometry because the model solved for it directly
 * and it stays stable at angles where landmark spacing becomes ambiguous.
 * MediaPipe returns column-major data, so the rotation basis is read from
 * elements 0..10 accordingly.
 */
export function poseFromMatrix(matrix: readonly number[]): { yaw: number; pitch: number; roll: number } | null {
  if (matrix.length < 16) return null;

  /*
   * Column-major storage: m[col * 4 + row] is R[row][col].
   *
   * Standard Tait-Bryan extraction, with the axes named for a head rather than
   * for the maths:
   *
   *   yaw   — shaking "no"   — rotation about the VERTICAL axis  — asin(-R[2][0])
   *   pitch — nodding "yes"  — rotation about the LATERAL axis   — atan2(R[2][1], R[2][2])
   *   roll  — tilting an ear — rotation about the FORWARD axis   — atan2(R[1][0], R[0][0])
   *
   * Worth spelling out: `asin(-R[2][0])` is the Y-axis term, which is yaw for a
   * head. Reading it as pitch swaps nodding for shaking, which a test caught
   * here and a person would only notice as a face that moves the wrong way.
   */
  const r00 = matrix[0] ?? 0;
  const r10 = matrix[1] ?? 0;
  const r20 = matrix[2] ?? 0;
  const r21 = matrix[6] ?? 0;
  const r22 = matrix[10] ?? 0;

  // Guard against a degenerate basis producing NaN from asin.
  const sinYaw = Math.max(-1, Math.min(1, -r20));

  // Near gimbal lock the pitch/roll split is meaningless; fall back to
  // landmarks rather than returning two arbitrary angles.
  if (Math.abs(sinYaw) > 0.9999) return null;

  return {
    yaw: Math.asin(sinYaw),
    pitch: Math.atan2(r21, r22),
    roll: Math.atan2(r10, r00),
  };
}

/**
 * Head pose from landmarks, used when the model gave no matrix.
 *
 * Deliberately coarse: an approximation from facial proportions, not a solved
 * pose. Yaw comes from how far the nose sits from the midpoint between the
 * cheeks relative to face width, which is a reasonable proxy at moderate angles
 * and degrades gracefully past them — exactly where the safe-envelope limits
 * will stop the renderer anyway.
 */
export function poseFromLandmarks(landmarks: readonly Point3[]): { yaw: number; pitch: number; roll: number } {
  const nose = landmarks[FACE_LANDMARKS.noseTip];
  const leftCheek = landmarks[FACE_LANDMARKS.leftCheek];
  const rightCheek = landmarks[FACE_LANDMARKS.rightCheek];
  const forehead = landmarks[FACE_LANDMARKS.foreheadTop];
  const chin = landmarks[FACE_LANDMARKS.chin];
  const leftEye = landmarks[FACE_LANDMARKS.leftEyeOuter];
  const rightEye = landmarks[FACE_LANDMARKS.rightEyeOuter];

  if (!nose || !leftCheek || !rightCheek || !forehead || !chin || !leftEye || !rightEye) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  const faceWidth = Math.abs(rightCheek.x - leftCheek.x) || 1e-6;
  const faceHeight = Math.abs(chin.y - forehead.y) || 1e-6;

  const midX = (leftCheek.x + rightCheek.x) / 2;
  const midY = (forehead.y + chin.y) / 2;

  // Scaled so a nose fully at one cheek reads as roughly ±60°, then clamped.
  const yaw = Math.max(-1, Math.min(1, ((nose.x - midX) / faceWidth) * 2)) * (Math.PI / 3);
  const pitch = Math.max(-1, Math.min(1, ((nose.y - midY) / faceHeight) * 2)) * (Math.PI / 4);

  // Roll is the only one landmarks give honestly: the eye line's angle.
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  return { yaw, pitch, roll };
}

/**
 * Eyelid separation, normalised by eye width so it survives distance changes.
 *
 * Returned as a ratio rather than a blendshape because the blendshape is a blink
 * score — high when closed — and mixing the two conventions is an easy way to
 * render a face that blinks inside out.
 */
/** Vertical eyelid pairs across each eye: outer third, centre, inner third. */
const EYELID_PAIRS = {
  left: [[160, 144], [159, 145], [158, 153]],
  right: [[387, 373], [386, 374], [385, 380]],
} as const;

/**
 * Eyelid aperture: the mean of three vertical lid separations over eye width,
 * so it is scale-free and one noisy landmark cannot open or close an eye.
 * Normalised so a fully open eye (~0.45 of its width at the centre) reads 1.
 */
export function eyeOpenness(landmarks: readonly Point3[], side: "left" | "right"): number {
  const outer = landmarks[side === "left" ? FACE_LANDMARKS.leftEyeOuter : FACE_LANDMARKS.rightEyeOuter];
  const inner = landmarks[side === "left" ? FACE_LANDMARKS.leftEyeInner : FACE_LANDMARKS.rightEyeInner];
  if (!outer || !inner) return 0;
  let sum = 0;
  for (const [u, l] of EYELID_PAIRS[side]) {
    const upper = landmarks[u];
    const lower = landmarks[l];
    if (!upper || !lower) return 0;
    sum += distance(upper, lower);
  }
  const width = distance(outer, inner) || 1e-6;
  return Math.max(0, Math.min(1, (sum / 3 / width) / 0.45));
}

/** Lip separation, normalised by mouth width. */
export function mouthOpenness(landmarks: readonly Point3[]): number {
  const left = landmarks[FACE_LANDMARKS.mouthLeft];
  const right = landmarks[FACE_LANDMARKS.mouthRight];

  if (!left || !right) return 0;

  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const width = Math.hypot(dx, dy) || 1e-6;
  const vx = -dy / width;
  const vy = dx / width;
  // Inner-lip cross-sections from the centre out to either side. Projecting
  // onto the mouth's local perpendicular rejects horizontal corner movement
  // and remains stable when the head rolls.
  const pairs = [[13, 14], [82, 87], [312, 317], [81, 178], [311, 402]] as const;
  let opening = 0;
  let count = 0;
  for (const [upperIndex, lowerIndex] of pairs) {
    const upper = landmarks[upperIndex];
    const lower = landmarks[lowerIndex];
    if (!upper || !lower) continue;
    opening += Math.abs((upper.x - lower.x) * vx + (upper.y - lower.y) * vy);
    count++;
  }
  if (count === 0) return 0;
  // A wide-open jaw is roughly 0.6 of mouth width.
  return Math.max(0, Math.min(1, (opening / count / width) / 0.6));
}

/** Lower-jaw drop relative to the nose, normalized by the cheek-to-cheek span. */
export function jawDisplacement(landmarks: readonly Point3[]): number {
  const nose = landmarks[FACE_LANDMARKS.noseTip];
  const chin = landmarks[FACE_LANDMARKS.chin];
  const left = landmarks[FACE_LANDMARKS.leftCheek];
  const right = landmarks[FACE_LANDMARKS.rightCheek];
  if (!nose || !chin || !left || !right) return 0;
  const faceWidth = Math.hypot(right.x - left.x, right.y - left.y) || 1e-6;
  return (chin.y - nose.y) / faceWidth;
}

/**
 * How far one mouth corner sits above the lip-centre line.
 *
 * A geometric smile measure, for fusing with `mouthSmileLeft`/`Right`. Divided
 * by mouth width so it is unaffected by distance from the camera, and signed so
 * a downturned mouth reads as zero rather than as a smile.
 *
 * "left" is the SUBJECT'S left, matching every other left/right in this file and
 * MediaPipe's own naming.
 */
export function mouthCornerLift(landmarks: readonly Point3[], side: "left" | "right"): number {
  const corner = landmarks[side === "left" ? FACE_LANDMARKS.mouthLeft : FACE_LANDMARKS.mouthRight];
  const upper = landmarks[FACE_LANDMARKS.mouthUpper];
  const lower = landmarks[FACE_LANDMARKS.mouthLower];
  const left = landmarks[FACE_LANDMARKS.mouthLeft];
  const right = landmarks[FACE_LANDMARKS.mouthRight];

  if (!corner || !upper || !lower || !left || !right) return 0;

  const width = distance(left, right) || 1e-6;
  const centreY = (upper.y + lower.y) / 2;
  // y grows down, so a raised corner has the SMALLER y.
  const lift = (centreY - corner.y) / width;
  // A broad smile lifts a corner by roughly a fifth of mouth width.
  // Do not clamp the upper end here. Jaw opening can move the lip centre down
  // far enough to exceed 1; retaining the excess lets the caller subtract that
  // measured jaw contribution before clamping an actual smile signal.
  return Math.max(0, lift / 0.2);
}

export function faceBounds(landmarks: readonly Point3[]): DerivedFaceGeometry["bounds"] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of landmarks) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Everything the pipeline derives from one frame's landmarks.
 *
 * `matrix` is used for pose when present; the landmark estimate is the fallback.
 */
export function deriveFaceGeometry(
  landmarks: readonly Point3[],
  matrix: readonly number[] | null,
  blendshapes: BlendshapeScores,
): DerivedFaceGeometry | null {
  if (landmarks.length === 0) return null;

  const leftEye = landmarks[FACE_LANDMARKS.leftEyeOuter];
  const rightEye = landmarks[FACE_LANDMARKS.rightEyeOuter];
  if (!leftEye || !rightEye) return null;

  const bounds = faceBounds(landmarks);
  const pose = (matrix && poseFromMatrix(matrix)) ?? poseFromLandmarks(landmarks);

  const openLeft = eyeOpenness(landmarks, "left");
  const openRight = eyeOpenness(landmarks, "right");

  /*
   * Blendshapes win for the mouth when available.
   *
   * `jawOpen` is what the model solved for and responds faster than lip
   * distance, which lags on a quick word. The landmark measure is the fallback.
   */
  const jawOpen = blendshapes.jawOpen;
  const mouth = typeof jawOpen === "number" ? Math.max(0, Math.min(1, jawOpen)) : mouthOpenness(landmarks);

  return {
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      z: 0,
    },
    scale: distance(leftEye, rightEye),
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    eyeOpenness: (openLeft + openRight) / 2,
    eyeOpennessLeft: openLeft,
    eyeOpennessRight: openRight,
    mouthOpenness: mouth,
    bounds,
  };
}

/**
 * How much to trust this frame.
 *
 * The face landmarker in this build reports no per-face score, so confidence is
 * inferred from whether the geometry is plausible: a face that has collapsed to
 * a point, left the frame, or produced non-finite coordinates is not one the
 * renderer should follow. This is what the safe-envelope and hold-last-stable
 * logic will key on later.
 */
export function estimateConfidence(landmarks: readonly Point3[], derived: DerivedFaceGeometry | null): number {
  if (landmarks.length === 0 || !derived) return 0;

  for (const point of landmarks) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 0;
  }

  // A face smaller than this is either very far away or a bad detection.
  const scaleScore = Math.max(0, Math.min(1, derived.scale / 0.06));

  // How much of the face is inside the frame at all.
  const width = derived.bounds.maxX - derived.bounds.minX;
  const height = derived.bounds.maxY - derived.bounds.minY;
  if (width <= 0 || height <= 0) return 0;

  const visibleX = Math.max(0, Math.min(1, derived.bounds.maxX) - Math.max(0, derived.bounds.minX));
  const visibleY = Math.max(0, Math.min(1, derived.bounds.maxY) - Math.max(0, derived.bounds.minY));
  const visibility = Math.max(0, Math.min(1, (visibleX / width) * (visibleY / height)));

  return Math.max(0, Math.min(1, scaleScore * 0.4 + visibility * 0.6));
}
