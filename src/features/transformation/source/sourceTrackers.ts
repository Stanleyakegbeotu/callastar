import { deriveFaceGeometry } from "../engine/faceGeometry";
import type { BlendshapeScores, Point3 } from "../engine/faceTypes";
import { derivePoseGeometry } from "../engine/poseGeometry";
import type { PoseLandmark } from "../engine/poseTypes";
import { loadMediaPipeVision } from "../loaders";
import { transformationModelAssets, transformationWasmBasePath } from "../modelAssets";

/**
 * The models, in IMAGE mode.
 *
 * Deliberately separate wrappers from `FaceTracker` and `PoseTracker`, which
 * are VIDEO-mode and built around a different problem: a monotonic clock, a
 * per-frame busy guard, rolling timing averages, and results that are allowed
 * to be "skipped" because another frame is along in 33ms.
 *
 * None of that applies to a still. There is no clock, a skipped result is a
 * failure rather than a shrug, and `detectForVideo` on a single image would
 * mean inventing a timestamp to satisfy an API whose semantics do not fit.
 * MediaPipe has an IMAGE running mode for exactly this, and forcing the live
 * abstraction onto it would be contorting the call site to avoid one class.
 *
 * These are created for an analysis and disposed when it finishes. Source
 * analysis is finite: leaving a second pair of models resident afterwards would
 * double the Studio's memory for something nothing is using.
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

interface MediaPipePoseMask {
  width?: number;
  height?: number;
  close?: () => void;
}

interface MediaPipePoseResult {
  landmarks?: { x: number; y: number; z: number; visibility?: number }[][];
  worldLandmarks?: { x: number; y: number; z: number; visibility?: number }[][];
  segmentationMasks?: MediaPipePoseMask[];
}

interface FaceLandmarkerLike {
  detect(image: CanvasImageSource): MediaPipeFaceResult;
  close(): void;
}

interface PoseLandmarkerLike {
  detect(image: CanvasImageSource): MediaPipePoseResult;
  close(): void;
}

/** What one still image yielded. Never "skipped": a still either worked or did not. */
export interface SourceFaceResult {
  detected: boolean;
  landmarks: readonly Point3[];
  blendshapes: BlendshapeScores;
  facialTransformationMatrix: readonly number[] | null;
  derived: ReturnType<typeof deriveFaceGeometry>;
}

export interface SourcePoseResult {
  detected: boolean;
  landmarks: readonly PoseLandmark[];
  worldLandmarks: readonly PoseLandmark[];
  derived: ReturnType<typeof derivePoseGeometry> | null;
  segmentationAvailable: boolean;
}

const NO_FACE: SourceFaceResult = {
  detected: false,
  landmarks: [],
  blendshapes: {},
  facialTransformationMatrix: null,
  derived: null,
};

const NO_POSE: SourcePoseResult = {
  detected: false,
  landmarks: [],
  worldLandmarks: [],
  derived: null,
  segmentationAvailable: false,
};

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

/** Copied out of MediaPipe's reused buffers, which the next call overwrites. */
function copyPoints(points: { x: number; y: number; z: number }[] | undefined): Point3[] {
  return (points ?? []).map((point) => ({ x: point.x, y: point.y, z: point.z }));
}

function copyLandmarks(points: { x: number; y: number; z: number; visibility?: number }[] | undefined): PoseLandmark[] {
  return (points ?? []).map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    ...(typeof point.visibility === "number" ? { visibility: point.visibility } : {}),
  }));
}

/**
 * Both models for one analysis, created together and released together.
 *
 * One object rather than two, because they have exactly one lifetime here and
 * the failure worth preventing — an analysis that finishes and leaves a model
 * resident — is a failure to dispose one of a pair.
 */
export class SourceAnalysisTasks {
  private face: FaceLandmarkerLike | null = null;
  private pose: PoseLandmarkerLike | null = null;
  private disposed = false;

  get ready(): boolean {
    return this.face !== null && !this.disposed;
  }

  /** Whether the pose model is available; a face-only analysis can proceed without it. */
  get poseReady(): boolean {
    return this.pose !== null && !this.disposed;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("SourceAnalysisTasks has been disposed");
    if (this.face) return;

    const faceModel = transformationModelAssets.faceLandmarker;
    const poseModel = transformationModelAssets.poseLandmarker;
    if (!faceModel) {
      throw new Error("Face Landmarker model is not configured. Run `pnpm assets:transformation`.");
    }

    const vision = await loadMediaPipeVision();
    const fileset = await vision.FilesetResolver.forVisionTasks(transformationWasmBasePath);

    const face = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: faceModel, delegate: "GPU" },
      // The whole reason this class exists.
      runningMode: "IMAGE",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    /*
     * Pose is optional, and its absence is not fatal.
     *
     * A source with a clear face and no shoulders is still useful — it drives
     * head movement. Failing the whole analysis because the pose model would
     * not load would throw away the half that works.
     */
    let pose: PoseLandmarkerLike | null = null;
    if (poseModel) {
      try {
        pose = (await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: poseModel, delegate: "GPU" },
          runningMode: "IMAGE",
          numPoses: 1,
          // Asked for so the profile can record honestly whether this source
          // HAS a mask. The pixels are not read, and nothing composites them.
          outputSegmentationMasks: true,
        })) as unknown as PoseLandmarkerLike;
      } catch {
        pose = null;
      }
    }

    // Disposal can land while the tasks are still being built.
    if (this.disposed) {
      face.close();
      pose?.close();
      return;
    }

    this.face = face as unknown as FaceLandmarkerLike;
    this.pose = pose;
  }

  detectFace(image: CanvasImageSource): SourceFaceResult {
    if (this.disposed || !this.face) return NO_FACE;

    let raw: MediaPipeFaceResult;
    try {
      raw = this.face.detect(image);
    } catch {
      // One unreadable frame of a video must not stop the sampler.
      return NO_FACE;
    }

    const landmarks = copyPoints(raw.faceLandmarks?.[0]);
    if (landmarks.length === 0) return NO_FACE;

    const matrixData = raw.facialTransformationMatrixes?.[0]?.data;
    const matrix = matrixData ? Array.from(matrixData) : null;
    const blendshapes = toScores(raw);

    return {
      detected: true,
      landmarks,
      blendshapes,
      facialTransformationMatrix: matrix,
      derived: deriveFaceGeometry(landmarks, matrix, blendshapes),
    };
  }

  detectPose(image: CanvasImageSource): SourcePoseResult {
    if (this.disposed || !this.pose) return NO_POSE;

    let raw: MediaPipePoseResult;
    try {
      raw = this.pose.detect(image);
    } catch {
      return NO_POSE;
    }

    /*
     * Described and closed immediately.
     *
     * A mask owns WASM memory. Analysing twenty sampled frames and keeping
     * twenty masks would leak steadily through a single analysis, which is the
     * same rule the live pose tracker follows.
     */
    const masks = raw.segmentationMasks ?? [];
    const segmentationAvailable = masks.length > 0;
    for (const mask of masks) {
      try {
        mask.close?.();
      } catch {
        // A mask that cannot be closed is already gone.
      }
    }

    const landmarks = copyLandmarks(raw.landmarks?.[0]);
    if (landmarks.length === 0) return { ...NO_POSE, segmentationAvailable };

    return {
      detected: true,
      landmarks,
      worldLandmarks: copyLandmarks(raw.worldLandmarks?.[0]),
      derived: derivePoseGeometry(landmarks),
      segmentationAvailable,
    };
  }

  /** Source analysis is finite. Nothing stays resident once it ends. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const face = this.face;
    const pose = this.pose;
    this.face = null;
    this.pose = null;

    try {
      face?.close();
    } catch {
      // Already gone.
    }
    try {
      pose?.close();
    } catch {
      // Already gone.
    }
  }
}
