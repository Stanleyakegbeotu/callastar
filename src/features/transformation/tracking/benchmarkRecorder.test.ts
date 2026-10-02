import { describe, expect, it } from 'vitest';
import { BenchmarkRecorder } from './benchmarkRecorder';
import type { TrackerSample } from './trackerProvider';
export const sample = (overrides: Partial<TrackerSample> = {}): TrackerSample => ({
  provider: 'jeeliz', timestamp: 0, detected: true, confidence: .9, centerX: .5, centerY: .5, scale: .3,
  pose: { yaw: 0, pitch: 0, roll: 0 }, rawRotation: [0, 0, 0],
  mouthOpen: .2, smile: null, browFrown: null, browRaise: null,
  blinkLeft: null, blinkRight: null, gazeX: null, gazeY: null, landmarkCount: null,
  callbackIntervalMs: 100, inferenceMs: null, frameAgeMs: 5, stale: false, droppedFrames: 0, ...overrides,
});
describe('numeric benchmark recording', () => {
  it('aggregates rates, supported averages and expression range without inventing inference', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, 120);
    for (let i = 0; i < 10; i++) r.add(sample({ timestamp: i * 100, mouthOpen: i / 10, stale: i === 2, droppedFrames: i === 9 ? 3 : 0 }));
    const result = r.stop(1000)!;
    expect(result.samples).toBe(10); expect(result.callbackFps).toBe(10); expect(result.trackingFps).toBe(9);
    expect(result.inferenceMs).toBeNull(); expect(result.frameAgeMs).toBe(5); expect(result.droppedFrames).toBe(3);
    expect(result.expressionRanges.mouthOpen).toEqual([0, .9]); expect(result.expressionRanges.smile).toBeNull();
  });
  it('records actual lost transitions, reacquisition and unresolved loss', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, 1);
    r.add(sample()); r.add(sample({ timestamp: 100, detected: false })); r.add(sample({ timestamp: 300, detected: true })); r.add(sample({ timestamp: 400, detected: false }));
    const summary = r.stop(500)!;
    expect(summary.lostFaceEvents).toBe(2); expect(summary.reacquisitionMs).toBe(200); expect(summary.unresolvedLoss).toBe(true);
  });
  it('uses only first five seconds of fresh, detected samples for neutral jitter', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, 1);
    r.add(sample({ timestamp: 0, pose: { yaw: -.1, pitch: 0, roll: 0 } })); r.add(sample({ timestamp: 100, pose: { yaw: .1, pitch: 0, roll: 0 } }));
    r.add(sample({ timestamp: 200, stale: true, pose: { yaw: 10, pitch: 0, roll: 0 } })); r.add(sample({ timestamp: 6000, pose: { yaw: 10, pitch: 0, roll: 0 } }));
    const result = r.stop(7000)!;
    expect(result.neutralJitter[0]).toBeCloseTo(.1); expect(result.jitterAxes).toContain('physical');
  });
  it('labels unverified raw jitter and handles empty runs as unavailable', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, null);
    expect(r.stop(100)!.callbackFps).toBeNull();
    r.start('jeeliz', 'default', 0, null); r.add(sample({ pose: null })); r.add(sample({ timestamp: 50, pose: null, rawRotation: [.2, 0, 0] }));
    const result = r.stop(100)!; expect(result.jitterAxes).toContain('unverified raw'); expect(result.neutralJitter[0]).toBeCloseTo(.1);
  });
  it('copies numeric samples and rejects mixed providers and stopped samples', () => {
    const r = new BenchmarkRecorder(); const s = sample(); r.start('jeeliz', 'default', 0, 1); r.add(s); s.pose!.yaw = 9;
    r.add(sample({ provider: 'mediapipe' }));
    expect(r.count).toBe(1); r.stop(50); r.add(sample()); expect(r.count).toBe(1); r.reset(); expect(r.count).toBe(0);
  });
  it('measures cue response and retains no fabricated unanswered response', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, 1);
    r.cue('movement', 100, sample()); r.add(sample({ timestamp: 400, pose: { yaw: .2, pitch: 0, roll: 0 } }));
    r.cue('expression', 450, sample());
    const result = r.stop(500)!; expect(result.movementResponseMs).toBe(300); expect(result.expressionResponseMs).toBeNull();
  });
  it('bounds storage at the numeric sample cap', () => {
    const r = new BenchmarkRecorder(); r.start('jeeliz', 'default', 0, null);
    for (let i = 0; i <= r.limit; i++) r.add(sample({ timestamp: i }));
    const result = r.stop(40000)!; expect(result.samples).toBe(r.limit); expect(result.capped).toBe(true);
  });
});
