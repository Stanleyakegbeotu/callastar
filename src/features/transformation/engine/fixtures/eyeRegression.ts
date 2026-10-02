import type { FaceTrackingResult, Point3 } from '../faceTypes';
import { EYE_ANCHORS, EYE_RENDER_CHANNELS, type EyeSide } from '../eyeControls';
import { EYELIDS } from '../rendering/expressionDeformer';
import { deriveFaceGeometry } from '../faceGeometry';

/** LOCKED M8.6: asymmetric almond eyes, 478-point topology, stable iris origin.
 * Synthetic geometry proves math and renderer behavior; it is not a physical
 * person, a model accuracy fixture, or phone performance evidence. */
export function eyeRegressionFixture(settings: Partial<Record<EyeSide, { ratio?: number; irisX?: number; irisY?: number }>> = {}): Point3[] {
  const p = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
  p[1] = { x: .5, y: .5, z: -.05 }; p[234] = { x: .28, y: .5, z: 0 }; p[454] = { x: .72, y: .5, z: 0 };
  p[10] = { x: .5, y: .25, z: 0 }; p[152] = { x: .5, y: .8, z: 0 };
  p[61] = { x: .43, y: .65, z: -.01 }; p[291] = { x: .57, y: .65, z: -.01 };
  p[13] = { x: .5, y: .645, z: -.01 }; p[14] = { x: .5, y: .655, z: -.01 };
  for (const side of ['left', 'right'] as const) {
    const cx = side === 'left' ? .6 : .4, cy = .4;
    const height = side === 'left' ? .035 : .025;
    const options = settings[side] ?? {}, ratio = options.ratio ?? 1;
    const rings = EYELIDS[EYE_RENDER_CHANNELS[side]], anchors = EYE_ANCHORS[side];
    for (const [name, sign, portion] of [['upper', -1, .7], ['lower', 1, .3]] as const) {
      rings[name].forEach((index, k) => {
        const t = k / (rings[name].length - 1);
        const direction = (name === 'lower' ? -1 : 1) * (side === 'left' ? 1 : -1);
        p[index] = { x: cx + (t - .5) * .1 * direction, y: cy + sign * height * portion * Math.sin(Math.PI * t) * ratio, z: -.01 };
      });
    }
    // Orient fixture corners consistently with physical anatomical indices.
    p[anchors.outer] = { x: cx + (side === 'left' ? .05 : -.05), y: cy, z: -.01 };
    p[anchors.inner] = { x: cx + (side === 'left' ? -.05 : .05), y: cy, z: -.01 };
    const sign = side === 'left' ? 1 : -1;
    const iris = { x: cx + (options.irisX ?? 0) * .1 * sign, y: cy + (options.irisY ?? 0) * .1, z: -.012 };
    p[anchors.iris] = iris;
    for (let k = 1; k <= 4; k++) {
      const angle = (k - 1) * Math.PI / 2;
      p[anchors.iris + k] = { x: iris.x + Math.cos(angle) * .009, y: iris.y + Math.sin(angle) * .009, z: iris.z };
    }
  }
  for (const [index, x] of [[70,.37],[107,.45],[300,.63],[336,.55]] as const) p[index] = { x, y: .31, z: -.01 };
  return p;
}

export function eyeRegressionFrame(points = eyeRegressionFixture(), timestampMs = 0): FaceTrackingResult {
  const matrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return { timestampMs, detected: true, status: 'tracked', confidence: 1, landmarks: points,
    blendshapes: { eyeBlinkLeft: 0, eyeBlinkRight: 0 }, facialTransformationMatrix: matrix,
    derived: deriveFaceGeometry(points, matrix, {}) };
}
