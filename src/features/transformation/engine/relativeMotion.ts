import type { TransformationCalibrationProfile } from "./calibrationTypes";
import type { FaceTrackingResult } from "./faceTypes";
import type { PoseTrackingResult } from "./poseTypes";

/**
 * Live tracking, expressed relative to the calibrated neutral.
 *
 * Pure, renderer-independent, and in normalised units throughout. Nothing here
 * knows about a canvas, a texture or a mesh, and nothing here emits a pixel —
 * a deformation driven by pixels would behave differently at every camera
 * resolution.
 *
 * SIGNS ARE THE WHOLE RISK AT THIS LAYER.
 *
 * Milestone 2 shipped a silent axis inversion: `asin(-R[2][0])` was assigned to
 * pitch when it is yaw, so a 30° head turn read as a 30° nod. It was invisible
 * until a test asserted a known rotation produced zero on the other two axes.
 * The same class of error here would be worse, because it would look like a
 * plausible transformation of the wrong thing. Every direction below is stated
 * in words and pinned by a test with a known sign.
 *
 * All motion is computed in the UNMIRRORED tracking space the models saw.
 * Mirroring is a display concern and lives in `coordinateMapping.ts`; applying
 * it here as well would cancel on one axis and not the other.
 */

export interface HeadMotion {
  /**
   * Sideways movement, in units of the neutral face width.
   *
   * POSITIVE when the operator moves towards the RIGHT of the unmirrored camera
   * frame. On a mirrored selfie preview that looks like moving left on screen,
   * which is correct: the preview is the mirror, the tracking space is not.
   */
  translationX: number;
  /** POSITIVE when the operator moves DOWN in frame. Screen coordinates, not maths. */
  translationY: number;
  /**
   * Ratio, not a difference: 1 is the calibrated distance, 1.1 is ten percent
   * closer in apparent size. See `scaleDelta` below for why.
   */
  scaleDelta: number;
  /** Radians. POSITIVE when the head turns further to the SUBJECT'S LEFT than neutral. */
  yawDelta: number;
  /** Radians. POSITIVE when the head tilts further BACK than neutral. */
  pitchDelta: number;
  /** Radians. POSITIVE when the head tilts further towards the SUBJECT'S RIGHT ear. */
  rollDelta: number;
}

/**
 * Expression, passed through LIVE.
 *
 * Deliberately not neutralised the way head pose is. Head orientation has a
 * meaningful resting value to subtract — a blink does not. Someone with
 * naturally narrow eyes has a lower resting openness, and subtracting it would
 * make their neutral face read as a permanent half-blink and their actual blink
 * read as nothing.
 *
 * The profile records `neutralEyeOpenness` and `neutralMouthOpenness` so a
 * later consumer can apply a resting offset where it genuinely helps, but the
 * default is the live signal, unmodified.
 */
export interface ExpressionMotion {
  /** 0..1 from the model's blendshapes, where 1 is fully closed. */
  blinkLeft: number;
  blinkRight: number;
  /** 0..1. Live, not relative. */
  mouthOpen: number;
  /** 0..1, averaged across both corners. Null when the model did not report it. */
  smile: number | null;
  /**
   * How far eyes and mouth sit from their calibrated rest, for consumers that
   * want it. Provided, never applied by default.
   */
  eyeOpennessFromNeutral: number;
  mouthOpennessFromNeutral: number;
}

export interface UpperBodyMotion {
  /** Units of neutral shoulder width. POSITIVE towards the right of the frame. */
  translationX: number;
  /** POSITIVE downwards. */
  translationY: number;
  /** Ratio against neutral shoulder width. */
  shoulderScaleDelta: number;
  /** Radians. POSITIVE when the subject's RIGHT shoulder drops further than neutral. */
  shoulderAngleDelta: number;
  /** Radians, and an approximation — see `PoseDerivedGeometry.torsoLean`. */
  torsoLeanDelta: number | null;
}

export interface CalibrationMotion {
  /** Null when the face is not currently tracked. Absent, not zero. */
  head: HeadMotion | null;
  expression: ExpressionMotion | null;
  /** Null for a face-only calibration, or when the shoulders are not tracked. */
  upperBody: UpperBodyMotion | null;
  /**
   * Whether the current frame is usable at all.
   *
   * Tracking loss does NOT invalidate the baseline — someone looking away for
   * two seconds must not have to recalibrate. Motion is simply unavailable
   * until they look back, and then resumes against the same neutral.
   */
  tracked: boolean;
}

export const NO_MOTION: CalibrationMotion = {
  head: null,
  expression: null,
  upperBody: null,
  tracked: false,
};

/**
 * Motion envelopes, PROVISIONAL.
 *
 * Chosen from what the acceptance envelope and ordinary desk movement suggest,
 * not measured against a product requirement — which is exactly why they are
 * documented here rather than buried as literals. For this milestone they drive
 * diagnostics warnings only. They become deformation clamps later, and should
 * be revisited with a real source and a real phone before they do.
 */
export const RECOMMENDED_MOTION_ENVELOPE = {
  /** ±30°: past this the far side of the face is hidden from the model. */
  yaw: 0.52,
  /** ±20°: a nod, not a look at the ceiling. */
  pitch: 0.35,
  /** ±15°: a head tilt reads badly on a source face well before this. */
  roll: 0.26,
  /** Apparent size, as a ratio of neutral. */
  scaleMin: 0.75,
  scaleMax: 1.35,
  /** Face widths. Roughly half a head either way. */
  translationX: 0.6,
  translationY: 0.5,
  /** ~11° of shoulder tilt. */
  shoulderAngle: 0.2,
} as const;

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Translation, normalised so the same physical movement gives the same number.
 *
 * Divided by the NEUTRAL face scale rather than by the frame, because a frame
 * fraction means something different at every distance from the camera: leaning
 * 5cm sideways is a large movement when the face fills the frame and a small
 * one when it does not. In face widths it is the same movement either way.
 *
 * The vertical axis is additionally divided by the tracking aspect ratio.
 * Landmarks are normalised against width and height separately, so a frame
 * fraction on y is a different physical distance from the same fraction on x.
 * The neutral scale is an interocular distance and therefore measured mostly
 * horizontally, so correcting y by the aspect puts both axes in the same unit.
 */
function normalizeTranslation(
  deltaX: number,
  deltaY: number,
  neutralScale: number,
  aspect: number,
): { translationX: number; translationY: number } {
  if (!usable(neutralScale) || neutralScale <= 0) return { translationX: 0, translationY: 0 };
  const safeAspect = usable(aspect) && aspect > 0 ? aspect : 1;

  return {
    translationX: deltaX / neutralScale,
    translationY: deltaY / (neutralScale * safeAspect),
  };
}

/**
 * Apparent size, as a RATIO.
 *
 * `current / neutral`, never `current - neutral`. Distance from a camera is
 * multiplicative: a face twice as far away is half as wide, wherever it started.
 * A difference would mean "moved 0.02 closer", which is a different physical
 * distance for every operator and every camera, and cannot drive a scale.
 */
function scaleRatio(current: number, neutral: number): number {
  if (!usable(current) || !usable(neutral) || neutral <= 0) return 1;
  return current / neutral;
}

export function computeRelativeMotion(
  profile: TransformationCalibrationProfile | null,
  face: FaceTrackingResult | null,
  pose: PoseTrackingResult | null,
): CalibrationMotion {
  if (!profile) return NO_MOTION;

  const aspect =
    profile.trackingSpace.height > 0 ? profile.trackingSpace.width / profile.trackingSpace.height : 1;

  const head = computeHeadMotion(profile, face, aspect);
  const expression = computeExpression(profile, face);
  const upperBody = computeUpperBodyMotion(profile, pose, aspect);

  return { head, expression, upperBody, tracked: head !== null };
}

function computeHeadMotion(
  profile: TransformationCalibrationProfile,
  face: FaceTrackingResult | null,
  aspect: number,
): HeadMotion | null {
  const derived = face?.derived;
  if (!face?.detected || !derived) return null;
  if (!usable(derived.center.x) || !usable(derived.center.y) || !usable(derived.scale)) return null;

  const neutral = profile.face;
  const { translationX, translationY } = normalizeTranslation(
    derived.center.x - neutral.center.x,
    derived.center.y - neutral.center.y,
    neutral.scale,
    aspect,
  );

  return {
    translationX,
    translationY,
    scaleDelta: scaleRatio(derived.scale, neutral.scale),
    // Plain subtraction: these are angles about fixed axes, and the acceptance
    // envelope keeps them far from any wrap.
    yawDelta: derived.yaw - neutral.yaw,
    pitchDelta: derived.pitch - neutral.pitch,
    rollDelta: derived.roll - neutral.roll,
  };
}

function computeExpression(
  profile: TransformationCalibrationProfile,
  face: FaceTrackingResult | null,
): ExpressionMotion | null {
  const derived = face?.derived;
  if (!face?.detected || !derived) return null;

  const shapes = face.blendshapes;
  const smileLeft = shapes.mouthSmileLeft;
  const smileRight = shapes.mouthSmileRight;
  const smile =
    typeof smileLeft === "number" && typeof smileRight === "number" ? (smileLeft + smileRight) / 2 : null;

  return {
    // The model's own blink signal where it exists; the derived openness
    // inverted where it does not.
    blinkLeft: typeof shapes.eyeBlinkLeft === "number" ? shapes.eyeBlinkLeft : 1 - derived.eyeOpennessLeft,
    blinkRight: typeof shapes.eyeBlinkRight === "number" ? shapes.eyeBlinkRight : 1 - derived.eyeOpennessRight,
    mouthOpen: derived.mouthOpenness,
    smile,
    eyeOpennessFromNeutral: derived.eyeOpenness - profile.face.neutralEyeOpenness,
    mouthOpennessFromNeutral: derived.mouthOpenness - profile.face.neutralMouthOpenness,
  };
}

function computeUpperBodyMotion(
  profile: TransformationCalibrationProfile,
  pose: PoseTrackingResult | null,
  aspect: number,
): UpperBodyMotion | null {
  const neutral = profile.pose;
  const derived = pose?.derived;

  // A face-only baseline has nothing to be relative to, and a lost pose is
  // absent rather than zero.
  if (!neutral.shoulderCenter || !usable(neutral.shoulderWidth) || neutral.shoulderWidth <= 0) return null;
  if (!pose?.detected || !derived?.shoulderCenter || !usable(derived.shoulderWidth)) return null;

  const { translationX, translationY } = normalizeTranslation(
    derived.shoulderCenter.x - neutral.shoulderCenter.x,
    derived.shoulderCenter.y - neutral.shoulderCenter.y,
    neutral.shoulderWidth,
    aspect,
  );

  const leanDelta =
    usable(derived.torsoLean) && usable(neutral.torsoLean) ? derived.torsoLean - neutral.torsoLean : null;

  return {
    translationX,
    translationY,
    shoulderScaleDelta: scaleRatio(derived.shoulderWidth, neutral.shoulderWidth),
    shoulderAngleDelta:
      usable(derived.shoulderAngle) && usable(neutral.shoulderAngle)
        ? derived.shoulderAngle - neutral.shoulderAngle
        : 0,
    torsoLeanDelta: leanDelta,
  };
}

/** Which recommended envelopes the current motion is outside. Diagnostics only. */
export function motionOutsideEnvelope(motion: CalibrationMotion): string[] {
  const outside: string[] = [];
  const head = motion.head;
  if (!head) return outside;

  if (Math.abs(head.yawDelta) > RECOMMENDED_MOTION_ENVELOPE.yaw) outside.push("yaw");
  if (Math.abs(head.pitchDelta) > RECOMMENDED_MOTION_ENVELOPE.pitch) outside.push("pitch");
  if (Math.abs(head.rollDelta) > RECOMMENDED_MOTION_ENVELOPE.roll) outside.push("roll");
  if (
    head.scaleDelta < RECOMMENDED_MOTION_ENVELOPE.scaleMin ||
    head.scaleDelta > RECOMMENDED_MOTION_ENVELOPE.scaleMax
  ) {
    outside.push("scale");
  }
  if (Math.abs(head.translationX) > RECOMMENDED_MOTION_ENVELOPE.translationX) outside.push("translationX");
  if (Math.abs(head.translationY) > RECOMMENDED_MOTION_ENVELOPE.translationY) outside.push("translationY");

  if (
    motion.upperBody &&
    Math.abs(motion.upperBody.shoulderAngleDelta) > RECOMMENDED_MOTION_ENVELOPE.shoulderAngle
  ) {
    outside.push("shoulderAngle");
  }

  return outside;
}
