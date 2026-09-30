import { describe, expect, it } from "vitest";

import { SAMPLING, dedupeTimestamps, sampleCountFor, sampleTimestamps } from "./videoSampling";

/**
 * Which moments of a video get looked at.
 *
 * The property that matters most is the one a test can state plainly: analysis
 * cost must not grow with the length of the file. A ten-minute clip must cost
 * exactly what a twenty-second one costs, because otherwise somebody waits a
 * minute and a half to learn what a dozen frames would have told them.
 */

describe("sample count", () => {
  it("is bounded however long the video is", () => {
    for (const duration of [30, 120, 600, 3600, 86_400]) {
      expect(sampleCountFor(duration), `${duration}s`).toBeLessThanOrEqual(SAMPLING.maxSamples);
    }
  });

  it("does not grow between a short video and a very long one", () => {
    // The whole policy, in one assertion.
    expect(sampleCountFor(3600)).toBe(sampleCountFor(60));
  });

  it("still takes enough samples from a short clip to build a bank", () => {
    expect(sampleCountFor(2)).toBe(SAMPLING.minSamples);
    expect(sampleCountFor(0.5)).toBe(SAMPLING.minSamples);
  });

  it("scales in the middle band", () => {
    // 15s at one sample per 1.5s is ten — between the bounds, so it is used.
    expect(sampleCountFor(15)).toBe(10);
    expect(sampleCountFor(18)).toBe(12);
  });

  it("returns nothing for a duration it cannot use", () => {
    expect(sampleCountFor(0)).toBe(0);
    expect(sampleCountFor(-5)).toBe(0);
    expect(sampleCountFor(Number.NaN)).toBe(0);
    expect(sampleCountFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("timestamps", () => {
  it("stays inside the file", () => {
    const duration = 12;
    for (const timestamp of sampleTimestamps(duration)) {
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThan(duration);
    }
  });

  it("skips the very start and the very end", () => {
    /*
     * The first and last moments catch somebody reaching for the camera,
     * mid-blink, or already walking away. They are also where a seek is most
     * likely to land past the last decodable frame.
     */
    const duration = 20;
    const timestamps = sampleTimestamps(duration);
    const trim = Math.min(duration * SAMPLING.edgeTrimFraction, SAMPLING.maxEdgeTrimSeconds);

    expect(timestamps[0]!).toBeGreaterThanOrEqual(trim);
    expect(timestamps[timestamps.length - 1]!).toBeLessThanOrEqual(duration - trim);
  });

  it("spreads samples evenly", () => {
    const timestamps = sampleTimestamps(30);
    const gaps = timestamps.slice(1).map((value, index) => value - timestamps[index]!);
    const first = gaps[0]!;

    for (const gap of gaps) expect(gap).toBeCloseTo(first, 2);
  });

  it("is deterministic, so a failing analysis can be reproduced", () => {
    expect(sampleTimestamps(17.5)).toEqual(sampleTimestamps(17.5));
  });

  it("never returns the same moment twice", () => {
    // A very short clip can otherwise round eight samples onto three moments,
    // spending most of the budget re-analysing one frame.
    for (const duration of [0.3, 0.8, 1, 2, 5]) {
      const timestamps = sampleTimestamps(duration);
      expect(new Set(timestamps).size, `${duration}s`).toBe(timestamps.length);
    }
  });

  it("handles a clip too short to trim", () => {
    const timestamps = sampleTimestamps(0.2);
    expect(timestamps.length).toBeGreaterThan(0);
    for (const timestamp of timestamps) {
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThan(0.2);
    }
  });

  it("returns nothing for an unusable duration", () => {
    expect(sampleTimestamps(0)).toEqual([]);
    expect(sampleTimestamps(Number.NaN)).toEqual([]);
  });

  it("caps the work for a long video", () => {
    expect(sampleTimestamps(7200).length).toBeLessThanOrEqual(SAMPLING.maxSamples);
  });
});

describe("dedupe", () => {
  it("drops samples too close together to be different moments", () => {
    const kept = dedupeTimestamps([1, 1.01, 1.02, 2, 2.05, 3]);
    expect(kept).toEqual([1, 2, 3]);
  });

  it("sorts, so an out-of-order list still spaces correctly", () => {
    expect(dedupeTimestamps([3, 1, 2])).toEqual([1, 2, 3]);
  });

  it("discards values that are not usable timestamps", () => {
    expect(dedupeTimestamps([Number.NaN, -1, 2])).toEqual([2]);
  });

  it("keeps samples exactly at the spacing limit apart", () => {
    const spaced = [0, SAMPLING.minSpacingSeconds, SAMPLING.minSpacingSeconds * 2];
    expect(dedupeTimestamps(spaced)).toHaveLength(3);
  });
});
