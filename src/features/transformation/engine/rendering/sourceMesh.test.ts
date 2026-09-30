import { describe, expect, it } from "vitest";

import { FACE_RENDER_VERTEX_INDICES, FACE_MESH_SUBDIVISIONS, buildSourceFaceMesh } from "./sourceMesh";

describe("source face mesh", () => {
  it("keeps source UVs fixed and preserves ImageBitmap row orientation", () => {
    const landmarks = Array.from({ length: 478 }, (_, index) => ({ x: index / 500, y: 0.25, z: 0 }));
    const mesh = buildSourceFaceMesh(landmarks);
    const wedges = FACE_RENDER_VERTEX_INDICES.length - 1;
    expect(mesh.positions).toHaveLength(wedges * ((FACE_MESH_SUBDIVISIONS + 1) * (FACE_MESH_SUBDIVISIONS + 2) / 2) * 3);
    expect(mesh.uvs[1]).toBeCloseTo(0.25);
    expect(mesh.indices.length).toBe(wedges * FACE_MESH_SUBDIVISIONS ** 2 * 3);
    // The last wedge closes against the first boundary point.
    expect(mesh.uvs.length).toBe(mesh.positions.length / 3 * 2);
  });
});
