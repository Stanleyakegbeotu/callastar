import { describe, expect, it } from "vitest";

import {
  FACE_LANDMARKS,
  deriveFaceGeometry,
  estimateConfidence,
  eyeOpenness,
  faceBounds,
  jawDisplacement,
  mouthOpenness,
  poseFromLandmarks,
  poseFromMatrix,
} from "./faceGeometry";
import type { Point3 } from "./faceTypes";

/**
 * Derived geometry, tested on synthetic faces.
 *
 * This layer turns 478 landmarks into the handful of numbers the renderer will
 * follow, and it is the most likely place for an error that shows up only as a
 * subtly drifting face rather than a crash. Synthetic landmarks make each
 * property checkable in isolation: build a face looking straight ahead, or one
 * with its eyes shut, and assert the single number that should change.
 */

/** A neutral, forward-facing face centred in frame. */
function neutralFace(): Point3[] {
  const points: Point3[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

  points[FACE_LANDMARKS.noseTip] = { x: 0.5, y: 0.5, z: 0 };
  points[FACE_LANDMARKS.chin] = { x: 0.5, y: 0.7, z: 0 };
  points[FACE_LANDMARKS.foreheadTop] = { x: 0.5, y: 0.3, z: 0 };
  points[FACE_LANDMARKS.leftCheek] = { x: 0.35, y: 0.5, z: 0 };
  points[FACE_LANDMARKS.rightCheek] = { x: 0.65, y: 0.5, z: 0 };

  // Eyes level, open at a typical ratio.
  points[FACE_LANDMARKS.leftEyeOuter] = { x: 0.4, y: 0.45, z: 0 };
  points[FACE_LANDMARKS.leftEyeInner] = { x: 0.46, y: 0.45, z: 0 };
  points[FACE_LANDMARKS.leftEyeUpper] = { x: 0.43, y: 0.437, z: 0 };
  points[FACE_LANDMARKS.leftEyeLower] = { x: 0.43, y: 0.464, z: 0 };
  points[FACE_LANDMARKS.rightEyeOuter] = { x: 0.6, y: 0.45, z: 0 };
  points[FACE_LANDMARKS.rightEyeInner] = { x: 0.54, y: 0.45, z: 0 };
  points[FACE_LANDMARKS.rightEyeUpper] = { x: 0.57, y: 0.437, z: 0 };
  points[FACE_LANDMARKS.rightEyeLower] = { x: 0.57, y: 0.464, z: 0 };
  // The aperture is read at three points across each lid, not only the centre.
  for (const [upper, lower, x] of [[160, 144, 0.415], [158, 153, 0.445], [387, 373, 0.585], [385, 380, 0.555]] as const) {
    points[upper] = { x, y: 0.44, z: 0 };
    points[lower] = { x, y: 0.462, z: 0 };
  }

  // Mouth closed.
  points[FACE_LANDMARKS.mouthLeft] = { x: 0.44, y: 0.62, z: 0 };
  points[FACE_LANDMARKS.mouthRight] = { x: 0.56, y: 0.62, z: 0 };
  points[FACE_LANDMARKS.mouthUpper] = { x: 0.5, y: 0.618, z: 0 };
  points[FACE_LANDMARKS.mouthLower] = { x: 0.5, y: 0.622, z: 0 };
  const mouthPairs = [[13, 14, 0.5], [82, 87, 0.485], [312, 317, 0.515], [81, 178, 0.47], [311, 402, 0.53]] as const;
  for (const [upper, lower, x] of mouthPairs) {
    points[upper] = { x, y: 0.618, z: 0 };
    points[lower] = { x, y: 0.622, z: 0 };
  }

  return points;
}

/** Column-major identity, as MediaPipe returns it. */
function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

describe("head pose from the model matrix", () => {
  it("reads a neutral pose from an identity matrix", () => {
    const pose = poseFromMatrix(identityMatrix());
    expect(pose).not.toBeNull();
    expect(pose?.yaw).toBeCloseTo(0, 5);
    expect(pose?.pitch).toBeCloseTo(0, 5);
    expect(pose?.roll).toBeCloseTo(0, 5);
  });

  it("reads yaw from a rotation about the vertical axis", () => {
    // 30° about Y, column-major.
    const angle = Math.PI / 6;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const matrix = [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, 0, 0, 0, 1];

    const pose = poseFromMatrix(matrix);
    expect(pose).not.toBeNull();
    expect(Math.abs(pose?.pitch ?? 1)).toBeLessThan(0.01);
    expect(Math.abs(pose?.yaw ?? 0)).toBeGreaterThan(0.1);
  });

  it("refuses a malformed or degenerate matrix rather than returning NaN", () => {
    expect(poseFromMatrix([1, 0, 0])).toBeNull();
    expect(poseFromMatrix([])).toBeNull();

    // Gimbal lock: the yaw/roll split is meaningless, so it declines.
    const locked = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
    expect(poseFromMatrix(locked)).toBeNull();
  });
});

describe("head pose from landmarks", () => {
  it("reads a neutral face as facing forward", () => {
    const pose = poseFromLandmarks(neutralFace());
    expect(Math.abs(pose.yaw)).toBeLessThan(0.05);
    expect(Math.abs(pose.pitch)).toBeLessThan(0.05);
    expect(Math.abs(pose.roll)).toBeLessThan(0.05);
  });

  it("reads yaw when the nose moves toward a cheek", () => {
    const turned = neutralFace();
    turned[FACE_LANDMARKS.noseTip] = { x: 0.58, y: 0.5, z: 0 };

    const pose = poseFromLandmarks(turned);
    expect(pose.yaw).toBeGreaterThan(0.1);
  });

  it("reads roll from the eye line", () => {
    const tilted = neutralFace();
    tilted[FACE_LANDMARKS.leftEyeOuter] = { x: 0.4, y: 0.42, z: 0 };
    tilted[FACE_LANDMARKS.rightEyeOuter] = { x: 0.6, y: 0.48, z: 0 };

    expect(poseFromLandmarks(tilted).roll).toBeGreaterThan(0.1);
  });

  it("returns a neutral pose rather than NaN when landmarks are missing", () => {
    const pose = poseFromLandmarks([]);
    expect(pose).toEqual({ yaw: 0, pitch: 0, roll: 0 });
  });
});

describe("eye and mouth openness", () => {
  it("reports an open eye as open and a closed one as closed", () => {
    const face = neutralFace();
    expect(eyeOpenness(face, "left")).toBeGreaterThan(0.5);

    const shut = neutralFace();
    for (const [upper, lower, x] of [[160, 144, 0.415], [159, 145, 0.43], [158, 153, 0.445]] as const) {
      shut[upper] = { x, y: 0.45, z: 0 };
      shut[lower] = { x, y: 0.45, z: 0 };
    }
    expect(eyeOpenness(shut, "left")).toBeCloseTo(0, 2);

    // The other eye is unaffected — a wink must not close both.
    expect(eyeOpenness(shut, "right")).toBeGreaterThan(0.5);
  });

  it("reports a closed mouth as closed and an open one as open", () => {
    expect(mouthOpenness(neutralFace())).toBeLessThan(0.2);

    const open = neutralFace();
    for (const [upper, lower] of [[13, 14], [82, 87], [312, 317], [81, 178], [311, 402]] as const) {
      open[upper] = { ...open[upper]!, y: 0.6 };
      open[lower] = { ...open[lower]!, y: 0.67 };
    }
    expect(mouthOpenness(open)).toBeGreaterThan(0.5);
  });

  it("measures opening perpendicular to the mouth axis under roll", () => {
    const open = neutralFace();
    for (const [upper, lower] of [[13, 14], [82, 87], [312, 317], [81, 178], [311, 402]] as const) {
      open[upper] = { ...open[upper]!, y: 0.6 };
      open[lower] = { ...open[lower]!, y: 0.67 };
    }
    const frontal = mouthOpenness(open);
    const angle = Math.PI / 12;
    const rotated = open.map((point) => {
      const x = point.x - 0.5, y = point.y - 0.62;
      return { ...point, x: 0.5 + Math.cos(angle) * x - Math.sin(angle) * y,
        y: 0.62 + Math.sin(angle) * x + Math.cos(angle) * y };
    });
    expect(mouthOpenness(rotated)).toBeCloseTo(frontal, 5);
  });

  it("measures chin drop against stable upper-face anchors", () => {
    const neutral = neutralFace();
    const open = neutralFace();
    open[FACE_LANDMARKS.chin] = { ...open[FACE_LANDMARKS.chin]!, y: 0.73 };
    expect(jawDisplacement(open)).toBeGreaterThan(jawDisplacement(neutral));
  });

  it("stays within 0..1 however extreme the landmarks", () => {
    // A collapsed or exploded face must not drive the renderer past its limits.
    const extreme = neutralFace();
    extreme[FACE_LANDMARKS.mouthUpper] = { x: 0.5, y: 0.0, z: 0 };
    extreme[FACE_LANDMARKS.mouthLower] = { x: 0.5, y: 1.0, z: 0 };
    expect(mouthOpenness(extreme)).toBeLessThanOrEqual(1);
    expect(mouthOpenness(extreme)).toBeGreaterThanOrEqual(0);
  });
});

describe("derived geometry", () => {
  it("summarises a neutral face", () => {
    const derived = deriveFaceGeometry(neutralFace(), identityMatrix(), {});
    expect(derived).not.toBeNull();
    expect(derived?.center.x).toBeCloseTo(0.5, 1);
    expect(derived?.scale).toBeGreaterThan(0);
    expect(derived?.eyeOpenness).toBeGreaterThan(0.5);
  });

  it("prefers the jawOpen blendshape over lip distance for the mouth", () => {
    // The blendshape is what the model solved for and responds faster than lip
    // distance, which lags on a quick word.
    const closedLips = neutralFace();
    const derived = deriveFaceGeometry(closedLips, identityMatrix(), { jawOpen: 0.8 });
    expect(derived?.mouthOpenness).toBeCloseTo(0.8, 2);

    // Without the blendshape it falls back to the landmarks.
    const fallback = deriveFaceGeometry(closedLips, identityMatrix(), {});
    expect(fallback?.mouthOpenness).toBeLessThan(0.2);
  });

  it("returns nothing for an empty landmark set", () => {
    expect(deriveFaceGeometry([], null, {})).toBeNull();
  });

  it("computes bounds over every landmark", () => {
    const bounds = faceBounds([
      { x: 0.2, y: 0.3, z: 0 },
      { x: 0.8, y: 0.1, z: 0 },
      { x: 0.5, y: 0.9, z: 0 },
    ]);
    expect(bounds).toEqual({ minX: 0.2, minY: 0.1, maxX: 0.8, maxY: 0.9 });
  });
});

describe("confidence", () => {
  it("trusts a well-framed face", () => {
    const face = neutralFace();
    const derived = deriveFaceGeometry(face, identityMatrix(), {});
    expect(estimateConfidence(face, derived)).toBeGreaterThan(0.7);
  });

  it("distrusts a face that has collapsed to a point", () => {
    // A degenerate detection must not be followed by the renderer.
    const collapsed: Point3[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const derived = deriveFaceGeometry(collapsed, null, {});
    expect(estimateConfidence(collapsed, derived)).toBeLessThan(0.5);
  });

  it("distrusts non-finite coordinates outright", () => {
    const broken = neutralFace();
    broken[10] = { x: Number.NaN, y: 0.5, z: 0 };
    const derived = deriveFaceGeometry(broken, null, {});
    expect(estimateConfidence(broken, derived)).toBe(0);
  });

  it("drops as a face leaves the frame", () => {
    const inside = neutralFace();
    const outside = neutralFace().map((point) => ({ ...point, x: point.x + 0.45 }));

    const insideScore = estimateConfidence(inside, deriveFaceGeometry(inside, null, {}));
    const outsideScore = estimateConfidence(outside, deriveFaceGeometry(outside, null, {}));
    expect(outsideScore).toBeLessThan(insideScore);
  });

  it("is zero with no landmarks", () => {
    expect(estimateConfidence([], null)).toBe(0);
  });
});
