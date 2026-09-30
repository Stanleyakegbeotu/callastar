import { describe, expect, it } from "vitest";

import {
  FACE_RENDER_LIMITS,
  NEUTRAL_FACE_RENDER_POSE,
  poseFromMotion,
  poseFromSourceMotion,
  smoothFaceRenderPose,
} from "./faceRendererMath";

describe("face renderer motion", () => {
  it("converts tracking-down to render-up and clamps the supported envelope", () => {
    const result = poseFromMotion({
      tracked: true,
      expression: null,
      upperBody: null,
      head: { translationX: 3, translationY: 2, scaleDelta: 2, yawDelta: 2, pitchDelta: -2, rollDelta: 2 },
    });
    expect(result.requested.y).toBe(-2);
    expect(result.applied.x).toBe(FACE_RENDER_LIMITS.translationX);
    expect(result.applied.y).toBe(-FACE_RENDER_LIMITS.translationY);
    expect(result.applied.scale).toBe(FACE_RENDER_LIMITS.scaleMax);
    expect(result.clamped).toContain("yaw");
  });

  it("smooths only toward a global pose and is frame-rate independent", () => {
    const target = { ...NEUTRAL_FACE_RENDER_POSE, x: 1, yaw: 0.4 };
    const one = smoothFaceRenderPose(NEUTRAL_FACE_RENDER_POSE, target, 100);
    let ten = NEUTRAL_FACE_RENDER_POSE;
    for (let frame = 0; frame < 10; frame += 1) ten = smoothFaceRenderPose(ten, target, 10);
    expect(one.x).toBeCloseTo(ten.x, 3);
    expect(one.y).toBe(0);
  });

  it("respects the narrower coverage measured for the source face", () => {
    const result = poseFromSourceMotion(
      { tracked: true, expression: null, upperBody: null, head: {
        translationX: 0.5, translationY: 0.4, scaleDelta: 1.2, yawDelta: 0.3, pitchDelta: 0.2, rollDelta: 0.1,
      } },
      { translation: 0.2, scaleMin: 0.9, scaleMax: 1.1, yawLeft: 0.15, yawRight: 0.2,
        pitchUp: 0.1, pitchDown: 0.12, roll: 0.08, basis: "single-image" },
    );
    expect(result.applied.x).toBeCloseTo(0.2);
    expect(result.applied.scale).toBeCloseTo(1.1);
    expect(result.applied.yaw).toBeCloseTo(0.15);
    expect(result.applied.pitch).toBeCloseTo(0.1);
    expect(result.applied.roll).toBeCloseTo(0.08);
    expect(result.clamped).toEqual(["x", "y", "scale", "yaw", "pitch", "roll"]);
  });
});
