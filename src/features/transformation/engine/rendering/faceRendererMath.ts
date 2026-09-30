import type { CalibrationMotion } from "../relativeMotion";
import type { SourceMovementEnvelope } from "../../source/sourceTypes";

/**
 * Coordinates used by the first renderer.
 *
 * Source landmark space is normalised image space: x grows right, y grows
 * down and z is MediaPipe's shallow relative depth. Live tracking uses that
 * same unmirrored convention. `CalibrationMotion` is relative to its neutral
 * pose in face-width units. The render scene is centred world space: x grows
 * right, y grows up, and the camera looks down -z. The y conversion happens
 * exactly once here; source texture v also flips once in `sourceMesh.ts`.
 */

export interface FaceRenderPose {
  x: number;
  y: number;
  scale: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceRenderLimits {
  translationX: number;
  translationY: number;
  scaleMin: number;
  scaleMax: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export const FACE_RENDER_LIMITS: FaceRenderLimits = {
  translationX: 0.55,
  translationY: 0.45,
  scaleMin: 0.78,
  scaleMax: 1.28,
  yaw: 0.42,
  pitch: 0.28,
  roll: 0.22,
};

export const NEUTRAL_FACE_RENDER_POSE: FaceRenderPose = {
  x: 0,
  y: 0,
  scale: 1,
  yaw: 0,
  pitch: 0,
  roll: 0,
};

export interface FaceRenderPoseResult {
  requested: FaceRenderPose;
  applied: FaceRenderPose;
  clamped: readonly (keyof FaceRenderPose)[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Converts the global, calibration-relative head movement into render space. */
export function poseFromMotion(
  motion: CalibrationMotion | null | undefined,
  limits: FaceRenderLimits = FACE_RENDER_LIMITS,
): FaceRenderPoseResult {
  const head = motion?.head;
  const requested: FaceRenderPose = {
    // Tracking y grows down; world y grows up.
    x: finite(head?.translationX, 0),
    y: -finite(head?.translationY, 0),
    scale: finite(head?.scaleDelta, 1),
    yaw: finite(head?.yawDelta, 0),
    pitch: finite(head?.pitchDelta, 0),
    roll: finite(head?.rollDelta, 0),
  };
  const applied: FaceRenderPose = {
    x: clamp(requested.x, -limits.translationX, limits.translationX),
    y: clamp(requested.y, -limits.translationY, limits.translationY),
    scale: clamp(requested.scale, limits.scaleMin, limits.scaleMax),
    yaw: clamp(requested.yaw, -limits.yaw, limits.yaw),
    pitch: clamp(requested.pitch, -limits.pitch, limits.pitch),
    roll: clamp(requested.roll, -limits.roll, limits.roll),
  };
  const clamped = (Object.keys(applied) as (keyof FaceRenderPose)[]).filter(
    (key) => applied[key] !== requested[key],
  );
  return { requested, applied, clamped };
}

/** The usable motion is the intersection of renderer safety and source coverage. */
export function poseFromSourceMotion(
  motion: CalibrationMotion | null | undefined,
  source: SourceMovementEnvelope,
): FaceRenderPoseResult {
  const sourceTranslation = source.translation ?? FACE_RENDER_LIMITS.translationX;
  return poseFromMotion(motion, {
    translationX: Math.min(FACE_RENDER_LIMITS.translationX, sourceTranslation),
    translationY: Math.min(FACE_RENDER_LIMITS.translationY, sourceTranslation),
    scaleMin: Math.max(FACE_RENDER_LIMITS.scaleMin, source.scaleMin),
    scaleMax: Math.min(FACE_RENDER_LIMITS.scaleMax, source.scaleMax),
    yaw: Math.min(FACE_RENDER_LIMITS.yaw, source.yawLeft, source.yawRight),
    pitch: Math.min(FACE_RENDER_LIMITS.pitch, source.pitchUp, source.pitchDown),
    roll: Math.min(FACE_RENDER_LIMITS.roll, source.roll),
  });
}

/** Frame-rate independent exponential smoothing of only the six global values. */
export function smoothFaceRenderPose(
  current: FaceRenderPose,
  target: FaceRenderPose,
  elapsedMs: number,
  responsiveness = 16,
): FaceRenderPose {
  const alpha = 1 - Math.exp((-Math.max(0, elapsedMs) / 1000) * responsiveness);
  const blend = (from: number, to: number) => from + (to - from) * alpha;
  return {
    x: blend(current.x, target.x),
    y: blend(current.y, target.y),
    scale: blend(current.scale, target.scale),
    yaw: blend(current.yaw, target.yaw),
    pitch: blend(current.pitch, target.pitch),
    roll: blend(current.roll, target.roll),
  };
}
