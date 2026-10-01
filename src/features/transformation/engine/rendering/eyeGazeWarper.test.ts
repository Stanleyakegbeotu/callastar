import { describe, expect, it } from "vitest";
import { EyeGazeWarper } from "./eyeGazeWarper";
import type { Point3 } from "../faceTypes";

function sourceLandmarks(): Point3[] {
  const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i: number, x: number, y: number) => { p[i] = { x, y, z: 0 }; };
  set(133, 0.4, 0.45); set(33, 0.3, 0.45);
  set(159, 0.325, 0.44); set(158, 0.35, 0.44); set(157, 0.375, 0.44);
  set(145, 0.325, 0.46); set(153, 0.35, 0.46); set(154, 0.375, 0.46);
  set(468, 0.35, 0.45); set(469, 0.35, 0.445); set(470, 0.355, 0.45); set(471, 0.35, 0.455); set(472, 0.345, 0.45);
  set(362, 0.6, 0.45); set(263, 0.7, 0.45);
  set(386, 0.625, 0.44); set(385, 0.65, 0.44); set(384, 0.675, 0.44);
  set(374, 0.625, 0.46); set(380, 0.65, 0.46); set(381, 0.675, 0.46);
  set(473, 0.65, 0.45); set(474, 0.65, 0.445); set(475, 0.655, 0.45); set(476, 0.65, 0.455); set(477, 0.645, 0.45);
  return p;
}

describe("source eye gaze warping", () => {
  it("moves source eye pixels in the gaze direction while preserving other UVs", () => {
    const uv = new Float32Array(468 * 2);
    for (let i = 0; i < 468; i++) uv.set([0.5, 0.5], i * 2);
    uv.set([0.35, 0.45], 2 * 2);
    uv.set([0.65, 0.45], 3 * 2);
    const warper = new EyeGazeWarper(uv, sourceLandmarks());
    expect(warper.available).toEqual({ left: true, right: true });
    const moved = warper.update({ left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, clamped: false });
    expect(moved[4]).toBeGreaterThan(uv[4]!);
    expect(moved[6]).toBeGreaterThan(uv[6]!);
    expect(moved[0]).toBe(uv[0]);
  });

  it("returns exactly to the source UVs when gaze is neutral or absent", () => {
    const uv = new Float32Array(468 * 2);
    for (let i = 0; i < 468; i++) uv.set([0.5, 0.5], i * 2);
    uv.set([0.35, 0.45], 2 * 2);
    const warper = new EyeGazeWarper(uv, sourceLandmarks());
    warper.update({ left: { x: 1, y: 1 }, right: { x: 1, y: 1 }, clamped: false });
    expect(Array.from(warper.update(null))).toEqual(Array.from(uv));
  });
});
