import { describe, expect, it } from "vitest";

import { projectLiveMeshPositions, type ProjectionBinding } from "./liveMeshProjection";
import type { Point3 } from "../faceTypes";

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

describe("live source-mesh projection", () => {
  it("maps semantic face points into the tracked face bounds and retains local expression deltas", () => {
    const live: Point3[] = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    live[0] = { x: 0.3, y: 0.35, z: -0.04 };
    live[1] = { x: 0.7, y: 0.65, z: 0.04 };
    const bindings: ProjectionBinding[] = [
      { a: 0, b: 0, c: 0, wa: 1, wb: 0, wc: 0 },
      { a: 1, b: 1, c: 1, wa: 1, wb: 0, wc: 0 },
    ];
    const sourceBase = new Float32Array([0, 0, 0, 0.44, 0, 0]);
    const expression = new Float32Array([0.01, 0, 0, 0.44, 0, 0]);
    const output = expression.slice();

    expect(projectLiveMeshPositions(
      output, sourceBase, expression, bindings, live,
      { x: 0.5, y: 0.5, z: 0 }, 0.4, 0.75, identity,
    )).toBe(true);

    expect(output[0]).toBeCloseTo(-0.21);
    expect(output[1]).toBeCloseTo(0.22);
    expect(output[2]).toBeCloseTo(0.044);
    expect(output[3]).toBeCloseTo(0.22);
    expect(output[4]).toBeCloseTo(-0.22);
    expect(output[5]).toBeCloseTo(-0.044);
  });

  it("uses barycentric source-UV correspondence for interpolated vertices", () => {
    const live: Point3[] = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    live[0] = { x: 0.2, y: 0.2, z: 0 };
    live[1] = { x: 0.8, y: 0.2, z: 0 };
    live[2] = { x: 0.2, y: 0.8, z: 0 };
    const bindings: ProjectionBinding[] = [{ a: 0, b: 1, c: 2, wa: 0.5, wb: 0.25, wc: 0.25 }];
    const base = new Float32Array(3);
    const output = new Float32Array(3);

    projectLiveMeshPositions(output, base, base, bindings, live,
      { x: 0.5, y: 0.5, z: 0 }, 0.6, 1, identity);

    expect(output[0]).toBeCloseTo(-0.11);
    expect(output[1]).toBeCloseTo(0.11);
  });

  it("does not add source expression a second time to live lip vertices", () => {
    const live: Point3[] = Array.from({ length: 468 }, () => ({ x: .5, y: .5, z: 0 }));
    live[0] = { x: .4, y: .5, z: 0 };
    live[1] = { x: .6, y: .5, z: 0 };
    const bindings: ProjectionBinding[] = [
      { a: 0, b: 0, c: 0, wa: 1, wb: 0, wc: 0 },
      { a: 1, b: 1, c: 1, wa: 1, wb: 0, wc: 0 },
    ];
    const base = new Float32Array(6);
    const sourceExpression = new Float32Array([.1, 0, 0, .1, 0, 0]);
    const result = new Float32Array(6);
    projectLiveMeshPositions(result, base, sourceExpression, bindings, live,
      { x: .5, y: .5, z: 0 }, .4, 1, identity, .44, new Set([0]));
    expect(result[0]).toBeCloseTo(-.11);
    expect(result[3]).toBeCloseTo(.21);
  });
});
