import { describe, expect, it } from "vitest";
import { GazeSmoother, measureBinocularGaze, normalizeBinocularGaze } from "./eyeGaze";
import type { Point3 } from "./faceTypes";

function eyeMesh(): Point3[] {
  const p = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (index: number, x: number, y: number) => { p[index] = { x, y, z: 0 }; };
  // Subject left eye: the inner corner is rightmost in a non-mirrored frame.
  set(33, 0, 0); set(133, 1, 0);
  set(159, 0.25, -0.2); set(158, 0.5, -0.22); set(157, 0.75, -0.2);
  set(145, 0.25, 0.2); set(153, 0.5, 0.22); set(154, 0.75, 0.2);
  // Subject right eye.
  set(263, 3, 0); set(362, 2, 0);
  set(386, 2.75, -0.2); set(385, 2.5, -0.22); set(384, 2.25, -0.2);
  set(374, 2.75, 0.2); set(380, 2.5, 0.22); set(381, 2.25, 0.2);
  set(468, 0.5, 0); set(473, 2.5, 0);
  return p;
}

describe("iris gaze geometry", () => {
  it("keeps per-eye gaze neutral at the eye-local centre", () => {
    const gaze = measureBinocularGaze(eyeMesh());
    expect(gaze).not.toBeNull();
    expect(gaze!.left.x).toBeCloseTo(0, 6);
    expect(gaze!.left.y).toBeCloseTo(0, 6);
    expect(gaze!.right.x).toBeCloseTo(0, 6);
    expect(gaze!.right.y).toBeCloseTo(0, 6);
  });

  it("keeps the eyes independent and rejects missing iris landmarks", () => {
    const points = eyeMesh();
    points[468] = { x: 0.65, y: 0, z: 0 };
    const gaze = measureBinocularGaze(points);
    // The left eye's inner-to-outer basis points toward the image's left.
    expect(gaze!.left.x).toBeLessThan(0);
    expect(gaze!.right.x).toBeCloseTo(0, 6);
    expect(measureBinocularGaze(points.slice(0, 468))).toBeNull();
  });

  it("normalizes each eye against its own neutral and reports travel clamps", () => {
    const gaze = normalizeBinocularGaze(
      { left: { x: 0.2, y: -0.4 }, right: { x: -0.2, y: 0.4 }, quality: { left: 1, right: 1 } },
      { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
    );
    expect(gaze.left.x).toBe(1);
    expect(gaze.left.y).toBe(-1);
    expect(gaze.right.x).toBe(-1);
    expect(gaze.right.y).toBe(1);
    expect(gaze.clamped).toBe(true);
  });

  it("holds gaze through a blink, then relaxes lost tracking independently per eye", () => {
    const smoother = new GazeSmoother();
    const gaze = { left: { x: 0.8, y: -0.4 }, right: { x: -0.4, y: 0.2 }, clamped: false };
    const quality = { left: 1, right: 1 };
    const first = smoother.update(gaze, quality, 0);
    expect(first.left.x).toBeGreaterThan(0);
    const closed = smoother.update(null, { left: 0, right: 0 }, 33, { left: true, right: true });
    expect(closed.left.x).toBeCloseTo(first.left.x, 6);
    const missing = smoother.update(null, { left: 0, right: 0 }, 450);
    expect(Math.abs(missing.left.x)).toBeLessThan(Math.abs(closed.left.x));
    expect(Math.abs(missing.right.x)).toBeLessThan(Math.abs(closed.right.x));
  });
  it('a low-confidence apparent blink cannot freeze old gaze indefinitely', () => {
    const smoother = new GazeSmoother();
    const gaze = { left: { x: .8, y: .4 }, right: { x: .4, y: .2 }, clamped: false };
    const initial = smoother.update(gaze,{left:1,right:1},0);
    let out = initial;
    for(let t=100;t<=1000;t+=100) out=smoother.update(null,{left:0,right:0},t,{left:true,right:true},{left:false,right:false});
    expect(Math.abs(out.left.x)).toBeLessThan(.01);
    expect(Math.abs(out.right.x)).toBeLessThan(.01);
  });
});
