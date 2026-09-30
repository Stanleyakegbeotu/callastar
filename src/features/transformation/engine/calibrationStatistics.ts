import type { Point3 } from "./faceTypes";

/**
 * The statistics calibration is built on.
 *
 * Pure functions, separated from the collector, because this is where a subtle
 * error would be invisible: a baseline biased by one blink looks like a
 * perfectly ordinary set of numbers, and every frame afterwards inherits it.
 *
 * ROBUST STATISTIC: the median, throughout.
 *
 * Not the mean, which one dropped-landmark frame can move a long way. Not a
 * trimmed mean either, though it was the obvious alternative: over a window of
 * a dozen-odd frames a 20% trim still averages the near-outliers it did not
 * cut, and it needs a tie-break policy for the trim boundary that would have to
 * be pinned by test anyway. The median needs one stated rule — for an even
 * count, the mean of the two middle values — and is otherwise a sample the
 * operator actually produced.
 *
 * Angles are treated linearly rather than circularly. Head yaw, pitch and roll
 * are bounded well inside ±90° by the acceptance envelope, so there is no wrap
 * to handle, and a circular mean would only add a failure mode.
 */

/** Median of a sample. Null for an empty or wholly non-finite sample. */
export function median(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;

  const sorted = [...usable].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  // Even count: the mean of the two middle values, stated so the result is
  // deterministic rather than depending on a sort's tie-breaking.
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Median absolute deviation — the dispersion measure used for stability.
 *
 * MAD rather than variance for the same reason the median is used for the
 * centre: one frame in which the model briefly lost an eye would dominate a
 * variance and make a perfectly still operator read as moving.
 *
 * Deliberately NOT scaled by 1.4826 to approximate a standard deviation. That
 * constant assumes normally distributed noise, which tracker jitter is not, and
 * the tolerances below are calibrated against the raw MAD.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const centre = median(values);
  if (centre === null) return null;

  const deviations = values.filter((value) => Number.isFinite(value)).map((value) => Math.abs(value - centre));
  return median(deviations);
}

/**
 * Component-wise median of a set of points.
 *
 * Not the geometric median, which has no closed form and would need an
 * iterative solve for no practical gain here: the components are already nearly
 * independent, and the whole point is to reject a frame that jumped, which a
 * per-axis median does.
 */
export function medianPoint(points: readonly Point3[]): Point3 | null {
  if (points.length === 0) return null;

  const x = median(points.map((point) => point.x));
  const y = median(points.map((point) => point.y));
  const z = median(points.map((point) => point.z));

  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/**
 * How much each quantity may wander and still count as "holding still".
 *
 * These are dispersion limits, in the quantity's own units, over the stability
 * window. They are starting points chosen to accept ordinary breathing and
 * tracker jitter while rejecting a deliberate turn or lean — not measured
 * constants, and the report says so.
 *
 * Normalised units throughout: face centre and shoulder centre are fractions of
 * the tracking frame, scale is normalised interocular distance, angles are
 * radians.
 */
export const STABILITY_TOLERANCE = {
  /** ~1.2% of the frame. A head resting on a hand still drifts this much. */
  faceCenterX: 0.012,
  faceCenterY: 0.012,
  /** Interocular distance. Breathing moves this slightly; leaning does not. */
  faceScale: 0.006,
  /** ~2.9°. Below a deliberate glance, above tracker noise. */
  yaw: 0.05,
  pitch: 0.05,
  /** Roll is steadier than the other two in practice, so it is held tighter. */
  roll: 0.04,
  shoulderCenterX: 0.02,
  shoulderCenterY: 0.02,
  shoulderWidth: 0.02,
  /** ~3.4°. Shoulders jitter more than a head does. */
  shoulderAngle: 0.06,
} as const;

export type StabilityQuantity = keyof typeof STABILITY_TOLERANCE;

export interface StabilityAssessment {
  /** True when every measured quantity is inside its tolerance. */
  stable: boolean;
  /**
   * 0..1, from the worst quantity: `clamp(1 - worst / 2, 0, 1)` where `worst`
   * is the largest ratio of measured dispersion to its tolerance.
   *
   * So perfectly still is 1, exactly at the tolerance is 0.5 — which is also
   * the point `stable` flips — and twice the tolerance is 0. A stated formula
   * over measured dispersion, not a model's opinion.
   */
  score: number;
  /** Which quantity was worst, and by how much. Shown in diagnostics. */
  worstQuantity: StabilityQuantity | null;
  worstRatio: number;
  /** Per-quantity dispersion, for the diagnostics drawer. */
  dispersion: Partial<Record<StabilityQuantity, number>>;
}

const UNMEASURABLE: StabilityAssessment = {
  stable: false,
  score: 0,
  worstQuantity: null,
  worstRatio: Number.POSITIVE_INFINITY,
  dispersion: {},
};

/**
 * Whether the operator was still enough.
 *
 * Takes each quantity's samples, measures dispersion, and compares against the
 * tolerance for that quantity. The WORST one decides: a perfectly steady head
 * over a swaying torso is not a usable baseline for upper-body motion, and
 * averaging it anyway is exactly the silent failure this prevents.
 *
 * Quantities with no samples — shoulders, in a face-only calibration — are
 * skipped rather than counted as perfect.
 */
export function assessStability(samples: Partial<Record<StabilityQuantity, readonly number[]>>): StabilityAssessment {
  const dispersion: Partial<Record<StabilityQuantity, number>> = {};
  let worstQuantity: StabilityQuantity | null = null;
  let worstRatio = 0;
  let measured = 0;

  for (const key of Object.keys(STABILITY_TOLERANCE) as StabilityQuantity[]) {
    const values = samples[key];
    if (!values || values.length < 2) continue;

    const mad = medianAbsoluteDeviation(values);
    if (mad === null) continue;

    dispersion[key] = mad;
    measured += 1;

    const ratio = mad / STABILITY_TOLERANCE[key];
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstQuantity = key;
    }
  }

  // Nothing measurable is not the same as nothing moving.
  if (measured === 0) return UNMEASURABLE;

  return {
    stable: worstRatio <= 1,
    score: Math.max(0, Math.min(1, 1 - worstRatio / 2)),
    worstQuantity,
    worstRatio,
    dispersion,
  };
}

/**
 * The forward-facing envelope a frame must sit inside to be collected.
 *
 * Generous on purpose. This rejects someone looking over their shoulder or
 * leaning out of frame, not someone sitting slightly off-axis — a neutral pose
 * IS slightly off-axis, and refusing to calibrate it would make the whole
 * feature unusable for most people.
 */
export const ACCEPTANCE_ENVELOPE = {
  /** Below this the face is too small for the landmarks to be trustworthy. */
  minFaceScale: 0.03,
  /** Above this a head movement will crop, and the neutral is unusable. */
  maxFaceScale: 0.25,
  /** ~26°, ~20°, ~20°. Past these the far side of the mesh is hidden. */
  maxYaw: 0.45,
  maxPitch: 0.35,
  maxRoll: 0.35,
  /** Fraction of the frame the face centre must stay inside. */
  edgeMargin: 0.05,
  /** Below this the landmarks are a guess. Matches the guidance threshold. */
  minConfidence: 0.4,
} as const;
