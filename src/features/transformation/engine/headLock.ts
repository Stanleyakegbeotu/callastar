import type { Point3 } from "./faceTypes";
import type { HeadMotion } from "./relativeMotion";

/** Upper-face points that move with the skull and remain usable through speech. */
export const STABLE_HEAD_ANCHOR_IDS = [
  10, 151, 9, 8,                 // forehead and upper mid-face
  168, 6, 197, 195, 5,          // nose bridge
  33, 133, 263, 362,            // inner and outer eye corners, not lids
  50, 117, 118, 280, 346, 347,  // upper cheekbones
] as const;

export type StableHeadAnchors = readonly Point3[];

export interface StableHeadFit {
  center: Point3;
  scale: number;
  roll: number;
  residual: number;
  inlierCount: number;
  projectedReference: Point3[];
}

interface FitCore {
  angle: number;
  scale: number;
  cosine: number;
  sine: number;
  referenceMean: { x: number; y: number };
  currentMean: { x: number; y: number };
  residuals: number[];
  inliers: number[];
}

const finitePoint = (p: Point3 | undefined): p is Point3 => !!p && Number.isFinite(p.x + p.y + p.z);

export function stableHeadAnchors(landmarks: readonly Point3[]): Point3[] | null {
  if (STABLE_HEAD_ANCHOR_IDS.some(index => !finitePoint(landmarks[index]))) return null;
  return STABLE_HEAD_ANCHOR_IDS.map(index => ({ ...landmarks[index]! }));
}

function coreFit(reference: StableHeadAnchors, current: StableHeadAnchors, aspect: number, inliers: number[]): FitCore | null {
  if (inliers.length < 6) return null;
  let weightTotal = 0, rx = 0, ry = 0, cx = 0, cy = 0;
  for (const index of inliers) {
    const a = reference[index]!, b = current[index]!;
    const weight = index < 4 ? 0.75 : index < 9 ? 1.25 : 1;
    weightTotal += weight; rx += a.x * weight; ry += (a.y / aspect) * weight;
    cx += b.x * weight; cy += (b.y / aspect) * weight;
  }
  if (!weightTotal) return null;
  const referenceMean = { x: rx / weightTotal, y: ry / weightTotal };
  const currentMean = { x: cx / weightTotal, y: cy / weightTotal };
  let dot = 0, cross = 0, norm = 0;
  for (const index of inliers) {
    const a = reference[index]!, b = current[index]!;
    const ax = a.x - referenceMean.x, ay = a.y / aspect - referenceMean.y;
    const bx = b.x - currentMean.x, by = b.y / aspect - currentMean.y;
    const weight = index < 4 ? 0.75 : index < 9 ? 1.25 : 1;
    dot += weight * (ax * bx + ay * by);
    cross += weight * (ax * by - ay * bx);
    norm += weight * (ax * ax + ay * ay);
  }
  if (norm < 1e-8 || Math.hypot(dot, cross) < 1e-8) return null;
  const angle = Math.atan2(cross, dot);
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const scale = Math.hypot(dot, cross) / norm;
  const residuals = reference.map((a, index) => {
    const b = current[index]!;
    const dx = a.x - referenceMean.x, dy = a.y / aspect - referenceMean.y;
    const predictedX = currentMean.x + scale * (cosine * dx - sine * dy);
    const predictedY = currentMean.y + scale * (sine * dx + cosine * dy);
    return Math.hypot(predictedX - b.x, predictedY - b.y);
  });
  return { angle, scale, cosine, sine, referenceMean, currentMean, residuals, inliers };
}

/** Weighted 2D Procrustes fit with one MAD outlier rejection pass. */
export function fitStableHeadAnchors(
  reference: StableHeadAnchors,
  current: StableHeadAnchors,
  referenceCenter: Point3,
  aspect = 1,
): StableHeadFit | null {
  if (reference.length !== STABLE_HEAD_ANCHOR_IDS.length || current.length !== reference.length ||
      !finitePoint(referenceCenter) || !Number.isFinite(aspect) || aspect <= 0 ||
      reference.some(point => !finitePoint(point)) || current.some(point => !finitePoint(point))) return null;

  const all = reference.map((_point, index) => index);
  const first = coreFit(reference, current, aspect, all);
  if (!first) return null;
  const sorted = [...first.residuals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const deviations = first.residuals.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)]!;
  const threshold = Math.max(0.008, median + 3 * mad);
  const inliers = all.filter(index => first.residuals[index]! <= threshold);
  const fit = inliers.length === all.length ? first : coreFit(reference, current, aspect, inliers);
  if (!fit || fit.scale < 0.2 || fit.scale > 5) return null;

  const centerX = referenceCenter.x - fit.referenceMean.x;
  const centerY = referenceCenter.y / aspect - fit.referenceMean.y;
  const center = {
    x: fit.currentMean.x + fit.scale * (fit.cosine * centerX - fit.sine * centerY),
    y: (fit.currentMean.y + fit.scale * (fit.sine * centerX + fit.cosine * centerY)) * aspect,
    z: referenceCenter.z,
  };
  const residual = Math.sqrt(inliers.reduce((sum, index) => sum + fit.residuals[index]! ** 2, 0) / inliers.length);
  const projectedReference = reference.map(point => {
    const dx = point.x - fit.referenceMean.x, dy = point.y / aspect - fit.referenceMean.y;
    return {
      x: fit.currentMean.x + fit.scale * (fit.cosine * dx - fit.sine * dy),
      y: (fit.currentMean.y + fit.scale * (fit.sine * dx + fit.cosine * dy)) * aspect,
      z: point.z,
    };
  });
  return { center, scale: fit.scale, roll: fit.angle, residual, inlierCount: inliers.length, projectedReference };
}

/** Adaptive low-latency filtering. Call once for each newly inferred video frame. */
export class HeadMotionStabilizer {
  private value: HeadMotion | null = null;
  private timestampMs: number | null = null;
  lastUpdateMs = 0;
  lastLatencyEstimateMs: number | null = null;

  reset(): void { this.value = null; this.timestampMs = null; this.lastLatencyEstimateMs = null; }

  update(next: HeadMotion | null, timestampMs: number, stability = 72): HeadMotion | null {
    const startedAt = performance.now();
    if (!next || !Number.isFinite(timestampMs)) {
      this.reset();
      this.lastUpdateMs = performance.now() - startedAt;
      return null;
    }
    if (!this.value || this.timestampMs === null || timestampMs <= this.timestampMs) {
      this.value = { ...next };
      this.timestampMs = timestampMs;
      this.lastLatencyEstimateMs = 0;
      this.lastUpdateMs = performance.now() - startedAt;
      return this.value;
    }
    const dt = Math.min(100, Math.max(8, timestampMs - this.timestampMs));
    const previous = this.value;
    const energy = Math.max(
      Math.abs(next.translationX - previous.translationX),
      Math.abs(next.translationY - previous.translationY),
      Math.abs(next.scaleDelta - previous.scaleDelta) * 0.5,
      Math.abs(next.yawDelta - previous.yawDelta) * 0.5,
      Math.abs(next.pitchDelta - previous.pitchDelta) * 0.5,
      Math.abs(next.rollDelta - previous.rollDelta) * 0.5,
    );
    const boundedStability = Number.isFinite(stability) ? Math.max(0, Math.min(100, stability)) : 72;
    const tau = energy / (dt / 1000) > 0.35
      ? 0.010 + boundedStability * 0.000111111
      : 0.035 + boundedStability * 0.000555556;
    const alpha = 1 - Math.exp(-(dt / 1000) / tau);
    const blend = (from: number, to: number) => from + (to - from) * alpha;
    this.value = {
      translationX: blend(previous.translationX, next.translationX),
      translationY: blend(previous.translationY, next.translationY),
      scaleDelta: blend(previous.scaleDelta, next.scaleDelta),
      yawDelta: blend(previous.yawDelta, next.yawDelta),
      pitchDelta: blend(previous.pitchDelta, next.pitchDelta),
      rollDelta: blend(previous.rollDelta, next.rollDelta),
    };
    this.timestampMs = timestampMs;
    const latency = (Object.keys(next) as (keyof HeadMotion)[]).flatMap(key => {
      const velocity = Math.abs(next[key] - previous[key]) / (dt / 1000);
      return velocity > 0.03 ? [Math.abs(next[key] - this.value![key]) / velocity * 1000] : [];
    }).sort((a, b) => a - b);
    this.lastLatencyEstimateMs = latency.length ? Math.min(250, latency[Math.floor(latency.length / 2)]!) : 0;
    this.lastUpdateMs = performance.now() - startedAt;
    return this.value;
  }
}
