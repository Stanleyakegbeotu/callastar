import type { TrackerId, TrackerSample } from './trackerProvider';

const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const numbers = (values: (number | null)[]) => values.filter((v): v is number => v !== null && Number.isFinite(v));
const deviation = (values: number[]): number | null => {
  const average = mean(values);
  return average === null || values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
};
export interface BenchmarkSummary {
  provider: TrackerId; model: string; initializationMs: number | null;
  durationMs: number; samples: number; capped: boolean;
  confidence: number | null; callbackFps: number | null; trackingFps: number | null;
  callbackIntervalMs: number | null; inferenceMs: number | null; frameAgeMs: number | null;
  staleFrames: number; droppedFrames: number | null;
  neutralJitter: [number | null, number | null, number | null]; jitterAxes: string;
  lostFaceEvents: number; reacquisitionMs: number | null; unresolvedLoss: boolean;
  movementResponseMs: number | null; expressionResponseMs: number | null;
  expressionRanges: Record<'mouthOpen' | 'smile' | 'browFrown' | 'browRaise', [number, number] | null>;
}

/** Bounded, numeric-only memory; never accepts images, video, landmarks or provider objects. */
export class BenchmarkRecorder {
  private samples: TrackerSample[] = [];
  private started: number | null = null;
  private provider: TrackerId = 'mediapipe';
  private model = '';
  private initMs: number | null = null;
  private responses: { kind: 'movement' | 'expression'; at: number; baseline: number[]; elapsed: number | null }[] = [];
  private pending: number | null = null;
  private capped = false;
  readonly limit = 30000;
  get recording() { return this.started !== null; }
  get count() { return this.samples.length; }
  start(provider: TrackerId, model: string, at: number, initMs: number | null): void {
    this.reset(); this.provider = provider; this.model = model; this.started = at; this.initMs = initMs;
  }
  add(sample: TrackerSample): void {
    if (!this.recording || sample.provider !== this.provider) return;
    if (this.samples.length >= this.limit) { this.capped = true; return; }
    const copy = { ...sample, pose: sample.pose ? { ...sample.pose } : null, rawRotation: sample.rawRotation ? [...sample.rawRotation] as [number, number, number] : null };
    this.samples.push(copy);
    if (this.pending !== null && sample.detected && !sample.stale) {
      const cue = this.responses[this.pending]!;
      const values = this.responseValues(sample, cue.kind);
      if (values.length === cue.baseline.length && values.some((v, i) => Math.abs(v - cue.baseline[i]!) > 0.12)) {
        cue.elapsed = sample.timestamp - cue.at; this.pending = null;
      }
    }
  }
  private responseValues(sample: TrackerSample, kind: 'movement' | 'expression'): number[] {
    return kind === 'movement'
      ? sample.pose ? [sample.pose.yaw, sample.pose.pitch, sample.pose.roll] : sample.rawRotation ?? []
      : numbers([sample.mouthOpen, sample.smile, sample.browFrown, sample.browRaise]);
  }
  cue(kind: 'movement' | 'expression', at: number, sample: TrackerSample | null): void {
    if (!this.recording || !sample?.detected) return;
    const baseline = this.responseValues(sample, kind);
    if (!baseline.length) return;
    this.responses.push({ kind, at, baseline, elapsed: null }); this.pending = this.responses.length - 1;
  }
  stop(at: number): BenchmarkSummary | null {
    if (this.started === null) return null;
    const durationMs = Math.max(0, at - this.started);
    const samples = this.samples;
    const neutral = samples.filter(s => s.detected && !s.stale && s.timestamp - this.started! <= 5000);
    const physical = this.provider === 'mediapipe' || (neutral.length > 0 && neutral.every(s => s.pose !== null));
    const jitter = [0, 1, 2].map(index => deviation(neutral.flatMap(s => {
      const values = physical && s.pose ? [s.pose.yaw, s.pose.pitch, s.pose.roll] : s.rawRotation;
      return values ? [values[index]!] : [];
    }))) as BenchmarkSummary['neutralJitter'];
    let lostAt: number | null = null, previous: boolean | null = null, losses = 0;
    const reacquired: number[] = [];
    for (const sample of samples) {
      if (previous === true && !sample.detected) { lostAt = sample.timestamp; losses++; }
      if (lostAt !== null && sample.detected) { reacquired.push(sample.timestamp - lostAt); lostAt = null; }
      previous = sample.detected;
    }
    const range = (key: 'mouthOpen' | 'smile' | 'browFrown' | 'browRaise'): [number, number] | null => {
      const values = numbers(samples.filter(s => s.detected && !s.stale).map(s => s[key]));
      return values.length ? [Math.min(...values), Math.max(...values)] : null;
    };
    const callbacks = durationMs > 0 && samples.length ? samples.length * 1000 / durationMs : null;
    const drops = numbers(samples.map(s => s.droppedFrames));
    const summary: BenchmarkSummary = {
      provider: this.provider, model: this.model, initializationMs: this.initMs, durationMs, samples: samples.length, capped: this.capped,
      confidence: mean(samples.map(s => s.confidence)), callbackFps: callbacks,
      trackingFps: callbacks === null ? null : samples.filter(s => !s.stale).length * 1000 / durationMs,
      callbackIntervalMs: mean(numbers(samples.slice(1).map(s => s.callbackIntervalMs))),
      inferenceMs: mean(numbers(samples.map(s => s.inferenceMs))), frameAgeMs: mean(numbers(samples.map(s => s.frameAgeMs))),
      staleFrames: samples.filter(s => s.stale).length,
      droppedFrames: drops.length ? Math.max(0, drops[drops.length - 1]! - drops[0]!) : null,
      neutralJitter: jitter, jitterAxes: physical ? 'physical yaw / pitch / roll (radians)' : 'unverified raw rx / ry / rz (radians)',
      lostFaceEvents: losses, reacquisitionMs: mean(reacquired), unresolvedLoss: lostAt !== null,
      movementResponseMs: mean(numbers(this.responses.filter(r => r.kind === 'movement').map(r => r.elapsed))),
      expressionResponseMs: mean(numbers(this.responses.filter(r => r.kind === 'expression').map(r => r.elapsed))),
      expressionRanges: { mouthOpen: range('mouthOpen'), smile: range('smile'), browFrown: range('browFrown'), browRaise: range('browRaise') },
    };
    this.started = null; this.pending = null;
    return summary;
  }
  reset(): void { this.samples = []; this.responses = []; this.started = null; this.pending = null; this.capped = false; }
}
