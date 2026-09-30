import { loadMediaPipeVision } from "../loaders";
import { transformationModelAssets, transformationWasmBasePath } from "../modelAssets";

import { MonotonicClock } from "./monotonicClock";
import { derivePoseGeometry } from "./poseGeometry";
import { NO_POSE_RESULT, type PoseLandmark, type PoseTrackingResult, type SegmentationInfo } from "./poseTypes";

/**
 * The Pose Landmarker, wrapped.
 *
 * Same contract as the face tracker: one task for the life of the Studio,
 * reused every frame, disposed explicitly, and no MediaPipe object escaping
 * into the engine.
 *
 * The one genuinely different concern here is the segmentation mask. Those
 * objects own WASM memory and must be closed; a per-frame loop that retained
 * them would leak steadily until the tab died. This wrapper closes every mask
 * inside the inference call and reports only its dimensions — anything that
 * later wants the pixels will copy them out deliberately.
 */

interface MediaPipeMask {
  width?: number;
  height?: number;
  close?: () => void;
  /** Present on some builds; used only to describe the representation. */
  hasFloat32Array?: boolean;
  hasUint8Array?: boolean;
  hasWebGLTexture?: boolean;
}

interface MediaPipePoseResult {
  landmarks?: { x: number; y: number; z: number; visibility?: number }[][];
  worldLandmarks?: { x: number; y: number; z: number; visibility?: number }[][];
  segmentationMasks?: MediaPipeMask[];
  close?: () => void;
}

export interface PoseTrackerOptions {
  /** One person. The Studio transforms one operator. */
  maxPoses?: number;
  minDetectionConfidence?: number;
  minPresenceConfidence?: number;
  minTrackingConfidence?: number;
  /**
   * Whether to ask for the segmentation mask.
   *
   * Off by default: it costs work per frame and nothing consumes it yet. The
   * Studio turns it on when it wants to measure what the lite model actually
   * produces.
   */
  outputSegmentationMasks?: boolean;
  delegate?: "GPU" | "CPU";
}

export interface PoseTrackerTimings {
  initMs: number | null;
  firstInferenceMs: number | null;
  averageInferenceMs: number | null;
  inferenceCount: number;
}

interface PoseLandmarkerLike {
  detectForVideo(frame: CanvasImageSource, timestampMs: number): MediaPipePoseResult;
  close(): void;
}

function copyLandmarks(source: { x: number; y: number; z: number; visibility?: number }[] | undefined): PoseLandmark[] {
  if (!source) return [];
  // Copied out: MediaPipe reuses its buffers between frames, so retaining the
  // originals would mean last frame's pose silently changing.
  return source.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    ...(typeof point.visibility === "number" ? { visibility: point.visibility } : {}),
  }));
}

/**
 * Describes a mask, then closes it.
 *
 * Nothing provider-owned survives this function. Deliberately returns facts
 * rather than pixels: a mask retained across frames is a WASM leak, and a mask
 * copied speculatively is work nobody asked for yet.
 */
function describeAndCloseMask(masks: MediaPipeMask[] | undefined): SegmentationInfo {
  const mask = masks?.[0];
  if (!mask) return { available: false, width: null, height: null, representation: null };

  const representation = mask.hasWebGLTexture
    ? "webgl-texture"
    : mask.hasFloat32Array
      ? "float32"
      : mask.hasUint8Array
        ? "uint8"
        : "unknown";

  const info: SegmentationInfo = {
    available: true,
    width: mask.width ?? null,
    height: mask.height ?? null,
    representation,
  };

  for (const owned of masks ?? []) {
    try {
      owned.close?.();
    } catch {
      // A mask that cannot be closed is already gone.
    }
  }

  return info;
}

export class PoseTracker {
  private task: PoseLandmarkerLike | null = null;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  private busy = false;

  private timings: PoseTrackerTimings = {
    initMs: null,
    firstInferenceMs: null,
    averageInferenceMs: null,
    inferenceCount: 0,
  };

  private recentDurations: number[] = [];

  /**
   * Shared with the face tracker when the Studio supplies one, so both models
   * agree about when a frame was.
   */
  private readonly clock: MonotonicClock;

  constructor(
    private readonly options: PoseTrackerOptions = {},
    clock?: MonotonicClock,
  ) {
    this.clock = clock ?? new MonotonicClock();
  }

  get ready(): boolean {
    return this.task !== null && !this.disposed;
  }

  getTimings(): PoseTrackerTimings {
    return { ...this.timings };
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("PoseTracker has been disposed");
    if (this.task) return;
    this.initPromise ??= this.createTask();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async createTask(): Promise<void> {
    const modelPath = transformationModelAssets.poseLandmarker;
    if (!modelPath) {
      throw new Error(
        "Pose Landmarker model is not configured. Run `pnpm assets:transformation` to fetch it.",
      );
    }

    const started = performance.now();
    const vision = await loadMediaPipeVision();
    const fileset = await vision.FilesetResolver.forVisionTasks(transformationWasmBasePath);

    const task = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: this.options.delegate ?? "GPU",
      },
      runningMode: "VIDEO",
      numPoses: this.options.maxPoses ?? 1,
      minPoseDetectionConfidence: this.options.minDetectionConfidence ?? 0.5,
      minPosePresenceConfidence: this.options.minPresenceConfidence ?? 0.5,
      minTrackingConfidence: this.options.minTrackingConfidence ?? 0.5,
      outputSegmentationMasks: this.options.outputSegmentationMasks ?? false,
    });

    // Disposal can land while the task is still being built.
    if (this.disposed) {
      task.close();
      return;
    }

    this.task = task as unknown as PoseLandmarkerLike;
    this.timings.initMs = performance.now() - started;
  }

  /**
   * One frame.
   *
   * Never throws for an ordinary miss. A person half out of frame is a partial
   * result, not an error — the trackability state says which, and the Studio
   * turns that into guidance rather than a failure screen.
   */
  detect(frame: CanvasImageSource, timestampMs: number): PoseTrackingResult {
    if (this.disposed || !this.task) {
      return { ...NO_POSE_RESULT, status: "skipped", timestampMs };
    }

    if (this.busy) {
      return { ...NO_POSE_RESULT, status: "skipped", timestampMs };
    }

    const stamp = this.clock.next(timestampMs);
    this.busy = true;
    const started = performance.now();
    let raw: MediaPipePoseResult | null = null;

    try {
      raw = this.task.detectForVideo(frame, stamp);
      this.recordTiming(performance.now() - started);

      // Described and closed before anything else touches the result, so a
      // later throw cannot strand a mask.
      const segmentation = describeAndCloseMask(raw.segmentationMasks);

      const landmarks = copyLandmarks(raw.landmarks?.[0]);
      if (landmarks.length === 0) {
        return { ...NO_POSE_RESULT, segmentation, timestampMs: stamp };
      }

      return {
        timestampMs: stamp,
        status: "tracked",
        detected: true,
        landmarks,
        worldLandmarks: copyLandmarks(raw.worldLandmarks?.[0]),
        segmentation,
        derived: derivePoseGeometry(landmarks),
      };
    } catch {
      // A single bad frame must not stop the loop, and must not leak a mask.
      try {
        describeAndCloseMask(raw?.segmentationMasks);
      } catch {
        // Nothing further to do.
      }
      return { ...NO_POSE_RESULT, status: "skipped", timestampMs: stamp };
    } finally {
      this.busy = false;
    }
  }

  private recordTiming(duration: number): void {
    this.timings.inferenceCount += 1;
    this.timings.firstInferenceMs ??= duration;

    this.recentDurations.push(duration);
    if (this.recentDurations.length > 30) this.recentDurations.shift();

    const total = this.recentDurations.reduce((sum, value) => sum + value, 0);
    this.timings.averageInferenceMs = total / this.recentDurations.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const task = this.task;
    this.task = null;
    this.initPromise = null;
    this.recentDurations = [];

    try {
      task?.close();
    } catch {
      // Already gone.
    }
  }
}
