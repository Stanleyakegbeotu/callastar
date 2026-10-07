import { describe, expect, it } from "vitest";
import type { Point3 } from "../faceTypes";
import { INNER_LIP_RING, OUTER_LIP_RING } from "./sourceMesh";
import {
  CanonicalMouthStabilizer, canonicalMouthRings, measureLiveMouth,
  mouthMeshIndices, mouthPointToFaceLocal,
} from "./canonicalLiveMouth";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const points = (opening = .02): Point3[] => {
  const result = Array.from({ length: 468 }, () => ({ x: .5, y: .5, z: 0 }));
  result[234] = { x: .2, y: .5, z: 0 };
  result[454] = { x: .8, y: .5, z: 0 };
  OUTER_LIP_RING.forEach((index, i) => {
    const angle = Math.PI - i * Math.PI * 2 / 20;
    result[index] = { x: .5 + .12 * Math.cos(angle), y: .55 + .035 * Math.sin(angle), z: 0 };
  });
  INNER_LIP_RING.forEach((index, i) => {
    const angle = Math.PI - i * Math.PI * 2 / 20;
    result[index] = { x: .5 + .095 * Math.cos(angle), y: .55 + opening / 2 * Math.sin(angle), z: 0 };
  });
  return result;
};
const local = (landmarks: Point3[]) => canonicalMouthRings(landmarks,
  { x: .5, y: .5, z: 0 }, .6, 1, identity)!;
const span = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);

describe("canonical live mouth", () => {
  it("measures separate outer width and inner opening", () => {
    const measurements = measureLiveMouth(points(.06))!;
    expect(measurements.width).toBeCloseTo(.24);
    expect(measurements.openingHeight).toBeCloseTo(.06);
    expect(measurements.openRatio).toBeCloseTo(.25);
    expect(measurements.openingWidth).toBeCloseTo(.19);
  });

  it("preserves live width and opening without source expression multipliers", () => {
    const raw = local(points(.06));
    const stable = new CanonicalMouthStabilizer().update(raw, 100);
    expect(span(stable.outer[0]!, stable.outer[10]!)).toBeCloseTo(span(raw.outer[0]!, raw.outer[10]!));
    expect(stable.inner[15]!.y - stable.inner[5]!.y).toBeCloseTo(raw.inner[15]!.y - raw.inner[5]!.y);
  });

  it("removes translation and face scale before filtering", () => {
    const a = points(.04), translated = points(.04).map(p => ({ x: .5 + (p.x - .5) * 1.5 + .08,
      y: .5 + (p.y - .5) * 1.5 - .04, z: p.z }));
    const first = canonicalMouthRings(a, { x: .5, y: .5, z: 0 }, .6, 1, identity)!;
    const second = canonicalMouthRings(translated, { x: .58, y: .46, z: 0 }, .9, 1, identity)!;
    expect(span(first.outer[0]!, first.outer[10]!)).toBeCloseTo(span(second.outer[0]!, second.outer[10]!));
    expect(first.inner[15]!.y - first.inner[5]!.y).toBeCloseTo(second.inner[15]!.y - second.inner[5]!.y);
    const normalized = span(first.inner[0]!, first.inner[10]!) / span(first.outer[0]!, first.outer[10]!);
    expect(normalized).toBeCloseTo(span(first.inner[0]!, first.inner[10]!) * 2 /
      (span(first.outer[0]!, first.outer[10]!) * 2));
  });

  it("uses inverse root rotation for local coordinates", () => {
    const angle = Math.PI / 6, c = Math.cos(angle), s = Math.sin(angle);
    const inverse = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const point = mouthPointToFaceLocal({ x: .5 + c * .1, y: .5 - s * .1, z: 0 },
      { x: .5, y: .5, z: 0 }, .5, 1, inverse);
    expect(point.x).toBeCloseTo(.088);
    expect(point.y).toBeCloseTo(0);
  });

  it("lets projected mouth width compress naturally at both yaw directions", () => {
    for (const degrees of [0, 10, 20, 30, 40, -10, -20, -30, -40]) {
      const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
      const inverse = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
      const left = mouthPointToFaceLocal({ x: .5 - .1 * c, y: .5, z: -.1 * s },
        { x: .5, y: .5, z: 0 }, .5, 1, inverse);
      const right = mouthPointToFaceLocal({ x: .5 + .1 * c, y: .5, z: .1 * s },
        { x: .5, y: .5, z: 0 }, .5, 1, inverse);
      const projectedWidth = Math.abs((right.x * c + right.z * s) - (left.x * c + left.z * s));
      expect(projectedWidth).toBeCloseTo(.176 * c, 4);
    }
  });

  it("reduces static jitter but follows coordinated open/close and smiles", () => {
    const filter = new CanonicalMouthStabilizer();
    const neutral = local(points(.02));
    filter.update(neutral, 100);
    const jitter = local(points(.02));
    jitter.outer[3]!.y += .004;
    const filtered = filter.update(jitter, 133);
    expect(Math.abs(filtered.outer[3]!.y - neutral.outer[3]!.y)).toBeLessThan(.004);
    const open = local(points(.09));
    const moved = filter.update(open, 166);
    const originalGap = neutral.inner[15]!.y - neutral.inner[5]!.y;
    const targetGap = open.inner[15]!.y - open.inner[5]!.y;
    expect((moved.inner[15]!.y - moved.inner[5]!.y - originalGap) / (targetGap - originalGap)).toBeGreaterThan(.55);
    const smile = local(points(.09));
    smile.outer[0]!.x -= .04;
    smile.outer[10]!.x += .04;
    expect(filter.update(smile, 199).outer[0]!.x).toBeLessThan(moved.outer[0]!.x);
  });

  it("bounds an isolated point and prevents negative opening", () => {
    const filter = new CanonicalMouthStabilizer();
    const raw = local(points(.02));
    filter.update(raw, 100);
    const spike = local(points(.02));
    spike.outer[4]!.x += .2;
    const filtered = filter.update(spike, 133);
    expect(filter.stats.rejectedPoints).toBeGreaterThan(0);
    expect(Math.abs(filtered.outer[4]!.x - raw.outer[4]!.x)).toBeLessThan(.05);
    const crossed = local(points(.02));
    crossed.inner[15]!.y = crossed.inner[5]!.y - .03;
    const safe = filter.update(crossed, 166);
    expect(safe.inner[15]!.y).toBeGreaterThanOrEqual(safe.inner[5]!.y);
  });

  it("builds connected perioral, outer, and inner rings", () => {
    expect(mouthMeshIndices()).toHaveLength(20 * 6 * 2 + 20 * 3);
    expect(Math.max(...mouthMeshIndices())).toBe(60);
  });
});
