import type { Point3 } from "../faceTypes";
import { FACE_RENDER_TRIANGLES } from "./sourceMesh";

export interface ProjectionBinding {
  a: number;
  b: number;
  c: number;
  wa: number;
  wb: number;
  wc: number;
}

function barycentric(
  x: number,
  y: number,
  a: Point3,
  b: Point3,
  c: Point3,
): [number, number, number] | null {
  const v0x = b.x - a.x, v0y = b.y - a.y;
  const v1x = c.x - a.x, v1y = c.y - a.y;
  const v2x = x - a.x, v2y = y - a.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-10) return null;
  const wb = (v2x * v1y - v1x * v2y) / denominator;
  const wc = (v0x * v2y - v2x * v0y) / denominator;
  return [1 - wb - wc, wb, wc];
}

/** Precomputes a source-UV to MediaPipe topology lookup once per source mesh. */
export function buildProjectionBindings(
  uvs: Float32Array,
  sourceLandmarks: readonly Point3[],
): ProjectionBinding[] {
  const bindings: ProjectionBinding[] = new Array(uvs.length / 2);
  for (let vertex = 0; vertex < bindings.length; vertex++) {
    if (vertex < 468) {
      bindings[vertex] = { a: vertex, b: vertex, c: vertex, wa: 1, wb: 0, wc: 0 };
      continue;
    }
    const x = uvs[vertex * 2]!, y = uvs[vertex * 2 + 1]!;
    let best: { binding: ProjectionBinding; outside: number; distance: number } | null = null;
    for (const [aIndex, bIndex, cIndex] of FACE_RENDER_TRIANGLES) {
      const a = sourceLandmarks[aIndex]!, b = sourceLandmarks[bIndex]!, c = sourceLandmarks[cIndex]!;
      const weights = barycentric(x, y, a, b, c);
      if (!weights) continue;
      const outside = weights.reduce((sum, weight) => sum + Math.max(0, -weight), 0);
      const centroidDistance = Math.hypot(x - (a.x + b.x + c.x) / 3, y - (a.y + b.y + c.y) / 3);
      if (!best || outside < best.outside - 1e-5 ||
          (Math.abs(outside - best.outside) <= 1e-5 && centroidDistance < best.distance)) {
        best = {
          binding: { a: aIndex, b: bIndex, c: cIndex, wa: weights[0], wb: weights[1], wc: weights[2] },
          outside,
          distance: centroidDistance,
        };
        if (outside < 1e-5) break;
      }
    }
    bindings[vertex] = best?.binding ?? { a: 1, b: 1, c: 1, wa: 1, wb: 0, wc: 0 };
  }
  return bindings;
}

/**
 * Retargets the textured source topology onto this frame's dense live mesh.
 * Source UVs and identity pixels stay fixed; only the surface coordinates move.
 * Expression deltas are retained in the same head-local units.
 */
export function projectLiveMeshPositions(
  output: Float32Array,
  sourceBase: Float32Array,
  expressionPositions: Float32Array,
  bindings: readonly ProjectionBinding[],
  liveLandmarks: readonly Point3[],
  center: Point3,
  faceWidth: number,
  aspect: number,
  inverseRotation: ArrayLike<number>,
  canonicalWidth = 0.44,
  liveMouthIndices?: ReadonlySet<number>,
): boolean {
  if (faceWidth <= 1e-6 || aspect <= 1e-6 || liveLandmarks.length < 468) return false;
  for (let vertex = 0; vertex < bindings.length; vertex++) {
    const binding = bindings[vertex]!;
    const a = liveLandmarks[binding.a]!, b = liveLandmarks[binding.b]!, c = liveLandmarks[binding.c]!;
    const x = (a.x * binding.wa + b.x * binding.wb + c.x * binding.wc - center.x) / faceWidth * canonicalWidth;
    const y = -(a.y * binding.wa + b.y * binding.wb + c.y * binding.wc - center.y) / (faceWidth * aspect) * canonicalWidth;
    const z = -(a.z * binding.wa + b.z * binding.wb + c.z * binding.wc - center.z) / faceWidth * canonicalWidth;
    const rx = inverseRotation[0]! * x + inverseRotation[4]! * y + inverseRotation[8]! * z;
    const ry = inverseRotation[1]! * x + inverseRotation[5]! * y + inverseRotation[9]! * z;
    const rz = inverseRotation[2]! * x + inverseRotation[6]! * y + inverseRotation[10]! * z;
    const offset = vertex * 3;
    // The live landmarks already contain mouth expression. Adding the source
    // deformer again enlarges lip width/opening and can expose a second lip.
    const expressionWeight = liveMouthIndices?.has(vertex) ? 0 : 1;
    output[offset] = rx + (expressionPositions[offset]! - sourceBase[offset]!) * expressionWeight;
    output[offset + 1] = ry + (expressionPositions[offset + 1]! - sourceBase[offset + 1]!) * expressionWeight;
    output[offset + 2] = rz + (expressionPositions[offset + 2]! - sourceBase[offset + 2]!) * expressionWeight;
  }
  return true;
}
