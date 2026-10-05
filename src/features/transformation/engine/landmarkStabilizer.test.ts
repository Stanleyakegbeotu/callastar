import { describe, expect, it } from "vitest";
import { LandmarkStabilizer, isExpressiveLandmark } from "./landmarkStabilizer";

const frame = (x: number) => Array.from({ length: 478 }, (_, index) => ({
  x: index === 10 ? x : 0.5,
  y: index === 10 ? x : 0.5,
  z: 0,
}));

describe("LandmarkStabilizer", () => {
  it("reduces still-face jitter while preserving expressive landmarks", () => {
    const filter = new LandmarkStabilizer();
    filter.update(frame(0.5), 0);
    const next = frame(0.51);
    next[13] = { x: 0.8, y: 0.8, z: 0 };
    next[468] = { x: 0.7, y: 0.7, z: 0 };
    const filtered = filter.update(next, 33)!;
    expect(Math.abs(filtered[10]!.x - 0.5)).toBeLessThan(0.01);
    expect(filtered[13]!.x).toBeGreaterThan(0.77);
    expect(filtered[468]!.x).toBeGreaterThan(0.67);
    expect(isExpressiveLandmark(10)).toBe(false);
    expect(isExpressiveLandmark(13)).toBe(true);
  });

  it("follows rapid movement with adaptive velocity response", () => {
    const filter = new LandmarkStabilizer({ stableMinCutoffHz: 8, velocityGain: 2.5 });
    filter.update(frame(0.5), 0);
    const moved = frame(0.65);
    const filtered = filter.update(moved, 33)!;
    expect(filtered[10]!.x).toBeGreaterThan(0.56);
    expect(filtered[10]!.x).toBeLessThan(moved[10]!.x);
  });

  it("lets Motion Stability add bounded damping without freezing rapid movement", () => {
    const responsive = new LandmarkStabilizer();
    const stable = new LandmarkStabilizer();
    responsive.setStability(0);
    stable.setStability(100);
    responsive.update(frame(0.5), 0);
    stable.update(frame(0.5), 0);
    const next = frame(0.65);
    const responsivePoint = responsive.update(next, 33)![10]!;
    const stablePoint = stable.update(next, 33)![10]!;
    expect(responsivePoint.x).toBeGreaterThan(stablePoint.x);
    expect(stablePoint.x).toBeGreaterThan(0.5);
  });

  it("resets rather than carrying state across a tracking gap", () => {
    const filter = new LandmarkStabilizer();
    filter.update(frame(0.5), 0);
    expect(filter.update(null, 33)).toBeNull();
    expect(filter.update(frame(0.7), 66)![10]!.x).toBe(0.7);
  });
});
