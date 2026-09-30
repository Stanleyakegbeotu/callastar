import { describe, expect, it } from "vitest";

import { NEUTRAL_EXPRESSION, type ExpressionMotion } from "../engine/expressionMotion";
import type { CalibrationMotion, HeadMotion } from "../engine/relativeMotion";
import { faceDirectionVectors, visibleFaceDirection } from "../engine/rendering/rendererMotion";

import {
  NEUTRAL_AVATAR_MOTION,
  avatarMotionFromTracking,
  easeTowardsNeutral,
  restrictToCapabilities,
  smoothAvatarMotion,
} from "./avatarMotion";
import { AvatarRigAdapter, capabilitiesFromMapping } from "./avatarRigAdapter";
import type { AvatarCapabilities } from "./avatarTypes";

/**
 * Avatar motion, in physical language.
 *
 * Named for what a person does in front of a camera, and asserted on where the
 * avatar ends up POINTING — not on whether a number survived a function. The
 * previous milestone's failures were reported from a device where every
 * implementation-level sign test was green.
 *
 * The avatar deliberately borrows `rendererMotion.ts` for its signs, so these
 * tests also pin that it has not drifted from the face renderer: both surfaces
 * must turn the same way.
 */

const STRONG = 0.3;

function head(overrides: Partial<HeadMotion> = {}): CalibrationMotion {
  return {
    head: {
      translationX: 0,
      translationY: 0,
      scaleDelta: 1,
      yawDelta: 0,
      pitchDelta: 0,
      rollDelta: 0,
      ...overrides,
    },
    expression: null,
    upperBody: null,
    tracked: true,
  };
}

function expression(overrides: Partial<Record<string, number>> = {}): ExpressionMotion {
  return { ...NEUTRAL_EXPRESSION, ...overrides, status: "tracked", calculationMs: 0 } as ExpressionMotion;
}

/** Where the avatar's nose and crown point, as the operator sees them. */
function seen(motion: CalibrationMotion) {
  const avatar = avatarMotionFromTracking({ motion, expression: null, calibrated: true });
  return visibleFaceDirection(
    {
      x: avatar.head.translationX,
      y: avatar.head.translationY,
      scale: avatar.head.scale,
      rotationX: avatar.head.pitch,
      rotationY: avatar.head.yaw,
      rotationZ: avatar.head.roll,
    },
    "selfie",
  );
}

describe("physical head movement drives the avatar", () => {
  it("turnRight → avatar turns right", () => {
    // Turning towards the operator's own right is negative yaw; on a mirrored
    // preview the avatar's nose must travel to the right of the screen.
    expect(seen(head({ yawDelta: -STRONG })).nose.x).toBeGreaterThan(0.2);
  });

  it("turnLeft → avatar turns left", () => {
    expect(seen(head({ yawDelta: STRONG })).nose.x).toBeLessThan(-0.2);
  });

  it("lookUp → avatar looks up", () => {
    expect(seen(head({ pitchDelta: STRONG })).nose.y).toBeGreaterThan(0.2);
  });

  it("lookDown → avatar looks down", () => {
    expect(seen(head({ pitchDelta: -STRONG })).nose.y).toBeLessThan(-0.2);
  });

  it("tiltRight → avatar tilts right", () => {
    expect(seen(head({ rollDelta: STRONG })).up.x).toBeGreaterThan(0.15);
  });

  it("tiltLeft → avatar tilts left", () => {
    expect(seen(head({ rollDelta: -STRONG })).up.x).toBeLessThan(-0.15);
  });

  it("moveCloser → avatar grows and comes towards the viewer", () => {
    const closer = avatarMotionFromTracking({ motion: head({ scaleDelta: 1.25 }), expression: null, calibrated: true });
    expect(closer.head.scale).toBeGreaterThan(1);
    // Depth is derived from apparent size — a single camera cannot measure it.
    expect(closer.head.translationZ).toBeGreaterThan(0);
  });

  it("moveAway → avatar shrinks and recedes", () => {
    const away = avatarMotionFromTracking({ motion: head({ scaleDelta: 0.8 }), expression: null, calibrated: true });
    expect(away.head.scale).toBeLessThan(1);
    expect(away.head.translationZ).toBeLessThan(0);
  });

  it("moveDown → avatar follows down", () => {
    // Tracking y grows down, world y grows up: flipped once, upstream.
    const down = avatarMotionFromTracking({ motion: head({ translationY: 0.3 }), expression: null, calibrated: true });
    expect(down.head.translationY).toBeLessThan(0);
    const up = avatarMotionFromTracking({ motion: head({ translationY: -0.3 }), expression: null, calibrated: true });
    expect(up.head.translationY).toBeGreaterThan(0);
  });

  it("keeps one axis to one axis", () => {
    const turned = seen(head({ yawDelta: STRONG }));
    expect(Math.abs(turned.nose.y)).toBeLessThan(0.02);
    expect(Math.abs(turned.up.x)).toBeLessThan(0.02);

    const nodded = seen(head({ pitchDelta: STRONG }));
    expect(Math.abs(nodded.nose.x)).toBeLessThan(0.02);
  });

  it("turns the same way as the face renderer, from the same source of signs", () => {
    /*
     * Both surfaces take their signs from `rendererMotion.ts`. If the avatar ever
     * grew its own copy, this is what would catch it.
     */
    const motion = head({ yawDelta: -STRONG, pitchDelta: 0.2, rollDelta: 0.1 });
    const avatar = avatarMotionFromTracking({ motion, expression: null, calibrated: true });
    const renderer = faceDirectionVectors({
      x: 0,
      y: 0,
      scale: 1,
      rotationX: avatar.head.pitch,
      rotationY: avatar.head.yaw,
      rotationZ: avatar.head.roll,
    });

    expect(renderer.nose.x).toBeCloseTo(faceDirectionVectors({
      x: 0, y: 0, scale: 1,
      rotationX: -motion.head!.pitchDelta,
      rotationY: motion.head!.yawDelta,
      rotationZ: motion.head!.rollDelta,
    }).nose.x, 10);
  });

  it("is neutral without tracking, rather than guessing", () => {
    const motion = avatarMotionFromTracking({ motion: null, expression: null, calibrated: false });
    expect(motion.head).toEqual(NEUTRAL_AVATAR_MOTION.head);
    expect(motion.tracking.faceTracked).toBe(false);
  });

  it("reports quality only when the tracker gave one", () => {
    // Never invented.
    expect(avatarMotionFromTracking({ motion: head(), expression: null, calibrated: true }).tracking.quality).toBeNull();
    expect(
      avatarMotionFromTracking({ motion: head(), expression: null, calibrated: true, quality: Number.NaN }).tracking.quality,
    ).toBeNull();
    expect(
      avatarMotionFromTracking({ motion: head(), expression: null, calibrated: true, quality: 0.8 }).tracking.quality,
    ).toBe(0.8);
  });
});

describe("physical expressions drive the avatar", () => {
  const driven = (overrides: Partial<Record<string, number>>) =>
    avatarMotionFromTracking({ motion: head(), expression: expression(overrides), calibrated: true }).face;

  it("blinkLeft → left blink rises, and the right does not", () => {
    const face = driven({ blinkLeft: 0.9 });
    expect(face.blinkLeft).toBeCloseTo(0.9, 6);
    expect(face.blinkRight).toBe(0);
  });

  it("blinkRight → right blink rises, and the left does not", () => {
    const face = driven({ blinkRight: 0.9 });
    expect(face.blinkRight).toBeCloseTo(0.9, 6);
    expect(face.blinkLeft).toBe(0);
  });

  it("openMouth → jawOpen rises", () => {
    expect(driven({ jawOpen: 0.7 }).jawOpen).toBeCloseTo(0.7, 6);
  });

  it("smile → both corners rise independently", () => {
    const face = driven({ smileLeft: 0.6, smileRight: 0.2 });
    expect(face.smileLeft).toBeGreaterThan(face.smileRight);
  });

  it("clamps to the range a morph can take", () => {
    const face = driven({ jawOpen: 4, blinkLeft: -2 });
    expect(face.jawOpen).toBe(1);
    expect(face.blinkLeft).toBe(0);
  });

  it("is neutral without an expression, rather than holding the last one", () => {
    expect(avatarMotionFromTracking({ motion: head(), expression: null, calibrated: true }).face).toEqual(
      NEUTRAL_EXPRESSION,
    );
  });
});

function capabilities(overrides: Partial<Record<string, boolean>> = {}): AvatarCapabilities {
  return {
    headPose: true,
    headTransform: true,
    jawBone: false,
    expressions: {
      blinkLeft: true,
      blinkRight: true,
      jawOpen: true,
      smileLeft: true,
      smileRight: true,
      browInnerUp: true,
      browOuterUpLeft: true,
      browOuterUpRight: true,
      ...overrides,
    },
  };
}

describe("capability honesty", () => {
  it("silences an expression the model cannot perform", () => {
    /*
     * So diagnostics can show a live blink arriving while the rig has nowhere to
     * send it. That is the difference between "your wink is not tracked" and
     * "this model has no eyelid morph", and the operator deserves to know which.
     */
    const motion = avatarMotionFromTracking({
      motion: head(),
      expression: expression({ blinkLeft: 0.9, jawOpen: 0.5 }),
      calibrated: true,
    });
    const restricted = restrictToCapabilities(motion, capabilities({ blinkLeft: false }));

    expect(restricted.face.blinkLeft).toBe(0);
    expect(restricted.face.jawOpen).toBeCloseTo(0.5, 6);
  });

  it("never withholds head motion, which needs no rig", () => {
    const motion = avatarMotionFromTracking({ motion: head({ yawDelta: 0.3 }), expression: null, calibrated: true });
    const restricted = restrictToCapabilities(motion, capabilities({ blinkLeft: false, jawOpen: false }));
    expect(restricted.head.yaw).toBeCloseTo(0.3, 6);
  });

  it("derives capabilities from the mapping, so the two cannot disagree", () => {
    const mapped = capabilitiesFromMapping(
      { blinkLeft: [{ meshName: "Face", morphName: "eyeBlinkLeft", index: 0 }] },
      { hasSkeleton: true, jawBone: false },
    );

    expect(mapped.expressions.blinkLeft).toBe(true);
    expect(mapped.expressions.blinkRight).toBe(false);
    // Any model can be rotated and moved.
    expect(mapped.headPose).toBe(true);
    expect(mapped.headTransform).toBe(true);
  });

  it("grants jawOpen to a rig with a jaw bone and no morph for it", () => {
    const mapped = capabilitiesFromMapping({}, { hasSkeleton: true, jawBone: true });
    expect(mapped.expressions.jawOpen).toBe(true);
    expect(mapped.jawBone).toBe(true);
  });
});

describe("tracking loss", () => {
  it("eases towards neutral rather than freezing", () => {
    /*
     * A frozen avatar held mid-blink reads as a crash, and the operator cannot
     * tell whether the renderer died or they stepped out of frame.
     */
    const held = avatarMotionFromTracking({
      motion: head({ yawDelta: 0.4 }),
      expression: expression({ blinkLeft: 1, jawOpen: 0.8 }),
      calibrated: true,
    });

    const halfway = easeTowardsNeutral(held, 0.5);
    expect(Math.abs(halfway.head.yaw)).toBeLessThan(Math.abs(held.head.yaw));
    expect(halfway.face.blinkLeft).toBeLessThan(held.face.blinkLeft);

    const released = easeTowardsNeutral(held, 1);
    expect(released.head.yaw).toBeCloseTo(0, 6);
    expect(released.face.blinkLeft).toBeCloseTo(0, 6);
    expect(released.head.scale).toBeCloseTo(1, 6);
  });

  it("changes nothing at the start of the hold", () => {
    const held = avatarMotionFromTracking({ motion: head({ yawDelta: 0.4 }), expression: null, calibrated: true });
    expect(easeTowardsNeutral(held, 0)).toEqual(held);
  });
});

describe("smoothing", () => {
  it("lets a blink arrive faster than a brow", () => {
    // A blink that takes 200ms to appear is not a blink.
    const target = avatarMotionFromTracking({
      motion: head(),
      expression: expression({ blinkLeft: 1, browInnerUp: 1 }),
      calibrated: true,
    });
    const frame = smoothAvatarMotion(NEUTRAL_AVATAR_MOTION, target, 16);

    expect(frame.face.blinkLeft).toBeGreaterThan(frame.face.browInnerUp);
    expect(frame.face.blinkLeft).toBeLessThan(1);
  });

  it("releases a blink more slowly than it takes it up", () => {
    // Real eyelids close faster than they open.
    const closed = { ...NEUTRAL_AVATAR_MOTION, face: { ...NEUTRAL_EXPRESSION, blinkLeft: 1 } };
    const opening = smoothAvatarMotion(closed, NEUTRAL_AVATAR_MOTION, 16);
    const closing = smoothAvatarMotion(NEUTRAL_AVATAR_MOTION, closed, 16);

    expect(closing.face.blinkLeft).toBeGreaterThan(1 - opening.face.blinkLeft);
  });

  it("keeps head motion steadier than expressions", () => {
    // Yaw jitter on a rendered head reads as a shiver.
    const target = avatarMotionFromTracking({
      motion: head({ yawDelta: 1 }),
      expression: expression({ jawOpen: 1 }),
      calibrated: true,
    });
    const frame = smoothAvatarMotion(NEUTRAL_AVATAR_MOTION, target, 16);

    expect(frame.head.yaw).toBeLessThan(frame.face.jawOpen);
  });
});

describe("the rig adapter", () => {
  const mapping = {
    blinkLeft: [{ meshName: "Face", morphName: "eyeBlinkLeft", index: 0 }],
    blinkRight: [{ meshName: "Face", morphName: "eyeBlinkRight", index: 1 }],
    jawOpen: [{ meshName: "Face", morphName: "jawOpen", index: 2 }],
  };

  function adapter(overrides: Partial<Record<string, boolean>> = {}, jawBone = false) {
    return new AvatarRigAdapter({
      mappedMorphs: mapping,
      capabilities: { ...capabilities(overrides), jawBone },
    });
  }

  function motion(face: Partial<Record<string, number>>) {
    return avatarMotionFromTracking({ motion: head(), expression: expression(face), calibrated: true });
  }

  it("writes an influence for each mapped expression", () => {
    const result = adapter().apply(motion({ blinkLeft: 0.8, jawOpen: 0.4 }));

    expect(result.influences).toEqual(
      expect.arrayContaining([
        { meshName: "Face", index: 0, value: 0.8, key: "blinkLeft" },
        { meshName: "Face", index: 2, value: 0.4, key: "jawOpen" },
      ]),
    );
  });

  it("reports expressions the rig cannot perform rather than dropping them", () => {
    const result = adapter().apply(motion({ smileLeft: 0.9 }));
    expect(result.unsupported).toContain("smileLeft");
    expect(result.requested.smileLeft).toBeCloseTo(0.9, 6);
    expect(result.applied.smileLeft).toBe(0);
  });

  it("writes to every mesh carrying a morph", () => {
    /*
     * A head is routinely split into face, eyes, teeth and brows, and an eyelid
     * morph may live on more than one. Driving only the first would close the
     * skin and leave the eyeball open.
     */
    const multi = new AvatarRigAdapter({
      mappedMorphs: {
        blinkLeft: [
          { meshName: "Face", morphName: "eyeBlinkLeft", index: 0 },
          { meshName: "Eyes", morphName: "eyeBlinkLeft", index: 3 },
        ],
      },
      capabilities: capabilities(),
    });

    const result = multi.apply(motion({ blinkLeft: 1 }));
    expect(result.influences.filter((influence) => influence.key === "blinkLeft")).toHaveLength(2);
  });

  it("clamps a gained influence to what a morph can take", () => {
    // A morph driven past 1 tears most rigs.
    const gained = adapter();
    gained.setGain("blinkLeft", 3);
    expect(gained.apply(motion({ blinkLeft: 0.8 })).influences[0]!.value).toBe(1);
  });

  it("raises a weak rig's response without exceeding it", () => {
    const gained = adapter();
    gained.setGain("jawOpen", 2);
    const result = gained.apply(motion({ jawOpen: 0.3 }));
    expect(result.applied.jawOpen).toBeCloseTo(0.6, 6);
  });

  it("drives a jaw bone only when no morph can do the job", () => {
    const boneOnly = new AvatarRigAdapter({
      mappedMorphs: {},
      capabilities: { ...capabilities(), jawBone: true },
    });
    const result = boneOnly.apply(motion({ jawOpen: 1 }));

    expect(result.jawBoneRotation).toBeGreaterThan(0);
    expect(result.applied.jawOpen).toBeCloseTo(1, 6);

    // With a morph available, the bone stays still — otherwise the mouth opens twice.
    expect(adapter({}, true).apply(motion({ jawOpen: 1 })).jawBoneRotation).toBeNull();
  });

  it("produces nothing at rest", () => {
    const result = adapter().apply(NEUTRAL_AVATAR_MOTION);
    for (const influence of result.influences) expect(influence.value).toBe(0);
    expect(result.jawBoneRotation).toBeNull();
  });
});
