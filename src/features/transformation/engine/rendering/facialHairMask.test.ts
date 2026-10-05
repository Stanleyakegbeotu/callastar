import { describe, expect, it } from "vitest";
import type { Point3 } from "../faceTypes";
import { estimateFacialHairMask } from "./facialHairMask";

function face(): Point3[] {
  const points = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[234] = { x: 0.2, y: 0.5, z: 0 };
  points[454] = { x: 0.8, y: 0.5, z: 0 };
  points[13] = { x: 0.5, y: 0.6, z: 0 };
  points[152] = { x: 0.5, y: 0.86, z: 0 };
  points[123] = { x: 0.33, y: 0.57, z: 0 };
  points[352] = { x: 0.67, y: 0.57, z: 0 };
  points[205] = { x: 0.28, y: 0.6, z: 0 };
  points[425] = { x: 0.72, y: 0.6, z: 0 };
  return points;
}

function pixels(beard: boolean): Uint8ClampedArray {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const at = (y * 100 + x) * 4;
    const hair = beard && y >= 61 && x >= 27 && x <= 73;
    data[at] = data[at + 1] = data[at + 2] = hair ? 45 : 180;
    data[at + 3] = 255;
  }
  return data;
}

describe("source facial-hair appearance mask", () => {
  it("marks a dark source beard for independent appearance strength", () => {
    const estimate = estimateFacialHairMask(pixels(true), 100, 100, face());
    expect(estimate.present).toBe(true);
    expect(estimate.confidence).toBeGreaterThan(0.22);
    expect(Math.max(...estimate.weights)).toBeGreaterThan(0.7);
  });

  it("does not invent facial hair on a uniform clean-shaven source", () => {
    const estimate = estimateFacialHairMask(pixels(false), 100, 100, face());
    expect(estimate.present).toBe(false);
    expect(estimate.confidence).toBe(0);
    expect(Math.max(...estimate.weights)).toBe(0);
  });
});
