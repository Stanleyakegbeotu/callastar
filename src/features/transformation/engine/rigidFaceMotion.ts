import type { HeadMotion } from "./relativeMotion";

/**
 * The ONE place MediaPipe's head conventions become physical ones.
 *
 * The pipeline, in order, with the only sign decisions it contains:
 *
 *   MediaPipe            facial transformation matrix, camera frame: x towards
 *                        the IMAGE right (the subject's left), y UP, z towards
 *                        the camera. Right-handed angles about those axes.
 *   calibration          `relativeMotion.ts`: deltas against the neutral, still
 *                        in MediaPipe's frame (`HeadMotion`).
 *   RigidFaceMotion      THIS module: physical, named for what the person did.
 *   Three.js             `rendering/rendererMotion.ts`: physical -> rotation.
 *   display mirror       `mirrorScaleX`, one scene flip, nowhere else.
 *
 * MEASURED, not assumed: `tests/transformation-m83-roundtrip.browser.spec.ts`
 * renders the face nose-up and has MediaPipe read the image back. It reports a
 * NEGATIVE pitch. MediaPipe pitch is a right-handed turn about the image-right
 * axis, which carries the nose DOWN, so positive MediaPipe pitch is looking
 * DOWN. Every earlier milestone assumed the opposite, and three phone
 * complaints — pitch backwards, a source that never started neutral, and nods
 * leaking into the brows — were that one assumption.
 *
 * Yaw and roll needed no conversion and the round trip confirms both.
 */
export interface RigidFaceMotion {
  /** Eye-spans of neutral face; + towards the operator's LEFT (image right, unmirrored). */
  translationX: number;
  /** Eye-spans of neutral face; + UP. */
  translationY: number;
  /** Fraction of the neutral camera distance; + towards the camera. From apparent size. */
  translationZ: number;
  /** Apparent size against the neutral: current eye span / neutral eye span. */
  scale: number;
  /** Radians; + is a turn towards the operator's LEFT. */
  yaw: number;
  /** Radians; + is looking UP. */
  pitch: number;
  /** Radians; + is the head tipping towards the operator's RIGHT shoulder. */
  roll: number;
}

export const NEUTRAL_RIGID_MOTION: RigidFaceMotion = {
  translationX: 0, translationY: 0, translationZ: 0, scale: 1, yaw: 0, pitch: 0, roll: 0,
};

export interface HeadOrientation { yaw: number; pitch: number; roll: number }

const finite = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** MediaPipe angles (absolute or relative) as physical ones. */
export function physicalOrientation(mediaPipe: HeadOrientation): HeadOrientation {
  return {
    yaw: finite(mediaPipe.yaw, 0),
    // `0 - x`, not `-x`: a still head reads +0, not -0, in every diagnostic.
    pitch: 0 - finite(mediaPipe.pitch, 0),
    roll: finite(mediaPipe.roll, 0),
  };
}

/** Calibration-relative MediaPipe motion as physical motion. */
export function rigidMotionFromCalibration(head: HeadMotion | null | undefined): RigidFaceMotion {
  if (!head) return NEUTRAL_RIGID_MOTION;
  const scale = Math.max(0.05, finite(head.scaleDelta, 1));
  const angles = physicalOrientation({ yaw: head.yawDelta, pitch: head.pitchDelta, roll: head.rollDelta });
  return {
    translationX: finite(head.translationX, 0),
    // Tracking y grows down the image.
    translationY: 0 - finite(head.translationY, 0),
    // Pinhole camera: apparent size is inverse to distance, so d = d0 / scale
    // and the fraction travelled towards the camera is 1 - 1/scale.
    translationZ: 1 - 1 / scale,
    scale,
    ...angles,
  };
}
