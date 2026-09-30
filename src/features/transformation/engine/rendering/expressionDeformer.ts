import type { Point3 } from "../faceTypes";
import type { ExpressionValues } from "../expressionMotion";
import type { SourceFaceMeshData } from "./sourceMesh";

/** MediaPipe Face Mesh landmark anchors. Left/right follow model names in
 * unmirrored image space. These are anatomical regions, never live vertex targets. */
export const EXPRESSION_LANDMARKS = {
  leftEye: { outer: 33, inner: 133, upper: 159, lower: 145 },
  rightEye: { outer: 263, inner: 362, upper: 386, lower: 374 },
  mouth: { left: 61, right: 291, upper: 13, lower: 14, chin: 152 },
  brow: { innerLeft: 107, innerRight: 336, outerLeft: 70, outerRight: 300 },
  nose: 1,
} as const;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const falloff = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => {
  const d = Math.hypot((x - cx) / Math.max(0.001, rx), (y - cy) / Math.max(0.001, ry));
  const t = clamp(1 - d);
  return t * t * (3 - 2 * t);
};

/**
 * Source-local deformation. Weights are computed once against the source
 * landmarks; each frame only updates an existing position Float32Array.
 * UVs and triangle indices are never written here.
 */
export class ExpressionDeformer {
  private readonly base: Float32Array;
  private readonly weights: Float32Array;
  readonly positions: Float32Array;
  /** The neutral mesh, so a diagnostic can measure how far a frame moved it. */
  readonly basePositions: Float32Array;
  private readonly eyeGapLeft: number;
  private readonly eyeGapRight: number;
  private readonly mouthWidth: number;
  /** Source face width in normalised units. Every amplitude is a fraction of it. */
  readonly faceWidth: number;

  constructor(mesh: SourceFaceMeshData, landmarks: readonly Point3[]) {
    this.base = mesh.positions;
    this.basePositions = mesh.positions;
    this.positions = mesh.positions.slice();
    this.weights = new Float32Array((mesh.positions.length / 3) * 10);
    const p = (index: number) => landmarks[index] ?? landmarks[1] ?? { x: 0.5, y: 0.5, z: 0 };
    const left = EXPRESSION_LANDMARKS.leftEye;
    const right = EXPRESSION_LANDMARKS.rightEye;
    const mouth = EXPRESSION_LANDMARKS.mouth;
    const brow = EXPRESSION_LANDMARKS.brow;
    const eyeCenter = (eye: typeof left | typeof right) => ({
      x: (p(eye.outer).x + p(eye.inner).x) / 2,
      y: (p(eye.upper).y + p(eye.lower).y) / 2,
      width: Math.hypot(p(eye.outer).x - p(eye.inner).x, p(eye.outer).y - p(eye.inner).y),
      gap: Math.hypot(p(eye.upper).x - p(eye.lower).x, p(eye.upper).y - p(eye.lower).y),
    });
    const el = eyeCenter(left);
    const er = eyeCenter(right);
    /*
     * The TRUE eyelid separation, not a clamped one.
     *
     * This used to be `min(gap, width * 0.5)`, which on a measured source cut
     * the gap by about 40% before the blink coefficient was even applied. A full
     * blink then closed roughly a quarter of the eye — numbers moving, eyelid
     * effectively still. A blink has to travel the whole gap, so the whole gap is
     * what it is measured against.
     */
    this.eyeGapLeft = Math.max(0.004, el.gap);
    this.eyeGapRight = Math.max(0.004, er.gap);
    const mx = (p(mouth.left).x + p(mouth.right).x) / 2;
    const my = (p(mouth.upper).y + p(mouth.lower).y) / 2;
    this.mouthWidth = Math.hypot(p(mouth.left).x - p(mouth.right).x, p(mouth.left).y - p(mouth.right).y);
    this.faceWidth = Math.max(0.01, Math.abs(p(454).x - p(234).x));
    for (let i = 0; i < this.positions.length / 3; i++) {
      const x = mesh.uvs[i * 2]!;
      const y = mesh.uvs[i * 2 + 1]!;
      const w = i * 10;
      // Signed eyelid influence: upper lid moves down, lower lid moves up.
      // The compact support also leaves the nose and opposite eye unchanged.
      this.weights[w] = falloff(x, y, el.x, el.y, el.width * 0.85, Math.max(el.gap * 1.65, el.width * 0.2))
        * Math.max(-1, Math.min(1, (y - el.y) / Math.max(0.005, el.gap * 0.5)));
      this.weights[w + 1] = falloff(x, y, er.x, er.y, er.width * 0.85, Math.max(er.gap * 1.65, er.width * 0.2))
        * Math.max(-1, Math.min(1, (y - er.y) / Math.max(0.005, er.gap * 0.5)));
      this.weights[w + 2] = falloff(x, y, mx, my, this.mouthWidth * 0.85, this.mouthWidth * 0.5)
        * Math.max(-0.2, Math.min(1, (y - my) / Math.max(0.006, this.mouthWidth * 0.12)));
      this.weights[w + 3] = falloff(x, y, p(mouth.chin).x, p(mouth.chin).y, this.faceWidth * 0.45, this.faceWidth * 0.45);
      this.weights[w + 4] = falloff(x, y, p(mouth.left).x, p(mouth.left).y, this.mouthWidth * 0.48, this.mouthWidth * 0.46);
      this.weights[w + 5] = falloff(x, y, p(mouth.right).x, p(mouth.right).y, this.mouthWidth * 0.48, this.mouthWidth * 0.46);
      this.weights[w + 6] = falloff(x, y, (p(brow.innerLeft).x + p(brow.innerRight).x) / 2,
        (p(brow.innerLeft).y + p(brow.innerRight).y) / 2, this.faceWidth * 0.25, this.faceWidth * 0.16);
      this.weights[w + 7] = falloff(x, y, p(brow.outerLeft).x, p(brow.outerLeft).y, this.faceWidth * 0.22, this.faceWidth * 0.17);
      this.weights[w + 8] = falloff(x, y, p(brow.outerRight).x, p(brow.outerRight).y, this.faceWidth * 0.22, this.faceWidth * 0.17);
      // Mouth-area cheek falloff adds a small lateral lift, not whole-face stretch.
      this.weights[w + 9] = falloff(x, y, mx, my, this.mouthWidth * 1.4, this.mouthWidth * 0.85);
    }
  }

  /**
   * Amplitudes, each sized to the feature it has to move.
   *
   * Tuned from measurement, not multiplied uniformly. The previous set produced
   * 1 to 7 pixels of movement on a rendered face 199 pixels wide, which is why a
   * real device showed no blink, no jaw and no brow response while the
   * diagnostics reported perfectly good numbers. A blanket multiplier would have
   * fixed the eyelid and torn the mouth.
   *
   * Every figure is a fraction of a measured source dimension, so a large or
   * small face in frame behaves the same way.
   */
  private static readonly AMPLITUDE = {
    /*
     * Half the eyelid gap per lid, so the two lids MEET rather than approach.
     * The signed weight sends the upper lid down and the lower lid up, so this is
     * the travel of each one.
     */
    blink: 0.55,
    /** Lower lip travel, as a fraction of mouth width. */
    jawLip: 0.5,
    /** Chin and jawline follow, as a fraction of face width. */
    jawChin: 0.15,
    /** Mouth corners outwards, as a fraction of mouth width. */
    smileLateral: 0.1,
    /** And upwards, which is what actually reads as a smile. */
    smileVertical: 0.2,
    /** Brow travel, as a fraction of face width. */
    browInner: 0.085,
    browOuter: 0.095,
  } as const;

  update(expression: ExpressionValues): Float32Array {
    const e = expression;
    const a = ExpressionDeformer.AMPLITUDE;
    for (let i = 0; i < this.positions.length / 3; i++) {
      const p = i * 3;
      const w = i * 10;
      const smileL = this.weights[w + 4]! * e.smileLeft;
      const smileR = this.weights[w + 5]! * e.smileRight;
      this.positions[p] = this.base[p]!
        - smileL * this.mouthWidth * a.smileLateral + smileR * this.mouthWidth * a.smileLateral;
      this.positions[p + 1] = this.base[p + 1]!
        + this.weights[w]! * e.blinkLeft * this.eyeGapLeft * a.blink
        + this.weights[w + 1]! * e.blinkRight * this.eyeGapRight * a.blink
        - this.weights[w + 2]! * e.jawOpen * this.mouthWidth * a.jawLip
        - this.weights[w + 3]! * e.jawOpen * this.faceWidth * a.jawChin
        + (smileL + smileR) * this.mouthWidth * a.smileVertical
        + this.weights[w + 6]! * e.browInnerUp * this.faceWidth * a.browInner
        + this.weights[w + 7]! * e.browOuterUpLeft * this.faceWidth * a.browOuter
        + this.weights[w + 8]! * e.browOuterUpRight * this.faceWidth * a.browOuter;
      this.positions[p + 2] = this.base[p + 2]!;
    }
    return this.positions;
  }
}
