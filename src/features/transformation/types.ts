/** Contracts for a future browser-local transformation engine. No call state lives here. */
export type TransformationSourceKind = "image" | "video" | "3d-model";

export function isTransformationSourceKind(value: unknown): value is TransformationSourceKind {
  return value === "image" || value === "video";
}

export interface TransformationSource {
  kind: TransformationSourceKind;
  /** The caller owns this media and decides when to release it. */
  media: Blob | HTMLVideoElement;
}

export type TransformationEngineStatus =
  | "idle"
  | "loading"
  | "ready"
  | "calibrating"
  | "running"
  | "paused"
  | "failed"
  | "disposed";

export interface FaceTrackingResult {
  timestampMs: number;
  /** Shape and optional blendshapes/matrices remain provider-owned until implementation. */
  landmarks: readonly (readonly { x: number; y: number; z: number }[])[];
  blendshapes?: readonly unknown[];
  transformationMatrices?: readonly unknown[];
}

export interface PoseTrackingResult {
  timestampMs: number;
  landmarks: readonly (readonly { x: number; y: number; z: number }[])[];
  segmentationMasks?: readonly unknown[];
}

export interface SegmentationResult {
  timestampMs: number;
  width: number;
  height: number;
  /** Provider-owned until the eventual renderer has an explicit copy/release policy. */
  masks: readonly unknown[];
}

export interface TrackingProvider {
  track(frame: ImageBitmap, timestampMs: number): Promise<{
    face?: FaceTrackingResult;
    pose?: PoseTrackingResult;
    segmentation?: SegmentationResult;
  }>;
  dispose(): void;
}

export interface TransformationOutput {
  /** An eventual canvas capture track can be passed to the existing video sender. */
  videoTrack: MediaStreamTrack;
  release(): void;
}

export interface TransformationRenderer {
  render(frame: ImageBitmap, tracking: Awaited<ReturnType<TrackingProvider["track"]>>): void;
  getOutput(): TransformationOutput;
  dispose(): void;
}

export interface TransformationDiagnostics {
  status: TransformationEngineStatus;
  trackingFps?: number;
  renderingFps?: number;
  droppedFrames?: number;
  lastError?: string;
}

export interface TransformationEngine {
  readonly status: TransformationEngineStatus;
  load(source: TransformationSource): Promise<void>;
  start(): Promise<TransformationOutput>;
  pause(): void;
  dispose(): void;
  diagnostics(): TransformationDiagnostics;
}
