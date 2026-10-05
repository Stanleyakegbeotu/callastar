import type { Point3 } from "./faceTypes";
import { stabilityCutoff } from "./transformationControls";

interface ScalarState {
  value: number;
  derivative: number;
}

export interface LandmarkStabilizerOptions {
  stableMinCutoffHz?: number;
  expressiveMinCutoffHz?: number;
  velocityGain?: number;
  derivativeCutoffHz?: number;
}

const EXPRESSIVE_LANDMARKS = new Set<number>([
  7, 33, 133, 144, 145, 153, 154, 155, 157, 158, 159, 160, 161, 163, 173, 246,
  249, 263, 362, 373, 374, 380, 381, 382, 384, 385, 386, 387, 388, 390, 398, 466,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
  1, 4, 13, 14, 17, 61, 291, 199, 152,
  468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
]);

function smoothingAlpha(cutoffHz: number, deltaSeconds: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(0.01, cutoffHz));
  return 1 / (1 + tau / deltaSeconds);
}

function updateScalar(
  previous: ScalarState,
  value: number,
  deltaSeconds: number,
  minCutoffHz: number,
  velocityGain: number,
  derivativeCutoffHz: number,
): ScalarState {
  const derivative = (value - previous.value) / deltaSeconds;
  const derivativeAlpha = smoothingAlpha(derivativeCutoffHz, deltaSeconds);
  const filteredDerivative = previous.derivative + derivativeAlpha * (derivative - previous.derivative);
  const cutoff = minCutoffHz + velocityGain * Math.abs(filteredDerivative);
  const alpha = smoothingAlpha(cutoff, deltaSeconds);
  return {
    value: previous.value + alpha * (value - previous.value),
    derivative: filteredDerivative,
  };
}

/**
 * Low-latency One Euro filtering for the renderer's current face geometry.
 * Stable skin anchors get stronger still-frame filtering; expressive landmarks
 * use a higher cutoff so lids, gaze, lips, and jaw keep their response.
 */
export class LandmarkStabilizer {
  private states: ScalarState[][] | null = null;
  private timestampMs: number | null = null;
  private stableMinCutoffHz: number;
  private readonly expressiveMinCutoffHz: number;
  private readonly velocityGain: number;
  private readonly derivativeCutoffHz: number;
  lastUpdateMs = 0;
  lastLatencyEstimateMs: number | null = null;

  constructor(options: LandmarkStabilizerOptions = {}) {
    this.stableMinCutoffHz = options.stableMinCutoffHz ?? 8;
    this.expressiveMinCutoffHz = options.expressiveMinCutoffHz ?? 50;
    this.velocityGain = options.velocityGain ?? 2.5;
    this.derivativeCutoffHz = options.derivativeCutoffHz ?? 1;
  }

  /** Slider response is bounded so even 100% stability retains movement. */
  setStability(value: number): void {
    this.stableMinCutoffHz = stabilityCutoff(value);
  }

  reset(): void {
    this.states = null;
    this.timestampMs = null;
    this.lastLatencyEstimateMs = null;
  }

  update(points: readonly Point3[] | null, timestampMs: number): Point3[] | null {
    const startedAt = performance.now();
    if (!points || points.length === 0 || !Number.isFinite(timestampMs)) {
      this.reset();
      this.lastUpdateMs = performance.now() - startedAt;
      return null;
    }
    if (this.timestampMs === null || !this.states || timestampMs <= this.timestampMs || timestampMs - this.timestampMs > 500 || this.states.length !== points.length) {
      this.states = points.map(point => [point.x, point.y, point.z].map(value => ({ value, derivative: 0 })));
      this.timestampMs = timestampMs;
      this.lastLatencyEstimateMs = 0;
      this.lastUpdateMs = performance.now() - startedAt;
      return points.map(point => ({ ...point }));
    }
    const deltaSeconds = Math.min(0.1, Math.max(1 / 120, (timestampMs - this.timestampMs) / 1000));
    const output = new Array<Point3>(points.length);
    const latencyEstimates: number[] = [];
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!;
      const current = this.states[index]!;
      const cutoff = EXPRESSIVE_LANDMARKS.has(index) ? this.expressiveMinCutoffHz : this.stableMinCutoffHz;
      current[0] = updateScalar(current[0]!, point.x, deltaSeconds, cutoff, this.velocityGain, this.derivativeCutoffHz);
      current[1] = updateScalar(current[1]!, point.y, deltaSeconds, cutoff, this.velocityGain, this.derivativeCutoffHz);
      current[2] = updateScalar(current[2]!, point.z, deltaSeconds, cutoff, this.velocityGain, this.derivativeCutoffHz);
      output[index] = { x: current[0]!.value, y: current[1]!.value, z: current[2]!.value };
      if (Math.abs(current[0]!.derivative) > 0.03) latencyEstimates.push(Math.abs(point.x - current[0]!.value) / Math.abs(current[0]!.derivative) * 1000);
      if (Math.abs(current[1]!.derivative) > 0.03) latencyEstimates.push(Math.abs(point.y - current[1]!.value) / Math.abs(current[1]!.derivative) * 1000);
    }
    this.timestampMs = timestampMs;
    latencyEstimates.sort((a, b) => a - b);
    this.lastLatencyEstimateMs = latencyEstimates.length
      ? Math.min(250, latencyEstimates[Math.floor(latencyEstimates.length / 2)]!)
      : 0;
    this.lastUpdateMs = performance.now() - startedAt;
    return output;
  }
}

export function isExpressiveLandmark(index: number): boolean {
  return EXPRESSIVE_LANDMARKS.has(index);
}
