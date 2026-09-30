import type { SourceAnalysisProgress } from "../source/sourceTypes";
import type { SourceGrade, SourceWarning } from "../source/sourceTypes";

/**
 * What the Studio says about a source.
 *
 * Pure, so the wording is pinned by test. Two rules run through all of it: say
 * only what was measured, and say what it means for the result rather than
 * naming an internal state.
 *
 * In particular, nothing here mentions blur or lighting. Neither is measured
 * anywhere in this project, and telling somebody their photograph is blurry on
 * the strength of a guess makes them replace an image that was fine.
 */

const STAGE_COPY: Record<SourceAnalysisProgress["stage"], string> = {
  idle: "",
  preparing: "Preparing",
  decoding: "Preparing image",
  "loading-models": "Loading analysis models",
  "analyzing-face": "Analyzing face",
  "analyzing-pose": "Analyzing upper body",
  "loading-video": "Loading video",
  sampling: "Choosing frames",
  "analyzing-frames": "Analyzing frames",
  "selecting-references": "Selecting references",
  evaluating: "Evaluating source",
  done: "Ready",
  failed: "Could not analyze this source",
};

/**
 * The progress line.
 *
 * `Analyzing 3 / 12` counts frames genuinely analysed. Nothing advances on a
 * timer — a bar that reaches 85% because 850ms elapsed is a lie told to
 * somebody who is waiting.
 */
export function describeProgress(progress: SourceAnalysisProgress): string {
  if (progress.stage === "analyzing-frames" && progress.frame && progress.frameCount) {
    return `Analyzing ${progress.frame} / ${progress.frameCount}`;
  }
  return STAGE_COPY[progress.stage];
}

/** 0..1, from frames actually analysed. Null wherever there is nothing to count. */
export function progressFraction(progress: SourceAnalysisProgress): number | null {
  if (progress.stage === "analyzing-frames" && progress.frame && progress.frameCount) {
    return Math.min(1, progress.frame / progress.frameCount);
  }
  return null;
}

const GRADE_LABEL: Record<SourceGrade, string> = {
  excellent: "Excellent",
  good: "Good",
  limited: "Limited",
  unusable: "Not usable",
};

const GRADE_DETAIL: Record<SourceGrade, string> = {
  excellent: "Face, upper body and several head angles.",
  good: "Face and upper body captured cleanly.",
  limited: "Usable, with less movement range than a full source.",
  unusable: "No usable face was found in this source.",
};

export function describeGrade(grade: SourceGrade): { label: string; detail: string } {
  return { label: GRADE_LABEL[grade], detail: GRADE_DETAIL[grade] };
}

/** Each says what it means for the result, not what rule fired. */
const WARNING_COPY: Record<SourceWarning, string> = {
  "face-near-edge": "The face sits near the edge of the frame.",
  "head-strongly-angled": "The head is already strongly angled, which limits how much further it can turn.",
  "shoulders-not-visible": "Shoulders are not visible, so upper-body movement is unavailable.",
  "one-shoulder-only": "Only one shoulder is clearly visible, so upper-body movement will be limited.",
  "shoulders-cropped": "A shoulder is partially outside the frame.",
  "head-region-cropped": "The top of the head is cut off in this source.",
  "low-resolution": "This source is low resolution.",
  "small-face": "The face is small in the frame, so there is less detail to work from.",
  "single-image-limited-coverage": "A single image gives limited coverage of extreme head turns.",
  "few-reference-angles": "This video offered only a couple of usable head angles.",
};

export function describeSourceWarning(warning: SourceWarning): string {
  return WARNING_COPY[warning];
}

/**
 * The capability rows.
 *
 * Three states rather than a tick or a cross, because "limited" is the honest
 * answer for most real sources and collapsing it either way misleads.
 */
export type CapabilityLevel = "ready" | "limited" | "unavailable";

export const CAPABILITY_LABEL: Record<CapabilityLevel, string> = {
  ready: "Ready",
  limited: "Limited",
  unavailable: "Unavailable",
};

/** How much head movement the envelope actually allows, in words. */
export function describeHeadRoom(yawLeft: number, yawRight: number): CapabilityLevel {
  const smaller = Math.min(yawLeft, yawRight);
  // ~17° either way is a usable turn; below ~9° there is very little room.
  if (smaller >= 0.3) return "ready";
  if (smaller >= 0.16) return "limited";
  return "unavailable";
}

const ANGLE_LABEL = {
  front: "Front",
  "slight-left": "Left",
  "slight-right": "Right",
  "slight-up": "Up",
  "slight-down": "Down",
} as const;

export function describeAngle(angle: keyof typeof ANGLE_LABEL): string {
  return ANGLE_LABEL[angle];
}
