import type { TransformationCalibrationProfile } from "./calibrationTypes";
import type { FaceTrackingResult } from "./faceTypes";
import { eyeOpenness, jawDisplacement, mouthCornerLift, mouthOpenness } from "./faceGeometry";
import type { SourceExpressionProfile, SourceFaceGeometry } from "../source/sourceTypes";
import { canonicalFaceLandmarks, localBrowHeights } from './faceLocalGeometry';
import type { Point3 } from './faceTypes';
import { measureBinocularGaze, normalizeBinocularGaze, type NormalizedGaze } from './eyeGaze';
import { measureEyeGeometry, eyeStateFromGeometry, EYE_RENDER_CHANNELS, type EyeControlFrame } from './eyeControls';
import { measureMouthControls, measureMouthGeometry, smoothMouth, type MouthControlFrame } from './mouthControls';
import { noseControls, type NoseControlFrame } from './noseControls';
import { mouthNoseLocalLandmarks } from './mouthNoseLocalGeometry';
import { INNER_LIP_RING, OUTER_LIP_RING } from './rendering/sourceMesh';

const BROW_FULL_RAISE = 0.085;
const localScratch: Point3[] = [];
const regionScratch: Point3[] = [];
const previousBrow = new WeakMap<TransformationCalibrationProfile, { pitch: number; shape: number; height: number }>();

/** Only the eight expressions the face renderer currently supports. */
export const EXPRESSION_KEYS = [
  "blinkLeft", "blinkRight", "jawOpen", "smileLeft", "smileRight",
  "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
] as const;
export type ExpressionKey = (typeof EXPRESSION_KEYS)[number];
export type ExpressionValues = Record<ExpressionKey, number> & { eyes?: EyeControlFrame; mouth?: MouthControlFrame; nose?: NoseControlFrame };
/** Which input won for one expression, and the numbers behind it. */
export interface ExpressionTraceEntry {
  /** The blendshape score, or null when this build did not report that name. */
  blendshape: number | null;
  /**
   * The landmark-geometry measure, or null where there was none to take.
   *
   * Null rather than zero, because zero is a real reading — a relaxed mouth, an
   * open eye — and reporting it for a frame that carried no mesh would state a
   * measurement nobody made.
   */
  geometry: number | null;
  /** The operator's calibrated resting value. */
  neutral: number;
  /** After the neutral offset, before any source limit. */
  normalized: number;
  /** Which input the normalized value came from. */
  origin: "blendshape" | "geometry";
}

export type ExpressionTrace = Record<ExpressionKey, ExpressionTraceEntry>;

export interface ExpressionMotion extends ExpressionValues {
  /** Performance-clock time when this frame's expression calculation completed. */
  updatedAtMs?: number;
  /** Independent, calibrated eye motion. The source eye pixels stay the source's. */
  eyeGaze?: {
    raw: { left: { x: number; y: number }; right: { x: number; y: number } } | null;
    neutral: { left: { x: number; y: number }; right: { x: number; y: number } } | null;
    normalized: NormalizedGaze | null;
    applied: NormalizedGaze | null;
    quality: { left: number; right: number } | null;
  } | null;
  /** Observational only: never modifies expression values. */
  leakage?: boolean;
  /** Eyelid aperture per eye (face-local, multi-point), for diagnostics. */
  eyeAperture?: { left: number | null; right: number | null };
  /** Local inner-lip aperture and chin drop, retained for jaw diagnostics. */
  mouthAperture?: { ratio: number | null; jawDrop: number | null };
  /** Ephemeral landmarks only; consumed in-memory by the optional compositor. */
  liveMouth?: { timestampMs: number; ring: { x: number; y: number }[]; innerRing?: { x: number; y: number }[]; faceWidthRatio: number; sourceFrame?: HTMLCanvasElement };
  /** Per-eye blink state and the closure measured before it shaped the value. */
  blinkState?: {
    left: "open" | "closing" | "closed" | "opening";
    right: "open" | "closing" | "closed" | "opening";
    measuredLeft: number;
    measuredRight: number;
  };
  status: "tracked" | "manual";
  calculationMs: number;
  /**
   * The full input trace, for the Studio diagnostics.
   *
   * Exists because a real device showed numbers arriving while the face did not
   * move, and nothing distinguished "the blendshape read zero" from "the source
   * limit crushed it" from "the mesh barely shifted". Absent for a manual
   * override, which has no input to trace.
   */
  trace?: ExpressionTrace;
}
export type ExpressionEnvelope = ExpressionValues;

export const NEUTRAL_EXPRESSION: ExpressionValues = {
  blinkLeft: 0, blinkRight: 0, jawOpen: 0, smileLeft: 0, smileRight: 0,
  browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0,
};

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const relative = (value: number, neutral: number) => unit((value - neutral) / Math.max(0.25, 1 - neutral));

/**
 * How far a blendshape may drift from its neutral before it counts.
 *
 * MediaPipe's blendshapes are not pose-invariant; face-local geometry is. Measured
 * through the real tracker (transformation-m83-expression-isolation): a still
 * face turned or nodded 15° moved brow blendshapes by up to +0.13 and a resting
 * smile's by +0.06 — which the headroom normalisation above turned into a 0.24
 * "smile" for anyone who smiles at rest. So the blendshape's dead zone grows
 * with distance from the calibrated pose: frame jitter when frontal, the
 * measured drift by 15°. Geometry is never dead-zoned, so a real expression at
 * any pose still reads through it.
 */
export const BLENDSHAPE_JITTER = 0.02;

/**
 * Where a closed eye's aperture sits, as a fraction of the same eye open. Lid
 * landmarks stay ~20–30% apart on a shut eye, which is why eye-aspect-ratio
 * blink detectors threshold near 0.2 of open rather than at zero. Provisional
 * until a physical recording measures it.
 */
export const EYE_CLOSED_FRACTION = 0.25;
export const BLENDSHAPE_POSE_DRIFT = 0.12;
const POSE_DRIFT_FULL_AT = 0.26;

const relativeShape = (value: number, neutral: number, deadZone: number) =>
  unit((value - neutral - deadZone) / Math.max(0.25, 1 - neutral - deadZone));

/** All geometry ratios divide by local feature width, cancelling translation and scale.
 * Blendshapes supply the semantic signal and are preferred under moderate yaw.
 * Geometry is used only if that named blendshape is absent. */
export function computeExpressionMotion(
  face: FaceTrackingResult | null,
  calibration: TransformationCalibrationProfile | null,
): ExpressionMotion | null {
  if (!face?.detected || !face.derived || !calibration) return null;
  const started = performance.now();
  const shapes = face.blendshapes;
  const neutral = calibration.face.expressionNeutral;
  /*
   * Geometry needs a mesh, and its absence is not a reading.
   *
   * `eyeOpenness` returns 0 both for a fully closed eye AND for landmarks that
   * were never there, so a frame carrying no mesh would otherwise fuse to a full
   * blink on both eyes at once — destroying the left/right independence this is
   * supposed to protect. The classic mesh is 468 points; 478 with irises.
   */
  const hasMesh = face.landmarks.length >= 468;
  const local = hasMesh ? canonicalFaceLandmarks(face.landmarks, face.derived,
    calibration.trackingSpace ? calibration.trackingSpace.width / calibration.trackingSpace.height : 1, localScratch) : [];
  const brow = localBrowHeights(local);
  const browNeutral = calibration.face.neutralBrowHeights;
  // A full raise lifts the brow about 8.5% of face width above its neutral —
  // the same fraction the deformer moves the source brow by.
  const browSignal = (index: number) => brow && browNeutral ? unit((brow[index]! - browNeutral[index]!) / BROW_FULL_RAISE) : null;
  const before = previousBrow.get(calibration);
  const current = { pitch: face.derived.pitch, shape: shapes.browInnerUp ?? 0, height: brow?.[0] ?? 0 };
  const leakage = !!before && !!brow && Math.abs(current.pitch - before.pitch) > .08 &&
    Math.abs(current.shape - before.shape) > .1 && Math.abs(current.height - before.height) < .01;
  if (!before || Math.abs(current.pitch - before.pitch) > .08) previousBrow.set(calibration, current);
  const mouthBase = calibration.face.neutralMouthOpenness;
  const mouthGeometry = hasMesh ? mouthOpenness(local) : null;
  const jawGeometry = hasMesh ? jawDisplacement(local) : null;
  const jawNeutral = calibration.face.neutralJawDisplacement ?? jawGeometry ?? 0;
  // Chin-to-nose distance also changes slightly when canonical pose is estimated
  // from a real image. Let it support measured lip separation, but cap that vote
  // so a nod alone cannot overwhelm the actual mouth aperture. Full travel is
  // about 8% of face width.
  const mouthGeometrySignal = mouthGeometry === null ? 0 : relative(mouthGeometry, mouthBase);
  const jawDropSignal = jawGeometry === null ? 0 : Math.min(
    unit((jawGeometry - jawNeutral) / 0.08), mouthGeometrySignal + 0.15,
  );
  const mouthDelta = mouthGeometry === null ? 0 : Math.max(0, mouthGeometry - mouthBase);
  const eyeL = hasMesh ? eyeOpenness(local, "left") : null;
  const eyeR = hasMesh ? eyeOpenness(local, "right") : null;
  const rawGaze = hasMesh ? measureBinocularGaze(local) : null;
  const neutralGaze = calibration.face.neutralEyeGaze ?? null;
  const eyeGaze = rawGaze && neutralGaze
    ? { raw: { left: rawGaze.left, right: rawGaze.right }, neutral: neutralGaze,
        normalized: normalizeBinocularGaze(rawGaze, neutralGaze),
        applied: normalizeBinocularGaze(rawGaze, neutralGaze), quality: rawGaze.quality }
    : { raw: rawGaze ? { left: rawGaze.left, right: rawGaze.right } : null, neutral: neutralGaze,
        normalized: null, applied: null, quality: rawGaze?.quality ?? null };
  /*
   * Closure against THIS eye's calibrated opening, with a closed eye at
   * EYE_CLOSED_FRACTION of it rather than at zero: MediaPipe's lid landmarks
   * never fully meet on a shut eye, so measured against zero a real blink could
   * only ever read part-closed.
   */
  const lidClosure = (open: number | null, baseline: number) => {
    if (open === null) return null;
    const opened = Math.max(.05, baseline);
    const closed = opened * EYE_CLOSED_FRACTION;
    return 1 - unit((open - closed) / (opened - closed));
  };

  /*
   * FUSED, not one preferred over the other.
   *
   * Geometry used to be a fallback for a MISSING blendshape name, which meant a
   * name that was present but reading near zero suppressed the expression
   * entirely. A real device showed exactly that: jawOpen at 0.00 with the
   * operator's mouth plainly open, and blinks of 0.01 against 0.29 with both
   * eyes doing the same thing.
   *
   * So each expression takes the LARGER of its two signals. Both measure how far
   * open something is, both sit at zero when relaxed, and the failure being
   * guarded against is a false LOW from either input — which a maximum ignores
   * and an average would only halve. The trace records which one won, so an
   * unreliable input stays visible instead of being silently compensated for.
   */
  const trace = {} as ExpressionTrace;
  const rotated = Math.hypot(
    face.derived.yaw - calibration.face.yaw,
    face.derived.pitch - calibration.face.pitch,
    face.derived.roll - calibration.face.roll,
  );
  const shapeDeadZone = BLENDSHAPE_JITTER + BLENDSHAPE_POSE_DRIFT * Math.min(1, (Number.isFinite(rotated) ? rotated : 0) / POSE_DRIFT_FULL_AT);
  const fuse = (
    key: ExpressionKey,
    name: string,
    geometry: number | null,
    geometryBaseline: number,
    blendshapeBaseline: number,
    additionalGeometrySignal = 0,
    blendshapeCorrection = 0,
  ): number => {
    const raw = typeof shapes[name] === "number" ? shapes[name]! : null;
    const fromBlendshape = raw === null ? 0 : relativeShape(raw - blendshapeCorrection, blendshapeBaseline, shapeDeadZone);
    const fromGeometry = geometry === null ? 0 : relative(geometry, geometryBaseline);
    const normalized = Math.max(fromBlendshape, fromGeometry, additionalGeometrySignal);
    trace[key] = {
      blendshape: raw,
      geometry,
      neutral: blendshapeBaseline,
      normalized,
      origin: Math.max(fromGeometry, additionalGeometrySignal) > fromBlendshape ? "geometry" : "blendshape",
    };
    return normalized;
  };

  const result: ExpressionMotion = {
    // Eyelid aspect ratio, against the operator's own calibrated opening.
    blinkLeft: fuse("blinkLeft", hasMesh ? "eyeBlinkRight" : "eyeBlinkLeft", lidClosure(eyeL, calibration.face.neutralEyeOpennessLeft ?? calibration.face.neutralEyeOpenness), 0, neutral?.blinkLeft ?? 0),
    blinkRight: fuse("blinkRight", hasMesh ? "eyeBlinkLeft" : "eyeBlinkRight", lidClosure(eyeR, calibration.face.neutralEyeOpennessRight ?? calibration.face.neutralEyeOpenness), 0, neutral?.blinkRight ?? 0),
    // Lip separation, normalised by mouth width.
    jawOpen: fuse("jawOpen", "jawOpen", mouthGeometry, mouthBase, neutral?.jawOpen ?? mouthBase, jawDropSignal),
    /*
     * Mouth-corner lift. Its geometric baseline is zero because a relaxed mouth
     * has its corners roughly level with the lip centre — an approximation,
     * documented rather than measured, because calibration records no
     * corner-lift neutral of its own.
     */
    // Opening the jaw moves the lip centre and can raise both MediaPipe smile
    // scores even with still corners. Remove the measured jaw contribution;
    // genuine corner lift beyond it remains available, including with jaw open.
    smileLeft: fuse("smileLeft", "mouthSmileLeft",
      hasMesh ? Math.max(calibration.face.neutralSmileLeft ?? 0, mouthCornerLift(local, "left") - mouthDelta * 1.8) : null,
      calibration.face.neutralSmileLeft ?? 0, neutral?.smileLeft ?? 0, 0, mouthDelta * 0.3),
    smileRight: fuse("smileRight", "mouthSmileRight",
      hasMesh ? Math.max(calibration.face.neutralSmileRight ?? 0, mouthCornerLift(local, "right") - mouthDelta * 1.8) : null,
      calibration.face.neutralSmileRight ?? 0, neutral?.smileRight ?? 0, 0, mouthDelta * 0.3),
    /*
     * Brow geometry is measured in FACE-LOCAL space only. Measured in camera
     * space, a nod foreshortens the brow-to-eye distance and read as a raise,
     * which is why brows once had no geometric input at all. With the head's
     * rotation removed first, a rigid nod leaves this at neutral (pinned in
     * m82Isolation.test.ts); `leakage` flags a blendshape riding a nod.
     */
    browInnerUp: fuse("browInnerUp", "browInnerUp", browSignal(0), 0, neutral?.browInnerUp ?? 0),
    browOuterUpLeft: fuse("browOuterUpLeft", "browOuterUpLeft", browSignal(1), 0, neutral?.browOuterUpLeft ?? 0),
    browOuterUpRight: fuse("browOuterUpRight", "browOuterUpRight", browSignal(2), 0, neutral?.browOuterUpRight ?? 0),
    status: "tracked",
    calculationMs: performance.now() - started,
    updatedAtMs: performance.now(),
    trace,
    leakage,
    eyeAperture: { left: eyeL, right: eyeR },
    eyeGaze,
    mouthAperture: { ratio: mouthGeometry, jawDrop: jawGeometry },
    liveMouth: hasMesh ? {
      timestampMs: face.timestampMs,
      ring: OUTER_LIP_RING.map(index => ({ x: face.landmarks[index]!.x, y: face.landmarks[index]!.y })),
      innerRing: INNER_LIP_RING.map(index => ({ x: face.landmarks[index]!.x, y: face.landmarks[index]!.y })),
      // x is normalized by frame width, so the renderer multiplies by the
      // current tracking-frame width to recover face width in pixels.
      faceWidthRatio: Math.abs(face.landmarks[454]!.x - face.landmarks[234]!.x),
    } : undefined,
  };
  result.eyes = Object.fromEntries((['left', 'right'] as const).map(side => {
    const channel = EYE_RENDER_CHANNELS[side];
    return [side, eyeStateFromGeometry(hasMesh ? measureEyeGeometry(local, side) : null, calibration.face.eyes?.[side], channel === 'left' ? result.blinkLeft : result.blinkRight, face.confidence, eyeGaze.applied?.[channel] ?? null)];
  })) as unknown as EyeControlFrame;
  if (hasMesh && calibration.face.mouth) {
    const regionLocal=mouthNoseLocalLandmarks(face,calibration.trackingSpace ? calibration.trackingSpace.width / calibration.trackingSpace.height : 1, regionScratch);
    const geometry=measureMouthGeometry(regionLocal),base=calibration.face.mouth.geometry;
    const apertureSignal=geometry?relative(geometry.aperture,base.aperture):0;
    const jawSignal=geometry?Math.min(unit((geometry.jaw-base.jaw)/.08),apertureSignal+.15):0;
    const jaw=Math.max(relativeShape(shapes.jawOpen??0,calibration.face.mouth.shapes.jawOpen??0,shapeDeadZone),apertureSignal,jawSignal);
    result.mouth = measureMouthControls(regionLocal, shapes, calibration.face.mouth, jaw, face.confidence, face.timestampMs, rotated) ?? undefined;
    result.nose = noseControls(regionLocal, shapes, calibration.face.nose, face.confidence, rotated);
  }
  result.calculationMs = performance.now() - started;
  return result;
}

/**
 * The blendshape names this pipeline asks for.
 *
 * Exposed because a category renamed between model builds would otherwise read
 * as an expression that simply does not work. `describeBlendshapeCoverage` shows
 * at a glance whether each one resolves on the device in hand.
 */
export const EXPRESSION_BLENDSHAPE_NAMES: Record<ExpressionKey, string> = {
  blinkLeft: "eyeBlinkLeft",
  blinkRight: "eyeBlinkRight",
  jawOpen: "jawOpen",
  smileLeft: "mouthSmileLeft",
  smileRight: "mouthSmileRight",
  browInnerUp: "browInnerUp",
  browOuterUpLeft: "browOuterUpLeft",
  browOuterUpRight: "browOuterUpRight",
};

/** Which of the expected categories a tracked frame actually reported. */
export function describeBlendshapeCoverage(shapes: Readonly<Partial<Record<string, number>>>): {
  present: ExpressionKey[];
  missing: ExpressionKey[];
} {
  const present: ExpressionKey[] = [];
  const missing: ExpressionKey[] = [];
  for (const key of EXPRESSION_KEYS) {
    if (typeof shapes[EXPRESSION_BLENDSHAPE_NAMES[key]] === "number") present.push(key);
    else missing.push(key);
  }
  return { present, missing };
}

/** The prepared source can have a smile or partly shut eyes already. */
export function deriveSourceExpression(face: SourceFaceGeometry): SourceExpressionProfile {
  const eyeOpenLeft = unit(eyeOpenness(face.landmarks, "left"));
  const eyeOpenRight = unit(eyeOpenness(face.landmarks, "right"));
  const mouthOpen = unit(mouthOpenness(face.landmarks));
  const limitations: string[] = [];
  if (eyeOpenLeft < 0.18) limitations.push("left-eye-already-narrow");
  if (eyeOpenRight < 0.18) limitations.push("right-eye-already-narrow");
  if (mouthOpen < 0.12) limitations.push("closed-mouth-no-interior");
  return {
    eyeOpenLeft, eyeOpenRight, mouthOpen,
    smileLeft: unit(face.blendshapes?.mouthSmileLeft ?? 0),
    smileRight: unit(face.blendshapes?.mouthSmileRight ?? 0),
    browInnerUp: unit(face.blendshapes?.browInnerUp ?? 0),
    browOuterUpLeft: unit(face.blendshapes?.browOuterUpLeft ?? 0),
    browOuterUpRight: unit(face.blendshapes?.browOuterUpRight ?? 0),
    limitations,
  };
}

/**
 * What the SOURCE PIXELS cannot support — not what the source already shows.
 *
 * The previous version conflated the two, and a measurement showed the cost: a
 * full request arrived at the mesh as 0.15 to 0.32 for six of the eight
 * expressions, because the prepared source happened to be smiling a little and
 * had slightly raised brows. On a real device that reads as expressions simply
 * not working.
 *
 * The distinction that matters: a photograph of a CLOSED MOUTH genuinely has no
 * teeth or tongue behind the lips, so opening it far would have to invent them.
 * But a photograph of someone already half-smiling has every pixel needed to
 * smile more — their existing smile is a starting position, not a ceiling. So a
 * present expression now shifts the rest position gently rather than capping the
 * range, and only the mouth interior keeps a hard limit.
 */
export function deriveExpressionEnvelope(source: SourceExpressionProfile): ExpressionEnvelope {
  // An open-eyed source can close its eyes completely; a source photographed
  // mid-blink cannot close much further, and that one IS a real limit.
  const blink = (_open: number) => 1;
  // Headroom that falls with what the source already shows, but never below
  // half — enough to stay clearly visible.
  const headroom = (existing: number) => Math.max(0.5, 1 - unit(existing) * 0.35);

  return {
    blinkLeft: blink(source.eyeOpenLeft),
    blinkRight: blink(source.eyeOpenRight),
    /*
     * The one genuine pixel limit. A closed-mouth source must move lips, chin
     * and jaw without opening a hole it has nothing to fill — so the ceiling is
     * generous enough to be plainly visible and still short of a gape.
     */
    jawOpen: Math.min(0.9, 0.55 + source.mouthOpen * 0.35),
    smileLeft: headroom(source.smileLeft),
    smileRight: headroom(source.smileRight),
    browInnerUp: headroom(source.browInnerUp),
    browOuterUpLeft: headroom(source.browOuterUpLeft),
    browOuterUpRight: headroom(source.browOuterUpRight),
  };
}

export function clampExpression(requested: ExpressionValues, envelope: ExpressionEnvelope): {
  applied: ExpressionValues; clamped: ExpressionKey[];
} {
  const applied = { ...NEUTRAL_EXPRESSION };
  const clamped: ExpressionKey[] = [];
  clampExpressionInto(requested, envelope, applied, clamped);
  return { applied, clamped };
}

/** Allocation-free clamp for the renderer's frame loop. */
export function clampExpressionInto(
  requested: ExpressionValues,
  envelope: ExpressionEnvelope,
  applied: ExpressionValues,
  clamped: ExpressionKey[],
): void {
  applied.eyes = requested.eyes;
  // A cavity makes a closed photograph openable. The canonical jaw retains
  // its full progressive range; the original legacy slider envelope remains.
  applied.mouth = requested.mouth;
  applied.nose = requested.nose;
  clamped.length = 0;
  for (const key of EXPRESSION_KEYS) {
    applied[key] = Math.min(unit(requested[key]), envelope[key]);
    if (requested[key] > applied[key] + 1e-4) clamped.push(key);
  }
}

/** Blink uses a short attack. A single noisy sample is still damped. */
export function smoothExpression(previous: ExpressionValues, target: ExpressionValues, elapsedMs: number): ExpressionValues {
  const result = { ...NEUTRAL_EXPRESSION };
  smoothExpressionInto(previous, target, elapsedMs, result);
  return result;
}

/** Allocation-free smoother for the renderer's frame loop. */
export function smoothExpressionInto(
  previous: ExpressionValues,
  target: ExpressionValues,
  elapsedMs: number,
  result: ExpressionValues,
): void {
  // Eye controls are already filtered once per fresh tracker sample. Do not
  // add a second renderer-frame filter to gaze, wide aperture or lid travel.
  result.eyes = target.eyes;
  result.mouth = smoothMouth(previous.mouth, target.mouth, elapsedMs);
  result.nose = target.nose;
  for (const key of EXPRESSION_KEYS) {
    const tau = key.startsWith("blink") ? (target.eyes ? 8 : target[key] > previous[key] ? 28 : 55)
      : key === "jawOpen" ? 45 : 75;
    const alpha = 1 - Math.exp(-Math.min(80, Math.max(0, elapsedMs)) / tau);
    result[key] = previous[key] + (target[key] - previous[key]) * alpha;
  }
}
