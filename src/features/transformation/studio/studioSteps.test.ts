import { describe, expect, it } from "vitest";

import {
  initialTransformationState,
  type TransformationState,
} from "../engine/transformationPhase";

import { BUILT_STEPS, deriveStudioSteps, type StudioStepId } from "./studioSteps";

/**
 * The step rail.
 *
 * Its job is to be honest about how much of the Studio exists. A rail that
 * quietly hid the five unbuilt steps would make a tracking preview look like a
 * finished transformation tool.
 */

function state(overrides: Partial<TransformationState> = {}): TransformationState {
  return { ...initialTransformationState, ...overrides };
}

function statusOf(steps: ReturnType<typeof deriveStudioSteps>, id: StudioStepId) {
  return steps.find((step) => step.id === id)?.status;
}

describe("shape", () => {
  it("always shows all six steps in order", () => {
    const steps = deriveStudioSteps(state());
    expect(steps.map((step) => step.id)).toEqual([
      "source",
      "analyze",
      "camera",
      "calibrate",
      "preview",
      "save",
    ]);
  });

  it("marks everything that is not built as unbuilt, with a reason", () => {
    const steps = deriveStudioSteps(state({ phase: "running", camera: "live" }));

    for (const step of steps) {
      if (BUILT_STEPS.includes(step.id)) {
        expect(step.status, step.id).not.toBe("unbuilt");
        expect(step.note, step.id).toBeNull();
      } else {
        expect(step.status, step.id).toBe("unbuilt");
        // A greyed-out step with no explanation reads as a rendering fault.
        expect(step.note, step.id).toBeTruthy();
      }
    }
  });

  it("says plainly that the transformation cannot be saved yet", () => {
    const save = deriveStudioSteps(state()).find((step) => step.id === "save");
    expect(save?.note).toMatch(/no transformation to save/i);
  });

  it("names the five built steps, and nothing else", () => {
    expect([...BUILT_STEPS]).toEqual(["source", "analyze", "camera", "calibrate", "preview"]);
  });

  it("does not mark Analyze complete merely because a source was chosen", () => {
    /*
     * An unanalysed source is a chosen source and nothing more. Marking Analyze
     * done on the strength of a file being picked would claim geometry the
     * pipeline does not have.
     */
    const steps = deriveStudioSteps(state({ phase: "running", camera: "live" }), "idle", "selected");

    expect(statusOf(steps, "source")).toBe("done");
    expect(statusOf(steps, "analyze")).toBe("current");
  });
});

describe("current step", () => {
  it("is nothing before the Studio has started", () => {
    expect(statusOf(deriveStudioSteps(state()), "camera")).toBe("upcoming");
  });

  it("stays upcoming while the models are still loading", () => {
    // There is nothing for the operator to do during a download, and marking
    // Camera as current would suggest otherwise.
    expect(statusOf(deriveStudioSteps(state({ phase: "loading-models" })), "camera")).toBe("upcoming");
  });

  it("is Camera once the runtime is up", () => {
    for (const phase of ["source-selected", "camera-request", "ready", "running", "paused"] as const) {
      expect(statusOf(deriveStudioSteps(state({ phase })), "camera"), phase).toBe("current");
    }
  });

  it("stays Camera through a flip", () => {
    // A flip must not make the rail jump: the engine never stopped.
    const steps = deriveStudioSteps(state({ phase: "running", camera: "switching" }));
    expect(statusOf(steps, "camera")).toBe("current");
  });

  it("returns to upcoming after disposal", () => {
    expect(statusOf(deriveStudioSteps(state({ phase: "disposed" })), "camera")).toBe("upcoming");
  });

  it("keeps Camera current on a failure, rather than losing the operator's place", () => {
    const steps = deriveStudioSteps(state({ phase: "failed", camera: "denied" }));
    expect(statusOf(steps, "camera")).toBe("current");
  });
});

describe("calibration moves the rail on", () => {
  const live = state({ phase: "running", camera: "live" });

  it("is on Camera while no calibration has been started", () => {
    expect(statusOf(deriveStudioSteps(live, "idle"), "camera")).toBe("current");
    expect(statusOf(deriveStudioSteps(live, "idle"), "calibrate")).toBe("upcoming");
  });

  it("moves to Calibrate while a capture runs", () => {
    for (const phase of ["waiting-for-stable-tracking", "collecting", "evaluating"] as const) {
      const steps = deriveStudioSteps(live, phase);
      expect(statusOf(steps, "calibrate"), phase).toBe("current");
      expect(statusOf(steps, "camera"), phase).toBe("done");
    }
  });

  it("stays on Calibrate after a failed capture, so the retry is where it was", () => {
    expect(statusOf(deriveStudioSteps(live, "failed"), "calibrate")).toBe("current");
  });

  it("marks the live steps done once a baseline exists", () => {
    // Preview is the active step once a source and baseline both exist.
    const steps = deriveStudioSteps(live, "ready", "ready");

    expect(statusOf(steps, "camera")).toBe("done");
    expect(statusOf(steps, "calibrate")).toBe("done");
    expect(statusOf(steps, "preview")).toBe("current");
  });

  it("points at Source while the models load, because that is what can be done", () => {
    /*
     * Source analysis does not need the live runtime. A rail that showed
     * nothing during a model download would hide the one step that is actually
     * available.
     */
    const steps = deriveStudioSteps(state({ phase: "loading-models" }), "idle", "empty");

    expect(statusOf(steps, "source")).toBe("current");
    expect(statusOf(steps, "camera")).toBe("upcoming");
  });
});

describe("the source half", () => {
  const idle = state();

  it("starts on Source with nothing chosen", () => {
    const steps = deriveStudioSteps(idle, "idle", "empty");
    expect(statusOf(steps, "source")).toBe("current");
    expect(statusOf(steps, "analyze")).toBe("upcoming");
  });

  it("moves to Analyze while a source is being analysed", () => {
    expect(statusOf(deriveStudioSteps(idle, "idle", "analyzing"), "analyze")).toBe("current");
  });

  it("stays on Analyze after a failure, so the retry is where it was", () => {
    const steps = deriveStudioSteps(idle, "idle", "failed");
    expect(statusOf(steps, "source")).toBe("done");
    expect(statusOf(steps, "analyze")).toBe("current");
  });

  it("completes both once a profile exists", () => {
    const steps = deriveStudioSteps(idle, "idle", "ready");
    expect(statusOf(steps, "source")).toBe("done");
    expect(statusOf(steps, "analyze")).toBe("done");
  });

  it("advances independently of the live half", () => {
    /*
     * A source can be prepared before a camera has ever been started, and
     * tracking can be exercised with no source at all. The rail reports what
     * has actually happened in each half rather than forcing an order.
     */
    const sourceOnly = deriveStudioSteps(idle, "idle", "ready");
    expect(statusOf(sourceOnly, "analyze")).toBe("done");
    expect(statusOf(sourceOnly, "camera")).toBe("upcoming");

    const liveOnly = deriveStudioSteps(state({ phase: "running", camera: "live" }), "idle", "empty");
    expect(statusOf(liveOnly, "source")).toBe("current");
    expect(statusOf(liveOnly, "camera")).toBe("current");
  });

  it("makes Preview current and leaves Save unbuilt", () => {
    const steps = deriveStudioSteps(state({ phase: "running", camera: "live" }), "ready", "ready");
    expect(statusOf(steps, "preview")).toBe("current");
    expect(statusOf(steps, "save")).toBe("unbuilt");
  });
});
