import { loadMediaPipeVision } from "../loaders";
import { transformationModelAssets, transformationWasmBasePath } from "../modelAssets";

import { deriveFaceGeometry, estimateConfidence } from "./faceGeometry";
import { MonotonicClock } from "./monotonicClock";
import { NO_FACE_RESULT, type BlendshapeScores, type FaceTrackingResult, type Point3 } from "./faceTypes";

/**
 * The Face Landmarker, wrapped.
 *
 * One task instance for the life of the Studio: creating a MediaPipe task costs
 * a WASM instantiation and a model parse, so doing it per frame would be the
 * single most expensive mistake available here. It is created once, reused for
 * every frame, and disposed explicitly.
 *
 * Nothing above this layer sees a MediaPipe object. Results are normalised into
 * `FaceTrackingResult` at this boundary — see `faceTypes.ts` for why.
 *
 * Privacy: landmarks exist for the lifetime of a frame and are never persisted,
 * and no identity, embedding or recognition of any kind is computed. This is
 * geometry tracking.
 */

/**
 * The shape of the MediaPipe result we actually read.
 *
 * Declared locally rather than imported: the package's exported result types
 * vary between builds, and this wrapper only depends on these fields existing.
 */
interface MediaPipeCategory {
  categoryName?: string;
  displayName?: string;
  score?: number;
}

interface MediaPipeFaceResult {
  faceLandmarks?: { x: number; y: number; z: number }[][];
  faceBlendshapes?: { categories?: MediaPipeCategory[] }[];
  facialTransformationMatrixes?: { data?: number[] | Float32Array }[];
}

export interface FaceTrackerOptions {
  /**
   * One face. Transformation Studio transforms one operator, not a crowd, and
   * every extra face is another mesh solved per frame for nothing.
   */
  maxFaces?: number;
  minDetectionConfidence?: number;
  minTrackingConfidence?: number;
  /** GPU by default; CPU exists as a fallback for devices without WebGL2. */
  delegate?: "GPU" | "CPU";
}

export interface FaceTrackerTimings {
  /** Resolver + task creation, in ms. Paid once. */
  initMs: number | null;
  /** The first `detectForVideo`, which is slower than steady state. */
  firstInferenceMs: number | null;
  /** Rolling mean of recent inferences. */
  averageInferenceMs: number | null;
  inferenceCount: number;
}

/** MediaPipe's own type for the task; kept opaque to the rest of the app. */
interface FaceLandmarkerLike {
  detectForVideo(frame: CanvasImageSource, timestampMs: number): MediaPipeFaceResult;
  close(): void;
}

function toScores(result: MediaPipeFaceResult): BlendshapeScores {
  const categories = result.faceBlendshapes?.[0]?.categories;
  if (!categories) return {};

  const scores: Record<string, number> = {};
  for (const category of categories) {
    const name = category.categoryName ?? category.displayName;
    if (name && typeof category.score === "number") scores[name] = category.score;
  }
  return scores;
}

function toMatrix(result: MediaPipeFaceResult): readonly number[] | null {
  const data = result.facialTransformationMatrixes?.[0]?.data;
  if (!data) return null;
  // Copied out: MediaPipe reuses its buffers between frames, so holding the
  // original would mean last frame's matrix silently changing under us.
  return Array.from(data);
}

export class FaceTracker {
  private task: FaceLandmarkerLike | null = null;
  private disposed = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Strictly increasing timestamps for MediaPipe.
   *
   * Shared with the pose tracker when the Studio supplies one, so both models
   * agree about when a frame was — see `MonotonicClock`.
   */
  private readonly clock: MonotonicClock;

  /** One inference at a time; a frame arriving during one is dropped. */
  private busy = false;

  private timings: FaceTrackerTimings = {
    initMs: null,
    firstInferenceMs: null,
    averageInferenceMs: null,
    inferenceCount: 0,
  };

  private recentDurations: number[] = [];

  constructor(
    private readonly options: FaceTrackerOptions = {},
    clock?: MonotonicClock,
  ) {
    this.clock = clock ?? new MonotonicClock();
  }

  get ready(): boolean {
    return this.task !== null && !this.disposed;
  }

  getTimings(): FaceTrackerTimings {
    return { ...this.timings };
  }

  /** Idempotent: concurrent callers share one initialisation. */
  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("FaceTracker has been disposed");
    if (this.task) return;
    this.initPromise ??= this.createTask();
    try {
      await this.initPromise;
    } catch (error) {
      // Allow a retry rather than latching the failure forever.
      this.initPromise = null;
      throw error;
    }
  }

  private async createTask(): Promise<void> {
    const modelPath = transformationModelAssets.faceLandmarker;
    if (!modelPath) {
      throw new Error(
        "Face Landmarker model is not configured. Run `pnpm assets:transformation` to fetch it.",
      );
    }

    const started = performance.now();
    const vision = await loadMediaPipeVision();
    const fileset = await vision.FilesetResolver.forVisionTasks(transformationWasmBasePath);

    const task = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: this.options.delegate ?? "GPU",
      },
      // The whole reason this model was chosen over a bare mesh.
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      runningMode: "VIDEO",
      numFaces: this.options.maxFaces ?? 1,
      minFaceDetectionConfidence: this.options.minDetectionConfidence ?? 0.5,
      minTrackingConfidence: this.options.minTrackingConfidence ?? 0.5,
      minFacePresenceConfidence: this.options.minDetectionConfidence ?? 0.5,
    });

    // Disposal can land while the task is still being built; honour it rather
    // than leaking a live WASM instance nobody holds a reference to.
    if (this.disposed) {
      task.close();
      return;
    }

    this.task = task as unknown as FaceLandmarkerLike;
    this.timings.initMs = performance.now() - started;
  }

  /**
   * One frame.
   *
   * Never throws for an ordinary miss: a frame with no face, a frame that
   * arrived mid-inference and a disposed tracker are all normal states in a live
   * studio, and each returns a result saying which rather than an exception the
   * loop would have to catch.
   */
  detect(frame: CanvasImageSource, timestampMs: number, frameId?: number): FaceTrackingResult {
    if (this.disposed || !this.task) {
      return { ...NO_FACE_RESULT, status: "skipped", timestampMs, frameId };
    }

    // Dropping is correct here: queueing frames behind a slow inference builds
    // latency that never recovers, and the newest frame is the useful one.
    if (this.busy) {
      return { ...NO_FACE_RESULT, status: "skipped", timestampMs, frameId };
    }

    // Strictly increasing, whatever the caller passed. A flip or a resume can
    // legitimately hand us a repeated or lower value.
    const stamp = this.clock.next(timestampMs, frameId);

    this.busy = true;
    const started = performance.now();

    try {
      const raw = this.task.detectForVideo(frame, stamp) as MediaPipeFaceResult;
      const duration = performance.now() - started;
      this.recordTiming(duration);

      const landmarks = raw.faceLandmarks?.[0];
      if (!landmarks || landmarks.length === 0) {
        return { ...NO_FACE_RESULT, timestampMs: stamp, frameId };
      }

      // Copied out of MediaPipe's reused buffers, for the same reason as the
      // matrix above.
      const points: Point3[] = landmarks.map((point) => ({ x: point.x, y: point.y, z: point.z }));
      const blendshapes = toScores(raw);
      const matrix = toMatrix(raw);
      const derived = deriveFaceGeometry(points, matrix, blendshapes);

      return {
        timestampMs: stamp,
        frameId,
        status: "tracked",
        detected: true,
        confidence: estimateConfidence(points, derived),
        landmarks: points,
        blendshapes,
        facialTransformationMatrix: matrix,
        derived,
      };
    } catch {
      // A single bad frame must not stop the loop. The next one usually works,
      // and a persistent failure shows up as sustained `skipped`.
      return { ...NO_FACE_RESULT, status: "skipped", timestampMs: stamp, frameId };
    } finally {
      this.busy = false;
    }
  }

  private recordTiming(duration: number): void {
    this.timings.inferenceCount += 1;
    this.timings.firstInferenceMs ??= duration;

    // A short window, so the average reflects current conditions rather than
    // the whole session.
    this.recentDurations.push(duration);
    if (this.recentDurations.length > 30) this.recentDurations.shift();

    const total = this.recentDurations.reduce((sum, value) => sum + value, 0);
    this.timings.averageInferenceMs = total / this.recentDurations.length;
  }

  /**
   * Releases the WASM task.
   *
   * Idempotent, because teardown and an unmount routinely both arrive — and
   * under StrictMode they arrive twice.
   */
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
      // A task that cannot be closed is already gone.
    }
  }
}
