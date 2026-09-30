import type { CalibrationCollectorState } from "../engine/calibrationCollector";
import type { CalibrationQuality, CalibrationWarning } from "../engine/calibrationTypes";

/**
 * What the Studio says during a calibration.
 *
 * Minimal and calm. This is a person being asked to sit still and look at a
 * camera for a second — not a biometric enrolment, and it must not read like
 * one. One short line at a time, no progress percentages in the copy, no
 * instrument panel.
 *
 * Pure, so the wording is pinned by test rather than discovered on a device.
 */

export interface CalibrationGuidance {
  /** The single line shown over the preview. */
  message: string;
  /** Supporting line, only where it genuinely helps. */
  detail: string | null;
  /** Whether the operator is being asked to do something. */
  actionable: boolean;
}

const HOLD_STILL: CalibrationGuidance = {
  message: "Hold still",
  detail: null,
  actionable: true,
};

/**
 * The line for the current state.
 *
 * Ordered by what most needs saying. Only one problem is raised at a time,
 * because a list of four things to fix is a list nobody reads — and the
 * rejection reason already tells us which one is actually blocking.
 */
export function describeCalibration(state: CalibrationCollectorState): CalibrationGuidance {
  switch (state.phase) {
    case "idle":
      return {
        message: "Look at the camera",
        detail: "Calibration captures your resting position so later movement is measured from it.",
        actionable: false,
      };

    case "waiting-for-stable-tracking":
      return describeWaiting(state);

    case "collecting":
      // Past two thirds it is worth saying it is nearly over, so nobody moves
      // at the last moment.
      return state.progress > 0.66
        ? { message: "Almost ready…", detail: null, actionable: false }
        : HOLD_STILL;

    case "evaluating":
      return { message: "Almost ready…", detail: null, actionable: false };

    case "ready":
      return { message: "Calibration complete", detail: null, actionable: false };

    case "failed":
      return describeFailure(state);
  }
}

function describeWaiting(state: CalibrationCollectorState): CalibrationGuidance {
  switch (state.rejection) {
    case "no-face":
    case "low-confidence":
      return { message: "Look at the camera", detail: null, actionable: true };

    case "invalid-geometry":
      return { message: "Tracking is unsteady", detail: "More even lighting usually helps.", actionable: true };

    case "too-far":
      return { message: "Move a little closer", detail: null, actionable: true };

    case "too-close":
      return { message: "Move back slightly", detail: null, actionable: true };

    case "head-angled":
      return { message: "Face the camera directly", detail: null, actionable: true };

    case "face-near-edge":
      return { message: "Center your face", detail: null, actionable: true };

    case "no-pose":
    case "partial-pose":
      return {
        message: "Move back slightly so both shoulders are visible",
        detail: null,
        actionable: true,
      };

    case null:
      // Frames are being accepted; the operator simply has not settled yet.
      return state.stability && !state.stability.stable
        ? { message: "Hold still for a moment", detail: null, actionable: true }
        : HOLD_STILL;
  }
}

function describeFailure(state: CalibrationCollectorState): CalibrationGuidance {
  switch (state.failure) {
    case "no-face":
      return {
        message: "Could not find your face",
        detail: "Make sure your face is lit and fully in frame, then try again.",
        actionable: true,
      };

    case "pose-unavailable":
      return {
        message: "Could not see both shoulders",
        detail: "Move back so your shoulders are in frame, or calibrate your face only.",
        actionable: true,
      };

    case "unstable":
      return {
        message: "Could not get a steady reading",
        detail: "Rest your arms and hold a comfortable position, then try again.",
        actionable: true,
      };

    case "timeout":
      return { message: "Calibration timed out", detail: "Try again when you are settled.", actionable: true };

    case "cancelled":
      return { message: "Calibration cancelled", detail: null, actionable: false };

    case null:
      return { message: "Calibration did not complete", detail: null, actionable: true };
  }
}

const QUALITY_LABEL: Record<CalibrationQuality, string> = {
  excellent: "Excellent",
  good: "Good",
  limited: "Limited",
};

const QUALITY_DETAIL: Record<CalibrationQuality, string> = {
  excellent: "Face and shoulders captured cleanly.",
  good: "Face and shoulders captured.",
  // Named plainly rather than dressed up: it drives head motion and nothing else.
  limited: "Limited upper-body tracking — head movement only.",
};

export function describeQuality(quality: CalibrationQuality): { label: string; detail: string } {
  return { label: QUALITY_LABEL[quality], detail: QUALITY_DETAIL[quality] };
}

/** Informational, never a failure. Each says what it means for the result. */
const WARNING_COPY: Record<CalibrationWarning, string> = {
  "shoulders-outside-frame": "Your shoulders sit close to the edge of the frame.",
  "head-strongly-angled": "Your resting head position is noticeably angled.",
  "tracking-unstable": "Tracking was less steady than usual during calibration.",
  "face-near-edge": "Your face sits near the edge of the frame.",
  "upper-body-unavailable": "Shoulders were not captured, so upper-body movement is unavailable.",
};

export function describeWarning(warning: CalibrationWarning): string {
  return WARNING_COPY[warning];
}
