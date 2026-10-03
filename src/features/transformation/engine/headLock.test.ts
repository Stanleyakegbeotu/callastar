import { describe, expect, it } from "vitest";
import type { Point3 } from "./faceTypes";
import { HeadMotionStabilizer, STABLE_HEAD_ANCHOR_IDS, fitStableHeadAnchors, stableHeadAnchors } from "./headLock";
import type { HeadMotion } from "./relativeMotion";
import { faceWorldTransform } from "./rendering/faceFraming";

function neutralAnchors(): Point3[] {
  return [
    [0.50, 0.26], [0.50, 0.30], [0.47, 0.33], [0.53, 0.33],
    [0.50, 0.38], [0.50, 0.41], [0.50, 0.44], [0.50, 0.45], [0.50, 0.47],
    [0.38, 0.42], [0.46, 0.42], [0.62, 0.42], [0.54, 0.42],
    [0.35, 0.48], [0.37, 0.50], [0.40, 0.52], [0.65, 0.48], [0.63, 0.50], [0.60, 0.52],
  ].map(([x, y]) => ({ x: x!, y: y!, z: 0 }));
}

function project(points: readonly Point3[], options: { scale?: number; roll?: number; x?: number; y?: number } = {}): Point3[] {
  const scale = options.scale ?? 1, roll = options.roll ?? 0, x = options.x ?? 0, y = options.y ?? 0;
  const c = Math.cos(roll), s = Math.sin(roll);
  return points.map(p => ({
    x: 0.5 + scale * (c * (p.x - 0.5) - s * (p.y - 0.5)) + x,
    y: 0.5 + scale * (s * (p.x - 0.5) + c * (p.y - 0.5)) + y,
    z: p.z,
  }));
}

describe("stable upper-face lock", () => {
  it("fits one similarity transform and rejects a bad anchor", () => {
    const reference = neutralAnchors();
    const current = project(reference, { scale: 1.12, roll: 0.08, x: 0.04, y: -0.02 });
    current[0] = { x: 0.95, y: 0.04, z: 0 };
    const fit = fitStableHeadAnchors(reference, current, { x: 0.5, y: 0.5, z: 0 }, 1);
    expect(fit).not.toBeNull();
    expect(fit?.scale).toBeCloseTo(1.12, 2);
    expect(fit?.roll).toBeCloseTo(0.08, 2);
    expect(fit?.center.x).toBeCloseTo(0.54, 2);
    expect(fit?.center.y).toBeCloseTo(0.48, 2);
    expect(fit?.inlierCount).toBe(STABLE_HEAD_ANCHOR_IDS.length - 1);
  });

  it("keeps live translation and scale in the reference-to-current fit", () => {
    const reference = neutralAnchors();
    const referenceCenter = { x: 0.5, y: 0.5, z: 0 };
    for (const movement of [{ x: 0.15, y: 0 }, { x: -0.15, y: 0.15 }]) {
      const current = project(reference, movement);
      const fit = fitStableHeadAnchors(reference, current, referenceCenter)!;
      expect(fit.center.x).toBeCloseTo(0.5 + movement.x, 4);
      expect(fit.center.y).toBeCloseTo(0.5 + movement.y, 4);
    }
    for (const scale of [1.5, 0.65]) {
      const fit = fitStableHeadAnchors(reference, project(reference, { scale }), referenceCenter)!;
      expect(fit.scale).toBeCloseTo(scale, 3);
      expect(fit.center.x).toBeCloseTo(referenceCenter.x, 4);
      expect(fit.center.y).toBeCloseTo(referenceCenter.y, 4);
    }
  });

  it("maps the fitted live center and scale directly to the render root", () => {
    const framing = { neutralCenter: { x: 0.5, y: 0.5 }, neutralEyeSpan: 0.2, trackingWidth: 480, trackingHeight: 640 };
    const neutral = faceWorldTransform({ x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 }, 0.2,
      { width: 390, height: 600 }, framing, { center: { x: 0.5, y: 0.5 }, scale: 1 });
    const moved = faceWorldTransform({ x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 }, 0.2,
      { width: 390, height: 600 }, framing, { center: { x: 0.65, y: 0.65 }, scale: 1 });
    const closer = faceWorldTransform({ x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 }, 0.2,
      { width: 390, height: 600 }, framing, { center: { x: 0.5, y: 0.5 }, scale: 1.5 });
    const farther = faceWorldTransform({ x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 }, 0.2,
      { width: 390, height: 600 }, framing, { center: { x: 0.5, y: 0.5 }, scale: 0.65 });
    expect(moved.x).toBeGreaterThan(neutral.x);
    expect(moved.y).toBeLessThan(neutral.y);
    expect(closer.scale / neutral.scale).toBeCloseTo(1.5, 8);
    expect(farther.scale / neutral.scale).toBeCloseTo(0.65, 8);
  });

  it("ignores jaw, lips, mouth and brow motion because they are not global anchors", () => {
    const reference = neutralAnchors();
    const cameraFrame = project(reference, { scale: 1.08, roll: -0.04, x: -0.03, y: 0.02 });
    const baseline = fitStableHeadAnchors(reference, cameraFrame, { x: 0.5, y: 0.5, z: 0 })!;
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    STABLE_HEAD_ANCHOR_IDS.forEach((id, index) => { landmarks[id] = cameraFrame[index]!; });
    for (const id of [0, 13, 14, 61, 152, 291, 300, 336]) landmarks[id] = { x: 0.99, y: 0.01, z: 1 };
    const expressive = fitStableHeadAnchors(reference, stableHeadAnchors(landmarks)!, { x: 0.5, y: 0.5, z: 0 })!;
    expect(expressive.center).toEqual(baseline.center);
    expect(expressive.scale).toBe(baseline.scale);
    expect(expressive.roll).toBe(baseline.roll);
  });

  it("filters near-rest jitter more strongly and follows deliberate movement promptly", () => {
    const stabilizer = new HeadMotionStabilizer();
    const neutral: HeadMotion = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
    stabilizer.update(neutral, 0);
    const jitter = stabilizer.update({ ...neutral, translationX: 0.003 }, 33)!;
    expect(jitter.translationX).toBeGreaterThan(0);
    expect(jitter.translationX).toBeLessThan(0.003);
    const deliberate = stabilizer.update({ ...neutral, translationX: 0.3 }, 66)!;
    expect(deliberate.translationX).toBeGreaterThan(0.22);
  });
});
