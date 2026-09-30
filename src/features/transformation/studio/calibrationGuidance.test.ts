import { describe, expect, it } from "vitest";

import { CalibrationCollector } from "../engine/calibrationCollector";
import type { CalibrationCollectorState } from "../engine/calibrationCollector";

import { describeCalibration, describeQuality, describeWarning } from "./calibrationGuidance";

/**
 * What the Studio says while it calibrates.
 *
 * Tone is the thing under test as much as logic. This is a person being asked
 * to sit still and look at a camera for a second — the copy must read like
 * that, not like an instrument reporting a fault.
 */

function state(overrides: Partial<CalibrationCollectorState> = {}): CalibrationCollectorState {
  return { ...new CalibrationCollector().getState(), ...overrides };
}

describe("before anything starts", () => {
  it("explains what calibration is for, without instructions", () => {
    const guidance = describeCalibration(state({ phase: "idle" }));
    expect(guidance.message).toBe("Look at the camera");
    expect(guidance.detail).toMatch(/resting position/i);
  });
});

describe("while waiting for the operator to settle", () => {
  const waiting = (rejection: CalibrationCollectorState["rejection"]) =>
    describeCalibration(state({ phase: "waiting-for-stable-tracking", rejection }));

  it("asks for the one thing that is actually blocking", () => {
    // One sentence at a time. A list of four things to fix is a list nobody
    // reads, and the rejection reason already says which one matters.
    expect(waiting("no-face").message).toBe("Look at the camera");
    expect(waiting("too-far").message).toMatch(/closer/i);
    expect(waiting("too-close").message).toMatch(/back/i);
    expect(waiting("face-near-edge").message).toBe("Center your face");
    expect(waiting("head-angled").message).toMatch(/directly/i);
    expect(waiting("no-pose").message).toMatch(/both shoulders are visible/i);
  });

  it("says hold still when frames are being accepted but the reading is moving", () => {
    const guidance = describeCalibration(
      state({
        phase: "waiting-for-stable-tracking",
        rejection: null,
        stability: { stable: false, score: 0.2, worstQuantity: "yaw", worstRatio: 1.6, dispersion: {} },
      }),
    );

    expect(guidance.message).toBe("Hold still for a moment");
  });

  it("never blames the operator or reports an error", () => {
    for (const rejection of [
      "no-face",
      "low-confidence",
      "invalid-geometry",
      "too-far",
      "too-close",
      "head-angled",
      "face-near-edge",
      "no-pose",
      "partial-pose",
      null,
    ] as const) {
      const guidance = waiting(rejection);
      expect(guidance.message, `${rejection}`).not.toMatch(/error|fail|invalid|cannot|unable/i);
      expect(guidance.message.length, `${rejection}`).toBeLessThan(60);
    }
  });
});

describe("during collection", () => {
  it("says hold still, then that it is nearly over", () => {
    // The "almost" matters: it stops somebody moving at the last moment.
    expect(describeCalibration(state({ phase: "collecting", progress: 0.2 })).message).toBe("Hold still");
    expect(describeCalibration(state({ phase: "collecting", progress: 0.9 })).message).toBe("Almost ready…");
    expect(describeCalibration(state({ phase: "evaluating" })).message).toBe("Almost ready…");
  });

  it("says complete, and nothing more", () => {
    const guidance = describeCalibration(state({ phase: "ready" }));
    expect(guidance.message).toBe("Calibration complete");
    expect(guidance.detail).toBeNull();
  });
});

describe("when it does not work", () => {
  it("tells the operator what to do about it", () => {
    const noFace = describeCalibration(state({ phase: "failed", failure: "no-face" }));
    expect(noFace.detail).toMatch(/lit and fully in frame/i);
    expect(noFace.actionable).toBe(true);

    const unstable = describeCalibration(state({ phase: "failed", failure: "unstable" }));
    expect(unstable.detail).toMatch(/comfortable position/i);
  });

  it("offers face-only as the way out of a missing-shoulders failure", () => {
    const guidance = describeCalibration(state({ phase: "failed", failure: "pose-unavailable" }));
    expect(guidance.detail).toMatch(/face only/i);
  });

  it("says nothing reproachful when the operator cancelled", () => {
    const guidance = describeCalibration(state({ phase: "failed", failure: "cancelled" }));
    expect(guidance.message).toBe("Calibration cancelled");
    expect(guidance.actionable).toBe(false);
  });
});

describe("quality copy", () => {
  it("names limited as limited", () => {
    /*
     * A face-only baseline drives head movement and nothing else. Calling it
     * anything softer would let somebody build on it expecting upper-body
     * motion that is not there.
     */
    const limited = describeQuality("limited");
    expect(limited.label).toBe("Limited");
    expect(limited.detail).toMatch(/head movement only/i);
  });

  it("does not dress up a good result as an excellent one", () => {
    expect(describeQuality("excellent").label).toBe("Excellent");
    expect(describeQuality("good").label).toBe("Good");
    expect(describeQuality("good").detail).not.toMatch(/cleanly/i);
  });

  it("quotes no percentage anywhere", () => {
    // A number like "94% confidence" implies a model produced it. None did.
    for (const quality of ["excellent", "good", "limited"] as const) {
      const described = describeQuality(quality);
      expect(`${described.label} ${described.detail}`).not.toMatch(/%|\d\d\s*percent/i);
    }
  });
});

describe("warning copy", () => {
  it("says what each one means for the result", () => {
    expect(describeWarning("upper-body-unavailable")).toMatch(/upper-body movement is unavailable/i);
    expect(describeWarning("head-strongly-angled")).toMatch(/resting head position/i);
    expect(describeWarning("shoulders-outside-frame")).toMatch(/edge of the frame/i);
  });

  it("reads as information, not as a fault", () => {
    for (const warning of [
      "shoulders-outside-frame",
      "head-strongly-angled",
      "tracking-unstable",
      "face-near-edge",
      "upper-body-unavailable",
    ] as const) {
      expect(describeWarning(warning), warning).not.toMatch(/error|failed|invalid/i);
    }
  });
});
