import { describe, expect, it } from "vitest";
import { computeExpressionMotion } from "./expressionMotion";
import { jawDisplacement, mouthCornerLift, mouthOpenness } from "./faceGeometry";
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

describe("blendshape drift under head pose (M8.3, measured through the real tracker)", () => {
  // Someone who smiles at rest: their calibrated smile blendshape is near 1.
  const smiler = {
    face: {
      yaw: 0, pitch: 0, roll: 0, neutralEyeOpenness: .7, neutralMouthOpenness: .04,
      expressionNeutral: { blinkLeft: 0, blinkRight: 0, jawOpen: 0, smileLeft: .87, smileRight: .89, browInnerUp: .18, browOuterUpLeft: .2, browOuterUpRight: .13 },
    },
  } as TransformationCalibrationProfile;
  const at = (pitch: number, shapes: Record<string, number>): FaceTrackingResult => ({
    ...frame(0),
    derived: { ...frame(0).derived!, pitch },
    blendshapes: { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0, mouthSmileLeft: .87, mouthSmileRight: .89, browInnerUp: .18, browOuterUpLeft: .2, browOuterUpRight: .13, ...shapes },
  });

  it("does not read a 15° nod's blendshape drift as a smile or a brow raise", () => {
    // The drift MediaPipe actually showed: resting smile +0.06, a brow +0.13.
    const nodded = computeExpressionMotion(at(.26, { mouthSmileLeft: .93, mouthSmileRight: .95, browOuterUpLeft: .33 }), smiler)!;
    expect(nodded.smileLeft).toBe(0);
    expect(nodded.smileRight).toBe(0);
    expect(nodded.browOuterUpLeft).toBeLessThan(.02);
  });

  it("still reads a real expression at that pose, and keeps frontal sensitivity", () => {
    const raisedWhileNodding = computeExpressionMotion(at(.26, { browOuterUpLeft: .8 }), smiler)!;
    expect(raisedWhileNodding.browOuterUpLeft).toBeGreaterThan(.5);
    const smallFrontal = computeExpressionMotion(at(0, { browOuterUpLeft: .4 }), smiler)!;
    expect(smallFrontal.browOuterUpLeft).toBeGreaterThan(.2);
  });
});

describe("mouth and jaw signal separation", () => {
  const mouthLandmarks = (open: boolean) => {
    const p = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    p[1] = { x: 0.5, y: 0.5, z: 0 };
    p[152] = { x: 0.5, y: 0.7, z: 0 };
    p[234] = { x: 0.35, y: 0.5, z: 0 };
    p[454] = { x: 0.65, y: 0.5, z: 0 };
    p[61] = { x: 0.44, y: 0.62, z: 0 };
    p[291] = { x: 0.56, y: 0.62, z: 0 };
    for (const [upper, lower, x] of [[13, 14, 0.5], [82, 87, 0.485], [312, 317, 0.515], [81, 178, 0.47], [311, 402, 0.53]] as const) {
      p[upper] = { x, y: 0.618, z: 0 };
      p[lower] = { x, y: open ? 0.68 : 0.622, z: 0 };
    }
    return p;
  };

  it("does not read a neutral jaw opening as a smile", () => {
    const neutral = mouthLandmarks(false);
    const opened = mouthLandmarks(true);
    opened[152] = { ...opened[152]!, y: 0.74 };
    const baseline = {
      face: {
        yaw: 0, pitch: 0, roll: 0, neutralEyeOpenness: 0.5,
        neutralMouthOpenness: mouthOpenness(neutral),
        neutralJawDisplacement: jawDisplacement(neutral),
        neutralSmileLeft: mouthCornerLift(neutral, "left"),
        neutralSmileRight: mouthCornerLift(neutral, "right"),
        expressionNeutral: {
          blinkLeft: 0, blinkRight: 0, jawOpen: 0,
          smileLeft: 0.87, smileRight: 0.89, browInnerUp: 0,
          browOuterUpLeft: 0, browOuterUpRight: 0,
        },
      },
    } as TransformationCalibrationProfile;
    const result = computeExpressionMotion({
      ...frame(0), landmarks: opened,
      blendshapes: {
        jawOpen: 0.7, mouthSmileLeft: 0.96, mouthSmileRight: 0.97,
        eyeBlinkLeft: 0, eyeBlinkRight: 0,
      },
    }, baseline)!;

    expect(result.jawOpen).toBeGreaterThan(0.5);
    expect(result.smileLeft).toBeLessThan(0.15);
    expect(result.smileRight).toBeLessThan(0.15);
    expect(result.mouthAperture?.ratio).toBeGreaterThan(0.5);
    expect(result.mouthAperture?.jawDrop).toBeGreaterThan(baseline.face.neutralJawDisplacement!);
  });

  it("keeps a real corner lift when the jaw is open", () => {
    const neutral = mouthLandmarks(false);
    const opened = mouthLandmarks(true);
    opened[61] = { ...opened[61]!, y: 0.59 };
    opened[291] = { ...opened[291]!, y: 0.59 };
    const baseline = {
      face: {
        yaw: 0, pitch: 0, roll: 0, neutralEyeOpenness: 0.5,
        neutralMouthOpenness: mouthOpenness(neutral),
        neutralJawDisplacement: jawDisplacement(neutral),
        neutralSmileLeft: mouthCornerLift(neutral, "left"),
        neutralSmileRight: mouthCornerLift(neutral, "right"),
        expressionNeutral: {
          blinkLeft: 0, blinkRight: 0, jawOpen: 0,
          smileLeft: 0.87, smileRight: 0.89, browInnerUp: 0,
          browOuterUpLeft: 0, browOuterUpRight: 0,
        },
      },
    } as TransformationCalibrationProfile;
    const result = computeExpressionMotion({
      ...frame(0), landmarks: opened,
      blendshapes: { jawOpen: 0.7, mouthSmileLeft: 1, mouthSmileRight: 1, eyeBlinkLeft: 0, eyeBlinkRight: 0 },
    }, baseline)!;
    expect(result.smileLeft).toBeGreaterThan(0.25);
    expect(result.smileRight).toBeGreaterThan(0.25);
  });
});
