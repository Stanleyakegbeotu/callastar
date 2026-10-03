import { describe, expect, it } from "vitest";

import { NEUTRAL_EXPRESSION } from "../expressionMotion";
import { ExpressionDeformer } from "./expressionDeformer";
import { FACE_LANDMARK_VERTICES, FACE_RENDER_VERTEX_INDICES, INNER_LIP_RING, LEFT_EYE_BOUNDARY, OUTER_LIP_RING, RIGHT_EYE_BOUNDARY, buildSourceFaceMesh } from "./sourceMesh";

describe("source face mesh", () => {
  it("keeps source UVs fixed and preserves ImageBitmap row orientation", () => {
    const landmarks = Array.from({ length: 478 }, (_, index) => ({ x: index / 500, y: 0.25, z: 0 }));
    const mesh = buildSourceFaceMesh(landmarks);
    // Original face/mouth vertices plus 258 eye-only interior subdivisions.
    expect(mesh.positions).toHaveLength((468 + 21 + 21 + 258) * 3);
    expect(mesh.uvs[1]).toBeCloseTo(0.25);
    // 852 unchanged face triangles + 448 eye triangles + unchanged mouth fans.
    expect(mesh.indices.length).toBe(1340 * 3);
    expect(mesh.uvs.length).toBe(mesh.positions.length / 3 * 2);
  });

  it("fades the source face perimeter with coverage attached to the mesh vertices", () => {
    const landmarks = Array.from({ length: 478 }, (_, index) => ({ x: index / 500, y: 0.25, z: 0 }));
    const mesh = buildSourceFaceMesh(landmarks);
    const faceCoverage = mesh.boundaryAlpha.slice(0, FACE_LANDMARK_VERTICES);
    expect(mesh.boundaryAlpha).toHaveLength(mesh.positions.length / 3);
    expect(Math.min(...faceCoverage)).toBe(0);
    expect(Math.max(...faceCoverage)).toBe(1);
    expect(Array.from(mesh.boundaryAlpha).every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });

  it("enumerates the open topology loops and fades only the external face perimeter", () => {
    const landmarks = Array.from({ length: 478 }, (_, index) => ({ x: index / 500, y: 0.25, z: 0 }));
    const mesh = buildSourceFaceMesh(landmarks);
    expect(mesh.boundaryLoops).toHaveLength(4);
    const loop = (kind: string) => mesh.boundaryLoops.find(candidate => candidate.kind === kind)!;
    expect(loop("outer").vertices).toHaveLength(36);
    expect(loop("left-eye").vertices).toHaveLength(16);
    expect(loop("right-eye").vertices).toHaveLength(16);
    expect(loop("mouth").vertices).toHaveLength(20);
    expect(new Set(loop("outer").vertices)).toEqual(new Set(FACE_RENDER_VERTEX_INDICES.slice(1)));
    for (const vertex of loop("outer").vertices) expect(mesh.boundaryAlpha[vertex]).toBe(0);
    for (const vertex of [...LEFT_EYE_BOUNDARY, ...RIGHT_EYE_BOUNDARY, ...INNER_LIP_RING]) {
      expect(mesh.boundaryAlpha[vertex], `internal loop vertex ${vertex}`).toBe(1);
    }
    // Representative feature anchors and a central cheek remain fully covered.
    for (const vertex of [1, 159, 386, 205, 425, 13, 14, 61, 291]) {
      expect(mesh.boundaryAlpha[vertex], `feature vertex ${vertex}`).toBe(1);
    }
    expect(mesh.boundaryLoops.every(candidate => candidate.area >= 0 && candidate.perimeter >= 0)).toBe(true);
  });
});

/**
 * A face whose lip rings are ellipses around (0.5, 0.65), in the rings' own
 * landmark order: left corner, along the lower lip, right corner, back along
 * the upper lip. `apertureHeight` is the source's own mouth opening.
 */
function mouthFixture(apertureHeight: number) {
  const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  p[1] = { x: 0.5, y: 0.5, z: -0.09 };
  p[234] = { x: 0.28, y: 0.5, z: 0 };
  p[454] = { x: 0.72, y: 0.5, z: 0 };
  p[152] = { x: 0.5, y: 0.82, z: 0 };
  const ring = (indices: readonly number[], rx: number, ry: number) => indices.forEach((index, k) => {
    const angle = (2 * Math.PI * k) / indices.length;
    p[index] = { x: 0.5 - rx * Math.cos(angle), y: 0.65 + ry * Math.sin(angle), z: -0.03 };
  });
  ring(OUTER_LIP_RING, 0.1, 0.04);
  ring(INNER_LIP_RING, 0.08, apertureHeight);
  return p;
}

function inside(x: number, y: number, polygon: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe("source mouth aperture", () => {
  it("closes a smiling source's mouth with its own pixels, just behind the lips", () => {
    const landmarks = mouthFixture(0.015);
    const mesh = buildSourceFaceMesh(landmarks);
    const mouth = mesh.mouth!;
    expect(mouth.fillStart).toBe(FACE_LANDMARK_VERTICES);
    INNER_LIP_RING.forEach((landmark, k) => {
      const v = mouth.fillStart + k;
      expect(mesh.uvs[v * 2]).toBeCloseTo(landmarks[landmark]!.x, 6);
      expect(mesh.uvs[v * 2 + 1]).toBeCloseTo(landmarks[landmark]!.y, 6);
      expect(mesh.positions[v * 3]).toBeCloseTo(mesh.positions[landmark * 3]!, 6);
      expect(mesh.positions[v * 3 + 2]!).toBeLessThan(mesh.positions[landmark * 3 + 2]!);
    });
    // Every fill triangle is referenced, so the aperture has no uncovered wedge.
    const used = new Set(mesh.indices);
    for (let v = mouth.fillStart; v < mouth.fillStart + mouth.fillCount; v++) expect(used.has(v)).toBe(true);
  });

  for (const [label, height] of [["open-mouthed", 0.015], ["closed-mouthed", 0.0005]] as const) {
    it(`never shows the background through a ${label} source's opening jaw`, () => {
      const landmarks = mouthFixture(height);
      const mesh = buildSourceFaceMesh(landmarks);
      const mouth = mesh.mouth!;
      const deformer = new ExpressionDeformer(mesh, landmarks);
      const fill = mesh.positions.slice(mouth.fillStart * 3, (mouth.fillStart + mouth.fillCount) * 3);
      for (const jawOpen of [0.25, 0.5, 1]) {
        const out = deformer.update({ ...NEUTRAL_EXPRESSION, jawOpen });
        // The source's own teeth stay with the upper jaw instead of stretching.
        expect(Array.from(out.slice(mouth.fillStart * 3, (mouth.fillStart + mouth.fillCount) * 3))).toEqual(Array.from(fill));
        const cavity: [number, number][] = OUTER_LIP_RING.map((_, k) => {
          const v = mouth.cavityStart + k;
          return [out[v * 3]!, out[v * 3 + 1]!];
        });
        // Wherever the lips part to, the cavity is behind that opening.
        for (const landmark of INNER_LIP_RING) {
          const x = out[landmark * 3]!, y = out[landmark * 3 + 1]!;
          const cx = mesh.positions[(mouth.cavityStart + OUTER_LIP_RING.length) * 3]!;
          const cy = out[(mouth.cavityStart + OUTER_LIP_RING.length) * 3 + 1]!;
          // Nudge the lip point a hair towards the centre: a corner lying ON
          // the cavity edge is covered, and the ray test is ambiguous there.
          expect(inside(x + (cx - x) * 1e-3, y + (cy - y) * 1e-3, cavity), `${landmark} at jaw ${jawOpen}`).toBe(true);
        }
        const centre = (mouth.cavityStart + OUTER_LIP_RING.length) * 3 + 2;
        expect(out[centre]!).toBeLessThan(out[mouth.fillStart * 3 + 2]!);
      }
    });
  }
});
