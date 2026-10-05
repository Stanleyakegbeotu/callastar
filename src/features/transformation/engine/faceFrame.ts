import type { ExpressionMotion } from "./expressionMotion";
import type { Point3 } from "./faceTypes";
import type { HeadMotion } from "./relativeMotion";
import type { DisplayFacePlacement, DisplayGeometry } from "./coordinateMapping";

/** The single raw, current-frame global placement shared by preview and root. */
export interface LiveFacePlacement {
  frameId: number;
  timestampMs: number;
  center: Point3 | null;
  width: number | null;
  height: number | null;
  scale: number | null;
  roll: number | null;
  yaw: number | null;
  pitch: number | null;
  mirrored: boolean;
  devicePixelRatio: number;
  viewportTransform: DisplayGeometry;
  viewport: DisplayFacePlacement | null;
}

/** Atomic render input published from one camera inference result. */
export interface FaceFrameSnapshot {
  frameId: number;
  /** Strict MediaPipe inference timestamp, derived from the presented camera frame. */
  timestampMs: number;
  /** Wall-clock completion time for tracking age diagnostics. */
  trackingTimestampMs: number;
  /** Untouched MediaPipe observations from this frame. */
  landmarks: readonly Point3[];
  /** Stabilized stable-skin geometry; expressive landmarks retain live response. */
  stabilizedLandmarks: readonly Point3[];
  stabilizationMs: number;
  stabilizationLatencyEstimateMs: number | null;
  /** Low-resolution skin samples read from the same downscaled camera frame. */
  boundarySkinSamples?: readonly ({ r: number; g: number; b: number } | null)[];
  boundarySkinSampleTimestampMs?: number | null;
  boundarySkinSampleCostMs?: number;
  /** Unfiltered motion derived from this camera frame, relative to calibration. */
  rawGlobalTransform: HeadMotion | null;
  /** Filtered motion from the same frame; this is the renderer's live pose. */
  globalTransform: HeadMotion | null;
  /** Raw fitted center in the current camera frame, before temporal filtering. */
  globalCenter: Point3 | null;
  /** Raw face box and center mapped to the preview's CSS-pixel viewport. */
  viewportPlacement: DisplayFacePlacement | null;
  referenceCenter: Point3 | null;
  referenceScale: number | null;
  rawFaceScale: number | null;
  trackingAspect: number;
  rawScaleRatio: number | null;
  expressionState: ExpressionMotion | null;
  stableAnchors: readonly Point3[];
  referenceAnchors: readonly Point3[];
  projectedReferenceAnchors: readonly Point3[];
  livePlacement?: LiveFacePlacement;
}
