import type { Point3 } from './faceTypes';
import { rendererMotionFromPose } from './rendering/rendererMotion';
import { physicalOrientation } from './rigidFaceMotion';

export interface FaceOrientation { yaw: number; pitch: number; roll: number }

/** Brow height above its ipsilateral eye line, in face-width units. */
export function localBrowHeights(p: readonly Point3[]): [number, number, number] | null {
  if (p.length < 468) return null;
  const width = Math.abs(p[454]!.x - p[234]!.x);
  if (width < .001) return null;
  const leftEye = (p[33]!.y + p[133]!.y) / 2;
  const rightEye = (p[263]!.y + p[362]!.y) / 2;
  return [((leftEye - p[107]!.y) + (rightEye - p[336]!.y)) / (2 * width),
    (leftEye - p[70]!.y) / width, (rightEye - p[300]!.y) / width];
}

/** Camera landmarks -> metric image axes -> inverse rigid rotation -> local face.
 * x/z are image-width units; y is image-height units. Undo aspect BEFORE rotation.
 * Output retains y-down/z-away conventions for the existing feature measurements.
 * No display mirror enters this function. Translation and scale cancel in ratios.
 */
export function canonicalFaceLandmarks(
  points: readonly Point3[], pose: FaceOrientation, aspect = 1, output: Point3[] = [],
): Point3[] {
  const origin = points[1];
  if (!origin) return [];
  // `pose` is MediaPipe's; the renderer mapping takes physical angles.
  const r = rendererMotionFromPose({ x: 0, y: 0, scale: 1, ...physicalOrientation(pose) });
  const sx = Math.sin(r.rotationX), cx = Math.cos(r.rotationX);
  const sy = Math.sin(r.rotationY), cy = Math.cos(r.rotationY);
  const sz = Math.sin(r.rotationZ), cz = Math.cos(r.rotationZ);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const x = p.x - origin.x, y = (origin.y - p.y) / a, z = origin.z - p.z;
    // Transpose of Rx Ry Rz; orthonormal inverse, not Euler subtraction.
    const dest = output[i] ?? (output[i] = { x: 0, y: 0, z: 0 });
    dest.x = cy * cz * x + (cx * sz + sx * sy * cz) * y + (sx * sz - cx * sy * cz) * z;
    dest.y = -(-cy * sz * x + (cx * cz - sx * sy * sz) * y + (sx * cz + cx * sy * sz) * z);
    dest.z = -(sy * x - sx * cy * y + cx * cy * z);
  }
  output.length = points.length;
  return output;
}
