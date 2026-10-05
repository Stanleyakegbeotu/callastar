import type { BlendshapeScores, Point3 } from "../engine/faceTypes";
import type { PoseLandmark } from "../engine/poseTypes";
import type { SourceAppearanceProfile } from "./sourceAppearanceAnalysis";

/**
 * What CallaStar knows about the SOURCE person.
 *
 * The source is the face a caller will eventually see. This contract describes
 * it well enough for a renderer to plan against — what geometry exists, which
 * angles are covered, how far it can plausibly be moved — without containing
 * anything a renderer would have to be written around.
 *
 * Deliberately separate from `TransformationCalibrationProfile`. That describes
 * the LIVE OPERATOR; this describes the SOURCE ASSET. Merging them would make
 * one object whose halves have different lifetimes, different privacy rules and
 * different invalidation triggers. The future renderer consumes both plus
 * `CalibrationMotion`, and that separation is the architecture.
 *
 * NOTHING HERE IS RENDERER-SPECIFIC. No vertex buffers, no UVs, no textures, no
 * Three.js types. A later milestone builds those FROM this; it does not find
 * them in it.
 */

/**
 * `3d-model` is EXPERIMENTAL and sits beside the other two rather than replacing
 * either. A rigged model is analysed by `avatar/modelAnalyzer.ts` into its own
 * profile, because almost nothing the image and video analyser measures — face
 * landmarks, reference angles, a movement envelope derived from one photograph —
 * means anything for a model that already contains a whole head.
 */
export type SourceKind = "image" | "video" | "3d-model";

/**
 * Where the bytes came from.
 *
 * A stored asset is referenced by the id the admin repository already uses —
 * this deliberately does not invent a second media-storage subsystem. A
 * temporary upload has no id because it was never stored; it lives for the
 * Studio visit and is named only so the operator can see what they picked.
 */
export type SourceAssetReference =
  | { origin: "stored"; assetId: string; fileName: string; mimeType: string }
  | { origin: "upload"; assetId: null; fileName: string; mimeType: string };

export interface SourceDimensions {
  width: number;
  height: number;
  /** width / height. Recorded rather than recomputed by every consumer. */
  aspectRatio: number;
}

/**
 * The source face, with RAW model output kept apart from DERIVED geometry.
 *
 * The same split as the live tracker, for the same reason: a later change to
 * how yaw is computed must not be able to quietly corrupt the landmarks it was
 * computed from.
 */
export interface SourceFaceGeometry {
  /** 478 normalised landmarks in source image space. */
  landmarks: readonly Point3[];
  blendshapes: BlendshapeScores;
  /** Column-major 4x4 from the model, when this build provided one. */
  facialTransformationMatrix: readonly number[] | null;

  center: Point3;
  /** Normalised interocular distance — the source's own unit of scale. */
  scale: number;
  yaw: number;
  pitch: number;
  roll: number;
  bounds: SourceRegion;
  /** Resting expression in the source, for a renderer that wants a rest state. */
  neutralEyeOpenness: number;
  neutralMouthOpenness: number;
}

/** Measured appearance of the selected source frame, never live operator data. */
export interface SourceExpressionProfile {
  eyeOpenLeft: number;
  eyeOpenRight: number;
  mouthOpen: number;
  smileLeft: number;
  smileRight: number;
  browInnerUp: number;
  browOuterUpLeft: number;
  browOuterUpRight: number;
  limitations: string[];
}

export interface SourcePoseGeometry {
  landmarks: readonly PoseLandmark[];
  leftShoulder: Point3 | null;
  rightShoulder: Point3 | null;
  shoulderCenter: Point3 | null;
  shoulderWidth: number | null;
  shoulderAngle: number | null;
  torsoCenter: Point3 | null;
  torsoScale: number | null;
  /** Radians, and an approximation — see `PoseDerivedGeometry.torsoLean`. */
  torsoLean: number | null;
  /** Bounds of the usable upper body, normalised. Null without shoulders. */
  upperBodyBounds: SourceRegion | null;
  /** Whether the pose model offered a segmentation mask for this source. */
  segmentationAvailable: boolean;
}

/** A normalised rectangle in source space. */
export interface SourceRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Regions a later milestone will need, identified now.
 *
 * Face landmarks cover the face and nothing else — not hair, not the full ear,
 * not the outer silhouette of a head. A renderer that cropped to the landmark
 * bounds would cut someone's forehead off. These are measured expansions of the
 * face bounds, and they are only that: this milestone identifies regions, it
 * does not render them.
 */
export interface SourceRegions {
  face: SourceRegion;
  /** Face bounds expanded to plausibly include hair and ears. */
  head: SourceRegion;
  /** Head plus shoulders where they are known; head alone where they are not. */
  upperBody: SourceRegion;
  /** True when a region had to be clamped to the image edge — it is cropped. */
  headClipped: boolean;
  upperBodyClipped: boolean;
}

export type SourceWarning =
  | "face-near-edge"
  | "head-strongly-angled"
  | "shoulders-not-visible"
  | "one-shoulder-only"
  | "shoulders-cropped"
  | "head-region-cropped"
  | "low-resolution"
  | "small-face"
  | "single-image-limited-coverage"
  | "few-reference-angles";

/**
 * What this source can actually support.
 *
 * Booleans from measured conditions, not a score. A renderer asks these
 * directly — "do I have an upper body to move?" — rather than inferring
 * capability from a grade.
 */
export interface SourceCapabilities {
  face: boolean;
  expressions: boolean;
  headRotation: boolean;
  upperBody: boolean;
  /** More than one usable head angle. Only a video can offer this. */
  multiAngleReference: boolean;
}

export type SourceGrade = "excellent" | "good" | "limited" | "unusable";

export interface SourceQuality {
  grade: SourceGrade;
  warnings: SourceWarning[];
  capabilities: SourceCapabilities;
}

/**
 * How far this source can plausibly be moved.
 *
 * QUALITY METADATA for this milestone, not a clamp. A still image contains no
 * information about the side of a head it never showed, so a source already
 * turned well to one side has little additional room that way — and a renderer
 * that ignored this would invent a cheek that was never photographed.
 *
 * Expressed as signed radian limits either side of the source's own pose, so a
 * consumer does not have to re-derive the asymmetry.
 */
export interface SourceMovementEnvelope {
  yawLeft: number;
  yawRight: number;
  pitchUp: number;
  pitchDown: number;
  roll: number;
  /** Ratio limits on apparent size. */
  scaleMin: number;
  scaleMax: number;
  /** In source face widths. Null when nothing constrains it. */
  translation: number | null;
  /** Why the envelope is what it is, for the results panel. */
  basis: "single-image" | "multi-angle-video";
}

/**
 * The head angles a reference bank is organised by.
 *
 * Five buckets, chosen because they are the ones a source can plausibly cover
 * and a renderer can plausibly interpolate between. Only buckets the source
 * actually fills are created — a missing angle stays missing rather than being
 * filled with the nearest frame and quietly mislabelled.
 */
export type ReferenceAngle = "front" | "slight-left" | "slight-right" | "slight-up" | "slight-down";

export const REFERENCE_ANGLES: readonly ReferenceAngle[] = [
  "front",
  "slight-left",
  "slight-right",
  "slight-up",
  "slight-down",
];

/**
 * One chosen frame.
 *
 * Holds a timestamp and geometry, NEVER pixels. A renderer decodes the frame it
 * wants, when it wants it, by seeking the source asset to this timestamp —
 * keeping fifty decoded frames alive to avoid one seek would trade a few
 * milliseconds for tens of megabytes.
 */
export interface ReferenceFrame {
  timestampSeconds: number;
  angle: ReferenceAngle;
  face: SourceFaceGeometry;
  pose: SourcePoseGeometry | null;
  regions: SourceRegions;
  /** Higher is better. The deterministic score this frame won its bucket with. */
  score: number;
}

/**
 * Bumped when the MEANING of the analysis changes.
 *
 * A profile computed by an older analyser must not be reinterpreted under new
 * rules. Separate from `version`, which describes the shape of this object:
 * the shape can stay identical while the numbers in it come to mean something
 * different, and that is the case that silently corrupts a renderer.
 */
export const SOURCE_ANALYSIS_VERSION = 3;
export const SOURCE_PROFILE_VERSION = 3;

/**
 * PRIVACY.
 *
 * This describes the SELECTED SOURCE ASSET and nothing else. It must never
 * contain a live camera frame, a live operator landmark, or anything derived
 * from the person using the Studio — that belongs to calibration, which is a
 * separate object with a separate lifetime. No identity, embedding or
 * recognition of any kind is computed from either.
 *
 * Analysis is entirely browser-local. No source image or video is uploaded
 * anywhere, and the models are served from this origin.
 */
export interface TransformationSourceProfile {
  /** One prepared neutral video frame; memory-only and released with the profile. */
  preparedFrame?: Blob;
  baseFrameTime?: number;
  baseFrameScore?: number;
  version: number;
  analysisVersion: number;
  createdAt: number;
  sourceKind: SourceKind;
  asset: SourceAssetReference;
  /** Which admin profile this source was prepared for. Scoping, not decoration. */
  profileId: string;
  dimensions: SourceDimensions;
  /** Video only. Null for an image. */
  durationSeconds: number | null;
  primaryFace: SourceFaceGeometry;
  /** Optional because older in-memory profiles predate the pixel appearance analysis. */
  appearance?: SourceAppearanceProfile;
  /** Compact source expression state. Older in-memory fixtures may omit it. */
  expression?: SourceExpressionProfile;
  primaryPose: SourcePoseGeometry | null;
  regions: SourceRegions;
  quality: SourceQuality;
  movementEnvelope: SourceMovementEnvelope;
  /**
   * Empty for an image, which has exactly one angle and therefore no bank.
   * The image's own geometry is `primaryFace`; duplicating it as a
   * single-entry bank would invite a renderer to treat it as a choice.
   */
  referenceFrames: ReferenceFrame[];
}

/** Why an analysis could not produce a profile. Each has its own recovery. */
export type SourceAnalysisFailure =
  | "no-face"
  | "decode-failed"
  | "metadata-failed"
  | "unsupported-type"
  | "no-usable-frames"
  | "cancelled"
  | "model-load-failed";

/**
 * Progress, from real work.
 *
 * Each stage is entered when that work actually begins, and `frame` counts
 * frames genuinely analysed. Nothing here advances on a timer — a bar that
 * reaches 85% because 850ms elapsed is a lie told to somebody who is waiting.
 */
export type SourceAnalysisStage =
  | "idle"
  | "preparing"
  | "decoding"
  | "loading-models"
  | "analyzing-face"
  | "analyzing-pose"
  | "loading-video"
  | "sampling"
  | "analyzing-frames"
  | "selecting-references"
  | "evaluating"
  | "done"
  | "failed";

export interface SourceAnalysisProgress {
  stage: SourceAnalysisStage;
  /** Video frame analysis only; null elsewhere. */
  frame: number | null;
  frameCount: number | null;
}
