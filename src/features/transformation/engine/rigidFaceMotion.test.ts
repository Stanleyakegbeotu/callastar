import { describe, expect, it } from "vitest";

import { faceDirectionVectors, rendererMotionFromPose, visibleFaceDirection } from "./rendering/rendererMotion";
import { faceWorldTransform, type FaceRenderFraming } from "./rendering/faceFraming";
import { poseFromMotion } from "./rendering/faceRendererMath";
import type { HeadMotion } from "./relativeMotion";
import { physicalOrientation, rigidMotionFromCalibration } from "./rigidFaceMotion";

/**
 * M8.3 Phase 2: the rigid motion contract, in physical language.
 *
 * Inputs are what MediaPipe reports for the OPERATOR — looking up is NEGATIVE
 * pitch (measured by transformation-m83-roundtrip), turning to their own left
 * is positive yaw, tipping towards their right shoulder is positive roll,
 * moving towards their left is +x in the unmirrored image, up is −y.
 * Outputs are judged by where the face ends up on the Studio's mirrored
 * self-view, which is what the operator compares with themselves.
 */

const STILL: HeadMotion = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
const operator = (change: Partial<HeadMotion>): HeadMotion => ({ ...STILL, ...change });

function seenInStudio(head: HeadMotion) {
  const pose = poseFromMotion({ tracked: true, expression: null, upperBody: null, head }).applied;
  return visibleFaceDirection(rendererMotionFromPose(pose), "selfie");
}

/** Where the face lands on a 390x844 selfie canvas, in screen pixels (y down). */
function landedOnScreen(head: HeadMotion) {
  const framing: FaceRenderFraming = { neutralCenter: { x: 0.5, y: 0.45 }, neutralEyeSpan: 0.23, trackingWidth: 480, trackingHeight: 640 };
  const pose = poseFromMotion({ tracked: true, expression: null, upperBody: null, head }).applied;
  const world = faceWorldTransform(pose, 0.27, { width: 390, height: 844 }, framing);
  const pxPerWorld = 844 / 2;
  const aspect = 390 / 844;
  // The selfie scene flips x once, at the display.
  return { x: (-world.x + aspect) * pxPerWorld, y: (1 - world.y) * pxPerWorld, size: world.scale };
}

describe("rigid motion: the operator's physical movement, seen in the selfie view", () => {
  it("turn right → rendered face turns right", () => {
    expect(seenInStudio(operator({ yawDelta: -0.3 })).nose.x).toBeGreaterThan(0.2);
  });
  it("turn left → rendered face turns left", () => {
    expect(seenInStudio(operator({ yawDelta: 0.3 })).nose.x).toBeLessThan(-0.2);
  });
  it("look up → rendered face looks up", () => {
    expect(seenInStudio(operator({ pitchDelta: -0.2 })).nose.y).toBeGreaterThan(0.15);
  });
  it("look down → rendered face looks down", () => {
    expect(seenInStudio(operator({ pitchDelta: 0.2 })).nose.y).toBeLessThan(-0.15);
  });
  it("tilt right → rendered face tilts right", () => {
    expect(seenInStudio(operator({ rollDelta: 0.25 })).up.x).toBeGreaterThan(0.15);
  });
  it("tilt left → rendered face tilts left", () => {
    expect(seenInStudio(operator({ rollDelta: -0.25 })).up.x).toBeLessThan(-0.15);
  });

  const neutral = landedOnScreen(STILL);
  it("move right → renderer follows right", () => {
    // Towards the operator's right is towards image LEFT, so negative x.
    expect(landedOnScreen(operator({ translationX: -1 })).x).toBeGreaterThan(neutral.x + 20);
  });
  it("move left → renderer follows left", () => {
    expect(landedOnScreen(operator({ translationX: 1 })).x).toBeLessThan(neutral.x - 20);
  });
  it("move up → renderer follows up", () => {
    expect(landedOnScreen(operator({ translationY: -1 })).y).toBeLessThan(neutral.y - 20);
  });
  it("move down → renderer follows down", () => {
    expect(landedOnScreen(operator({ translationY: 1 })).y).toBeGreaterThan(neutral.y + 20);
  });
  it("move closer → rendered face grows", () => {
    expect(landedOnScreen(operator({ scaleDelta: 1.3 })).size).toBeCloseTo(neutral.size * 1.3, 6);
    expect(rigidMotionFromCalibration(operator({ scaleDelta: 1.3 })).translationZ).toBeGreaterThan(0);
  });
  it("move farther → rendered face shrinks", () => {
    expect(landedOnScreen(operator({ scaleDelta: 0.75 })).size).toBeCloseTo(neutral.size * 0.75, 6);
    expect(rigidMotionFromCalibration(operator({ scaleDelta: 0.75 })).translationZ).toBeLessThan(0);
  });
});

describe("axis isolation", () => {
  const axes = ["yaw", "pitch", "roll"] as const;
  const input = { yaw: "yawDelta", pitch: "pitchDelta", roll: "rollDelta" } as const;

  for (const axis of axes) {
    it(`${axis} alone changes no other angle, position or size`, () => {
      const rigid = rigidMotionFromCalibration(operator({ [input[axis]]: 0.2 }));
      for (const other of axes.filter((name) => name !== axis)) expect(rigid[other]).toBe(0);
      expect(rigid.translationX).toBe(0);
      expect(rigid.translationY).toBe(0);
      expect(rigid.scale).toBe(1);
      // And the rendered face rotates about that axis only.
      const motion = rendererMotionFromPose({ x: 0, y: 0, scale: 1, yaw: rigid.yaw, pitch: rigid.pitch, roll: rigid.roll });
      const { nose, up } = faceDirectionVectors(motion);
      if (axis === "yaw") { expect(nose.y).toBeCloseTo(0, 9); expect(up.x).toBeCloseTo(0, 9); }
      if (axis === "pitch") { expect(nose.x).toBeCloseTo(0, 9); expect(up.x).toBeCloseTo(0, 9); }
      if (axis === "roll") { expect(nose.x).toBeCloseTo(0, 9); expect(nose.y).toBeCloseTo(0, 9); }
    });
  }

  it("translation and scale move the face without rotating it", () => {
    const rigid = rigidMotionFromCalibration(operator({ translationX: 0.8, translationY: -0.5, scaleDelta: 1.4 }));
    expect([rigid.yaw, rigid.pitch, rigid.roll]).toEqual([0, 0, 0]);
  });

  it("converts MediaPipe orientation exactly once: only pitch changes sign", () => {
    expect(physicalOrientation({ yaw: 0.1, pitch: 0.2, roll: 0.3 })).toEqual({ yaw: 0.1, pitch: -0.2, roll: 0.3 });
  });
});

describe("glued framing", () => {
  const framing: FaceRenderFraming = { neutralCenter: { x: 0.5, y: 0.45 }, neutralEyeSpan: 0.23, trackingWidth: 480, trackingHeight: 640 };
  const neutralPose = { x: 0, y: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 };

  it("draws the neutral face where, and as large as, the cover-cropped camera shows it", () => {
    // 480x640 camera covering a 390x844 canvas: scaled by 844/640, cropped sideways.
    const world = faceWorldTransform(neutralPose, 0.27, { width: 390, height: 844 }, framing);
    const coverScale = 844 / 640;
    const eyeSpanPx = 0.23 * 480 * coverScale;
    expect(world.eyeSpanWorld * (844 / 2)).toBeCloseTo(eyeSpanPx, 6);
    expect(world.x).toBeCloseTo(0, 6);
    const centreYPx = 0.45 * 640 * coverScale;
    expect((1 - world.y) * (844 / 2)).toBeCloseTo(centreYPx, 6);
  });

  it("moves by one neutral eye span per unit of calibrated translation", () => {
    const at = (x: number) => faceWorldTransform({ ...neutralPose, x }, 0.27, { width: 390, height: 844 }, framing);
    expect(at(1).x - at(0).x).toBeCloseTo(at(0).eyeSpanWorld, 9);
  });

  it("keeps the face on screen rather than letting it vanish", () => {
    const world = faceWorldTransform({ ...neutralPose, x: 40, y: -40 }, 0.27, { width: 390, height: 844 }, framing);
    expect(Math.abs(world.x)).toBeLessThanOrEqual(390 / 844);
    expect(Math.abs(world.y)).toBeLessThanOrEqual(1);
  });

  it("falls back to the centred fixed size without a calibration", () => {
    const world = faceWorldTransform(neutralPose, 0.27, { width: 390, height: 844 }, null);
    expect(world.x).toBe(0);
    expect(world.y).toBe(0);
    expect(world.scale).toBeCloseTo(2, 9);
  });
});
