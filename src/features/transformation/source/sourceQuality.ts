import type { DerivedFaceGeometry } from "../engine/faceTypes";
import type { PoseDerivedGeometry } from "../engine/poseTypes";
import { physicalOrientation } from "../engine/rigidFaceMotion";

import type {
  SourceCapabilities,
  SourceDimensions,
  SourceGrade,
  SourceMovementEnvelope,
  SourceQuality,
  SourceRegion,
  SourceRegions,
  SourceWarning,
} from "./sourceTypes";

/**
 * Judging a source.
 *
 * Every rule here is measured. There is no blur detector and no lighting
 * analysis in this project, so nothing here says "this image is blurry" or
 * "your lighting is poor" — a guess dressed as a measurement is worse than
 * silence, because the operator changes a source that was fine. Product copy
 * can suggest good lighting; automated analysis may not claim to have checked
 * it.
 *
 * Equally, no percentages. A grade comes from stated conditions a reader can
 * check against the picture in front of them.
 */

export const SOURCE_RULES = {
  /**
   * Below this the face is too small for 478 landmarks to mean much.
   * Normalised interocular distance, the same unit the live tracker uses.
   */
  minFaceScale: 0.035,
  /** Below this it is usable but worth warning about. */
  smallFaceScale: 0.06,
  /** Fraction of the image the face centre must stay inside. */
  edgeMargin: 0.08,
  /** A comfortable margin; inside it the face is near the edge. */
  comfortableMargin: 0.15,
  /** ~26° and ~20°: beyond this the source is already strongly turned. */
  strongYaw: 0.45,
  strongPitch: 0.35,
  /**
   * Genuinely low resolution, on the shorter edge.
   *
   * Not a 1080p demand. A 480px-tall portrait of a head is a perfectly usable
   * source; a 120px thumbnail is not, and that is the difference worth naming.
   */
  lowResolutionShortEdge: 360,
  /*
   * How far face bounds expand to plausibly include hair and ears.
   *
   * As fractions of the face bounds, which already reach the hairline — the
   * 478-point mesh carries a forehead contour, so the bounds are not eyebrow to
   * chin but roughly hairline to chin. The remaining hair above is therefore
   * about a third of that height rather than most of it, and a larger figure
   * flags an ordinarily framed portrait as cropped.
   *
   * Asymmetric because a head is: there is much more of it above the eyebrows
   * than below the jaw.
   */
  headExpandX: 0.22,
  headExpandTop: 0.38,
  headExpandBottom: 0.12,
} as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRegion(region: SourceRegion): { region: SourceRegion; clipped: boolean } {
  const clamped: SourceRegion = {
    minX: clamp01(region.minX),
    minY: clamp01(region.minY),
    maxX: clamp01(region.maxX),
    maxY: clamp01(region.maxY),
  };

  const clipped =
    region.minX < 0 || region.minY < 0 || region.maxX > 1 || region.maxY > 1;

  return { region: clamped, clipped };
}

/**
 * The regions a later milestone will need.
 *
 * Face landmarks stop at the face. A renderer that cropped to their bounds
 * would cut off a forehead, both ears and all of the hair — so the head region
 * is the face bounds expanded by measured proportions, asymmetrically, because
 * there is far more head above the eyebrows than below the chin.
 *
 * `clipped` matters as much as the rectangle: a head region that had to be
 * clamped to the image edge means the source does not contain the whole head,
 * and a renderer needs to know that rather than discovering it as a hard edge.
 */
export function deriveSourceRegions(
  face: DerivedFaceGeometry,
  pose: PoseDerivedGeometry | null,
): SourceRegions {
  const bounds = face.bounds;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  const head = clampRegion({
    minX: bounds.minX - width * SOURCE_RULES.headExpandX,
    maxX: bounds.maxX + width * SOURCE_RULES.headExpandX,
    minY: bounds.minY - height * SOURCE_RULES.headExpandTop,
    maxY: bounds.maxY + height * SOURCE_RULES.headExpandBottom,
  });

  // Without shoulders the upper body is simply the head. Inventing a torso
  // under a cropped photograph would put a body where none was photographed.
  let upperBody = head;
  let upperBodyClipped = head.clipped;

  if (pose?.shoulderCenter && typeof pose.shoulderWidth === "number" && pose.shoulderWidth > 0) {
    const half = pose.shoulderWidth / 2;
    const withShoulders = clampRegion({
      minX: Math.min(head.region.minX, pose.shoulderCenter.x - half),
      maxX: Math.max(head.region.maxX, pose.shoulderCenter.x + half),
      minY: head.region.minY,
      maxY: Math.max(head.region.maxY, pose.shoulderCenter.y + half * 0.6),
    });
    upperBody = withShoulders;
    upperBodyClipped = withShoulders.clipped;
  }

  return {
    face: bounds,
    head: head.region,
    upperBody: upperBody.region,
    headClipped: head.clipped,
    upperBodyClipped,
  };
}

export interface SourceEvaluationInput {
  face: DerivedFaceGeometry;
  pose: PoseDerivedGeometry | null;
  regions: SourceRegions;
  dimensions: SourceDimensions;
  /** How many distinct head angles the source offers. One, for an image. */
  angleCount: number;
}

/**
 * Warnings, each from a condition that can be pointed at in the picture.
 *
 * Informational. None of these make a source unusable on their own — that is
 * decided by the grade, and only a missing or unusable face gets there.
 */
export function deriveSourceWarnings(input: SourceEvaluationInput): SourceWarning[] {
  const warnings: SourceWarning[] = [];
  const { face, pose, regions, dimensions } = input;

  const shortEdge = Math.min(dimensions.width, dimensions.height);
  if (shortEdge > 0 && shortEdge < SOURCE_RULES.lowResolutionShortEdge) warnings.push("low-resolution");

  if (face.scale < SOURCE_RULES.smallFaceScale) warnings.push("small-face");

  const margin = SOURCE_RULES.comfortableMargin;
  if (
    face.center.x < margin ||
    face.center.x > 1 - margin ||
    face.center.y < margin ||
    face.center.y > 1 - margin
  ) {
    warnings.push("face-near-edge");
  }

  if (Math.abs(face.yaw) > SOURCE_RULES.strongYaw || Math.abs(face.pitch) > SOURCE_RULES.strongPitch) {
    warnings.push("head-strongly-angled");
  }

  if (regions.headClipped) warnings.push("head-region-cropped");

  const trackability = pose?.trackability;
  if (!pose || trackability === "lost") {
    warnings.push("shoulders-not-visible");
  } else if (trackability === "partial") {
    warnings.push("one-shoulder-only");
  } else if (regions.upperBodyClipped) {
    warnings.push("shoulders-cropped");
  }

  if (input.angleCount <= 1) {
    warnings.push("single-image-limited-coverage");
  } else if (input.angleCount < 3) {
    warnings.push("few-reference-angles");
  }

  return warnings;
}

export function deriveSourceCapabilities(input: SourceEvaluationInput): SourceCapabilities {
  const { face, pose } = input;
  const usableFace = face.scale >= SOURCE_RULES.minFaceScale;

  return {
    face: usableFace,
    // Blendshapes come from the same model as the landmarks, so a usable face
    // is a usable expression source.
    expressions: usableFace,
    /*
     * Head rotation needs a face that is not already at the limit of what the
     * source shows. A profile view has no other cheek to turn towards.
     */
    headRotation: usableFace && Math.abs(face.yaw) < SOURCE_RULES.strongYaw,
    upperBody: pose?.trackability === "tracked",
    multiAngleReference: input.angleCount > 1,
  };
}

/**
 * The grade.
 *
 * `unusable` is reserved for a source a renderer genuinely cannot work with —
 * no face, or a face too small to land landmarks on. Everything else is a
 * matter of how much it supports, which is what the capabilities say.
 */
export function gradeSource(input: SourceEvaluationInput, warnings: SourceWarning[]): SourceGrade {
  const capabilities = deriveSourceCapabilities(input);
  if (!capabilities.face) return "unusable";

  const blocking = warnings.filter(
    (warning) => warning === "low-resolution" || warning === "head-region-cropped",
  );

  if (!capabilities.upperBody) return "limited";
  if (!capabilities.headRotation) return "limited";
  if (blocking.length > 0) return "limited";

  // A single image is a perfectly good source; it simply cannot be excellent,
  // because excellence here means more than one angle to draw from.
  if (!capabilities.multiAngleReference) {
    return warnings.some((warning) => warning === "face-near-edge" || warning === "small-face")
      ? "limited"
      : "good";
  }

  const cosmetic = warnings.filter((warning) => warning !== "few-reference-angles");
  return cosmetic.length === 0 ? "excellent" : "good";
}

export function evaluateSource(input: SourceEvaluationInput): SourceQuality {
  const warnings = deriveSourceWarnings(input);
  return {
    grade: gradeSource(input, warnings),
    warnings,
    capabilities: deriveSourceCapabilities(input),
  };
}

/**
 * How far this source can plausibly be moved.
 *
 * The governing fact: a photograph contains no information about a side of a
 * head it never showed. A source already turned 25° to one side has little
 * additional room that way and plenty the other, so the envelope is asymmetric
 * and centred on the source's own pose rather than on zero.
 *
 * A video with several angles earns more room, because it genuinely saw more.
 *
 * QUALITY METADATA for this milestone. Nothing clamps anything yet, and these
 * numbers should be revisited against a real renderer before they do.
 */
export const SOURCE_ENVELOPE_BASE = {
  /** ±25° from a front-facing still, before the unseen side starts to matter. */
  imageYaw: 0.44,
  imagePitch: 0.26,
  imageRoll: 0.26,
  /** A video that showed both sides earns roughly half as much again. */
  videoYawBonus: 0.26,
  videoPitchBonus: 0.12,
  imageScaleMin: 0.82,
  imageScaleMax: 1.25,
  videoScaleMin: 0.75,
  videoScaleMax: 1.35,
  translation: 0.45,
} as const;

export function deriveMovementEnvelope(
  face: DerivedFaceGeometry,
  pose: PoseDerivedGeometry | null,
  angles: { left: boolean; right: boolean; up: boolean; down: boolean; count: number },
): SourceMovementEnvelope {
  const multiAngle = angles.count > 1;
  const basis = multiAngle ? "multi-angle-video" : "single-image";

  const baseYaw = SOURCE_ENVELOPE_BASE.imageYaw;
  const basePitch = SOURCE_ENVELOPE_BASE.imagePitch;

  /*
   * Spend the source's existing angle against the direction it already points.
   *
   * Positive yaw is the head turned towards the subject's left. A source
   * already turned that way has used up part of its leftward room and gained
   * the same amount rightward, because turning back towards centre reveals only
   * what the photograph already contains.
   */
  const yawLeft = Math.max(0.05, baseYaw - Math.max(0, face.yaw)) + (angles.left ? SOURCE_ENVELOPE_BASE.videoYawBonus : 0);
  const yawRight = Math.max(0.05, baseYaw - Math.max(0, -face.yaw)) + (angles.right ? SOURCE_ENVELOPE_BASE.videoYawBonus : 0);

  // A source already looking up has spent part of its upward budget. Physical
  // pitch (+ up), because MediaPipe's own pitch is positive looking DOWN.
  const sourcePitch = physicalOrientation(face).pitch;
  const pitchUp = Math.max(0.04, basePitch - Math.max(0, sourcePitch)) + (angles.up ? SOURCE_ENVELOPE_BASE.videoPitchBonus : 0);
  const pitchDown = Math.max(0.04, basePitch - Math.max(0, -sourcePitch)) + (angles.down ? SOURCE_ENVELOPE_BASE.videoPitchBonus : 0);

  return {
    yawLeft,
    yawRight,
    pitchUp,
    pitchDown,
    roll: SOURCE_ENVELOPE_BASE.imageRoll,
    scaleMin: multiAngle ? SOURCE_ENVELOPE_BASE.videoScaleMin : SOURCE_ENVELOPE_BASE.imageScaleMin,
    scaleMax: multiAngle ? SOURCE_ENVELOPE_BASE.videoScaleMax : SOURCE_ENVELOPE_BASE.imageScaleMax,
    // Without shoulders there is no anchor for a translation to be measured
    // against, so the honest answer is that it is unconstrained here.
    translation: pose?.trackability === "tracked" ? SOURCE_ENVELOPE_BASE.translation : null,
    basis,
  };
}
