import { describe, expect, it } from "vitest";

import type { CalibrationMotion, HeadMotion } from "../relativeMotion";

import {
  faceDirectionVectors,
  mirrorScaleX,
  rendererMotionFromPose,
  rendererMotionFromTracking,
  visibleFaceDirection,
} from "./rendererMotion";

/**
 * Direction, in physical language.
 *
 * Every test here is named for something a person does in front of a camera and
 * asserts what they should SEE. That is deliberate: a test reading
 * `expect(mapped.yaw).toBe(-input.yaw)` only proves the implementation agrees
 * with itself, and would have passed happily throughout the milestone where a
 * real iPhone turned the wrong way on two axes.
 *
 * The bridge from signs to visible behaviour is `faceDirectionVectors`, which
 * rotates the mesh's own forward (+z) and up (+y) by the Euler the renderer
 * applies. Where the nose ends up IS what the operator sees.
 *
 * Tracking conventions, as MediaPipe reports the OPERATOR. Yaw and roll were
 * measured in Milestone 5; pitch in M8.3, by rendering the face nose-up and
 * having MediaPipe read it back (transformation-m83-roundtrip):
 *   yaw   > 0  head turned towards the SUBJECT'S LEFT
 *   pitch > 0  head tilted FORWARD, looking DOWN
 *   roll  > 0  head tilted towards the SUBJECT'S RIGHT ear
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

/** What the operator sees in the Studio, which is a mirrored self-view. */
function seenInStudio(motion: CalibrationMotion) {
  return visibleFaceDirection(rendererMotionFromTracking(motion), "selfie");
}

/** What a caller would see: the faithful, unmirrored view. */
function seenByCaller(motion: CalibrationMotion) {
  return visibleFaceDirection(rendererMotionFromTracking(motion), "faithful");
}

describe("physical head turns, as the operator sees them", () => {
  it("physical_right_turn_renders_right_turn", () => {
    /*
     * The operator turns towards their own right. Their right is negative yaw.
     *
     * In a mirrored self-view — the same mirror the camera preview uses — the
     * nose must travel to the RIGHT of the screen, because that is what a mirror
     * does and what makes the movement feel like your own.
     */
    const seen = seenInStudio(head({ yawDelta: -STRONG }));
    expect(seen.nose.x).toBeGreaterThan(0.2);
  });

  it("physical_left_turn_renders_left_turn", () => {
    const seen = seenInStudio(head({ yawDelta: STRONG }));
    expect(seen.nose.x).toBeLessThan(-0.2);
  });

  it("physical_look_up_renders_up", () => {
    // MediaPipe reads looking up as NEGATIVE pitch. The nose must rise.
    const seen = seenInStudio(head({ pitchDelta: -STRONG }));
    expect(seen.nose.y).toBeGreaterThan(0.2);
  });

  it("physical_look_down_renders_down", () => {
    const seen = seenInStudio(head({ pitchDelta: STRONG }));
    expect(seen.nose.y).toBeLessThan(-0.2);
  });

  it("physical_tilt_right_renders_right", () => {
    /*
     * Tilting the right ear towards the right shoulder is positive roll. In a
     * mirror the top of the head leans towards the screen-right, which is what
     * reads as "tilting right".
     */
    const seen = seenInStudio(head({ rollDelta: STRONG }));
    expect(seen.up.x).toBeGreaterThan(0.2);
  });

  it("physical_tilt_left_renders_left", () => {
    const seen = seenInStudio(head({ rollDelta: -STRONG }));
    expect(seen.up.x).toBeLessThan(-0.2);
  });

  it("physical_move_right_renders_right", () => {
    // Moving towards the subject's right decreases tracking x, because an
    // unmirrored image puts their right on the image's left.
    const motion = rendererMotionFromTracking(head({ translationX: -0.3 }));
    expect(motion.x * mirrorScaleX("selfie")).toBeGreaterThan(0);
  });

  it("physical_move_down_renders_down", () => {
    // Tracking y grows down; world y grows up. Flipped once.
    expect(rendererMotionFromTracking(head({ translationY: 0.3 })).y).toBeLessThan(0);
  });
});

describe("one axis at a time stays one axis", () => {
  it("a turn is not a nod and not a tilt", () => {
    // The Milestone 2 failure, guarded one layer further out: an axis leaking
    // into another still looks like a plausible transformation of the wrong
    // thing.
    const seen = seenInStudio(head({ yawDelta: STRONG }));
    expect(Math.abs(seen.nose.y)).toBeLessThan(0.02);
    expect(Math.abs(seen.up.x)).toBeLessThan(0.02);
  });

  it("a nod is not a turn", () => {
    const seen = seenInStudio(head({ pitchDelta: STRONG }));
    expect(Math.abs(seen.nose.x)).toBeLessThan(0.02);
  });

  it("a tilt moves the head's up vector, not its nose", () => {
    const seen = seenInStudio(head({ rollDelta: STRONG }));
    expect(Math.abs(seen.nose.x)).toBeLessThan(0.02);
    expect(Math.abs(seen.nose.y)).toBeLessThan(0.02);
  });
});

describe("what a caller would see", () => {
  it("is the mirror image of the self-view, horizontally and only horizontally", () => {
    /*
     * The self-view mirror is a DISPLAY decision, applied once at the surface.
     * The motion itself stays faithful, so the same tracked movement can drive a
     * mirrored Studio preview and a truthful outgoing frame without either being
     * recomputed — and so nothing has to be undone before this reaches a call.
     */
    const motion = head({ yawDelta: -STRONG, pitchDelta: 0.15, rollDelta: 0.1 });
    const studio = seenInStudio(motion);
    const caller = seenByCaller(motion);

    expect(studio.nose.x).toBeCloseTo(-caller.nose.x, 10);
    expect(studio.nose.y).toBeCloseTo(caller.nose.y, 10);
    expect(studio.nose.z).toBeCloseTo(caller.nose.z, 10);
  });

  it("shows a physical right turn going to the caller's left, which is correct", () => {
    // Facing someone, their right hand is on your left. A faithful view of
    // somebody turning to their right shows the nose moving to YOUR left.
    expect(seenByCaller(head({ yawDelta: -STRONG })).nose.x).toBeLessThan(-0.2);
  });
});

describe("the sign contract itself", () => {
  it("hands MediaPipe's angles to Three unchanged, because they already agree", () => {
    /*
     * Measured, not reasoned: MediaPipe pitch is positive nose-DOWN, and so is
     * Three's rotation.x. M8.1 negated it believing MediaPipe positive-up, and
     * every nod rendered backwards. The negation now sits between PHYSICAL
     * pitch (+ up) and Three, with MediaPipe -> physical in rigidFaceMotion.ts.
     */
    const motion = rendererMotionFromTracking(
      head({ yawDelta: 0.2, pitchDelta: 0.2, rollDelta: 0.2 }),
    );

    expect(motion.rotationY).toBeCloseTo(0.2, 10);
    expect(motion.rotationZ).toBeCloseTo(0.2, 10);
    expect(motion.rotationX).toBeCloseTo(0.2, 10);
  });

  it("maps a clamped pose the same way it maps raw tracking", () => {
    // Clamping happens on the PHYSICAL pose (pitch + up, y + up); each sign
    // still changes exactly once.
    const viaPose = rendererMotionFromPose({ x: 0.1, y: -0.2, scale: 1.1, yaw: 0.2, pitch: -0.3, roll: -0.1 });
    const viaTracking = rendererMotionFromTracking(
      head({ translationX: 0.1, translationY: 0.2, scaleDelta: 1.1, yawDelta: 0.2, pitchDelta: 0.3, rollDelta: -0.1 }),
    );

    expect(viaPose).toEqual(viaTracking);
  });

  it("is neutral without tracking, rather than guessing", () => {
    const motion = rendererMotionFromTracking(null);
    expect(motion).toEqual({ x: 0, y: 0, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0 });
    expect(rendererMotionFromTracking({ head: null, expression: null, upperBody: null, tracked: false })).toEqual(
      motion,
    );
  });

  it("survives non-finite tracking without producing NaN geometry", () => {
    const motion = rendererMotionFromTracking(
      head({ yawDelta: Number.NaN, scaleDelta: Number.POSITIVE_INFINITY }),
    );
    expect(motion.rotationY).toBe(0);
    expect(motion.scale).toBe(1);
  });
});

describe("direction vectors", () => {
  it("points the nose at the viewer when neutral", () => {
    const vectors = faceDirectionVectors({ x: 0, y: 0, scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0 });
    expect(vectors.nose.z).toBeCloseTo(1, 10);
    expect(vectors.up.y).toBeCloseTo(1, 10);
  });

  it("keeps the vectors unit length under rotation", () => {
    const vectors = faceDirectionVectors({ x: 0, y: 0, scale: 1, rotationX: 0.3, rotationY: -0.4, rotationZ: 0.2 });
    expect(Math.hypot(vectors.nose.x, vectors.nose.y, vectors.nose.z)).toBeCloseTo(1, 8);
    expect(Math.hypot(vectors.up.x, vectors.up.y, vectors.up.z)).toBeCloseTo(1, 8);
  });
});
