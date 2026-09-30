import { describe, expect, it } from "vitest";

import { MonotonicClock } from "./monotonicClock";
import { POSE_LANDMARKS, assessTrackability, derivePoseGeometry, shoulderAngle, shoulderWidth } from "./poseGeometry";
import type { PoseLandmark } from "./poseTypes";

/**
 * Upper-body geometry, on synthetic poses.
 *
 * Every direction below is pinned by a known sign. The face milestone caught a
 * silent axis inversion in exactly this kind of code — nothing crashed, the head
 * simply moved the wrong way — so "a raised left shoulder produces this sign" is
 * asserted rather than assumed.
 */

/** An upright person, shoulders level, facing the camera. */
function uprightPose(): PoseLandmark[] {
  const points: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));

  points[POSE_LANDMARKS.nose] = { x: 0.5, y: 0.2, z: 0, visibility: 0.99 };
  // MediaPipe's "left" is the subject's left, which appears on the right of a
  // non-mirrored frame.
  points[POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.4, z: 0, visibility: 0.99 };
  points[POSE_LANDMARKS.rightShoulder] = { x: 0.38, y: 0.4, z: 0, visibility: 0.99 };
  points[POSE_LANDMARKS.leftHip] = { x: 0.58, y: 0.75, z: 0, visibility: 0.9 };
  points[POSE_LANDMARKS.rightHip] = { x: 0.42, y: 0.75, z: 0, visibility: 0.9 };

  return points;
}

describe("shoulder geometry", () => {
  it("reads level shoulders as level", () => {
    const derived = derivePoseGeometry(uprightPose());
    expect(derived).not.toBeNull();
    expect(Math.abs(derived!.shoulderAngle)).toBeLessThan(0.02);
    expect(derived!.shoulderCenter?.x).toBeCloseTo(0.5, 2);
    expect(derived!.shoulderWidth).toBeCloseTo(0.24, 2);
  });

  it("gives opposite signs for a raised left and a raised right shoulder", () => {
    // The sign convention itself is the thing under test: a shrug must not move
    // the source's shoulders the wrong way.
    const leftUp = uprightPose();
    leftUp[POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.33, z: 0, visibility: 0.99 };

    const rightUp = uprightPose();
    rightUp[POSE_LANDMARKS.rightShoulder] = { x: 0.38, y: 0.33, z: 0, visibility: 0.99 };

    const leftAngle = derivePoseGeometry(leftUp)!.shoulderAngle;
    const rightAngle = derivePoseGeometry(rightUp)!.shoulderAngle;

    expect(Math.sign(leftAngle)).not.toBe(Math.sign(rightAngle));
    expect(Math.abs(leftAngle)).toBeGreaterThan(0.1);
    expect(Math.abs(rightAngle)).toBeGreaterThan(0.1);
  });

  it("tracks the body shifting left and right", () => {
    const left = uprightPose().map((point) => ({ ...point, x: point.x - 0.15 }));
    const right = uprightPose().map((point) => ({ ...point, x: point.x + 0.15 }));

    expect(derivePoseGeometry(left)!.shoulderCenter!.x).toBeLessThan(0.4);
    expect(derivePoseGeometry(right)!.shoulderCenter!.x).toBeGreaterThan(0.6);
  });

  it("reads shoulder width as a proxy for distance", () => {
    // Closer is wider. This is what the renderer will scale the source by.
    const closer = uprightPose();
    closer[POSE_LANDMARKS.leftShoulder] = { x: 0.75, y: 0.4, z: 0, visibility: 0.99 };
    closer[POSE_LANDMARKS.rightShoulder] = { x: 0.25, y: 0.4, z: 0, visibility: 0.99 };

    const farther = uprightPose();
    farther[POSE_LANDMARKS.leftShoulder] = { x: 0.56, y: 0.4, z: 0, visibility: 0.99 };
    farther[POSE_LANDMARKS.rightShoulder] = { x: 0.44, y: 0.4, z: 0, visibility: 0.99 };

    const base = derivePoseGeometry(uprightPose())!.shoulderWidth;
    expect(derivePoseGeometry(closer)!.shoulderWidth).toBeGreaterThan(base);
    expect(derivePoseGeometry(farther)!.shoulderWidth).toBeLessThan(base);
  });

  it("computes width and angle directly", () => {
    expect(shoulderWidth({ x: 0.3, y: 0.5, z: 0 }, { x: 0.7, y: 0.5, z: 0 })).toBeCloseTo(0.4, 5);
    expect(shoulderAngle({ x: 0.7, y: 0.5, z: 0 }, { x: 0.3, y: 0.5, z: 0 })).toBeCloseTo(0, 5);
  });
});

describe("torso geometry", () => {
  it("summarises an upright torso", () => {
    const derived = derivePoseGeometry(uprightPose())!;
    expect(derived.torsoCenter).not.toBeNull();
    expect(derived.torsoScale).toBeGreaterThan(0);
    expect(Math.abs(derived.torsoLean!)).toBeLessThan(0.05);
  });

  it("gives opposite signs for leaning each way", () => {
    // An approximation of lean, but its direction must still be right.
    const leanLeft = uprightPose();
    leanLeft[POSE_LANDMARKS.leftShoulder] = { x: 0.5, y: 0.4, z: 0, visibility: 0.99 };
    leanLeft[POSE_LANDMARKS.rightShoulder] = { x: 0.26, y: 0.4, z: 0, visibility: 0.99 };

    const leanRight = uprightPose();
    leanRight[POSE_LANDMARKS.leftShoulder] = { x: 0.74, y: 0.4, z: 0, visibility: 0.99 };
    leanRight[POSE_LANDMARKS.rightShoulder] = { x: 0.5, y: 0.4, z: 0, visibility: 0.99 };

    const left = derivePoseGeometry(leanLeft)!.torsoLean!;
    const right = derivePoseGeometry(leanRight)!.torsoLean!;

    expect(Math.sign(left)).not.toBe(Math.sign(right));
  });

  it("omits torso geometry when the hips are not visible", () => {
    // Half the operators testing this will be sitting at a desk with no hips in
    // frame. That must yield null, not a fabricated torso.
    const noHips = uprightPose();
    noHips[POSE_LANDMARKS.leftHip] = { x: 0.58, y: 0.75, z: 0, visibility: 0.1 };
    noHips[POSE_LANDMARKS.rightHip] = { x: 0.42, y: 0.75, z: 0, visibility: 0.1 };

    const derived = derivePoseGeometry(noHips)!;
    expect(derived.torsoCenter).toBeNull();
    expect(derived.torsoScale).toBeNull();
    expect(derived.torsoLean).toBeNull();
    // Shoulders are still perfectly usable.
    expect(derived.trackability).toBe("tracked");
    expect(derived.shoulderCenter).not.toBeNull();
  });
});

describe("trackability", () => {
  it("is tracked with both shoulders", () => {
    expect(derivePoseGeometry(uprightPose())!.trackability).toBe("tracked");
  });

  it("is partial with one shoulder out of frame", () => {
    // A normal thing to report, not an error: the Studio turns this into
    // "move back slightly so your shoulders are visible".
    const oneShoulder = uprightPose();
    oneShoulder[POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.4, z: 0, visibility: 0.2 };

    const derived = derivePoseGeometry(oneShoulder)!;
    expect(derived.trackability).toBe("partial");
    expect(derived.leftShoulder).toBeNull();
    expect(derived.rightShoulder).not.toBeNull();
    // Without both, there is no shoulder line to speak of.
    expect(derived.shoulderCenter).toBeNull();
    expect(derived.shoulderWidth).toBe(0);
  });

  it("is lost with neither shoulder nor hips", () => {
    const nothing = uprightPose().map((point) => ({ ...point, visibility: 0.05 }));
    expect(derivePoseGeometry(nothing)!.trackability).toBe("lost");
  });

  it("is partial when only hips remain", () => {
    const hipsOnly = uprightPose();
    hipsOnly[POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.4, z: 0, visibility: 0.1 };
    hipsOnly[POSE_LANDMARKS.rightShoulder] = { x: 0.38, y: 0.4, z: 0, visibility: 0.1 };

    expect(derivePoseGeometry(hipsOnly)!.trackability).toBe("partial");
  });

  it("trusts landmarks from a build that reports no visibility", () => {
    // Inventing a confidence the model did not give would be worse than
    // accepting its silence.
    const noVisibility = uprightPose().map(({ x, y, z }) => ({ x, y, z }));
    const derived = derivePoseGeometry(noVisibility)!;

    expect(derived.trackability).toBe("tracked");
    expect(derived.visibility).toBeNull();
  });

  it("assesses trackability directly", () => {
    const visible = { x: 0.5, y: 0.5, z: 0, visibility: 0.9 };
    const hidden = { x: 0.5, y: 0.5, z: 0, visibility: 0.1 };

    expect(assessTrackability(visible, visible, true)).toBe("tracked");
    expect(assessTrackability(visible, hidden, true)).toBe("partial");
    expect(assessTrackability(hidden, hidden, true)).toBe("partial");
    expect(assessTrackability(hidden, hidden, false)).toBe("lost");
    expect(assessTrackability(undefined, undefined, false)).toBe("lost");
  });
});

describe("malformed input", () => {
  it("rejects non-finite landmarks rather than propagating NaN", () => {
    const broken = uprightPose();
    broken[POSE_LANDMARKS.leftShoulder] = { x: Number.NaN, y: 0.4, z: 0, visibility: 0.99 };

    const derived = derivePoseGeometry(broken)!;
    expect(derived.leftShoulder).toBeNull();
    expect(derived.trackability).toBe("partial");
    expect(Number.isFinite(derived.shoulderWidth)).toBe(true);
  });

  it("returns nothing for an empty landmark set", () => {
    expect(derivePoseGeometry([])).toBeNull();
  });

  it("keeps every derived value finite", () => {
    const derived = derivePoseGeometry(uprightPose())!;
    for (const value of [derived.shoulderWidth, derived.shoulderAngle, derived.torsoScale, derived.torsoLean]) {
      if (value !== null) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("monotonic clock", () => {
  it("advances when the caller does", () => {
    const clock = new MonotonicClock();
    expect(clock.next(100)).toBe(100);
    expect(clock.next(200)).toBe(200);
  });

  it("never repeats or regresses, whatever it is handed", () => {
    // A camera flip restarts video.currentTime at zero; a resume can replay a
    // stamp. MediaPipe throws on either.
    const clock = new MonotonicClock();
    const stamps = [1000, 1000, 5, 0, -50, 1001].map((value) => clock.next(value));

    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]!, `stamp ${i} must exceed ${stamps[i - 1]}`).toBeGreaterThan(stamps[i - 1]!);
    }
  });

  it("survives non-finite input", () => {
    const clock = new MonotonicClock();
    clock.next(100);
    expect(Number.isFinite(clock.next(Number.NaN))).toBe(true);
    expect(clock.next(Number.NaN)).toBeGreaterThan(100);
  });

  it("lets two trackers share one timeline", () => {
    // In Milestone 4 both models see the same frame and must agree about when
    // it was; two independent clocks would drift by a millisecond nothing could
    // reconcile.
    const shared = new MonotonicClock();
    const forFace = shared.next(500);
    expect(shared.current).toBe(forFace);
  });
});
