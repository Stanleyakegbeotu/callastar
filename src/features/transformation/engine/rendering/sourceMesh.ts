import type { Point3 } from "../faceTypes";

/**
 * Fixed oval wedges subdivided at preparation time for expression deformation.
 *
 * It is a face-only radial mesh: the centre is landmark 1 (nose), surrounded
 * by stable face-oval landmarks. Subdivision creates vertices near the eyes,
 * lips and brows without changing the M7 boundary. It is fixed once per source,
 * never generated from a live frame, and does not extend into hair or ears.
 */
export const FACE_RENDER_VERTEX_INDICES = [
  1, 10, 109, 67, 103, 54, 21, 162, 127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152,
  377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338,
] as const;

/** Closed fan triangles around the nose-centre. This is source topology, never live topology. */
const FACE_BOUNDARY_COUNT = FACE_RENDER_VERTEX_INDICES.length - 1;
export const FACE_RENDER_TRIANGLES = Array.from({ length: FACE_BOUNDARY_COUNT }, (_, index) => [
  0,
  index + 1,
  ((index + 1) % FACE_BOUNDARY_COUNT) + 1,
]) as readonly (readonly [number, number, number])[];
export const FACE_MESH_SUBDIVISIONS = 16;

export interface SourceFaceMeshData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

/**
 * Positions are source-local world coordinates. z is deliberately shallow:
 * source landmark z helps the mesh take moderate yaw, but it never claims a
 * reconstructed head. For ImageBitmap sources Three leaves the decoded row
 * orientation intact (`flipY` is ignored), so v follows source y directly.
 *
 * Depth is INVERTED from MediaPipe's convention on the way in — see the comment
 * at the z assignment, which is the difference between a face and a mask.
 */
export function buildSourceFaceMesh(landmarks: readonly Point3[]): SourceFaceMeshData {
  const points = FACE_RENDER_VERTEX_INDICES.map((index) => landmarks[index]).filter((point): point is Point3 => !!point);
  if (points.length !== FACE_RENDER_VERTEX_INDICES.length) {
    throw new Error("The selected source does not contain the fixed face topology.");
  }

  const center = points[0]!;
  const n = FACE_MESH_SUBDIVISIONS;
  const verticesPerWedge = ((n + 1) * (n + 2)) / 2;
  const positions = new Float32Array(FACE_BOUNDARY_COUNT * verticesPerWedge * 3);
  const uvs = new Float32Array(FACE_BOUNDARY_COUNT * verticesPerWedge * 2);
  const indices = new Uint16Array(FACE_BOUNDARY_COUNT * n * n * 3);
  const vertexAt = (i: number, j: number) => i * (n + 1) - (i * (i - 1)) / 2 + j;
  let triangle = 0;
  for (let wedge = 0; wedge < FACE_BOUNDARY_COUNT; wedge++) {
    const a = points[wedge + 1]!;
    const b = points[((wedge + 1) % FACE_BOUNDARY_COUNT) + 1]!;
    const start = wedge * verticesPerWedge;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const v = j / n;
        const x = center.x * (1 - u - v) + a.x * u + b.x * v;
        const y = center.y * (1 - u - v) + a.y * u + b.y * v;
        const z = center.z * (1 - u - v) + a.z * u + b.z * v;
        const vertex = start + vertexAt(i, j);
        positions[vertex * 3] = x - center.x;
        positions[vertex * 3 + 1] = center.y - y;
        /*
         * NEGATED, and this matters more than it looks.
         *
         * MediaPipe landmark z is SMALLER the closer a point is to the camera,
         * so the nose tip (the centre landmark) holds the smallest value and
         * `z - center.z` is positive for every cheek, brow and jaw point around
         * it. Three.js z grows TOWARDS the viewer. Copied across unchanged, the
         * face oval ends up nearer the camera than the nose — a face inside-out
         * in depth.
         *
         * That is the hollow-mask illusion, and it does not read as a depth bug:
         * a concave face rotating one way is indistinguishable from a convex
         * face rotating the OTHER way. It is why a real device appeared to turn
         * the wrong direction even where the yaw sign was right.
         */
        positions[vertex * 3 + 2] = Math.max(-0.08, Math.min(0.08, -(z - center.z) * 0.35));
        uvs[vertex * 2] = x;
        uvs[vertex * 2 + 1] = y;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        indices[triangle++] = start + vertexAt(i, j);
        indices[triangle++] = start + vertexAt(i + 1, j);
        indices[triangle++] = start + vertexAt(i, j + 1);
        if (j < n - i - 1) {
          indices[triangle++] = start + vertexAt(i + 1, j);
          indices[triangle++] = start + vertexAt(i + 1, j + 1);
          indices[triangle++] = start + vertexAt(i, j + 1);
        }
      }
    }
  }
  return { positions, uvs, indices };
}
