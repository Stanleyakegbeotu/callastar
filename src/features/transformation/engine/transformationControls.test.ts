import { describe, expect, it } from "vitest";
import { BOUNDARY_SKIN_REGIONS, estimateBoundaryCorrections } from "./rendering/boundaryHarmonization";
import {
  coverageExtensionScale,
  boundaryCorrectionLimit,
  DEFAULT_TRANSFORMATION_CONTROLS,
  featherExtensionScale,
  responseGain,
  scaleFollowRatio,
  sourceSurfaceAlpha,
  stabilityCutoff,
} from "./transformationControls";

describe("live transformation control mappings", () => {
  it("keeps current tracking response at the accepted UI defaults", () => {
    expect(responseGain(DEFAULT_TRANSFORMATION_CONTROLS.tracking.yawResponse, 70)).toBe(1);
    expect(responseGain(DEFAULT_TRANSFORMATION_CONTROLS.tracking.pitchResponse, 70)).toBe(1);
    expect(responseGain(DEFAULT_TRANSFORMATION_CONTROLS.tracking.scaleFollow, 72)).toBe(1);
  });

  it("bounds pose gains and keeps every coverage value connected to the extension", () => {
    expect(responseGain(-100, 70)).toBe(0.75);
    expect(responseGain(1000, 70)).toBe(1.25);
    expect(coverageExtensionScale(0, 100)).toBe(0);
    expect(coverageExtensionScale(100, 0)).toBe(0);
    expect(coverageExtensionScale(100, 100)).toBe(1);
  });

  it("uses a bounded feather range and stronger still-frame damping", () => {
    expect(featherExtensionScale(0)).toBe(0.35);
    expect(featherExtensionScale(100)).toBe(1.6);
    expect(stabilityCutoff(0)).toBe(16);
    expect(stabilityCutoff(100)).toBeCloseTo(4.8889, 3);
  });

  it("keeps opacity separate from source-beard strength and leaves tracking geometry alone", () => {
    expect(sourceSurfaceAlpha(0.8, 0, 1, 100, true)).toBe(0);
    expect(sourceSurfaceAlpha(0.8, 50, 1, 100, true)).toBeCloseTo(0.4);
    expect(sourceSurfaceAlpha(0.8, 100, 1, 0, true)).toBe(0);
    expect(sourceSurfaceAlpha(0.8, 100, 1, 0, false)).toBeCloseTo(0.8);
  });

  it("exposes bounded skin-match and scale-follow ranges", () => {
    expect(boundaryCorrectionLimit(0, true)).toBe(0);
    expect(boundaryCorrectionLimit(100, true)).toBe(0.12);
    expect(boundaryCorrectionLimit(100, false)).toBe(0.24);
    expect(scaleFollowRatio(1.5, 72)).toBe(1.5);
    expect(scaleFollowRatio(1.5, 0)).toBeCloseTo(1.375);
    expect(scaleFollowRatio(1.5, 100)).toBeCloseTo(1.625);
    expect(scaleFollowRatio(0.4, 100)).toBeCloseTo(0.25);
    const source = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 100, g: 100, b: 100 }));
    const live = BOUNDARY_SKIN_REGIONS.map(() => ({ r: 160, g: 160, b: 160 }));
    const lowMatch = estimateBoundaryCorrections(source, live, boundaryCorrectionLimit(0, true));
    const highMatch = estimateBoundaryCorrections(source, live, boundaryCorrectionLimit(100, true));
    expect(highMatch[0]!.r - 1).toBeGreaterThan(lowMatch[0]!.r - 1);
  });
});
