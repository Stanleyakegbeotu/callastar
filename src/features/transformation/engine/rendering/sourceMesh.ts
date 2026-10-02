import type { Point3 } from "../faceTypes";
import { canonicalFaceLandmarks, type FaceOrientation } from "../faceLocalGeometry";
import { DENSE_FACE_TRIANGLES } from "./faceTopology";

/** Oval indices retained for diagnostics and fixture construction. */
export const FACE_RENDER_VERTEX_INDICES = [1, 10, 109, 67, 103, 54, 21, 162, 127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338] as const;
export const FACE_MESH_SUBDIVISIONS = 1;
export const FACE_RENDER_TRIANGLES = DENSE_FACE_TRIANGLES;

/** The 468 landmark vertices. Anything after them is a mouth part below. */
export const FACE_LANDMARK_VERTICES = 468;
/** MediaPipe lip rings, in order around the mouth. */
export const INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191] as const;
export const OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185] as const;
/**
 * How far behind the lips each mouth part sits, as a fraction of face width.
 * The fill only has to lose to the lips; the cavity is roughly where a real
 * mouth's back wall is, so it shows parallax under yaw instead of a flat decal.
 */
const MOUTH_FILL_DEPTH = 0.012;
const MOUTH_CAVITY_DEPTH = 0.12;

export interface SourceMouthParts {
  /** First vertex of the pinned source-aperture fill (ring, then centroid). */
  fillStart: number;
  fillCount: number;
  fillIndexStart: number;
  fillIndexCount: number;
  /** First vertex of the cavity (ring, then centroid). Deforms with the lips. */
  cavityStart: number;
  cavityCount: number;
  /** Index range drawn with the untextured cavity material. */
  cavityIndexStart: number;
  cavityIndexCount: number;
}

export interface SourceFaceMeshData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  localLandmarks?: readonly Point3[];
  mouth?: SourceMouthParts;
  /** Eye-only interior vertices; no outer-face layers or new head geometry. */
  eyeInterior?: { start: number; count: number };
}

/** Measured source depth, with fixed topology and original source UVs.
 * MediaPipe z grows away; Three z grows toward the camera. No depth attenuation.
 * Eye surfaces are closed by fixed lid fans, so source eye pixels remain visible.
 *
 * The tessellation leaves the inner-lip loop open. Left open, a smiling source
 * lost its own teeth and showed the canvas through its mouth at neutral. Two
 * fixed fans close it instead:
 * - a FILL over the source's inner-lip ring, textured from the source and
 *   pinned, so the teeth a photograph really shows stay put when the jaw drops;
 * - a dark untextured CAVITY over the outer-lip ring, deeper still and moving
 *   with the lips, which is what shows once lips part beyond the source's own
 *   aperture. It is a shadow, not teeth or a tongue — a closed-mouth portrait
 *   has neither.
 */
export function buildSourceFaceMesh(
  landmarks: readonly Point3[],
  pose: FaceOrientation = { yaw: 0, pitch: 0, roll: 0 },
  aspect = 1,
): SourceFaceMeshData {
  if (landmarks.length < 468 || landmarks.some(p => !Number.isFinite(p.x + p.y + p.z))) {
    throw new Error("The selected source does not contain the fixed face topology.");
  }
  const localLandmarks = canonicalFaceLandmarks(landmarks, pose, aspect);
  const width = Math.abs(localLandmarks[454]!.x - localLandmarks[234]!.x);
  const scale = width > .001 ? .44 / width : 1;
  for (const p of localLandmarks) { p.x *= scale; p.y *= scale; p.z *= scale; }
  /*
   * The pivot: the face's own centre, not its nose tip.
   *
   * Calibration measures where the face IS by the centre of its 2D bounds, and
   * a turning head carries that centre with it. Rotating about the nose tip
   * left the nose fixed while the cheeks swung, so the rendered face slid
   * against where the camera saw it. Centred on its bounds (and at mid-depth),
   * rotation plus the measured translation reproduces what the camera saw.
   */
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < FACE_LANDMARK_VERTICES; i++) {
    const p = localLandmarks[i]!;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const [cx, cy, cz] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  for (const p of localLandmarks) { p.x -= cx; p.y -= cy; p.z -= cz; }
  const fillStart = FACE_LANDMARK_VERTICES;
  const fillCount = INNER_LIP_RING.length + 1;
  const cavityStart = fillStart + fillCount;
  const cavityCount = OUTER_LIP_RING.length + 1;
  const vertexCount = cavityStart + cavityCount;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let i = 0; i < FACE_LANDMARK_VERTICES; i++) {
    const p = localLandmarks[i]!;
    positions.set([p.x, -p.y, -p.z], i * 3);
    uvs.set([landmarks[i]!.x, landmarks[i]!.y], i * 2);
  }
  const indices = DENSE_FACE_TRIANGLES.flatMap(t => [...t]);
  const eyeTriangles: number[][] = [];
  for (const ring of [
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  ]) for (let i = 1; i < ring.length - 1; i++) eyeTriangles.push([ring[0]!, ring[i]!, ring[i + 1]!]);

  // Each mouth part copies its ring, sets it back, and fans from its centroid.
  // A centroid fan stays valid for the concave-ish ring of a smile, where a
  // corner fan would fold over itself.
  const faceWidth = .44;
  const addFan = (ring: readonly number[], start: number, depth: number) => {
    const centre = start + ring.length;
    let cx = 0, cy = 0, cz = 0, cu = 0, cv = 0;
    ring.forEach((landmark, k) => {
      const x = positions[landmark * 3]!, y = positions[landmark * 3 + 1]!;
      const z = positions[landmark * 3 + 2]! - depth * faceWidth;
      const u = uvs[landmark * 2]!, v = uvs[landmark * 2 + 1]!;
      positions.set([x, y, z], (start + k) * 3);
      uvs.set([u, v], (start + k) * 2);
      cx += x; cy += y; cz += z; cu += u; cv += v;
      indices.push(centre, start + k, start + (k + 1) % ring.length);
    });
    const n = ring.length;
    positions.set([cx / n, cy / n, cz / n], centre * 3);
    uvs.set([cu / n, cv / n], centre * 2);
  };
  const fillIndexStart = indices.length;
  addFan(INNER_LIP_RING, fillStart, MOUTH_FILL_DEPTH);
  const fillIndexCount = indices.length - fillIndexStart;
  const cavityIndexStart = indices.length;
  addFan(OUTER_LIP_RING, cavityStart, MOUTH_CAVITY_DEPTH);
  const cavityIndexCount = indices.length - cavityIndexStart;
  // Interior texture motion needs interior UVs. Subdivide only the existing
  // eye fans twice; every aperture boundary and all other geometry are kept.
  const eyePositions = Array.from(positions), eyeUvs = Array.from(uvs);
  const midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    const existing = midpoints.get(key);
    if (existing !== undefined) return existing;
    const index = eyePositions.length / 3;
    for (let d = 0; d < 3; d++) eyePositions.push((eyePositions[a * 3 + d]! + eyePositions[b * 3 + d]!) / 2);
    for (let d = 0; d < 2; d++) eyeUvs.push((eyeUvs[a * 2 + d]! + eyeUvs[b * 2 + d]!) / 2);
    midpoints.set(key, index); return index;
  };
  let triangles = eyeTriangles;
  for (let pass = 0; pass < 2; pass++) triangles = triangles.flatMap(([a, b, c]) => {
    const ab = midpoint(a!, b!), bc = midpoint(b!, c!), ca = midpoint(c!, a!);
    return [[a!, ab, ca], [ab, b!, bc], [ca, bc, c!], [ab, bc, ca]];
  });
  for (const triangle of triangles) indices.push(...triangle);
  return {
    positions: new Float32Array(eyePositions),
    uvs: new Float32Array(eyeUvs),
    indices: new Uint16Array(indices),
    localLandmarks,
    mouth: {
      fillStart, fillCount, fillIndexStart, fillIndexCount, cavityStart, cavityCount,
      cavityIndexStart, cavityIndexCount,
    },
    eyeInterior: { start: vertexCount, count: eyePositions.length / 3 - vertexCount },
  };
}
