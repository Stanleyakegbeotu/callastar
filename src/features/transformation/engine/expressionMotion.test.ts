import { describe, expect, it } from "vitest";
import { computeExpressionMotion } from "./expressionMotion";
import type { FaceTrackingResult } from "./faceTypes";
import type { TransformationCalibrationProfile } from "./calibrationTypes";

const calibration = {
  face: {
    neutralEyeOpenness: .7,
    neutralMouthOpenness: .04,
    expressionNeutral: {
      blinkLeft: .08, blinkRight: .06, jawOpen: .04,
      smileLeft: .12, smileRight: .1, browInnerUp: .04,
      browOuterUpLeft: .03, browOuterUpRight: .03,
    },
  },
} as TransformationCalibrationProfile;

function frame(yaw: number): FaceTrackingResult {
  return {
    detected: true, status: "tracked", timestampMs: 100, confidence: 1,
    landmarks: [], facialTransformationMatrix: null,
    derived: { eyeOpenness: .5, eyeOpennessLeft: .4, eyeOpennessRight: .6, mouthOpenness: .3,
      yaw, pitch: 0, roll: 0, scale: .1, center: { x: .5, y: .5, z: 0 },
      bounds: { minX: .2, maxX: .8, minY: .2, maxY: .8 } },
    blendshapes: {
      eyeBlinkLeft: .9, eyeBlinkRight: .1, jawOpen: .7,
      mouthSmileLeft: .6, mouthSmileRight: .2,
      browInnerUp: .55, browOuterUpLeft: .4, browOuterUpRight: .1,
    },
  };
}

describe("expression motion contract", () => {
  it("subtracts neutral scores and preserves left/right asymmetry", () => {
    const result = computeExpressionMotion(frame(0), calibration)!;
    expect(result.status).toBe("tracked");
    expect(result.blinkLeft).toBeGreaterThan(result.blinkRight);
    expect(result.smileLeft).toBeGreaterThan(result.smileRight);
    expect(result.browOuterUpLeft).toBeGreaterThan(result.browOuterUpRight);
    expect(result.jawOpen).toBeGreaterThan(.5);
  });

  it("does not turn yaw into an expression or retain lost tracking", () => {
    const neutralPose = computeExpressionMotion(frame(0), calibration)!;
    for (const yaw of [-Math.PI / 12, Math.PI / 12]) {
      const angled = computeExpressionMotion(frame(yaw), calibration)!;
      for (const key of ["blinkLeft", "blinkRight", "jawOpen", "smileLeft", "smileRight", "browInnerUp"] as const) {
        expect(angled[key]).toBe(neutralPose[key]);
      }
    }
    expect(computeExpressionMotion(null, calibration)).toBeNull();
  });
});
