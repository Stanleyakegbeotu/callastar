import type { FaceTrackingResult, Point3 } from "./faceTypes"
import { canonicalFaceLandmarks } from "./faceLocalGeometry"

/** Mouth/nose use the model's full rotation basis when present. Reconstructing
 * extracted Euler angles in another order leaks compound rotations into local
 * ratios. The locked eye coordinate path stays unchanged. */
export function mouthNoseLocalLandmarks(
  face: FaceTrackingResult,
  aspect = 1,
  output: Point3[] = [],
): Point3[] {
  const m = face.facialTransformationMatrix,
    origin = face.landmarks[1]
  if (!m || m.length < 16 || !origin || !face.derived)
    return face.derived
      ? canonicalFaceLandmarks(face.landmarks, face.derived, aspect, output)
      : []
  const columns = [0, 4, 8].map((i) => Math.hypot(m[i]!, m[i + 1]!, m[i + 2]!))
  if (
    columns.some((n) => !Number.isFinite(n) || n < 1e-6) ||
    m.some((n) => !Number.isFinite(n))
  )
    return canonicalFaceLandmarks(face.landmarks, face.derived, aspect, output)
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  for (let i = 0; i < face.landmarks.length; i++) {
    const p = face.landmarks[i]!,
      x = p.x - origin.x,
      y = (origin.y - p.y) / a,
      z = origin.z - p.z
    const d = output[i] ?? (output[i] = { x: 0, y: 0, z: 0 })
    d.x = (m[0]! * x + m[1]! * y + m[2]! * z) / columns[0]!
    d.y = -(m[4]! * x + m[5]! * y + m[6]! * z) / columns[1]!
    d.z = -(m[8]! * x + m[9]! * y + m[10]! * z) / columns[2]!
  }
  output.length = face.landmarks.length
  return output
}
