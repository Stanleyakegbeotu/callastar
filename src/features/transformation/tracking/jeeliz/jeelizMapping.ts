import type { CanonicalHeadPose } from '../trackerProvider';
import type { JeelizModel, JeelizState, JeelizTrackingSample } from './jeelizTypes';

const number = (value: number): number => Number.isFinite(value) ? value : 0;
const channel = (values: number[], index: number): number | null => Number.isFinite(values[index]) ? values[index]! : null;

/** Official viewport x is rightward and y upward; CallaStar camera space is 0..1, y down. */
export function jeelizCameraPosition(sample: JeelizTrackingSample): { centerX: number; centerY: number } {
  return { centerX: (sample.centerX + 1) / 2, centerY: (1 - sample.centerY) / 2 };
}

/** Copies provider-owned, reused state immediately. Indexes: official cubeExpr/main.js. */
export function copyJeelizState(state: JeelizState, model: JeelizModel, timestamp: number): JeelizTrackingSample {
  const expressions = Array.from(state.expressions);
  return {
    timestamp, detected: number(state.detected), centerX: number(state.x), centerY: number(state.y),
    scale: number(state.s), rotationX: number(state.rx), rotationY: number(state.ry), rotationZ: number(state.rz),
    expressions, mouthOpen: channel(expressions, 0),
    smile: model === '4-expression' ? channel(expressions, 1) : null,
    browFrown: model === '4-expression' ? channel(expressions, 2) : null,
    browRaise: model === '4-expression' ? channel(expressions, 3) : null,
    inferenceIntervalMs: null,
  };
}

export type PoseGesture = 'neutral' | 'right' | 'left' | 'up' | 'down' | 'tilt-right' | 'tilt-left';
export type PoseEvidence = Partial<Record<PoseGesture, [number, number, number]>>;
export interface MeasuredPoseMapping {
  neutral: [number, number, number];
  yaw: { axis: number; sign: number }; pitch: { axis: number; sign: number }; roll: { axis: number; sign: number };
}
const deltaAngle = (value: number, neutral: number) => Math.atan2(Math.sin(value - neutral), Math.cos(value - neutral));

/** Infer axes and signs from opposing PHYSICAL movements, never from field names. */
export function measurePoseMapping(evidence: PoseEvidence): MeasuredPoseMapping | null {
  const neutral = evidence.neutral;
  if (!neutral) return null;
  const pair = (positive: PoseGesture, negative: PoseGesture) => {
    const a = evidence[positive], b = evidence[negative];
    if (!a || !b) return null;
    const differences = a.map((v, i) => deltaAngle(v, neutral[i]!) - deltaAngle(b[i]!, neutral[i]!));
    const ranked = [0, 1, 2].sort((i, j) => Math.abs(differences[j]!) - Math.abs(differences[i]!));
    const axis = ranked[0]!;
    const change = differences[axis]!;
    if (Math.abs(change) < 0.2 || Math.abs(change) < Math.abs(differences[ranked[1]!]!) * 1.5) return null;
    const sign = Math.sign(change);
    if (deltaAngle(a[axis]!, neutral[axis]!) * sign < 0.06 || deltaAngle(b[axis]!, neutral[axis]!) * sign > -0.06) return null;
    return { axis, sign };
  };
  const yaw = pair('left', 'right'), pitch = pair('up', 'down'), roll = pair('tilt-right', 'tilt-left');
  if (!yaw || !pitch || !roll || new Set([yaw.axis, pitch.axis, roll.axis]).size !== 3) return null;
  return { neutral: [...neutral], yaw, pitch, roll };
}

/** The ONLY Jeeliz -> physical rotation conversion. No mapping means no claimed physical angles. */
export function canonicalJeelizPose(raw: readonly number[], mapping: MeasuredPoseMapping | null): CanonicalHeadPose | null {
  if (!mapping) return null;
  const convert = (key: 'yaw' | 'pitch' | 'roll') => {
    const { axis, sign } = mapping[key];
    return sign * deltaAngle(raw[axis]!, mapping.neutral[axis]!);
  };
  return { yaw: convert('yaw'), pitch: convert('pitch'), roll: convert('roll') };
}
