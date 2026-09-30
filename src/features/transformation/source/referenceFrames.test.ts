import { describe, expect, it } from "vitest";

import type { DerivedFaceGeometry } from "../engine/faceTypes";
import type { PoseDerivedGeometry } from "../engine/poseTypes";

import {
  CLASSIFICATION,
  classifyAngle,
  coveredAngles,
  screenCandidate,
  scoreCandidate,
  selectReferenceFrames,
  type CandidateInput,
} from "./referenceFrames";
import type { ReferenceAngle, ReferenceFrame } from "./sourceTypes";

/**
 * Sorting frames into a bank of head angles.
 *
 * The risk here is the Milestone 2 risk wearing different clothes. An inverted
 * yaw sign would produce a bank whose every side label is mirrored — and
 * nothing about it would look wrong, because each frame really is a turned
 * head. The renderer would simply reach for the wrong cheek, forever.
 *
 * So the sign convention is pinned explicitly, in the terms `faceTypes`
 * documents and the Milestone 5 browser proof measured: POSITIVE yaw is the
 * head turned towards the SUBJECT'S LEFT.
 */

function face(overrides: Partial<DerivedFaceGeometry> = {}): DerivedFaceGeometry {
  return {
    center: { x: 0.5, y: 0.45, z: 0 },
    scale: 0.1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    eyeOpenness: 0.8,
    eyeOpennessLeft: 0.8,
    eyeOpennessRight: 0.8,
    mouthOpenness: 0.05,
    bounds: { minX: 0.35, minY: 0.2, maxX: 0.65, maxY: 0.7 },
    ...overrides,
  };
}

function pose(trackability: PoseDerivedGeometry["trackability"] = "tracked"): PoseDerivedGeometry {
  return {
    leftShoulder: { x: 0.35, y: 0.72, z: 0 },
    rightShoulder: { x: 0.65, y: 0.72, z: 0 },
    shoulderCenter: { x: 0.5, y: 0.72, z: 0 },
    shoulderWidth: 0.3,
    shoulderAngle: 0.02,
    torsoCenter: null,
    torsoScale: null,
    torsoLean: null,
    trackability,
    visibility: 0.9,
  };
}

function candidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { timestampSeconds: 1, face: face(), pose: pose(), ...overrides };
}

/** A minimal builder; the bank's contents are tested through the inputs. */
const build = (input: CandidateInput, angle: ReferenceAngle, score: number): ReferenceFrame =>
  ({
    timestampSeconds: input.timestampSeconds,
    angle,
    score,
    face: {} as ReferenceFrame["face"],
    pose: null,
    regions: {} as ReferenceFrame["regions"],
  }) satisfies ReferenceFrame;

describe("angle classification", () => {
  it("calls a square-on head front", () => {
    expect(classifyAngle(face({ yaw: 0, pitch: 0 }))).toBe("front");
    expect(classifyAngle(face({ yaw: 0.05, pitch: -0.04 }))).toBe("front");
  });

  it("maps positive yaw to the subject's left", () => {
    /*
     * The sign that must never flip.
     *
     * `faceTypes` defines positive yaw as the head turning towards the
     * SUBJECT'S left, and the Milestone 5 browser proof measured that against
     * real model output. A bank built on the opposite reading looks entirely
     * plausible and is wrong in every entry.
     */
    expect(classifyAngle(face({ yaw: 0.35 }))).toBe("slight-left");
    expect(classifyAngle(face({ yaw: -0.35 }))).toBe("slight-right");
  });

  it("maps positive pitch to looking up", () => {
    // Positive pitch is the head tilted back.
    expect(classifyAngle(face({ pitch: 0.25 }))).toBe("slight-up");
    expect(classifyAngle(face({ pitch: -0.25 }))).toBe("slight-down");
  });

  it("prefers the turn when a head is both turned and tilted", () => {
    // Horizontal coverage is what a renderer most needs, and a turned-and-
    // tilted head reads primarily as turned.
    expect(classifyAngle(face({ yaw: 0.3, pitch: 0.2 }))).toBe("slight-left");
  });

  it("refuses an angle past what the source can show", () => {
    // A profile view hides the far side of the face entirely.
    expect(classifyAngle(face({ yaw: CLASSIFICATION.maxUsableYaw + 0.1 }))).toBeNull();
    expect(classifyAngle(face({ pitch: CLASSIFICATION.maxUsablePitch + 0.1 }))).toBeNull();
  });

  it("refuses a frame between the front envelope and the side threshold", () => {
    /*
     * A real angle, but not one of the five buckets. Forcing it into the
     * nearest would label a nearly-front frame as a side reference, and the
     * renderer would use it as though it showed a cheek it does not.
     */
    const between = (CLASSIFICATION.frontYaw + CLASSIFICATION.minSideYaw) / 2;
    if (between > CLASSIFICATION.frontYaw && between < CLASSIFICATION.minSideYaw) {
      expect(classifyAngle(face({ yaw: between }))).toBeNull();
    }
  });

  it("refuses non-finite geometry rather than guessing", () => {
    expect(classifyAngle(face({ yaw: Number.NaN }))).toBeNull();
    expect(classifyAngle(face({ pitch: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  describe("boundaries", () => {
    it("treats the side threshold as inclusive", () => {
      expect(classifyAngle(face({ yaw: CLASSIFICATION.minSideYaw }))).toBe("slight-left");
      expect(classifyAngle(face({ yaw: -CLASSIFICATION.minSideYaw }))).toBe("slight-right");
    });

    it("treats the vertical threshold as inclusive", () => {
      expect(classifyAngle(face({ pitch: CLASSIFICATION.minVerticalPitch }))).toBe("slight-up");
      expect(classifyAngle(face({ pitch: -CLASSIFICATION.minVerticalPitch }))).toBe("slight-down");
    });

    it("keeps a frame just inside the usable limit", () => {
      expect(classifyAngle(face({ yaw: CLASSIFICATION.maxUsableYaw - 0.01 }))).toBe("slight-left");
    });
  });
});

describe("candidate screening", () => {
  it("accepts an ordinary frame", () => {
    expect(screenCandidate(candidate())).toBeNull();
  });

  it("rejects non-finite geometry", () => {
    expect(screenCandidate(candidate({ face: face({ scale: Number.NaN }) }))).toBe("invalid-geometry");
    expect(screenCandidate(candidate({ face: face({ center: { x: Number.NaN, y: 0.5, z: 0 } }) }))).toBe(
      "invalid-geometry",
    );
  });

  it("rejects a face too small to land landmarks on", () => {
    expect(screenCandidate(candidate({ face: face({ scale: 0.01 }) }))).toBe("face-too-small");
  });

  it("rejects a face at the edge of frame", () => {
    // Partly outside the information the source actually contains.
    expect(screenCandidate(candidate({ face: face({ center: { x: 0.02, y: 0.5, z: 0 } }) }))).toBe("face-at-edge");
    expect(screenCandidate(candidate({ face: face({ center: { x: 0.5, y: 0.98, z: 0 } }) }))).toBe("face-at-edge");
  });

  it("rejects an extreme angle", () => {
    expect(screenCandidate(candidate({ face: face({ yaw: 1.2 }) }))).toBe("extreme-angle");
  });

  it("rejects a frame that belongs to no bucket", () => {
    const between = (CLASSIFICATION.frontYaw + CLASSIFICATION.minSideYaw) / 2;
    if (between > CLASSIFICATION.frontYaw && between < CLASSIFICATION.minSideYaw) {
      expect(screenCandidate(candidate({ face: face({ yaw: between }) }))).toBe("no-bucket");
    }
  });
});

describe("scoring", () => {
  it("prefers the frame closest to the bucket's target angle", () => {
    const near = scoreCandidate(candidate({ face: face({ yaw: 0.34 }) }), "slight-left");
    const far = scoreCandidate(candidate({ face: face({ yaw: 0.6 }) }), "slight-left");
    expect(near).toBeGreaterThan(far);
  });

  it("prefers a well-centred face", () => {
    const centred = scoreCandidate(candidate({ face: face({ center: { x: 0.5, y: 0.5, z: 0 } }) }), "front");
    const offCentre = scoreCandidate(candidate({ face: face({ center: { x: 0.2, y: 0.8, z: 0 } }) }), "front");
    expect(centred).toBeGreaterThan(offCentre);
  });

  it("prefers a frame with both shoulders", () => {
    // A reference without them cannot contribute upper-body geometry.
    const both = scoreCandidate(candidate({ pose: pose("tracked") }), "front");
    const one = scoreCandidate(candidate({ pose: pose("partial") }), "front");
    const none = scoreCandidate(candidate({ pose: null }), "front");

    expect(both).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(none);
  });

  it("prefers a larger face, up to a point", () => {
    const small = scoreCandidate(candidate({ face: face({ scale: 0.04 }) }), "front");
    const comfortable = scoreCandidate(candidate({ face: face({ scale: 0.08 }) }), "front");
    const huge = scoreCandidate(candidate({ face: face({ scale: 0.3 }) }), "front");

    expect(comfortable).toBeGreaterThan(small);
    // Saturating: past a comfortable size more detail does not help.
    expect(huge).toBeCloseTo(comfortable, 6);
  });

  it("is deterministic", () => {
    const input = candidate({ face: face({ yaw: 0.3 }) });
    expect(scoreCandidate(input, "slight-left")).toBe(scoreCandidate(input, "slight-left"));
  });
});

describe("bank selection", () => {
  it("keeps one frame per angle and no more", () => {
    /*
     * Fifty near-identical frames is a small copy of the video, not a bank.
     * The renderer needs meaningful alternatives.
     */
    const many = Array.from({ length: 40 }, (_unused, index) =>
      candidate({ timestampSeconds: index, face: face({ yaw: 0.01 * (index % 3) }) }),
    );

    const { frames } = selectReferenceFrames(many, build);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.angle).toBe("front");
  });

  it("builds a bank across the angles the source actually contains", () => {
    const { frames } = selectReferenceFrames(
      [
        candidate({ timestampSeconds: 1, face: face({ yaw: 0 }) }),
        candidate({ timestampSeconds: 2, face: face({ yaw: 0.35 }) }),
        candidate({ timestampSeconds: 3, face: face({ yaw: -0.35 }) }),
      ],
      build,
    );

    expect(frames.map((frame) => frame.angle).sort()).toEqual(["front", "slight-left", "slight-right"]);
  });

  it("never fabricates an angle the source does not have", () => {
    // A missing angle stays missing rather than being filled with the nearest
    // frame and quietly mislabelled.
    const { frames } = selectReferenceFrames([candidate({ face: face({ yaw: 0 }) })], build);

    expect(frames).toHaveLength(1);
    expect(coveredAngles(frames).up).toBe(false);
    expect(coveredAngles(frames).left).toBe(false);
  });

  it("lets the best candidate win its bucket", () => {
    const { frames } = selectReferenceFrames(
      [
        // Off-centre and no shoulders.
        candidate({ timestampSeconds: 1, face: face({ yaw: 0.35, center: { x: 0.25, y: 0.5, z: 0 } }), pose: null }),
        // Centred, both shoulders, closer to the target angle.
        candidate({ timestampSeconds: 2, face: face({ yaw: 0.35 }), pose: pose("tracked") }),
      ],
      build,
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]!.timestampSeconds).toBe(2);
  });

  it("breaks a tie on the earlier timestamp, so the bank is reproducible", () => {
    const identical = face({ yaw: 0.35 });
    const { frames } = selectReferenceFrames(
      [
        candidate({ timestampSeconds: 9, face: identical }),
        candidate({ timestampSeconds: 4, face: identical }),
      ],
      build,
    );

    expect(frames[0]!.timestampSeconds).toBe(4);
  });

  it("counts why candidates were refused", () => {
    const { frames, rejections } = selectReferenceFrames(
      [
        candidate({ face: face({ scale: 0.005 }) }),
        candidate({ face: face({ center: { x: 0.01, y: 0.5, z: 0 } }) }),
        candidate({ face: face({ yaw: 1.4 }) }),
        candidate({ timestampSeconds: 5, face: face({ yaw: 0 }) }),
      ],
      build,
    );

    expect(rejections["face-too-small"]).toBe(1);
    expect(rejections["face-at-edge"]).toBe(1);
    expect(rejections["extreme-angle"]).toBe(1);
    expect(frames).toHaveLength(1);
  });

  it("returns an empty bank rather than a bad one", () => {
    // One terrible frame does not belong in the bank merely because the sampler
    // landed on it.
    const { frames } = selectReferenceFrames([candidate({ face: face({ scale: 0.001 }) })], build);
    expect(frames).toEqual([]);
  });

  it("orders the bank by timestamp", () => {
    const { frames } = selectReferenceFrames(
      [
        candidate({ timestampSeconds: 8, face: face({ yaw: 0.35 }) }),
        candidate({ timestampSeconds: 2, face: face({ yaw: 0 }) }),
        candidate({ timestampSeconds: 5, face: face({ yaw: -0.35 }) }),
      ],
      build,
    );

    expect(frames.map((frame) => frame.timestampSeconds)).toEqual([2, 5, 8]);
  });
});

describe("coverage", () => {
  it("reports exactly the angles present", () => {
    const frames = [
      { angle: "front" } as ReferenceFrame,
      { angle: "slight-left" } as ReferenceFrame,
    ];
    const covered = coveredAngles(frames);

    expect(covered).toMatchObject({ front: true, left: true, right: false, up: false, down: false, count: 2 });
  });

  it("reports nothing for an empty bank", () => {
    expect(coveredAngles([]).count).toBe(0);
  });
});
