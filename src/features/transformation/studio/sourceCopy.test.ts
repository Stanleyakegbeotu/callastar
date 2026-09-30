import { describe, expect, it } from "vitest";

import { REFERENCE_ANGLES, type SourceAnalysisProgress, type SourceGrade, type SourceWarning } from "../source/sourceTypes";

import {
  CAPABILITY_LABEL,
  describeAngle,
  describeGrade,
  describeHeadRoom,
  describeProgress,
  describeSourceWarning,
  progressFraction,
} from "./sourceCopy";

/**
 * What the Studio says about a source.
 *
 * Two rules under test as much as the wording: say only what was measured, and
 * say what it means for the result rather than naming an internal state.
 */

const ALL_WARNINGS: SourceWarning[] = [
  "face-near-edge",
  "head-strongly-angled",
  "shoulders-not-visible",
  "one-shoulder-only",
  "shoulders-cropped",
  "head-region-cropped",
  "low-resolution",
  "small-face",
  "single-image-limited-coverage",
  "few-reference-angles",
];

const ALL_GRADES: SourceGrade[] = ["excellent", "good", "limited", "unusable"];

function progress(overrides: Partial<SourceAnalysisProgress> = {}): SourceAnalysisProgress {
  return { stage: "idle", frame: null, frameCount: null, ...overrides };
}

describe("progress copy", () => {
  it("names the work being done", () => {
    expect(describeProgress(progress({ stage: "decoding" }))).toBe("Preparing image");
    expect(describeProgress(progress({ stage: "analyzing-face" }))).toBe("Analyzing face");
    expect(describeProgress(progress({ stage: "analyzing-pose" }))).toBe("Analyzing upper body");
    expect(describeProgress(progress({ stage: "loading-video" }))).toBe("Loading video");
    expect(describeProgress(progress({ stage: "selecting-references" }))).toBe("Selecting references");
    expect(describeProgress(progress({ stage: "evaluating" }))).toBe("Evaluating source");
  });

  it("counts frames genuinely analysed", () => {
    expect(describeProgress(progress({ stage: "analyzing-frames", frame: 3, frameCount: 12 }))).toBe(
      "Analyzing 3 / 12",
    );
  });

  it("does not invent a count it does not have", () => {
    // Mid-stage with no frame numbers yet: a generic line, not "Analyzing 0 / 0".
    expect(describeProgress(progress({ stage: "analyzing-frames" }))).toBe("Analyzing frames");
  });

  it("offers a fraction only where there is something real to count", () => {
    /*
     * A bar that reaches 85% because 850ms elapsed is a lie told to somebody
     * who is waiting. Everything except frame counting returns null, and the
     * panel shows an indeterminate bar instead.
     */
    expect(progressFraction(progress({ stage: "analyzing-frames", frame: 6, frameCount: 12 }))).toBeCloseTo(0.5, 6);
    expect(progressFraction(progress({ stage: "decoding" }))).toBeNull();
    expect(progressFraction(progress({ stage: "loading-models" }))).toBeNull();
    expect(progressFraction(progress({ stage: "evaluating" }))).toBeNull();
  });

  it("never exceeds one", () => {
    expect(progressFraction(progress({ stage: "analyzing-frames", frame: 14, frameCount: 12 }))).toBe(1);
  });
});

describe("grade copy", () => {
  it("does not call a good single image excellent", () => {
    expect(describeGrade("good").label).toBe("Good");
    expect(describeGrade("excellent").detail).toMatch(/several head angles/i);
  });

  it("names an unusable source plainly", () => {
    expect(describeGrade("unusable").label).toBe("Not usable");
    expect(describeGrade("unusable").detail).toMatch(/no usable face/i);
  });

  it("says what limited means rather than softening it", () => {
    expect(describeGrade("limited").detail).toMatch(/less movement range/i);
  });

  it("quotes no percentage anywhere", () => {
    // A figure like "94%" implies a model produced it. None did.
    for (const grade of ALL_GRADES) {
      const described = describeGrade(grade);
      expect(`${described.label} ${described.detail}`, grade).not.toMatch(/%|\d\d\s*percent/i);
    }
  });
});

describe("warning copy", () => {
  it("says what each one means for the result", () => {
    expect(describeSourceWarning("shoulders-not-visible")).toMatch(/upper-body movement is unavailable/i);
    expect(describeSourceWarning("head-strongly-angled")).toMatch(/how much further it can turn/i);
    expect(describeSourceWarning("single-image-limited-coverage")).toMatch(/extreme head turns/i);
    expect(describeSourceWarning("head-region-cropped")).toMatch(/top of the head is cut off/i);
  });

  it("never claims anything about blur or lighting", () => {
    /*
     * The rule this file exists to enforce.
     *
     * Nothing in this project measures either. Telling somebody their
     * photograph is blurry on the strength of a guess makes them throw away an
     * image that was fine.
     */
    for (const warning of ALL_WARNINGS) {
      const copy = describeSourceWarning(warning);
      expect(copy, warning).not.toMatch(/blurr?y|blur|lighting|poorly lit|underexposed|sharpness|noisy/i);
    }
  });

  it("reads as information, not as a fault", () => {
    for (const warning of ALL_WARNINGS) {
      expect(describeSourceWarning(warning), warning).not.toMatch(/error|failed|invalid|rejected/i);
    }
  });

  it("covers every warning the analyser can produce", () => {
    // A missing entry would render as an empty bullet.
    for (const warning of ALL_WARNINGS) {
      expect(describeSourceWarning(warning).length, warning).toBeGreaterThan(10);
    }
  });
});

describe("head room", () => {
  it("reports the tighter direction, not the generous one", () => {
    /*
     * An envelope with plenty of room one way and almost none the other is
     * limited: a renderer turning the head towards the tight side runs out
     * first, and averaging the two would hide that.
     */
    expect(describeHeadRoom(0.5, 0.05)).toBe("unavailable");
    expect(describeHeadRoom(0.05, 0.5)).toBe("unavailable");
  });

  it("grades a comfortable envelope as ready", () => {
    expect(describeHeadRoom(0.44, 0.44)).toBe("ready");
  });

  it("grades a modest envelope as limited", () => {
    expect(describeHeadRoom(0.2, 0.25)).toBe("limited");
  });

  it("labels every level", () => {
    for (const level of ["ready", "limited", "unavailable"] as const) {
      expect(CAPABILITY_LABEL[level].length).toBeGreaterThan(0);
    }
  });
});

describe("angle labels", () => {
  it("names every reference angle", () => {
    for (const angle of REFERENCE_ANGLES) {
      expect(describeAngle(angle).length, angle).toBeGreaterThan(0);
    }
  });

  it("uses short labels a strip can hold", () => {
    expect(describeAngle("slight-left")).toBe("Left");
    expect(describeAngle("front")).toBe("Front");
    for (const angle of REFERENCE_ANGLES) {
      expect(describeAngle(angle).length, angle).toBeLessThan(8);
    }
  });
});
