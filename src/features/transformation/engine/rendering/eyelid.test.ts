import { describe, expect, it } from "vitest";

import { NEUTRAL_EXPRESSION } from "../expressionMotion";
import { EYELIDS, ExpressionDeformer, LOWER_LID_RISE } from "./expressionDeformer";
import { buildSourceFaceMesh } from "./sourceMesh";

/**
 * Two almond eyes whose lids follow real curves (corner to corner), brows two
 * openings above them. Image coordinates, y down.
 */
const EYE = { width: 0.1, gap: 0.035 };
const CENTRES = { left: { x: 0.38, y: 0.42 }, right: { x: 0.62, y: 0.42 } };
const BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];

function face() {
  const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  p[234] = { x: 0.28, y: 0.5, z: 0 };
  p[454] = { x: 0.72, y: 0.5, z: 0 };
  p[1] = { x: 0.5, y: 0.5, z: -0.05 };
  for (const side of ["left", "right"] as const) {
    const c = CENTRES[side];
    const lid = (ring: readonly number[], sign: 1 | -1) => ring.forEach((index, k) => {
      const t = k / (ring.length - 1); // corner (0) to corner (1)
      const x = c.x + (t - 0.5) * EYE.width * (ring[0] === EYELIDS[side].lower[0] ? 1 : -1);
      p[index] = { x, y: c.y + sign * (EYE.gap / 2) * Math.sin(Math.PI * t), z: -0.01 };
    });
    lid(EYELIDS[side].lower, 1);
    lid(EYELIDS[side].upper, -1);
  }
  BROWS.forEach((index, k) => {
    const c = k < 5 ? CENTRES.left : CENTRES.right;
    p[index] = { x: c.x - 0.05 + (k % 5) * 0.025, y: c.y - 2.2 * EYE.gap, z: -0.01 };
  });
  return p;
}

function setup() {
  const landmarks = face();
  const mesh = buildSourceFaceMesh(landmarks);
  return { mesh, deformer: new ExpressionDeformer(mesh, landmarks) };
}

const y = (positions: Float32Array, index: number) => positions[index * 3 + 1]!;

describe("eyelid closure", () => {
  it("brings the upper lid down onto a closure line just above the lower lid", () => {
    const { mesh, deformer } = setup();
    const out = deformer.update({ ...NEUTRAL_EXPRESSION, blinkLeft: 1, blinkRight: 1 });
    for (const side of ["left", "right"] as const) {
      const upper = EYELIDS[side].upper.slice(1, -1);
      const lower = EYELIDS[side].lower.slice(1, -1);
      // Mid-lid: lids meet. (World y is up, so the lower lid has the smaller y.)
      const midUpper = upper[Math.floor(upper.length / 2)]!;
      const midLower = lower[Math.floor(lower.length / 2)]!;
      expect(Math.abs(y(out, midUpper) - y(out, midLower))).toBeLessThan(1e-3);
      // The upper lid did nearly all the travelling; the lower lid rose a little.
      const upperTravel = y(mesh.positions, midUpper) - y(out, midUpper);
      const lowerTravel = y(out, midLower) - y(mesh.positions, midLower);
      expect(upperTravel).toBeGreaterThan(lowerTravel * 4);
      // The face is already 0.44 wide, so mesh units are fixture units.
      expect(lowerTravel).toBeLessThanOrEqual(LOWER_LID_RISE * EYE.gap * 1.05);
    }
  });

  it("never crosses or folds: lid order is kept at every amount", () => {
    const { deformer } = setup();
    for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
      const out = deformer.update({ ...NEUTRAL_EXPRESSION, blinkLeft: amount });
      // Upper lid stays at or above the lower lid, point for point across the eye.
      EYELIDS.left.upper.slice(1, -1).forEach((u, k, all) => {
        const l = EYELIDS.left.lower[EYELIDS.left.lower.length - 2 - k]!;
        expect(y(out, u) - y(out, l), `pair ${u}/${l} at ${amount}`).toBeGreaterThanOrEqual(-1e-6);
      });
      // Every vertex above the eye keeps its height order relative to the lid.
      expect(y(out, BROWS[2]!)).toBeGreaterThan(y(out, EYELIDS.left.upper[4]!));
    }
  });

  it("leaves the brows and the other eye exactly where they were", () => {
    const { mesh, deformer } = setup();
    const out = deformer.update({ ...NEUTRAL_EXPRESSION, blinkLeft: 1 });
    for (const brow of BROWS) expect(y(out, brow), `brow ${brow}`).toBe(y(mesh.positions, brow));
    for (const index of [...EYELIDS.right.upper, ...EYELIDS.right.lower]) expect(y(out, index)).toBe(y(mesh.positions, index));
  });

  it("closes monotonically: a deeper blink is never more open", () => {
    const { deformer } = setup();
    let previous = Infinity;
    for (const amount of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const out = deformer.update({ ...NEUTRAL_EXPRESSION, blinkRight: amount });
      const gap = y(out, EYELIDS.right.upper[4]!) - y(out, EYELIDS.right.lower[4]!);
      expect(gap).toBeLessThanOrEqual(previous + 1e-9);
      previous = gap;
    }
    expect(previous).toBeLessThan(1e-3);
  });
});
