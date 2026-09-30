import type { TransformationCalibrationProfile } from "./calibrationTypes";
import type { FaceTrackingResult } from "./faceTypes";
import { eyeOpenness, mouthCornerLift, mouthOpenness } from "./faceGeometry";
import type { SourceExpressionProfile, SourceFaceGeometry } from "../source/sourceTypes";

/** Only the eight expressions the face renderer currently supports. */
export const EXPRESSION_KEYS = [
  "blinkLeft", "blinkRight", "jawOpen", "smileLeft", "smileRight",
  "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
] as const;
export type ExpressionKey = (typeof EXPRESSION_KEYS)[number];
export type ExpressionValues = Record<ExpressionKey, number>;
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
  const eyeBase = Math.max(0.05, calibration.face.neutralEyeOpenness);
  const mouthBase = calibration.face.neutralMouthOpenness;
  const eyeL = hasMesh ? eyeOpenness(face.landmarks, "left") : null;
  const eyeR = hasMesh ? eyeOpenness(face.landmarks, "right") : null;
  const lidClosure = (open: number | null) => (open === null ? null : 1 - Math.min(1, open / eyeBase));

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
  const fuse = (
    key: ExpressionKey,
    name: string,
    geometry: number | null,
    geometryBaseline: number,
    blendshapeBaseline: number,
  ): number => {
    const raw = typeof shapes[name] === "number" ? shapes[name]! : null;
    const fromBlendshape = raw === null ? 0 : relative(raw, blendshapeBaseline);
    const fromGeometry = geometry === null ? 0 : relative(geometry, geometryBaseline);
    const normalized = Math.max(fromBlendshape, fromGeometry);
    trace[key] = {
      blendshape: raw,
      geometry,
      neutral: blendshapeBaseline,
      normalized,
      origin: geometry !== null && fromGeometry > fromBlendshape ? "geometry" : "blendshape",
    };
    return normalized;
  };

  return {
    // Eyelid aspect ratio, against the operator's own calibrated opening.
    blinkLeft: fuse("blinkLeft", "eyeBlinkLeft", lidClosure(eyeL), 0, neutral?.blinkLeft ?? 0),
    blinkRight: fuse("blinkRight", "eyeBlinkRight", lidClosure(eyeR), 0, neutral?.blinkRight ?? 0),
    // Lip separation, normalised by mouth width.
    jawOpen: fuse("jawOpen", "jawOpen", hasMesh ? mouthOpenness(face.landmarks) : null, mouthBase, neutral?.jawOpen ?? mouthBase),
    /*
     * Mouth-corner lift. Its geometric baseline is zero because a relaxed mouth
     * has its corners roughly level with the lip centre — an approximation,
     * documented rather than measured, because calibration records no
     * corner-lift neutral of its own.
     */
    smileLeft: fuse("smileLeft", "mouthSmileLeft", hasMesh ? mouthCornerLift(face.landmarks, "left") : null, 0, neutral?.smileLeft ?? 0),
    smileRight: fuse("smileRight", "mouthSmileRight", hasMesh ? mouthCornerLift(face.landmarks, "right") : null, 0, neutral?.smileRight ?? 0),
    /*
     * Brows get no landmark fallback, deliberately. The mesh's brow points move
     * with the forehead, so a geometric measure would largely track head pitch
     * and would raise the brows every time somebody nodded. The blendshape is the
     * only honest input here, and the trace shows that rather than implying a
     * fusion which is not happening.
     */
    browInnerUp: fuse("browInnerUp", "browInnerUp", null, 0, neutral?.browInnerUp ?? 0),
    browOuterUpLeft: fuse("browOuterUpLeft", "browOuterUpLeft", null, 0, neutral?.browOuterUpLeft ?? 0),
    browOuterUpRight: fuse("browOuterUpRight", "browOuterUpRight", null, 0, neutral?.browOuterUpRight ?? 0),
    status: "tracked",
    calculationMs: performance.now() - started,
    trace,
  };
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
  const blink = (open: number) => unit(0.35 + open * 0.65);
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
  for (const key of EXPRESSION_KEYS) {
    const tau = key.startsWith("blink") ? (target[key] > previous[key] ? 28 : 55)
      : key === "jawOpen" ? 45 : 75;
    const alpha = 1 - Math.exp(-Math.min(80, Math.max(0, elapsedMs)) / tau);
    result[key] = previous[key] + (target[key] - previous[key]) * alpha;
  }
}
