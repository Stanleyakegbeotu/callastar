import { computeFitRect, mapNormalizedToDisplay, type DisplayGeometry } from "../engine/coordinateMapping";
import type { FaceTrackingResult } from "../engine/faceTypes";
import type { FaceFrameSnapshot, LiveFacePlacement } from "../engine/faceFrame";
import { FACE_RENDER_VERTEX_INDICES } from "../engine/rendering/sourceMesh";
import { POSE_LANDMARKS } from "../engine/poseGeometry";
import type { PoseLandmark, PoseTrackingResult } from "../engine/poseTypes";

/**
 * Drawing the face and pose overlays.
 *
 * Canvas 2D, on ONE surface, over the video. Not Three.js: M4 proves the input
 * pipeline, and a WebGL context here would be a second renderer to manage for
 * some dots and lines. Not two canvases either — the face mesh and the skeleton
 * share a coordinate space, and splitting them is how they end up a frame apart.
 *
 * Every point goes through `mapNormalizedToDisplay`, which is where cover-crop,
 * mirroring and pixel ratio are handled. Nothing here does its own arithmetic on
 * a landmark, because two places computing the same mapping is how an overlay
 * drifts from the face under it.
 */

export interface OverlayStyle {
  faceDot: string;
  faceBounds: string;
  poseLine: string;
  poseJoint: string;
  shoulderLine: string;
  /** Scales strokes and dots with the backing store, so lines are not hairlines. */
  ratio: number;
}

export const DEFAULT_OVERLAY_STYLE: Omit<OverlayStyle, "ratio"> = {
  // Warm against skin, readable over both a bright window and a dark room.
  faceDot: "rgba(120, 236, 255, 0.85)",
  faceBounds: "rgba(120, 236, 255, 0.35)",
  poseLine: "rgba(255, 214, 112, 0.9)",
  poseJoint: "rgba(255, 214, 112, 1)",
  shoulderLine: "rgba(255, 138, 190, 0.95)",
};

/**
 * The upper-body segments actually drawn.
 *
 * Only what this pipeline reasons about. Drawing legs would imply the
 * transformation tracks them, and `POSE_LANDMARKS` deliberately names no knee.
 */
export const POSE_SEGMENTS: readonly (readonly [number, number])[] = [
  [POSE_LANDMARKS.leftShoulder, POSE_LANDMARKS.rightShoulder],
  [POSE_LANDMARKS.leftShoulder, POSE_LANDMARKS.leftElbow],
  [POSE_LANDMARKS.rightShoulder, POSE_LANDMARKS.rightElbow],
  [POSE_LANDMARKS.leftShoulder, POSE_LANDMARKS.leftHip],
  [POSE_LANDMARKS.rightShoulder, POSE_LANDMARKS.rightHip],
  [POSE_LANDMARKS.leftHip, POSE_LANDMARKS.rightHip],
];

/**
 * Below this a landmark is a guess, and drawing it would show a limb that is
 * not there. Matches the threshold the geometry uses.
 */
export const DRAW_VISIBILITY = 0.5;

function visible(point: PoseLandmark | undefined): point is PoseLandmark {
  if (!point) return false;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return point.visibility === undefined || point.visibility >= DRAW_VISIBILITY;
}

/**
 * How many face landmarks to draw.
 *
 * All 478 as 2px rectangles is one fill path and costs almost nothing; the same
 * points as arcs would be 478 sub-paths per frame. The subsample exists for the
 * quality preset, not because the full set is unaffordable.
 */
export function faceDotStride(landmarkCount: number, budget: number): number {
  if (budget <= 0 || landmarkCount <= budget) return 1;
  return Math.ceil(landmarkCount / budget);
}

export interface OverlayOptions {
  geometry: DisplayGeometry;
  style: OverlayStyle;
  showFace: boolean;
  showPose: boolean;
  /** Max face dots to draw. The full 478 on a phone is still cheap. */
  faceDotBudget?: number;
  faceLockDebug?: FaceFrameSnapshot | null;
  livePlacement?: LiveFacePlacement | null;
}

/**
 * Draws one frame.
 *
 * Clears first and unconditionally: leaving the previous mesh up while this
 * frame decides it has nothing to draw is how a stale overlay outlives the face
 * it belonged to.
 */
export function drawTrackingOverlay(
  context: CanvasRenderingContext2D,
  face: FaceTrackingResult | null,
  pose: PoseTrackingResult | null,
  options: OverlayOptions,
): void {
  const { geometry, style } = options;

  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (computeFitRect(geometry).scale === 0) return;

  // One transform for the device pixel ratio, so everything below is written in
  // CSS pixels and matches the geometry the mapping returns.
  context.save();
  context.setTransform(style.ratio, 0, 0, style.ratio, 0, 0);

  try {
    if (options.showPose && pose?.detected) drawPose(context, pose, options);
    // Face last: it is the smaller, more detailed layer and should sit on top.
    if (options.showFace && face?.detected) drawFace(context, face, options);
    if (options.faceLockDebug) drawFaceLock(context, options.faceLockDebug, options);
  } finally {
    context.restore();
  }
}

function drawFaceLock(context: CanvasRenderingContext2D, frame: FaceFrameSnapshot, options: OverlayOptions): void {
  const { geometry, style } = options;
  const current = frame.stableAnchors;
  const reference = frame.projectedReferenceAnchors;
  const map = (point: { x: number; y: number }) => mapNormalizedToDisplay(point, geometry);
  context.lineWidth = Math.max(1, 1.5 * style.ratio);
  for (const point of current) {
    const p = map(point);
    context.fillStyle = "#00eaff";
    context.beginPath(); context.arc(p.x, p.y, 3 * style.ratio, 0, Math.PI * 2); context.fill();
  }
  for (const point of reference) {
    const p = map(point);
    context.strokeStyle = "#ff22c8";
    context.beginPath(); context.arc(p.x, p.y, 5 * style.ratio, 0, Math.PI * 2); context.stroke();
  }

  const boundary = FACE_RENDER_VERTEX_INDICES.slice(1).map(index => frame.landmarks[index]).filter((point): point is NonNullable<typeof point> => !!point);
  if (boundary.length > 2) {
    context.strokeStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 2 * style.ratio;
    context.beginPath();
    boundary.forEach((point, index) => {
      const p = map(point);
      if (index === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
    });
    context.closePath(); context.stroke();
  }

  if (frame.globalCenter) {
    const center = frame.livePlacement?.viewport?.center ?? map(frame.globalCenter);
    const roll = frame.globalTransform?.rollDelta ?? 0;
    const half = 24 * style.ratio;
    context.strokeStyle = "#a5ff37";
    context.lineWidth = 2 * style.ratio;
    context.beginPath();
    context.moveTo(center.x - Math.cos(roll) * half, center.y - Math.sin(roll) * half);
    context.lineTo(center.x + Math.cos(roll) * half, center.y + Math.sin(roll) * half);
    context.stroke();
    context.fillStyle = "#a5ff37";
    context.beginPath(); context.arc(center.x, center.y, 4 * style.ratio, 0, Math.PI * 2); context.fill();
  }
  const transform = frame.globalTransform;
  context.fillStyle = "#fff";
  context.font = `${12 * style.ratio}px sans-serif`;
  context.fillText(`frame ${frame.frameId} · ${frame.timestampMs.toFixed(1)} ms · track ${frame.trackingTimestampMs.toFixed(1)} ms`, 8, 18 * style.ratio);
  context.fillText(`yaw ${(transform?.yawDelta ?? 0).toFixed(3)} · pitch ${(transform?.pitchDelta ?? 0).toFixed(3)} · roll ${(transform?.rollDelta ?? 0).toFixed(3)}`, 8, 34 * style.ratio);
}

function drawFace(context: CanvasRenderingContext2D, face: FaceTrackingResult, options: OverlayOptions): void {
  const { geometry, style } = options;
  const landmarks = face.landmarks;
  if (landmarks.length === 0) return;

  const stride = faceDotStride(landmarks.length, options.faceDotBudget ?? landmarks.length);
  const size = 2;
  const half = size / 2;

  context.fillStyle = style.faceDot;
  for (let index = 0; index < landmarks.length; index += stride) {
    const point = landmarks[index]!;
    const mapped = mapNormalizedToDisplay(point, geometry);
    context.fillRect(mapped.x - half, mapped.y - half, size, size);
  }

  // The bounds box is what makes a mapping error obvious: a mesh that is subtly
  // offset still looks like a face, but a box that misses the head does not.
  const bounds = face.derived?.bounds;
  if (!bounds) return;

  const placement = options.livePlacement?.viewport;
  const topLeft = placement
    ? { x: placement.left, y: placement.top }
    : mapNormalizedToDisplay({ x: bounds.minX, y: bounds.minY }, geometry);
  const bottomRight = placement
    ? { x: placement.left + placement.width, y: placement.top + placement.height }
    : mapNormalizedToDisplay({ x: bounds.maxX, y: bounds.maxY }, geometry);

  context.strokeStyle = style.faceBounds;
  context.lineWidth = 1.5;
  context.strokeRect(
    Math.min(topLeft.x, bottomRight.x),
    Math.min(topLeft.y, bottomRight.y),
    Math.abs(bottomRight.x - topLeft.x),
    Math.abs(bottomRight.y - topLeft.y),
  );
}

function drawPose(context: CanvasRenderingContext2D, pose: PoseTrackingResult, options: OverlayOptions): void {
  const { geometry, style } = options;
  const landmarks = pose.landmarks;

  context.lineWidth = 3;
  context.lineCap = "round";

  for (const [from, to] of POSE_SEGMENTS) {
    const a = landmarks[from];
    const b = landmarks[to];
    // A segment with one invisible end is not drawn at all: half a line reads as
    // an arm pointing somewhere it is not.
    if (!visible(a) || !visible(b)) continue;

    const isShoulderLine = from === POSE_LANDMARKS.leftShoulder && to === POSE_LANDMARKS.rightShoulder;
    context.strokeStyle = isShoulderLine ? style.shoulderLine : style.poseLine;

    const start = mapNormalizedToDisplay(a, geometry);
    const end = mapNormalizedToDisplay(b, geometry);

    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }

  context.fillStyle = style.poseJoint;
  for (const index of Object.values(POSE_LANDMARKS)) {
    const point = landmarks[index];
    if (!visible(point)) continue;
    const mapped = mapNormalizedToDisplay(point, geometry);
    context.beginPath();
    context.arc(mapped.x, mapped.y, 4, 0, Math.PI * 2);
    context.fill();
  }

  // The shoulder centre is the anchor a later milestone will attach a torso to,
  // so it is worth being able to watch it move.
  const center = pose.derived?.shoulderCenter;
  if (!center) return;

  const mapped = mapNormalizedToDisplay(center, geometry);
  context.strokeStyle = style.shoulderLine;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(mapped.x, mapped.y, 7, 0, Math.PI * 2);
  context.stroke();
}
