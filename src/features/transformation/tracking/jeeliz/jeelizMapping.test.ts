import { describe, expect, it } from 'vitest';
import { canonicalJeelizPose, copyJeelizState, jeelizCameraPosition, measurePoseMapping, type PoseEvidence } from './jeelizMapping';
import { jeelizCapabilities } from './jeelizCapabilities';
import { metricText } from '../trackerProvider';
import type { JeelizState } from './jeelizTypes';

const state: JeelizState = { detected: .95, x: .2, y: -.1, s: .3, rx: .1, ry: -.2, rz: .3, expressions: new Float32Array([.2, .4, .6, .8]) };
describe('official Jeeliz state and capabilities', () => {
  it('maps camera-space position at center and opposing image corners without baking in mirroring', () => {
    expect(jeelizCameraPosition(copyJeelizState({ ...state, x: 0, y: 0 }, 'default', 0))).toEqual({ centerX: .5, centerY: .5 });
    expect(jeelizCameraPosition(copyJeelizState({ ...state, x: -1, y: 1 }, 'default', 0))).toEqual({ centerX: 0, centerY: 0 });
    expect(jeelizCameraPosition(copyJeelizState({ ...state, x: 1, y: -1 }, 'default', 0))).toEqual({ centerX: 1, centerY: 1 });
  });
  it('copies primitive values and the reused expression buffer', () => {
    const raw = { ...state, expressions: new Float32Array(state.expressions) };
    const sample = copyJeelizState(raw, '4-expression', 123);
    raw.rx = 9; raw.expressions[0] = 1;
    expect(sample.rotationX).toBe(.1); expect(sample.expressions[0]).toBeCloseTo(.2);
    expect(sample.timestamp).toBe(123); expect(sample.inferenceIntervalMs).toBeNull();
  });
  it('maps only mouth opening for the default model', () => {
    const s = copyJeelizState(state, 'default', 1);
    expect(s.mouthOpen).toBeCloseTo(.2);
    expect([s.smile, s.browFrown, s.browRaise]).toEqual([null, null, null]);
  });
  it('uses official four-expression indexes and handles absent channels', () => {
    const s = copyJeelizState(state, '4-expression', 1);
    expect(s.smile).toBeCloseTo(.4); expect(s.browFrown).toBeCloseTo(.6); expect(s.browRaise).toBeCloseTo(.8);
    const absent = copyJeelizState({ ...state, expressions: [] }, '4-expression', 1);
    expect([absent.mouthOpen, absent.smile, absent.browFrown, absent.browRaise]).toEqual([null, null, null, null]);
  });
  it('does not manufacture dense mesh, irises, independent blinks or gaze', () => {
    for (const model of ['default', '4-expression'] as const) {
      const c = jeelizCapabilities(model);
      expect([c.denseLandmarks, c.irisLandmarks, c.gaze, c.blinkPerEye, c.multiFace]).toEqual([false, false, false, false, false]);
    }
    expect(jeelizCapabilities('default').smile).toBe(false);
    expect(jeelizCapabilities('4-expression').smile).toBe(true);
  });
  it('distinguishes unsupported, missing, and measured zero', () => {
    expect(metricText(0, false)).toBe('unsupported'); expect(metricText(null)).toBe('unavailable');
    expect(metricText(0)).toBe('0.000'); expect(metricText(NaN)).toBe('unavailable');
  });
});

// Deliberately permuted axes: measurement must discover signs instead of assuming rx=pitch.
const evidence: PoseEvidence = {
  neutral: [.1, .2, .3], right: [.1, .2, .8], left: [.1, .2, -.2],
  up: [.5, .2, .3], down: [-.3, .2, .3], 'tilt-right': [.1, -.2, .3], 'tilt-left': [.1, .6, .3],
};
describe('empirical physical mapping', () => {
  it('makes no physical angle claims before complete measurements', () => {
    expect(measurePoseMapping({ neutral: [0, 0, 0] })).toBeNull(); expect(canonicalJeelizPose([1, 2, 3], null)).toBeNull();
  });
  it('discovers which raw axis represents each physical motion', () => {
    const m = measurePoseMapping(evidence)!;
    expect(m.yaw).toEqual({ axis: 2, sign: -1 }); expect(m.pitch).toEqual({ axis: 0, sign: 1 }); expect(m.roll).toEqual({ axis: 1, sign: -1 });
  });
  it.each([
    ['right', 'yaw', -1], ['left', 'yaw', 1], ['up', 'pitch', 1], ['down', 'pitch', -1], ['tilt-right', 'roll', 1], ['tilt-left', 'roll', -1],
  ] as const)('%s has the measured physical direction', (gesture, axis, sign) => {
    const pose = canonicalJeelizPose(evidence[gesture]!, measurePoseMapping(evidence))!;
    expect(Math.sign(pose[axis])).toBe(sign);
    expect(Math.abs(pose[axis])).toBeGreaterThan(.2);
  });
  it('rejects contradictory, weak and duplicate axes', () => {
    expect(measurePoseMapping({ ...evidence, left: evidence.right })).toBeNull();
    expect(measurePoseMapping({ ...evidence, up: [.11, .2, .3] })).toBeNull();
    expect(measurePoseMapping({ ...evidence, up: [.1, .6, .3], down: [.1, -.2, .3] })).toBeNull();
  });
  it('subtracts the measured neutral and wraps angle boundaries', () => {
    const mapping = measurePoseMapping(evidence)!;
    expect(canonicalJeelizPose(evidence.neutral!, mapping)).toEqual({ yaw: -0, pitch: 0, roll: -0 });
    const wrapped = { ...mapping, neutral: [Math.PI - .05, .2, .3] as [number, number, number] };
    expect(canonicalJeelizPose([-Math.PI + .05, .2, .3], wrapped)!.pitch).toBeCloseTo(.1);
  });
});
