import type { DerivedFaceGeometry } from "../engine/faceTypes";
import { deriveSourceExpression } from "../engine/expressionMotion";
import type { PoseDerivedGeometry } from "../engine/poseTypes";

import {
  coveredAngles,
  selectNeutralCandidate,
  scoreNeutralCandidate,
  classifyAngle,
  selectReferenceFrames,
  type CandidateInput,
  type CandidateRejection,
} from "./referenceFrames";
import type { SourceAsset } from "./sourceAsset";
import {
  deriveMovementEnvelope,
  deriveSourceRegions,
  evaluateSource,
} from "./sourceQuality";
import { SourceAnalysisTasks, type SourceFaceResult, type SourcePoseResult } from "./sourceTrackers";
import {
  SOURCE_ANALYSIS_VERSION,
  SOURCE_PROFILE_VERSION,
  type ReferenceAngle,
  type ReferenceFrame,
  type SourceAnalysisFailure,
  type SourceAnalysisProgress,
  type SourceFaceGeometry,
  type SourcePoseGeometry,
  type TransformationSourceProfile,
} from "./sourceTypes";
import { sampleTimestamps } from "./videoSampling";
import { VideoFrameReader, VideoSeekError } from "./videoFrameReader";

/**
 * Turning a source asset into a profile.
 *
 * Deliberately not inside React. This is a long, cancellable, resource-owning
 * process with several failure modes, and expressing it as effects and state
 * would scatter the teardown across a component tree — which is how an
 * abandoned analysis keeps a decoder and two models alive.
 *
 * The Studio calls `analyze`, watches progress, and may call `cancel`. It never
 * touches a model, a video element or an ImageBitmap.
 *
 * INDEPENDENT OF THE CAMERA. Nothing here needs a live camera, a calibration or
 * signalling. A source can be prepared before any of those exist.
 */

export type SourceAnalysisResult =
  | { ok: true; profile: TransformationSourceProfile }
  | { ok: false; failure: SourceAnalysisFailure; message: string };

export interface AnalyzeOptions {
  asset: SourceAsset;
  /** Which admin profile this source is being prepared for. */
  profileId: string;
  onProgress?: (progress: SourceAnalysisProgress) => void;
  /** Injected in tests. */
  now?: () => number;
}

/** Timings, for the milestone report rather than for the operator. */
export interface SourceAnalysisTimings {
  decodeMs: number | null;
  modelInitMs: number | null;
  faceMs: number | null;
  poseMs: number | null;
  /** Video: mean across every frame actually analysed. */
  perFrameMs: number | null;
  framesAnalyzed: number;
  totalMs: number | null;
}

const FAILURE_COPY: Record<SourceAnalysisFailure, string> = {
  "no-face": "No clear face was detected in this source.",
  "decode-failed": "This file could not be decoded.",
  "metadata-failed": "This video did not report a usable duration or size.",
  "unsupported-type": "This file is not a supported image or video.",
  "no-usable-frames": "No usable frames were found in this video.",
  cancelled: "Analysis was cancelled.",
  "model-load-failed": "The analysis models could not be loaded.",
};

function faceGeometryFrom(result: SourceFaceResult, derived: DerivedFaceGeometry): SourceFaceGeometry {
  return {
    // RAW model output, kept apart from the derived numbers beside it.
    landmarks: result.landmarks,
    blendshapes: result.blendshapes,
    facialTransformationMatrix: result.facialTransformationMatrix,

    center: derived.center,
    scale: derived.scale,
    yaw: derived.yaw,
    pitch: derived.pitch,
    roll: derived.roll,
    bounds: derived.bounds,
    neutralEyeOpenness: derived.eyeOpenness,
    neutralMouthOpenness: derived.mouthOpenness,
  };
}

function poseGeometryFrom(
  result: SourcePoseResult,
  derived: PoseDerivedGeometry | null,
  upperBodyBounds: SourcePoseGeometry["upperBodyBounds"],
): SourcePoseGeometry | null {
  if (!result.detected || !derived) return null;

  return {
    landmarks: result.landmarks,
    leftShoulder: derived.leftShoulder,
    rightShoulder: derived.rightShoulder,
    shoulderCenter: derived.shoulderCenter,
    shoulderWidth: derived.shoulderWidth,
    shoulderAngle: derived.shoulderAngle,
    torsoCenter: derived.torsoCenter,
    torsoScale: derived.torsoScale,
    // Never invented: null where the hips were not visible, which is most
    // seated sources.
    torsoLean: derived.torsoLean,
    upperBodyBounds,
    segmentationAvailable: result.segmentationAvailable,
  };
}

export class SourceAnalyzer {
  private tasks: SourceAnalysisTasks | null = null;
  private reader: VideoFrameReader | null = null;
  private bitmap: ImageBitmap | null = null;
  private cancelled = false;
  /**
   * Identifies the run in flight.
   *
   * A cancelled analysis may still be inside an await when the next one starts.
   * Every resumption point checks this token, so a late result cannot mark a
   * source ready that the operator has already replaced.
   */
  private runToken = 0;
  private timings: SourceAnalysisTimings = {
    decodeMs: null,
    modelInitMs: null,
    faceMs: null,
    poseMs: null,
    perFrameMs: null,
    framesAnalyzed: 0,
    totalMs: null,
  };

  getTimings(): SourceAnalysisTimings {
    return { ...this.timings };
  }

  /** Stops the run in flight and releases everything it owned. */
  cancel(): void {
    this.cancelled = true;
    this.runToken += 1;
    this.releaseResources();
  }

  /**
   * Everything one analysis owns.
   *
   * Called on cancellation, on failure and on success. Source analysis is
   * finite: leaving the models resident after it would double the Studio's
   * memory for something nothing is using.
   */
  private releaseResources(): void {
    this.tasks?.dispose();
    this.tasks = null;
    this.reader?.dispose();
    this.reader = null;
    this.bitmap?.close();
    this.bitmap = null;
  }

  async analyze(options: AnalyzeOptions): Promise<SourceAnalysisResult> {
    // Anything still running belongs to a source the operator has moved on from.
    this.releaseResources();
    this.cancelled = false;
    const token = ++this.runToken;
    const now = options.now ?? (() => performance.now());
    const startedAt = now();

    this.timings = {
      decodeMs: null,
      modelInitMs: null,
      faceMs: null,
      poseMs: null,
      perFrameMs: null,
      framesAnalyzed: 0,
      totalMs: null,
    };

    const report = (progress: SourceAnalysisProgress) => {
      if (this.runToken !== token) return;
      options.onProgress?.(progress);
    };

    const stale = () => this.cancelled || this.runToken !== token;

    /*
     * A 3D model is not this analyser's job.
     *
     * Almost nothing it measures — face landmarks, reference angles, an envelope
     * inferred from one photograph — means anything for a model that already
     * contains a whole head. `avatar/modelAnalyzer.ts` handles those, and saying
     * so plainly is better than letting a GLB fall through the video branch and
     * fail somewhere deep in a decoder.
     */
    if (options.asset.kind === "3d-model") {
      return this.fail("unsupported-type", report);
    }

    try {
      const result =
        options.asset.kind === "image"
          ? await this.analyzeImage(options, token, report, stale, now)
          : await this.analyzeVideo(options, token, report, stale, now);

      if (stale()) return this.fail("cancelled", report);

      this.timings.totalMs = now() - startedAt;
      report({ stage: result.ok ? "done" : "failed", frame: null, frameCount: null });
      return result;
    } catch (error) {
      if (stale()) return this.fail("cancelled", report);

      const failure: SourceAnalysisFailure =
        error instanceof VideoSeekError
          ? error.reason === "metadata"
            ? "metadata-failed"
            : "decode-failed"
          : "decode-failed";

      return this.fail(failure, report);
    } finally {
      // Whatever happened, nothing stays running.
      if (this.runToken === token) this.releaseResources();
    }
  }

  private fail(
    failure: SourceAnalysisFailure,
    report: (progress: SourceAnalysisProgress) => void,
  ): SourceAnalysisResult {
    report({ stage: "failed", frame: null, frameCount: null });
    return { ok: false, failure, message: FAILURE_COPY[failure] };
  }

  /** Both models, created for this analysis alone. */
  private async ensureTasks(now: () => number): Promise<SourceAnalysisTasks> {
    if (this.tasks) return this.tasks;
    const started = now();
    const tasks = new SourceAnalysisTasks();
    await tasks.initialize();
    this.tasks = tasks;
    this.timings.modelInitMs = now() - started;
    return tasks;
  }

  private async analyzeImage(
    options: AnalyzeOptions,
    token: number,
    report: (progress: SourceAnalysisProgress) => void,
    stale: () => boolean,
    now: () => number,
  ): Promise<SourceAnalysisResult> {
    report({ stage: "decoding", frame: null, frameCount: null });

    /*
     * Decoded exactly once, by the browser.
     *
     * `createImageBitmap` with `imageOrientation: "from-image"` applies the
     * EXIF orientation, which is the difference between analysing a portrait
     * photograph and analysing a sideways one — a phone photo is very often
     * stored rotated with a flag saying so, and a model handed the raw pixels
     * finds no face at all.
     */
    const decodeStarted = now();
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(options.asset.blob, { imageOrientation: "from-image" });
    } catch {
      return this.fail("decode-failed", report);
    }

    if (stale() || this.runToken !== token) {
      bitmap.close();
      return this.fail("cancelled", report);
    }

    this.bitmap = bitmap;
    this.timings.decodeMs = now() - decodeStarted;

    report({ stage: "loading-models", frame: null, frameCount: null });
    let tasks: SourceAnalysisTasks;
    try {
      tasks = await this.ensureTasks(now);
    } catch {
      return this.fail("model-load-failed", report);
    }
    if (stale()) return this.fail("cancelled", report);

    report({ stage: "analyzing-face", frame: null, frameCount: null });
    const faceStarted = now();
    const faceResult = tasks.detectFace(bitmap);
    this.timings.faceMs = now() - faceStarted;

    // A face is required. Everything downstream is measured relative to one.
    if (!faceResult.detected || !faceResult.derived) return this.fail("no-face", report);
    if (stale()) return this.fail("cancelled", report);

    report({ stage: "analyzing-pose", frame: null, frameCount: null });
    const poseStarted = now();
    const poseResult = tasks.poseReady ? tasks.detectPose(bitmap) : null;
    this.timings.poseMs = now() - poseStarted;
    if (stale()) return this.fail("cancelled", report);

    report({ stage: "evaluating", frame: null, frameCount: null });

    const derivedPose = poseResult?.derived ?? null;
    const regions = deriveSourceRegions(faceResult.derived, derivedPose);
    const dimensions = {
      width: bitmap.width,
      height: bitmap.height,
      aspectRatio: bitmap.height > 0 ? bitmap.width / bitmap.height : 1,
    };

    const evaluation = { face: faceResult.derived, pose: derivedPose, regions, dimensions, angleCount: 1 };

    return {
      ok: true,
      profile: {
        version: SOURCE_PROFILE_VERSION,
        analysisVersion: SOURCE_ANALYSIS_VERSION,
        createdAt: Date.now(),
        sourceKind: "image",
        asset: options.asset.assetId
          ? {
              origin: "stored",
              assetId: options.asset.assetId,
              fileName: options.asset.fileName,
              mimeType: options.asset.mimeType,
            }
          : { origin: "upload", assetId: null, fileName: options.asset.fileName, mimeType: options.asset.mimeType },
        profileId: options.profileId,
        dimensions,
        durationSeconds: null,
        primaryFace: faceGeometryFrom(faceResult, faceResult.derived),
        expression: deriveSourceExpression(faceGeometryFrom(faceResult, faceResult.derived)),
        primaryPose: poseResult
          ? poseGeometryFrom(poseResult, derivedPose, derivedPose?.shoulderCenter ? regions.upperBody : null)
          : null,
        regions,
        quality: evaluateSource(evaluation),
        movementEnvelope: deriveMovementEnvelope(faceResult.derived, derivedPose, {
          left: false,
          right: false,
          up: false,
          down: false,
          count: 1,
        }),
        // An image has one angle, not a bank. A single-entry bank would invite
        // a renderer to treat it as a choice between alternatives.
        referenceFrames: [],
      },
    };
  }

  private async analyzeVideo(
    options: AnalyzeOptions,
    token: number,
    report: (progress: SourceAnalysisProgress) => void,
    stale: () => boolean,
    now: () => number,
  ): Promise<SourceAnalysisResult> {
    report({ stage: "loading-video", frame: null, frameCount: null });

    const reader = new VideoFrameReader();
    this.reader = reader;

    const decodeStarted = now();
    const metadata = await reader.open(options.asset.blob);
    this.timings.decodeMs = now() - decodeStarted;
    if (stale()) return this.fail("cancelled", report);

    report({ stage: "sampling", frame: null, frameCount: null });
    const timestamps = sampleTimestamps(metadata.durationSeconds);
    if (timestamps.length === 0) return this.fail("metadata-failed", report);

    report({ stage: "loading-models", frame: null, frameCount: null });
    let tasks: SourceAnalysisTasks;
    try {
      tasks = await this.ensureTasks(now);
    } catch {
      return this.fail("model-load-failed", report);
    }
    if (stale()) return this.fail("cancelled", report);

    const candidates: CandidateInput[] = [];
    const geometry = new Map<number, { face: SourceFaceResult; pose: SourcePoseResult | null }>();
    const rejections: Partial<Record<CandidateRejection | "seek-failed" | "no-face", number>> = {};
    let frameTimeTotal = 0;
    let analysed = 0;

    for (const [index, timestamp] of timestamps.entries()) {
      if (stale()) return this.fail("cancelled", report);

      report({ stage: "analyzing-frames", frame: index + 1, frameCount: timestamps.length });

      let frame: HTMLCanvasElement;
      try {
        frame = await reader.frameAt(timestamp);
      } catch (error) {
        // One unreachable moment is not a failed analysis. A file with a few
        // unseekable points still has plenty of usable ones.
        if (error instanceof VideoSeekError && error.reason === "cancelled") {
          return this.fail("cancelled", report);
        }
        rejections["seek-failed"] = (rejections["seek-failed"] ?? 0) + 1;
        continue;
      }

      if (stale()) return this.fail("cancelled", report);

      const frameStarted = now();
      const faceResult = tasks.detectFace(frame);
      if (!faceResult.detected || !faceResult.derived) {
        frameTimeTotal += now() - frameStarted;
        analysed += 1;
        rejections["no-face"] = (rejections["no-face"] ?? 0) + 1;
        continue;
      }

      const poseResult = tasks.poseReady ? tasks.detectPose(frame) : null;
      frameTimeTotal += now() - frameStarted;
      analysed += 1;

      candidates.push({
        timestampSeconds: timestamp,
        face: faceResult.derived,
        pose: poseResult?.derived ?? null,
      });
      // Geometry only. The decoded frame is reused by the next seek and never
      // retained — twenty full-resolution buffers is not a reference bank.
      geometry.set(timestamp, { face: faceResult, pose: poseResult });
    }

    this.timings.framesAnalyzed = analysed;
    this.timings.perFrameMs = analysed > 0 ? frameTimeTotal / analysed : null;
    if (stale()) return this.fail("cancelled", report);

    report({ stage: "selecting-references", frame: null, frameCount: null });

    const selection = selectReferenceFrames(candidates, (candidate, angle, score) =>
      this.buildReferenceFrame(candidate, angle, score, geometry),
    );

    if (candidates.length === 0) {
      return this.fail(rejections["no-face"] ? "no-face" : "no-usable-frames", report);
    }
    if (selection.frames.length === 0) return this.fail("no-usable-frames", report);

    report({ stage: "evaluating", frame: null, frameCount: null });

    /*
     * The primary is the front reference where the source has one.
     *
     * A renderer asking "what does this person look like" wants the frame
     * facing the camera, not whichever moment the sampler happened to reach
     * first. Where there is no front frame, the best-scoring one stands in.
     */
    const best = selectNeutralCandidate(candidates)!;
    const primary = this.buildReferenceFrame(best, classifyAngle(best.face)!, scoreNeutralCandidate(best), geometry);
    const preparedCanvas = await reader.frameAt(best.timestampSeconds);
    const preparedFrame = await new Promise<Blob>((resolve, reject) => preparedCanvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Unable to prepare the neutral source frame')), 'image/png'));
    if (stale()) return this.fail('cancelled', report);
    const angles = coveredAngles(selection.frames);
    const primaryDerived = candidates.find((candidate) => candidate.timestampSeconds === primary.timestampSeconds)!;

    const dimensions = {
      width: metadata.width,
      height: metadata.height,
      aspectRatio: metadata.height > 0 ? metadata.width / metadata.height : 1,
    };

    const evaluation = {
      face: primaryDerived.face,
      pose: primaryDerived.pose,
      regions: primary.regions,
      dimensions,
      angleCount: angles.count,
    };

    return {
      ok: true,
      profile: {
        version: SOURCE_PROFILE_VERSION,
        analysisVersion: SOURCE_ANALYSIS_VERSION,
        createdAt: Date.now(),
        sourceKind: "video",
        preparedFrame,
        baseFrameTime: best.timestampSeconds,
        baseFrameScore: scoreNeutralCandidate(best),
        asset: options.asset.assetId
          ? {
              origin: "stored",
              assetId: options.asset.assetId,
              fileName: options.asset.fileName,
              mimeType: options.asset.mimeType,
            }
          : { origin: "upload", assetId: null, fileName: options.asset.fileName, mimeType: options.asset.mimeType },
        profileId: options.profileId,
        dimensions,
        durationSeconds: metadata.durationSeconds,
        primaryFace: primary.face,
        expression: deriveSourceExpression(primary.face),
        primaryPose: primary.pose,
        regions: primary.regions,
        quality: evaluateSource(evaluation),
        movementEnvelope: deriveMovementEnvelope(primaryDerived.face, primaryDerived.pose, {
          left: angles.left,
          right: angles.right,
          up: angles.up,
          down: angles.down,
          count: angles.count,
        }),
        referenceFrames: selection.frames,
      },
    };
  }

  private buildReferenceFrame(
    candidate: CandidateInput,
    angle: ReferenceAngle,
    score: number,
    geometry: Map<number, { face: SourceFaceResult; pose: SourcePoseResult | null }>,
  ): ReferenceFrame {
    const stored = geometry.get(candidate.timestampSeconds)!;
    const regions = deriveSourceRegions(candidate.face, candidate.pose);

    return {
      timestampSeconds: candidate.timestampSeconds,
      angle,
      face: faceGeometryFrom(stored.face, candidate.face),
      pose: stored.pose
        ? poseGeometryFrom(stored.pose, candidate.pose, candidate.pose?.shoulderCenter ? regions.upperBody : null)
        : null,
      regions,
      score,
    };
  }
}

/**
 * Whether a prepared profile belongs to the profile being edited.
 *
 * Scoping, checked rather than assumed. Silently accepting Profile A's prepared
 * source while Profile B is open would give one person another person's face,
 * which is the single worst thing this feature could do.
 */
export function profileMatchesSource(
  profile: TransformationSourceProfile | null,
  profileId: string | null,
): boolean {
  if (!profile || !profileId) return false;
  return profile.profileId === profileId;
}

/** Whether a stored profile was produced by the current analyser. */
export function isSourceProfileCurrent(profile: TransformationSourceProfile): boolean {
  return profile.analysisVersion === SOURCE_ANALYSIS_VERSION;
}
