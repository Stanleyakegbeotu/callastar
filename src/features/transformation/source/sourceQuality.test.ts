import { describe, expect, it } from "vitest";

import type { DerivedFaceGeometry } from "../engine/faceTypes";
import type { PoseDerivedGeometry } from "../engine/poseTypes";

import {
  SOURCE_RULES,
  deriveMovementEnvelope,
  deriveSourceCapabilities,
  deriveSourceRegions,
  deriveSourceWarnings,
  evaluateSource,
  gradeSource,
  type SourceEvaluationInput,
} from "./sourceQuality";

/**
 * Judging a source.
 *
 * The rule this whole file is written around: every claim must be measured.
 * There is no blur detector and no lighting analysis in this project, so
 * nothing here may say a source is blurry or badly lit — a guess dressed as a
 * measurement is worse than silence, because the operator throws away an image
 * that was fine.
 */

function face(overrides: Partial<DerivedFaceGeometry> = {}): DerivedFaceGeometry {
  return {
    center: { x: 0.5, y: 0.42, z: 0 },
    scale: 0.1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    eyeOpenness: 0.8,
    eyeOpennessLeft: 0.8,
    eyeOpennessRight: 0.8,
    mouthOpenness: 0.05,
    bounds: { minX: 0.38, minY: 0.25, maxX: 0.62, maxY: 0.6 },
    ...overrides,
  };
}

function pose(overrides: Partial<PoseDerivedGeometry> = {}): PoseDerivedGeometry {
  return {
    leftShoulder: { x: 0.3, y: 0.78, z: 0 },
    rightShoulder: { x: 0.7, y: 0.78, z: 0 },
    shoulderCenter: { x: 0.5, y: 0.78, z: 0 },
    shoulderWidth: 0.4,
    shoulderAngle: 0.01,
    torsoCenter: null,
    torsoScale: null,
    torsoLean: null,
    trackability: "tracked",
    visibility: 0.9,
    ...overrides,
  };
}

function input(overrides: Partial<SourceEvaluationInput> = {}): SourceEvaluationInput {
  const resolved = { face: face(), pose: pose(), angleCount: 1, ...overrides };
  return {
    ...resolved,
    regions: overrides.regions ?? deriveSourceRegions(resolved.face, resolved.pose),
    dimensions: overrides.dimensions ?? { width: 1080, height: 1440, aspectRatio: 0.75 },
  };
}

describe("regions", () => {
  it("expands the face bounds to cover a head", () => {
    /*
     * Face landmarks stop at the face. A renderer cropping to them would cut
     * off a forehead, both ears and all of the hair — so the head region is a
     * measured expansion, and asymmetric, because there is far more head above
     * the eyebrows than below the chin.
     */
    const regions = deriveSourceRegions(face(), pose());

    expect(regions.head.minY).toBeLessThan(regions.face.minY);
    expect(regions.head.maxY).toBeGreaterThan(regions.face.maxY);
    expect(regions.head.minX).toBeLessThan(regions.face.minX);

    const aboveChin = regions.face.minY - regions.head.minY;
    const belowChin = regions.head.maxY - regions.face.maxY;
    expect(aboveChin, "more head above the eyebrows than below the chin").toBeGreaterThan(belowChin);
  });

  it("reports a head that ran off the image as clipped", () => {
    // Not a rectangle problem: it means the source does not contain the whole
    // head, and the renderer needs to know rather than find a hard edge.
    const highFace = face({ bounds: { minX: 0.38, minY: 0.02, maxX: 0.62, maxY: 0.35 } });
    expect(deriveSourceRegions(highFace, pose()).headClipped).toBe(true);
  });

  it("includes the shoulders in the upper body when they are known", () => {
    const wide = pose({ shoulderCenter: { x: 0.5, y: 0.8, z: 0 }, shoulderWidth: 0.7 });
    const regions = deriveSourceRegions(face(), wide);

    expect(regions.upperBody.maxX - regions.upperBody.minX).toBeGreaterThan(
      regions.head.maxX - regions.head.minX,
    );
  });

  it("does not invent a torso when there are no shoulders", () => {
    // Putting a body under a cropped photograph invents what was never taken.
    const regions = deriveSourceRegions(face(), null);
    expect(regions.upperBody).toEqual(regions.head);
  });
});

describe("warnings", () => {
  it("says nothing about a clean source", () => {
    const warnings = deriveSourceWarnings(input({ angleCount: 3 }));
    expect(warnings).toEqual([]);
  });

  it("never claims anything about blur or lighting", () => {
    /*
     * Nothing in this project measures either. Product copy may suggest good
     * lighting; automated analysis may not claim to have checked it.
     */
    const noisy = deriveSourceWarnings(
      input({
        face: face({ scale: 0.02, center: { x: 0.05, y: 0.05, z: 0 }, yaw: 1 }),
        pose: null,
        dimensions: { width: 120, height: 160, aspectRatio: 0.75 },
      }),
    );

    for (const warning of noisy) {
      expect(warning).not.toMatch(/blur|light|expos|sharp|noise/i);
    }
  });

  it("flags a genuinely low-resolution source", () => {
    const low = deriveSourceWarnings(input({ dimensions: { width: 240, height: 320, aspectRatio: 0.75 } }));
    expect(low).toContain("low-resolution");
  });

  it("does not demand 1080p", () => {
    // A 480px-tall portrait of a head is a perfectly usable source.
    const modest = deriveSourceWarnings(input({ dimensions: { width: 480, height: 640, aspectRatio: 0.75 } }));
    expect(modest).not.toContain("low-resolution");
  });

  it("flags a small face, a face near the edge and a strongly angled head", () => {
    expect(deriveSourceWarnings(input({ face: face({ scale: 0.04 }) }))).toContain("small-face");
    expect(deriveSourceWarnings(input({ face: face({ center: { x: 0.08, y: 0.5, z: 0 } }) }))).toContain(
      "face-near-edge",
    );
    expect(deriveSourceWarnings(input({ face: face({ yaw: 0.6 }) }))).toContain("head-strongly-angled");
  });

  it("distinguishes no shoulders from one shoulder", () => {
    expect(deriveSourceWarnings(input({ pose: null }))).toContain("shoulders-not-visible");
    expect(deriveSourceWarnings(input({ pose: pose({ trackability: "partial" }) }))).toContain("one-shoulder-only");
  });

  it("says a single image covers limited angles", () => {
    // True of every still, and worth saying once rather than implying.
    expect(deriveSourceWarnings(input({ angleCount: 1 }))).toContain("single-image-limited-coverage");
    expect(deriveSourceWarnings(input({ angleCount: 2 }))).toContain("few-reference-angles");
    expect(deriveSourceWarnings(input({ angleCount: 4 }))).not.toContain("few-reference-angles");
  });
});

describe("capabilities", () => {
  it("reports what a good source supports", () => {
    const capabilities = deriveSourceCapabilities(input({ angleCount: 3 }));
    expect(capabilities).toEqual({
      face: true,
      expressions: true,
      headRotation: true,
      upperBody: true,
      multiAngleReference: true,
    });
  });

  it("withdraws head rotation from a source already at its limit", () => {
    // A profile view has no other cheek to turn towards.
    expect(deriveSourceCapabilities(input({ face: face({ yaw: 0.6 }) })).headRotation).toBe(false);
  });

  it("withdraws upper body without both shoulders", () => {
    expect(deriveSourceCapabilities(input({ pose: pose({ trackability: "partial" }) })).upperBody).toBe(false);
    expect(deriveSourceCapabilities(input({ pose: null })).upperBody).toBe(false);
  });

  it("reports a face too small to use as no face at all", () => {
    const tiny = deriveSourceCapabilities(input({ face: face({ scale: 0.01 }) }));
    expect(tiny.face).toBe(false);
    expect(tiny.expressions).toBe(false);
  });

  it("only a video can offer multiple angles", () => {
    expect(deriveSourceCapabilities(input({ angleCount: 1 })).multiAngleReference).toBe(false);
  });
});

describe("grading", () => {
  it("calls a face-less source unusable", () => {
    const unusable = input({ face: face({ scale: 0.005 }) });
    expect(gradeSource(unusable, deriveSourceWarnings(unusable))).toBe("unusable");
  });

  it("calls a clean single image good, not excellent", () => {
    /*
     * Excellence here means more than one angle to draw from, which a still
     * cannot have. Calling a good photograph excellent would imply coverage it
     * does not contain.
     */
    const still = input({ angleCount: 1 });
    expect(gradeSource(still, deriveSourceWarnings(still))).toBe("good");
  });

  it("reserves excellent for a multi-angle source with nothing to say about it", () => {
    const video = input({ angleCount: 4 });
    expect(gradeSource(video, deriveSourceWarnings(video))).toBe("excellent");
  });

  it("calls a source without shoulders limited", () => {
    const faceOnly = input({ pose: null });
    expect(gradeSource(faceOnly, deriveSourceWarnings(faceOnly))).toBe("limited");
  });

  it("does not reject an otherwise useful face-only image", () => {
    // Limited is a usable source with less range, not a refusal.
    const faceOnly = evaluateSource(input({ pose: null }));
    expect(faceOnly.grade).toBe("limited");
    expect(faceOnly.capabilities.face).toBe(true);
    expect(faceOnly.capabilities.expressions).toBe(true);
  });

  it("calls a cropped head limited however good the rest is", () => {
    const cropped = input({
      angleCount: 4,
      face: face({ bounds: { minX: 0.38, minY: 0.01, maxX: 0.62, maxY: 0.35 } }),
    });
    expect(gradeSource(cropped, deriveSourceWarnings(cropped))).toBe("limited");
  });
});

describe("movement envelope", () => {
  const angles = { left: false, right: false, up: false, down: false, count: 1 };

  it("is symmetric for a front-facing still", () => {
    const envelope = deriveMovementEnvelope(face({ yaw: 0 }), pose(), angles);
    expect(envelope.yawLeft).toBeCloseTo(envelope.yawRight, 10);
    expect(envelope.basis).toBe("single-image");
  });

  it("spends a source's existing turn against that direction", () => {
    /*
     * The governing fact: a photograph contains no information about a side of
     * a head it never showed. A source already turned towards the subject's
     * left has used up part of its leftward room and gained the same rightward,
     * because turning back towards centre reveals only what is already there.
     */
    const turnedLeft = deriveMovementEnvelope(face({ yaw: 0.3 }), pose(), angles);

    expect(turnedLeft.yawLeft).toBeLessThan(turnedLeft.yawRight);
    expect(turnedLeft.yawRight).toBeCloseTo(deriveMovementEnvelope(face({ yaw: 0 }), pose(), angles).yawRight, 10);
  });

  it("does the same the other way", () => {
    const turnedRight = deriveMovementEnvelope(face({ yaw: -0.3 }), pose(), angles);
    expect(turnedRight.yawRight).toBeLessThan(turnedRight.yawLeft);
  });

  it("never collapses to nothing, however angled the source", () => {
    const extreme = deriveMovementEnvelope(face({ yaw: 1.2, pitch: 0.9 }), pose(), angles);
    expect(extreme.yawLeft).toBeGreaterThan(0);
    expect(extreme.pitchUp).toBeGreaterThan(0);
  });

  it("gives a multi-angle video more room than a still", () => {
    // It genuinely saw more.
    const still = deriveMovementEnvelope(face(), pose(), angles);
    const video = deriveMovementEnvelope(face(), pose(), {
      left: true,
      right: true,
      up: true,
      down: true,
      count: 5,
    });

    expect(video.yawLeft).toBeGreaterThan(still.yawLeft);
    expect(video.scaleMax).toBeGreaterThan(still.scaleMax);
    expect(video.basis).toBe("multi-angle-video");
  });

  it("only widens the directions the video actually covered", () => {
    const leftOnly = deriveMovementEnvelope(face(), pose(), {
      left: true,
      right: false,
      up: false,
      down: false,
      count: 2,
    });

    expect(leftOnly.yawLeft).toBeGreaterThan(leftOnly.yawRight);
  });

  it("leaves translation unconstrained without shoulders to anchor it", () => {
    expect(deriveMovementEnvelope(face(), null, angles).translation).toBeNull();
    expect(deriveMovementEnvelope(face(), pose(), angles).translation).not.toBeNull();
  });
});
