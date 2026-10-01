import type { FaceTrackingResult } from "../engine/faceTypes";
import type { PoseTrackingResult } from "../engine/poseTypes";

/**
 * What the Studio tells the operator about their own framing.
 *
 * Pure, and kept apart from the components, because this is the part that is
 * easy to get subtly wrong: an ordinary moment — someone leaning out of frame to
 * reach a cable — must read as guidance, not as a failure. Only `tracking-lost`
 * is a problem, and even that is phrased as something to do rather than
 * something that broke.
 *
 * Nothing here persists, logs or transmits anything. It reads the current
 * frame's result and returns a sentence.
 */

export type TrackingQuality =
  /** Face and shoulders both solid. */
  | "good"
  /** Usable, but something is worth correcting. */
  | "fair"
  /** Not enough to work with. */
  | "poor"
  /** The loop is not running. */
  | "idle";

export interface TrackingGuidance {
  quality: TrackingQuality;
  /** Two or three words for the status chip. */
  label: string;
  /** One sentence, addressed to the operator. Never a raw error. */
  detail: string;
}

/**
 * Below this the face landmarks are a guess.
 *
 * Deliberately generous: the confidence is derived rather than reported by the
 * model (see `estimateConfidence`), so treating it as a hard gate would reject
 * frames that look perfectly fine on screen.
 */
export const LOW_FACE_CONFIDENCE = 0.4;

/** Interocular distance below which the operator is too far from the camera. */
export const MIN_FACE_SCALE = 0.045;

/**
 * Framing advice, not a tracking limit. Nothing stops when it is crossed.
 *
 * Eye span as a fraction of frame width. An ordinary head-and-shoulders phone
 * call measured 0.23 — and the old 0.22 called that "too close", which is
 * the phone complaint. With the eye span about 0.65 of face width and the face
 * about 1.35 times as tall as wide, 0.45 is a face filling ~70% of a portrait
 * frame's width with its chin and forehead still in. Past that, a small lean
 * crops it. Geometric, not yet a measured phone range.
 */
export const MAX_FACE_SCALE = 0.45;

/** Bounds this close to the top or bottom edge are already cropping the face. */
export const FRAME_EDGE_MARGIN = 0.01;

/** Radians. Beyond this a profile view loses the far side of the mesh. */
export const MAX_COMFORTABLE_YAW = 0.6;

const IDLE: TrackingGuidance = {
  quality: "idle",
  label: "Not tracking",
  detail: "Start the camera to see live face and shoulder tracking.",
};

/**
 * The guidance for one frame.
 *
 * Ordered by what most needs saying: no face at all beats a face that is merely
 * badly framed, and framing beats a missing shoulder. Only one sentence is shown
 * at a time, so the order decides which problem the operator fixes first.
 */
export function describeTracking(
  face: FaceTrackingResult | null,
  pose: PoseTrackingResult | null,
  options: { running: boolean },
): TrackingGuidance {
  if (!options.running) return IDLE;

  // Before the first inference lands there is nothing to report, and claiming a
  // problem would be inventing one.
  if (!face && !pose) {
    return { quality: "idle", label: "Starting", detail: "Waiting for the first tracked frame." };
  }

  if (!face || !face.detected) {
    return {
      quality: "poor",
      label: "No face",
      detail: "Look towards the camera so your whole face is in frame.",
    };
  }

  const derived = face.derived;

  if (face.confidence < LOW_FACE_CONFIDENCE) {
    return {
      quality: "poor",
      label: "Weak tracking",
      detail: "Tracking is unsteady. More even lighting on your face usually fixes it.",
    };
  }

  if (derived) {
    if (derived.scale < MIN_FACE_SCALE) {
      return { quality: "fair", label: "Too far", detail: "Move a little closer to the camera." };
    }

    const cropped = derived.bounds.minY < FRAME_EDGE_MARGIN || derived.bounds.maxY > 1 - FRAME_EDGE_MARGIN;
    if (derived.scale > MAX_FACE_SCALE || cropped) {
      return { quality: "fair", label: "Too close", detail: "Move back slightly for the best framing. Tracking continues." };
    }

    if (Math.abs(derived.yaw) > MAX_COMFORTABLE_YAW) {
      return {
        quality: "fair",
        label: "Turned away",
        detail: "Face the camera more directly — a full profile hides half the tracked points.",
      };
    }
  }

  // The face is fine, so anything remaining is about the shoulders. A missing
  // pose is common and unalarming: it usually means the camera is cropped close.
  const trackability = pose?.derived?.trackability ?? (pose?.detected ? "partial" : "lost");

  if (trackability === "lost") {
    return {
      quality: "fair",
      label: "Face only",
      detail: "Move back slightly so your shoulders are visible.",
    };
  }

  if (trackability === "partial") {
    return {
      quality: "fair",
      label: "One shoulder",
      detail: "Centre yourself so both shoulders are in frame.",
    };
  }

  return { quality: "good", label: "Tracking", detail: "Face and shoulders are tracking steadily." };
}

/**
 * Whether the overlay should be drawn at all.
 *
 * A stale mesh left on screen after tracking drops is worse than no mesh: it
 * looks like it is still working.
 */
export function shouldDrawFace(face: FaceTrackingResult | null): boolean {
  return !!face && face.detected && face.landmarks.length > 0;
}

export function shouldDrawPose(pose: PoseTrackingResult | null): boolean {
  return !!pose && pose.detected && pose.landmarks.length > 0;
}
