import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_ENVELOPE,
  STABILITY_TOLERANCE,
  assessStability,
  median,
  medianAbsoluteDeviation,
  medianPoint,
} from "./calibrationStatistics";

/**
 * The statistics a baseline is built from.
 *
 * The failure this guards against is silent: a baseline pulled sideways by one
 * blink looks like an entirely ordinary set of numbers, and every frame
 * afterwards inherits the error. So the outlier cases matter more here than the
 * ordinary ones.
 */

describe("median", () => {
  it("is the middle sample for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("averages the two middle values for an even count", () => {
    // Stated explicitly so the result does not depend on a sort's tie-breaking.
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is unmoved by a single wild outlier", () => {
    /*
     * The whole reason this is not a mean.
     *
     * One frame where the model briefly lost an eye produces a scale of 0.9
     * among a dozen readings of 0.10. The mean would be dragged to 0.16; the
     * median does not move at all.
     */
    const clean = [0.1, 0.101, 0.099, 0.1, 0.102, 0.098, 0.1];
    const withOutlier = [...clean, 0.9];

    const mean = withOutlier.reduce((sum, value) => sum + value, 0) / withOutlier.length;
    expect(mean).toBeGreaterThan(0.15);
    expect(median(withOutlier)!).toBeCloseTo(median(clean)!, 2);
  });

  it("ignores non-finite samples rather than returning NaN", () => {
    expect(median([1, Number.NaN, 3])).toBe(2);
    expect(median([Number.POSITIVE_INFINITY, 4, 2])).toBe(3);
  });

  it("returns null when there is nothing usable", () => {
    expect(median([])).toBeNull();
    expect(median([Number.NaN, Number.NaN])).toBeNull();
  });

  it("is deterministic for the same multiset in any order", () => {
    const values = [0.4, 0.1, 0.9, 0.2, 0.3];
    const shuffled = [0.9, 0.3, 0.1, 0.4, 0.2];
    expect(median(values)).toBe(median(shuffled));
  });
});

describe("median absolute deviation", () => {
  it("is zero for a perfectly steady sample", () => {
    expect(medianAbsoluteDeviation([0.5, 0.5, 0.5, 0.5])).toBe(0);
  });

  it("measures spread without being dominated by one jump", () => {
    const steady = [0.5, 0.501, 0.499, 0.5, 0.502];
    const withJump = [...steady, 0.9];

    // The jump widens it slightly but does not redefine it.
    expect(medianAbsoluteDeviation(steady)!).toBeLessThan(0.002);
    expect(medianAbsoluteDeviation(withJump)!).toBeLessThan(0.01);
  });

  it("grows with genuine movement", () => {
    const moving = [0.3, 0.4, 0.5, 0.6, 0.7];
    expect(medianAbsoluteDeviation(moving)!).toBeGreaterThan(0.09);
  });

  it("returns null for an empty sample", () => {
    expect(medianAbsoluteDeviation([])).toBeNull();
  });
});

describe("median point", () => {
  it("takes each axis independently", () => {
    const point = medianPoint([
      { x: 0.1, y: 0.9, z: 0 },
      { x: 0.2, y: 0.5, z: 0 },
      { x: 0.3, y: 0.1, z: 0 },
    ]);
    expect(point).toEqual({ x: 0.2, y: 0.5, z: 0 });
  });

  it("resists one frame that jumped", () => {
    const steady = Array.from({ length: 9 }, () => ({ x: 0.5, y: 0.4, z: 0 }));
    const point = medianPoint([...steady, { x: 0.05, y: 0.95, z: 0 }]);
    expect(point!.x).toBeCloseTo(0.5, 5);
    expect(point!.y).toBeCloseTo(0.4, 5);
  });

  it("returns null for nothing", () => {
    expect(medianPoint([])).toBeNull();
  });
});

/** A steady sample around a centre, with a little jitter. */
function steady(centre: number, jitter: number, count = 10): number[] {
  return Array.from({ length: count }, (_unused, index) => centre + (index % 2 === 0 ? jitter : -jitter));
}

describe("stability", () => {
  it("accepts ordinary jitter", () => {
    // Half the tolerance on every axis: breathing, not moving.
    const result = assessStability({
      faceCenterX: steady(0.5, STABILITY_TOLERANCE.faceCenterX / 2),
      faceCenterY: steady(0.4, STABILITY_TOLERANCE.faceCenterY / 2),
      faceScale: steady(0.1, STABILITY_TOLERANCE.faceScale / 2),
      yaw: steady(0.05, STABILITY_TOLERANCE.yaw / 2),
      pitch: steady(0, STABILITY_TOLERANCE.pitch / 2),
      roll: steady(0, STABILITY_TOLERANCE.roll / 2),
    });

    expect(result.stable).toBe(true);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("rejects a window in which the operator was turning", () => {
    // Deliberate movement, not jitter: this must never be averaged.
    const result = assessStability({
      yaw: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3],
      faceCenterX: steady(0.5, 0.001),
    });

    expect(result.stable).toBe(false);
    expect(result.worstQuantity).toBe("yaw");
    expect(result.worstRatio).toBeGreaterThan(1);
  });

  it("is decided by the worst quantity, not the average of them", () => {
    /*
     * A perfectly steady head over a swaying torso is not a usable baseline for
     * upper-body motion. Averaging the ratios would let five good axes hide one
     * bad one.
     */
    const result = assessStability({
      faceCenterX: steady(0.5, 0.0001),
      faceCenterY: steady(0.4, 0.0001),
      faceScale: steady(0.1, 0.0001),
      yaw: steady(0, 0.0001),
      pitch: steady(0, 0.0001),
      roll: steady(0, 0.0001),
      shoulderAngle: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
    });

    expect(result.stable).toBe(false);
    expect(result.worstQuantity).toBe("shoulderAngle");
  });

  it("skips quantities with no samples rather than scoring them as perfect", () => {
    // A face-only calibration has no shoulder samples, and absent is not steady.
    const result = assessStability({ yaw: steady(0, 0.001), faceScale: steady(0.1, 0.0001) });

    expect(result.stable).toBe(true);
    expect(result.dispersion.shoulderWidth).toBeUndefined();
    expect(Object.keys(result.dispersion)).toEqual(["faceScale", "yaw"]);
  });

  it("reports nothing measurable as unstable, not as still", () => {
    expect(assessStability({}).stable).toBe(false);
    expect(assessStability({}).score).toBe(0);
    // One sample cannot show dispersion.
    expect(assessStability({ yaw: [0.1] }).stable).toBe(false);
  });

  it("puts the tolerance at a score of 0.5, where stable flips", () => {
    /*
     * The stated formula is `1 - worst / 2`, so a dispersion exactly at the
     * tolerance scores 0.5 and that is also where `stable` flips.
     *
     * Asserted either side of the boundary rather than on it: comparing a
     * floating-point ratio against exactly 1 turns on the sixteenth decimal,
     * and nobody's shoulders sit at precisely the tolerance.
     */
    const spread = (amount: number) => [0.5 - amount, 0.5 + amount];

    const inside = assessStability({ faceScale: spread(STABILITY_TOLERANCE.faceScale * 0.98) });
    expect(inside.stable).toBe(true);
    // ratio 0.98 -> 1 - 0.49
    expect(inside.score).toBeCloseTo(0.51, 3);

    const outside = assessStability({ faceScale: spread(STABILITY_TOLERANCE.faceScale * 1.02) });
    expect(outside.stable).toBe(false);
    // ratio 1.02 -> 1 - 0.51
    expect(outside.score).toBeCloseTo(0.49, 3);
  });

  it("bottoms out rather than going negative", () => {
    const result = assessStability({ yaw: [0, 1, 2, 3, 4] });
    expect(result.score).toBe(0);
    expect(result.stable).toBe(false);
  });
});

describe("acceptance envelope", () => {
  it("leaves room for a resting pose that is not perfectly square-on", () => {
    /*
     * A neutral pose IS slightly off-axis. An envelope tight enough to demand a
     * perfectly forward head would refuse to calibrate most people, which is a
     * worse outcome than a baseline taken at four degrees of yaw.
     */
    const fourDegrees = (4 * Math.PI) / 180;
    expect(ACCEPTANCE_ENVELOPE.maxYaw).toBeGreaterThan(fourDegrees);
    expect(ACCEPTANCE_ENVELOPE.maxPitch).toBeGreaterThan(fourDegrees);
    expect(ACCEPTANCE_ENVELOPE.maxRoll).toBeGreaterThan(fourDegrees);
  });

  it("refuses the eleven-degree pitch a phone once accepted as neutral", () => {
    const elevenDegrees = (11 * Math.PI) / 180;
    expect(ACCEPTANCE_ENVELOPE.maxPitch).toBeLessThan(elevenDegrees);
    expect(ACCEPTANCE_ENVELOPE.maxYaw).toBeLessThan(elevenDegrees);
    expect(ACCEPTANCE_ENVELOPE.maxRoll).toBeLessThan(elevenDegrees);
  });

  it("brackets a plausible face size", () => {
    expect(ACCEPTANCE_ENVELOPE.minFaceScale).toBeLessThan(ACCEPTANCE_ENVELOPE.maxFaceScale);
    expect(ACCEPTANCE_ENVELOPE.minFaceScale).toBeGreaterThan(0);
  });
});
