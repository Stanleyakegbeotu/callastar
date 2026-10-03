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
  /** Per-vertex coverage; the outer face contour fades into the live frame. */
  boundaryAlpha: Float32Array;
  indices: Uint16Array;
  localLandmarks?: readonly Point3[];
  mouth?: SourceMouthParts;
  /** Eye-only interior vertices; no outer-face layers or new head geometry. */
  eyeInterior?: { start: number; count: number };
  /** Ordered open-edge components, classified from the projected face geometry. */
  boundaryLoops: FaceBoundaryLoop[];
}

export interface FaceBoundaryLoop {
  id: number;
  kind: "outer" | "left-eye" | "right-eye" | "mouth" | "internal";
  vertices: number[];
  centroid: { x: number; y: number };
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Projected area and perimeter in canonical face-width units. */
  area: number;
  perimeter: number;
}

/**
 * Build a static coverage ramp from the face mesh's own triangulation.
 * Boundary vertices have zero source coverage; successive topological rings
 * fade in over four edges. The returned weights are stored with the vertices,
 * so expression deformation and the renderer's pose transform carry the mask
 * with the exact geometry that draws the source pixels.
 */
export const LEFT_EYE_BOUNDARY = [7, 33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163, 173, 246] as const;
export const RIGHT_EYE_BOUNDARY = [249, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390, 398, 466] as const;

function sameVertices(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every(vertex => b.includes(vertex));
}

function polygonContains(loop: readonly number[], landmarks: readonly Point3[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = landmarks[loop[i]!]!, b = landmarks[loop[j]!]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function faceBoundaryCoverage(localLandmarks: readonly Point3[]): { alpha: Float32Array; loops: FaceBoundaryLoop[] } {
  const neighbors = Array.from({ length: FACE_LANDMARK_VERTICES }, () => new Set<number>());
  const edgeUse = new Map<string, { a: number; b: number; count: number }>();
  for (const [a, b, c] of DENSE_FACE_TRIANGLES) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      neighbors[u]!.add(v);
      neighbors[v]!.add(u);
      const lo = Math.min(u, v), hi = Math.max(u, v), key = `${lo}:${hi}`;
      const edge = edgeUse.get(key);
      if (edge) edge.count++;
      else edgeUse.set(key, { a: lo, b: hi, count: 1 });
    }
  }

  const boundaryNeighbors = Array.from({ length: FACE_LANDMARK_VERTICES }, () => new Set<number>());
  for (const { a, b, count } of edgeUse.values()) if (count === 1) {
    boundaryNeighbors[a]!.add(b);
    boundaryNeighbors[b]!.add(a);
  }
  const seen = new Set<number>();
  const loops: FaceBoundaryLoop[] = [];
  for (let seed = 0; seed < FACE_LANDMARK_VERTICES; seed++) {
    if (seen.has(seed) || !boundaryNeighbors[seed]!.size) continue;
    const component: number[] = [];
    const pending = [seed]; seen.add(seed);
    while (pending.length) {
      const vertex = pending.pop()!; component.push(vertex);
      for (const next of boundaryNeighbors[vertex]!) if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
    const ordered: number[] = [];
    let previous = -1, current = component[0]!;
    for (let count = 0; count < component.length; count++) {
      ordered.push(current);
      const next = [...boundaryNeighbors[current]!].find(candidate => candidate !== previous && (candidate !== ordered[0] || count === component.length - 1));
      if (next === undefined || (next === ordered[0] && count < component.length - 1)) break;
      previous = current; current = next;
    }
    const points = ordered.map(index => localLandmarks[index]!);
    let twiceArea = 0, cx = 0, cy = 0, perimeter = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      const cross = a.x * b.y - b.x * a.y;
      twiceArea += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
    }
    const area = Math.abs(twiceArea) / 2;
    const centroid = Math.abs(twiceArea) > 1e-10 ? { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) } : {
      x: points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length),
      y: points.reduce((sum, p) => sum + p.y, 0) / Math.max(1, points.length),
    };
    loops.push({ id: loops.length, kind: "internal", vertices: ordered, centroid,
      bounds: { minX, maxX, minY, maxY }, area, perimeter });
  }

  // The outer component is identified by projected enclosure of every other
  // loop and maximal projected area; vertex count alone cannot distinguish it.
  const outerCandidates = loops.filter(candidate => loops.every(other => other === candidate ||
    polygonContains(candidate.vertices, localLandmarks, other.centroid.x, other.centroid.y)));
  const external = outerCandidates.sort((a, b) => b.area - a.area)[0] ??
    // Degenerate source projections (including topology-only test fixtures)
    // have no usable polygon enclosure. The established named oval is the
    // canonical fallback and is checked against geometry whenever available.
    loops.find(loop => sameVertices(loop.vertices, FACE_RENDER_VERTEX_INDICES.slice(1)));
  if (!external) throw new Error("The face topology has no external boundary loop.");
  external.kind = "outer";
  for (const loop of loops) {
    if (loop === external) continue;
    if (sameVertices(loop.vertices, INNER_LIP_RING)) loop.kind = "mouth";
    else if (sameVertices(loop.vertices, LEFT_EYE_BOUNDARY)) loop.kind = "left-eye";
    else if (sameVertices(loop.vertices, RIGHT_EYE_BOUNDARY)) loop.kind = "right-eye";
  }

  const distance = new Int16Array(FACE_LANDMARK_VERTICES).fill(-1);
  const queue: number[] = [];
  for (const vertex of external.vertices) {
    distance[vertex] = 0;
    queue.push(vertex);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const vertex = queue[cursor]!;
    for (const neighbor of neighbors[vertex]!) {
      if (distance[neighbor] !== -1) continue;
      distance[neighbor] = distance[vertex]! + 1;
      queue.push(neighbor);
    }
  }

  const ramp = [0, 0.2, 0.48, 0.76, 1] as const;
  return { alpha: Float32Array.from(distance, d => ramp[Math.min(ramp.length - 1, Math.max(0, d))]!), loops };
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
  const { alpha: faceCoverage, loops: rawBoundaryLoops } = faceBoundaryCoverage(localLandmarks);
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
  const boundaryLoops = rawBoundaryLoops.map(loop => ({
    ...loop,
    centroid: { x: (loop.centroid.x - cx) * scale, y: (loop.centroid.y - cy) * scale },
    bounds: { minX: (loop.bounds.minX - cx) * scale, maxX: (loop.bounds.maxX - cx) * scale,
      minY: (loop.bounds.minY - cy) * scale, maxY: (loop.bounds.maxY - cy) * scale },
    area: loop.area * scale * scale,
    perimeter: loop.perimeter * scale,
  }));
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
  const eyeCoverage = Array.from({ length: vertexCount }, (_, i) => i < FACE_LANDMARK_VERTICES ? faceCoverage[i]! : 1);
  const midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    const existing = midpoints.get(key);
    if (existing !== undefined) return existing;
    const index = eyePositions.length / 3;
    for (let d = 0; d < 3; d++) eyePositions.push((eyePositions[a * 3 + d]! + eyePositions[b * 3 + d]!) / 2);
    for (let d = 0; d < 2; d++) eyeUvs.push((eyeUvs[a * 2 + d]! + eyeUvs[b * 2 + d]!) / 2);
    eyeCoverage.push((eyeCoverage[a]! + eyeCoverage[b]!) / 2);
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
    boundaryAlpha: new Float32Array(eyeCoverage),
    indices: new Uint16Array(indices),
    localLandmarks,
    mouth: {
      fillStart, fillCount, fillIndexStart, fillIndexCount, cavityStart, cavityCount,
      cavityIndexStart, cavityIndexCount,
    },
    eyeInterior: { start: vertexCount, count: eyePositions.length / 3 - vertexCount },
    boundaryLoops,
  };
}
