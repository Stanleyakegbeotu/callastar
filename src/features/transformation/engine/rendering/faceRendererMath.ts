import type { CalibrationMotion } from "../relativeMotion";
import type { SourceMovementEnvelope } from "../../source/sourceTypes";
import { rigidMotionFromCalibration } from "../rigidFaceMotion";

/**
 * The renderer's pose: `RigidFaceMotion` (physical — pitch + looking UP, y +
 * UP) after the envelope, in eye-spans of the operator's neutral face. Every
 * MediaPipe sign was converted in `rigidFaceMotion.ts`; nothing here negates.
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

/**
 * Only yaw and pitch are limited by what a photograph contains. Moving,
 * zooming and tilting in the image plane show nothing the source lacks, so
 * those bounds are sanity limits on tracking, not on the source — the earlier
 * 0.45 eye-span and 0.82–1.25 scale envelopes clamped ordinary call movement
 * and made the face feel detached from the operator. The renderer separately
 * keeps the face on screen.
 */
export const FACE_RENDER_LIMITS: FaceRenderLimits = {
  translationX: 3,
  translationY: 3,
  scaleMin: 0.45,
  scaleMax: 2.4,
  yaw: 0.42,
  pitch: 0.28,
  roll: Math.PI / 3,
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
  const rigid = rigidMotionFromCalibration(motion?.head);
  const requested: FaceRenderPose = {
    x: finite(rigid.translationX, 0),
    y: finite(rigid.translationY, 0),
    scale: finite(rigid.scale, 1),
    yaw: finite(rigid.yaw, 0),
    pitch: finite(rigid.pitch, 0),
    roll: finite(rigid.roll, 0),
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

/**
 * The usable motion is the intersection of renderer safety and source
 * coverage — for the two axes where coverage means anything. A turn or a nod
 * reveals a side of the head the photograph may not show; moving, zooming and
 * tilting do not, so the source's translation, scale and roll figures are not
 * applied to the face (the avatar and diagnostics still read them).
 */
export function poseFromSourceMotion(
  motion: CalibrationMotion | null | undefined,
  source: SourceMovementEnvelope,
): FaceRenderPoseResult {
  const result = poseFromMotion(motion, FACE_RENDER_LIMITS);
  result.applied.yaw = clamp(result.applied.yaw, -source.yawRight, source.yawLeft);
  result.applied.pitch = clamp(result.applied.pitch, -source.pitchDown, source.pitchUp);
  result.clamped = (Object.keys(result.applied) as (keyof FaceRenderPose)[]).filter(key => result.applied[key] !== result.requested[key]);
  return result;
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
