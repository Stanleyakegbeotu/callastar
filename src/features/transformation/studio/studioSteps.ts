import type { CalibrationPhase } from "../engine/calibrationTypes";
import type { TransformationState } from "../engine/transformationPhase";

import type { SourceStage } from "./useSourceSelection";

/**
 * The Studio's six steps.
 *
 * Shown in full from the first visit. Save is visibly unavailable until a later
 * milestone adds persistence, so the Preview does not look like a finished
 * transformation workflow.
 *
 * The five built steps do not have to run in order. A source can be prepared
 * before a camera has ever been started, and tracking and calibration can be
 * exercised with no source at all — which is a development path, and the rail
 * shows it as one by marking only what has actually happened.
 */

export type StudioStepId = "source" | "analyze" | "camera" | "calibrate" | "preview" | "save";

export type StudioStepStatus =
  /** Finished. */
  | "done"
  /** Where the operator is now. */
  | "current"
  /** Built, reachable, not yet reached. */
  | "upcoming"
  /** Not built yet. Says so, rather than looking merely disabled. */
  | "unbuilt";

export interface StudioStep {
  id: StudioStepId;
  label: string;
  status: StudioStepStatus;
  /** Shown on an unbuilt step, so the rail explains itself. */
  note: string | null;
}

const ORDER: readonly StudioStepId[] = ["source", "analyze", "camera", "calibrate", "preview", "save"];

const LABELS: Record<StudioStepId, string> = {
  source: "Source",
  analyze: "Analyze",
  camera: "Camera",
  calibrate: "Calibrate",
  preview: "Preview",
  save: "Save",
};

/**
 * What exists today.
 *
 * One constant, so a milestone turns its step on by adding an id here rather
 * than by editing the rail in several places. Camera proved the live input
 * pipeline; Calibrate turns it into a stable baseline; Preview applies that
 * baseline to the selected source face.
 */
export const BUILT_STEPS: readonly StudioStepId[] = ["source", "analyze", "camera", "calibrate", "preview"];

/** Why each unbuilt step is not there yet, in the operator's terms. */
const NOTES: Partial<Record<StudioStepId, string>> = {
  save: "There is no transformation to save yet.",
};

function isBuilt(id: StudioStepId): boolean {
  return BUILT_STEPS.includes(id);
}

/**
 * Where the operator is in the source half of the pipeline.
 *
 * `Source` is done once an asset is chosen; `Analyze` is done once it has been
 * analysed. Nothing is marked complete on the strength of a step merely being
 * reachable — an unanalysed source is a chosen source and nothing more.
 */
function sourceStatus(stage: SourceStage): { source: StudioStepStatus; analyze: StudioStepStatus } {
  switch (stage) {
    case "empty":
      return { source: "current", analyze: "upcoming" };
    case "selected":
    case "failed":
      return { source: "done", analyze: "current" };
    case "analyzing":
      return { source: "done", analyze: "current" };
    case "ready":
      return { source: "done", analyze: "done" };
  }
}

/**
 * Where the operator is in the live half.
 *
 * Null while nothing has started, so the rail does not point at a step the
 * operator has not reached.
 */
function liveStep(state: TransformationState, calibration: CalibrationPhase): StudioStepId | null {
  if (state.phase === "disposed" || state.phase === "idle") return null;
  if (state.phase === "loading-dependencies" || state.phase === "loading-models") return null;

  if (calibration === "ready") return null;
  if (calibration !== "idle") return "calibrate";
  return "camera";
}

export function deriveStudioSteps(
  state: TransformationState,
  calibration: CalibrationPhase = "idle",
  sourceStage: SourceStage = "empty",
): StudioStep[] {
  const source = sourceStatus(sourceStage);
  const live = liveStep(state, calibration);
  const calibrated = calibration === "ready";

  const statusFor = (id: StudioStepId): StudioStepStatus => {
    if (id === "source") return source.source;
    if (id === "analyze") return source.analyze;

    // The live half only reports progress once something in it has started.
    if (id === "camera") {
      if (calibrated || live === "calibrate") return "done";
      return live === "camera" ? "current" : "upcoming";
    }

    if (id === "preview") return calibrated && source.analyze === "done" ? "current" : "upcoming";

    if (calibrated) return "done";
    return live === "calibrate" ? "current" : "upcoming";
  };

  return ORDER.map((id) => {
    if (!isBuilt(id)) {
      return { id, label: LABELS[id], status: "unbuilt" as const, note: NOTES[id] ?? null };
    }
    return { id, label: LABELS[id], status: statusFor(id), note: null };
  });
}
