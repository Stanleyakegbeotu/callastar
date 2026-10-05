import { describe, expect, it } from "vitest";
import {
  applyBoundaryCorrections,
  BOUNDARY_SKIN_REGIONS,
  estimateBoundaryCorrections,
  sampleImageRegion,
  smoothBoundaryCorrections,
} from "./boundaryHarmonization";

describe("boundary skin harmonization", () => {
  it("measures bounded regional low-frequency correction", () => {
    const source = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 100, g: 100, b: 100 }));
    const live = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 150, g: 70, b: 105 }));
    const corrections = estimateBoundaryCorrections(source, live);
    expect(corrections[0]!.r).toBeLessThanOrEqual(1.12);
    expect(corrections[0]!.g).toBeGreaterThanOrEqual(0.88);
    expect(corrections[0]!.b).toBeGreaterThan(1.08);
    expect(corrections[0]!.b).toBeLessThan(1.12);
    expect(corrections[2]).toEqual(corrections[0]);
  });

  it("adapts the transition edge while leaving source center and alpha intact", () => {
    const base = new Float32Array([0.5, 0.4, 0.3, 1, 0.5, 0.4, 0.3, 0]);
    const output = new Float32Array(base.length);
    applyBoundaryCorrections(output, base, new Float32Array([1, 0]), new Float32Array([0, 0, 0, 0, 0, 0]),
      [{ x: 0, y: 0 }], [{ r: 1.1, g: 0.9, b: 1.05 }]);
    expect(Array.from(output.slice(0, 4))).toEqual(Array.from(base.slice(0, 4)));
    expect(output[4]).toBeCloseTo(0.55);
    expect(output[5]).toBeCloseTo(0.36);
    expect(output[6]).toBeCloseTo(0.315);
    expect(output[7]).toBe(0);
  });

  it("smooths appearance updates and samples robust local colors", () => {
    const identity = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 1, g: 1, b: 1 }));
    const target = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 1.12, g: 0.88, b: 1 }));
    const smooth = smoothBoundaryCorrections(identity, target, 100);
    expect(smooth[0]!.r).toBeGreaterThan(1);
    expect(smooth[0]!.r).toBeLessThan(1.12);
    expect(sampleImageRegion(new Uint8ClampedArray([
      20, 40, 60, 255, 21, 41, 61, 255,
      19, 39, 59, 255, 200, 200, 200, 255,
    ]), 2, 2, { x: 0, y: 0 }, 1)).toEqual({ r: 20.5, g: 40.5, b: 60.5 });
  });
});
