import { describe, expect, it } from "vitest";

import { CALIBRATION_PROFILE_VERSION, type TransformationCalibrationProfile } from "./calibrationTypes";
import type { DerivedFaceGeometry, FaceTrackingResult } from "./faceTypes";
import type { PoseDerivedGeometry, PoseTrackingResult } from "./poseTypes";
import {
  NO_MOTION,
  RECOMMENDED_MOTION_ENVELOPE,
  computeRelativeMotion,
  motionOutsideEnvelope,
} from "./relativeMotion";

/**
 * Relative motion, and its SIGNS.
 *
 * This is the file that exists because of the Milestone 2 bug. A transformation
 * matrix was read with yaw's formula assigned to pitch, so a thirty-degree head
 * turn came out as a thirty-degree nod — and it looked entirely plausible until
 * a test asserted that a known rotation about one axis produced zero on the
 * others.
 *
 * The same mistake one layer up would be worse: a deformation driven by the
 * wrong axis still looks like a transformation, just of something the operator
 * did not do. So every direction below starts from a neutral, applies one
 * movement, and asserts both that the intended axis moved the right way AND
 * that the others did not move at all.
 */

const NEUTRAL_YAW = 0.04;
const NEUTRAL_PITCH = -0.02;
const NEUTRAL_ROLL = 0.01;
const NEUTRAL_SCALE = 0.1;
const NEUTRAL_CENTER = { x: 0.5, y: 0.45, z: 0 };
const NEUTRAL_SHOULDER_CENTER = { x: 0.5, y: 0.72, z: 0 };
const NEUTRAL_SHOULDER_WIDTH = 0.3;
const NEUTRAL_SHOULDER_ANGLE = 0.02;

/** A square tracking space, so the aspect correction is 1 and signs read plainly. */
function profile(overrides: Partial<TransformationCalibrationProfile> = {}): TransformationCalibrationProfile {
  return {
    version: CALIBRATION_PROFILE_VERSION,
    createdAt: 0,
    mode: "full",
    cameraFacing: "user",
    face: {
      center: NEUTRAL_CENTER,
      scale: NEUTRAL_SCALE,
      yaw: NEUTRAL_YAW,
      pitch: NEUTRAL_PITCH,
      roll: NEUTRAL_ROLL,
      neutralEyeOpenness: 0.8,
      neutralMouthOpenness: 0.05,
    },
    pose: {
      shoulderCenter: NEUTRAL_SHOULDER_CENTER,
      shoulderWidth: NEUTRAL_SHOULDER_WIDTH,
      shoulderAngle: NEUTRAL_SHOULDER_ANGLE,
      torsoCenter: null,
      torsoScale: null,
      torsoLean: null,
    },
    trackingSpace: { width: 480, height: 480, mirrorMode: "mirrored" },
    quality: {
      faceAvailable: true,
      poseAvailable: true,
      frameCount: 20,
      stabilityScore: 0.9,
      quality: "excellent",
      warnings: [],
    },
    ...overrides,
  };
}

function faceGeometry(overrides: Partial<DerivedFaceGeometry> = {}): DerivedFaceGeometry {
  return {
    center: NEUTRAL_CENTER,
    scale: NEUTRAL_SCALE,
    yaw: NEUTRAL_YAW,
    pitch: NEUTRAL_PITCH,
    roll: NEUTRAL_ROLL,
    eyeOpenness: 0.8,
    eyeOpennessLeft: 0.8,
    eyeOpennessRight: 0.8,
    mouthOpenness: 0.05,
    bounds: { minX: 0.35, minY: 0.2, maxX: 0.65, maxY: 0.7 },
    ...overrides,
  };
}

function face(
  geometry: Partial<DerivedFaceGeometry> = {},
  overrides: Partial<FaceTrackingResult> = {},
): FaceTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    confidence: 0.9,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    blendshapes: {},
    facialTransformationMatrix: null,
    derived: faceGeometry(geometry),
    ...overrides,
  };
}

function pose(geometry: Partial<PoseDerivedGeometry> = {}): PoseTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    worldLandmarks: [],
    segmentation: { available: false, width: null, height: null, representation: null },
    derived: {
      leftShoulder: { x: 0.35, y: 0.72, z: 0 },
      rightShoulder: { x: 0.65, y: 0.72, z: 0 },
      shoulderCenter: NEUTRAL_SHOULDER_CENTER,
      shoulderWidth: NEUTRAL_SHOULDER_WIDTH,
      shoulderAngle: NEUTRAL_SHOULDER_ANGLE,
      torsoCenter: null,
      torsoScale: null,
      torsoLean: null,
      trackability: "tracked",
      visibility: 0.9,
      ...geometry,
    },
  };
}

function headMotion(geometry: Partial<DerivedFaceGeometry>) {
  return computeRelativeMotion(profile(), face(geometry), pose()).head!;
}

describe("the neutral itself", () => {
  it("is zero motion, not the raw angles", () => {
    /*
     * The point of the whole milestone.
     *
     * This operator rests at 0.04 rad of yaw. Sitting perfectly still must read
     * as no movement — not as a permanent two-degree turn baked into every
     * frame the pipeline ever produces.
     */
    const motion = headMotion({});

    expect(motion.yawDelta).toBeCloseTo(0, 10);
    expect(motion.pitchDelta).toBeCloseTo(0, 10);
    expect(motion.rollDelta).toBeCloseTo(0, 10);
    expect(motion.translationX).toBeCloseTo(0, 10);
    expect(motion.translationY).toBeCloseTo(0, 10);
    expect(motion.scaleDelta).toBeCloseTo(1, 10);
  });

  it("reports upper body as neutral too", () => {
    const motion = computeRelativeMotion(profile(), face(), pose());
    expect(motion.upperBody!.shoulderAngleDelta).toBeCloseTo(0, 10);
    expect(motion.upperBody!.shoulderScaleDelta).toBeCloseTo(1, 10);
    expect(motion.upperBody!.translationX).toBeCloseTo(0, 10);
  });
});

describe("head rotation signs", () => {
  it("turning towards the subject's left is positive yaw, and nothing else", () => {
    // Positive yaw is the head turning to the SUBJECT'S left, per `faceTypes`.
    const motion = headMotion({ yaw: NEUTRAL_YAW + 0.3 });

    expect(motion.yawDelta).toBeCloseTo(0.3, 10);
    expect(motion.pitchDelta, "a turn is not a nod").toBeCloseTo(0, 10);
    expect(motion.rollDelta, "a turn is not a tilt").toBeCloseTo(0, 10);
  });

  it("turning the other way is negative yaw", () => {
    expect(headMotion({ yaw: NEUTRAL_YAW - 0.3 }).yawDelta).toBeCloseTo(-0.3, 10);
  });

  it("tilting the head back is positive pitch, and nothing else", () => {
    const motion = headMotion({ pitch: NEUTRAL_PITCH + 0.2 });

    expect(motion.pitchDelta).toBeCloseTo(0.2, 10);
    expect(motion.yawDelta, "a nod is not a turn").toBeCloseTo(0, 10);
    expect(motion.rollDelta).toBeCloseTo(0, 10);
  });

  it("nodding down is negative pitch", () => {
    expect(headMotion({ pitch: NEUTRAL_PITCH - 0.2 }).pitchDelta).toBeCloseTo(-0.2, 10);
  });

  it("tilting towards the subject's right ear is positive roll, and nothing else", () => {
    const motion = headMotion({ roll: NEUTRAL_ROLL + 0.15 });

    expect(motion.rollDelta).toBeCloseTo(0.15, 10);
    expect(motion.yawDelta).toBeCloseTo(0, 10);
    expect(motion.pitchDelta).toBeCloseTo(0, 10);
  });

  it("tilting the other way is negative roll", () => {
    expect(headMotion({ roll: NEUTRAL_ROLL - 0.15 }).rollDelta).toBeCloseTo(-0.15, 10);
  });

  it("keeps all three axes independent when they move together", () => {
    // The M2 failure would show here as one axis leaking into another.
    const motion = headMotion({
      yaw: NEUTRAL_YAW + 0.1,
      pitch: NEUTRAL_PITCH - 0.2,
      roll: NEUTRAL_ROLL + 0.3,
    });

    expect(motion.yawDelta).toBeCloseTo(0.1, 10);
    expect(motion.pitchDelta).toBeCloseTo(-0.2, 10);
    expect(motion.rollDelta).toBeCloseTo(0.3, 10);
  });
});

describe("head translation signs", () => {
  it("moving towards the right of the camera frame is positive X", () => {
    /*
     * Tracking space, not screen space.
     *
     * On a mirrored selfie preview this looks like moving LEFT, and that is
     * correct — the preview is the mirror. Applying the flip here as well would
     * cancel on one axis and not the other, which is the exact class of bug the
     * coordinate mapping was written to prevent.
     */
    const motion = headMotion({ center: { x: NEUTRAL_CENTER.x + 0.05, y: NEUTRAL_CENTER.y, z: 0 } });

    expect(motion.translationX).toBeGreaterThan(0);
    expect(motion.translationY).toBeCloseTo(0, 10);
  });

  it("moving the other way is negative X", () => {
    const motion = headMotion({ center: { x: NEUTRAL_CENTER.x - 0.05, y: NEUTRAL_CENTER.y, z: 0 } });
    expect(motion.translationX).toBeLessThan(0);
  });

  it("moving down the frame is positive Y", () => {
    // Screen coordinates, where y grows downwards — not maths convention.
    const motion = headMotion({ center: { x: NEUTRAL_CENTER.x, y: NEUTRAL_CENTER.y + 0.05, z: 0 } });

    expect(motion.translationY).toBeGreaterThan(0);
    expect(motion.translationX).toBeCloseTo(0, 10);
  });

  it("moving up the frame is negative Y", () => {
    expect(headMotion({ center: { x: NEUTRAL_CENTER.x, y: NEUTRAL_CENTER.y - 0.05, z: 0 } }).translationY).toBeLessThan(0);
  });

  it("is measured in face widths, so it survives a resolution change", () => {
    /*
     * Half a neutral face width sideways is 0.5, whatever the camera is.
     *
     * Emitting a frame fraction instead would make the same physical movement
     * produce a different number at every distance from the camera, and a
     * deformation driven by it would be inconsistent between sessions.
     */
    const motion = headMotion({
      center: { x: NEUTRAL_CENTER.x + NEUTRAL_SCALE / 2, y: NEUTRAL_CENTER.y, z: 0 },
    });
    expect(motion.translationX).toBeCloseTo(0.5, 10);
  });

  it("corrects the vertical axis for a non-square tracking frame", () => {
    /*
     * Landmarks are normalised against width and height separately, so the same
     * fraction means a different physical distance on each axis. A 9:16 portrait
     * frame is the ordinary case on a phone, and without the correction a
     * vertical movement would read as nearly twice the equivalent horizontal one.
     */
    const portrait = profile({ trackingSpace: { width: 360, height: 640, mirrorMode: "mirrored" } });
    const aspect = 360 / 640;

    const shifted = face({ center: { x: NEUTRAL_CENTER.x, y: NEUTRAL_CENTER.y + 0.05, z: 0 } });
    const motion = computeRelativeMotion(portrait, shifted, pose()).head!;

    expect(motion.translationY).toBeCloseTo(0.05 / (NEUTRAL_SCALE * aspect), 8);

    // The same fraction on each axis gives a larger vertical number, because on
    // a portrait frame it genuinely is a larger movement.
    const sideways = face({ center: { x: NEUTRAL_CENTER.x + 0.05, y: NEUTRAL_CENTER.y, z: 0 } });
    const across = computeRelativeMotion(portrait, sideways, pose()).head!;
    expect(Math.abs(motion.translationY)).toBeGreaterThan(Math.abs(across.translationX));
  });
});

describe("scale", () => {
  it("is a ratio, not a difference", () => {
    /*
     * Distance from a camera is multiplicative: a face twice as far away is half
     * as wide, wherever it started. A difference would mean "0.02 closer", which
     * is a different physical distance for every operator and cannot drive a
     * scale.
     */
    const motion = headMotion({ scale: NEUTRAL_SCALE * 1.2 });

    expect(motion.scaleDelta).toBeCloseTo(1.2, 10);
    expect(motion.scaleDelta).not.toBeCloseTo(NEUTRAL_SCALE * 0.2, 4);
  });

  it("is above one when closer and below one when further", () => {
    expect(headMotion({ scale: NEUTRAL_SCALE * 1.3 }).scaleDelta).toBeGreaterThan(1);
    expect(headMotion({ scale: NEUTRAL_SCALE * 0.7 }).scaleDelta).toBeLessThan(1);
  });

  it("is the same ratio for the same relative movement at any calibrated size", () => {
    // Someone who calibrated close and someone who calibrated far, both leaning
    // in by the same proportion, must produce the same number.
    const close = computeRelativeMotion(
      profile({ face: { ...profile().face, scale: 0.2 } }),
      face({ scale: 0.24 }),
      pose(),
    ).head!;
    const far = computeRelativeMotion(
      profile({ face: { ...profile().face, scale: 0.05 } }),
      face({ scale: 0.06 }),
      pose(),
    ).head!;

    expect(close.scaleDelta).toBeCloseTo(far.scaleDelta, 10);
    expect(close.scaleDelta).toBeCloseTo(1.2, 10);
  });

  it("refuses to divide by a degenerate neutral", () => {
    const broken = computeRelativeMotion(
      profile({ face: { ...profile().face, scale: 0 } }),
      face({ scale: 0.1 }),
      pose(),
    ).head!;

    expect(broken.scaleDelta).toBe(1);
    expect(Number.isFinite(broken.translationX)).toBe(true);
  });
});

describe("upper body signs", () => {
  it("the subject's right shoulder dropping is positive angle delta", () => {
    // Positive shoulder angle is the subject's right shoulder sitting lower,
    // per `poseGeometry`. The delta inherits that convention exactly.
    const motion = computeRelativeMotion(
      profile(),
      face(),
      pose({ shoulderAngle: NEUTRAL_SHOULDER_ANGLE + 0.1 }),
    ).upperBody!;

    expect(motion.shoulderAngleDelta).toBeCloseTo(0.1, 10);
  });

  it("the other shoulder dropping is negative", () => {
    const motion = computeRelativeMotion(
      profile(),
      face(),
      pose({ shoulderAngle: NEUTRAL_SHOULDER_ANGLE - 0.1 }),
    ).upperBody!;

    expect(motion.shoulderAngleDelta).toBeCloseTo(-0.1, 10);
  });

  it("leaning right in frame is positive X, and does not move the head", () => {
    const motion = computeRelativeMotion(
      profile(),
      face(),
      pose({ shoulderCenter: { x: NEUTRAL_SHOULDER_CENTER.x + 0.06, y: NEUTRAL_SHOULDER_CENTER.y, z: 0 } }),
    );

    expect(motion.upperBody!.translationX).toBeGreaterThan(0);
    // The head did not move, and the two are measured independently.
    expect(motion.head!.translationX).toBeCloseTo(0, 10);
  });

  it("measures shoulder translation in shoulder widths", () => {
    const motion = computeRelativeMotion(
      profile(),
      face(),
      pose({
        shoulderCenter: {
          x: NEUTRAL_SHOULDER_CENTER.x + NEUTRAL_SHOULDER_WIDTH / 2,
          y: NEUTRAL_SHOULDER_CENTER.y,
          z: 0,
        },
      }),
    ).upperBody!;

    expect(motion.translationX).toBeCloseTo(0.5, 10);
  });

  it("scales shoulders by ratio too", () => {
    const motion = computeRelativeMotion(
      profile(),
      face(),
      pose({ shoulderWidth: NEUTRAL_SHOULDER_WIDTH * 0.8 }),
    ).upperBody!;

    expect(motion.shoulderScaleDelta).toBeCloseTo(0.8, 10);
  });

  it("reports torso lean only when both sides have it", () => {
    const withoutNeutral = computeRelativeMotion(profile(), face(), pose({ torsoLean: 0.3 })).upperBody!;
    expect(withoutNeutral.torsoLeanDelta, "no neutral to be relative to").toBeNull();

    const leaning = computeRelativeMotion(
      profile({ pose: { ...profile().pose, torsoLean: 0.1 } }),
      face(),
      pose({ torsoLean: 0.3 }),
    ).upperBody!;
    expect(leaning.torsoLeanDelta).toBeCloseTo(0.2, 10);
  });
});

describe("availability", () => {
  it("has no motion without a calibration", () => {
    expect(computeRelativeMotion(null, face(), pose())).toEqual(NO_MOTION);
  });

  it("reports a lost face as absent, not as zero", () => {
    /*
     * Zero would mean "in the neutral pose", which is a claim about somebody
     * who is not in frame. A renderer reading it would snap the source to
     * centre instead of holding its last position.
     */
    const motion = computeRelativeMotion(profile(), face({}, { detected: false, derived: null }), pose());

    expect(motion.head).toBeNull();
    expect(motion.expression).toBeNull();
    expect(motion.tracked).toBe(false);
  });

  it("survives a temporary tracking loss against the same baseline", () => {
    // Looking away for two seconds must not mean recalibrating.
    const baseline = profile();
    const before = computeRelativeMotion(baseline, face({ yaw: NEUTRAL_YAW + 0.2 }), pose());
    const during = computeRelativeMotion(baseline, null, null);
    const after = computeRelativeMotion(baseline, face({ yaw: NEUTRAL_YAW + 0.2 }), pose());

    expect(during.tracked).toBe(false);
    expect(after.head!.yawDelta).toBeCloseTo(before.head!.yawDelta, 10);
  });

  it("gives head motion without shoulders for a face-only baseline", () => {
    const faceOnly = profile({
      mode: "face-only",
      pose: {
        shoulderCenter: null,
        shoulderWidth: null,
        shoulderAngle: null,
        torsoCenter: null,
        torsoScale: null,
        torsoLean: null,
      },
    });

    const motion = computeRelativeMotion(faceOnly, face({ yaw: NEUTRAL_YAW + 0.2 }), pose());
    expect(motion.head!.yawDelta).toBeCloseTo(0.2, 10);
    expect(motion.upperBody, "nothing to be relative to").toBeNull();
    expect(motion.tracked).toBe(true);
  });

  it("drops upper body when the shoulders are lost but keeps the head", () => {
    const motion = computeRelativeMotion(profile(), face({ yaw: NEUTRAL_YAW + 0.1 }), null);
    expect(motion.head!.yawDelta).toBeCloseTo(0.1, 10);
    expect(motion.upperBody).toBeNull();
  });
});

describe("expression", () => {
  it("passes blink through live rather than subtracting a resting value", () => {
    /*
     * Head pose has a meaningful neutral to subtract. A blink does not.
     *
     * Someone with naturally narrow eyes has a lower resting openness, and
     * neutralising it the way yaw is neutralised would make their ordinary face
     * read as a permanent half-blink and their actual blink read as nothing.
     */
    const blinking = face({}, { blendshapes: { eyeBlinkLeft: 0.95, eyeBlinkRight: 0.93 } });
    const expression = computeRelativeMotion(profile(), blinking, pose()).expression!;

    expect(expression.blinkLeft).toBe(0.95);
    expect(expression.blinkRight).toBe(0.93);
  });

  it("keeps mouth openness responsive and absolute", () => {
    const expression = computeRelativeMotion(profile(), face({ mouthOpenness: 0.6 }), pose()).expression!;
    expect(expression.mouthOpen).toBe(0.6);
  });

  it("offers the distance from rest without applying it", () => {
    // Available for a consumer that wants it; never the default.
    const expression = computeRelativeMotion(profile(), face({ mouthOpenness: 0.6 }), pose()).expression!;
    expect(expression.mouthOpennessFromNeutral).toBeCloseTo(0.55, 10);
    expect(expression.mouthOpen).not.toBeCloseTo(expression.mouthOpennessFromNeutral, 3);
  });

  it("falls back to derived openness when the model reports no blendshape", () => {
    const expression = computeRelativeMotion(
      profile(),
      face({ eyeOpennessLeft: 0.2, eyeOpennessRight: 0.9 }),
      pose(),
    ).expression!;

    expect(expression.blinkLeft).toBeCloseTo(0.8, 10);
    expect(expression.blinkRight).toBeCloseTo(0.1, 10);
  });

  it("reports smile as absent rather than zero when the model did not say", () => {
    const silent = computeRelativeMotion(profile(), face(), pose()).expression!;
    expect(silent.smile).toBeNull();

    const smiling = computeRelativeMotion(
      profile(),
      face({}, { blendshapes: { mouthSmileLeft: 0.6, mouthSmileRight: 0.4 } }),
      pose(),
    ).expression!;
    expect(smiling.smile).toBeCloseTo(0.5, 10);
  });
});

describe("recommended envelope", () => {
  it("says nothing about ordinary movement", () => {
    const motion = computeRelativeMotion(profile(), face({ yaw: NEUTRAL_YAW + 0.2 }), pose());
    expect(motionOutsideEnvelope(motion)).toEqual([]);
  });

  it("names each axis that went past its recommendation", () => {
    const motion = computeRelativeMotion(
      profile(),
      face({
        yaw: NEUTRAL_YAW + RECOMMENDED_MOTION_ENVELOPE.yaw + 0.1,
        scale: NEUTRAL_SCALE * 2,
      }),
      pose(),
    );

    const outside = motionOutsideEnvelope(motion);
    expect(outside).toContain("yaw");
    expect(outside).toContain("scale");
    expect(outside).not.toContain("pitch");
  });

  it("names nothing when there is no motion to judge", () => {
    expect(motionOutsideEnvelope(NO_MOTION)).toEqual([]);
  });
});
