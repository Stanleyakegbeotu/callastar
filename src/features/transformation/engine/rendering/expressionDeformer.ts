import type { Point3 } from "../faceTypes";
import type { ExpressionValues } from "../expressionMotion";
import { EYE_RENDER_CHANNELS, type CanonicalEyeState } from "../eyeControls";
import type { SourceFaceMeshData } from "./sourceMesh";
import { MouthRegionDeformer } from './mouthRegionDeformer';
import { NoseRegionDeformer } from './noseRegionDeformer';

/** MediaPipe Face Mesh landmark anchors. Left/right follow model names in
 * unmirrored image space. These are anatomical regions, never live vertex targets. */
export const EXPRESSION_LANDMARKS = {
  leftEye: { outer: 33, inner: 133, upper: 159, lower: 145 },
  rightEye: { outer: 263, inner: 362, upper: 386, lower: 374 },
  mouth: { left: 61, right: 291, upper: 13, lower: 14, chin: 152 },
  brow: { innerLeft: 107, innerRight: 336, outerLeft: 70, outerRight: 300 },
  nose: 1,
  cheek: { left: 205, right: 425 },
  nasolabial: { left: 216, right: 436 },
} as const;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const falloff = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => {
  const d = Math.hypot((x - cx) / Math.max(0.001, rx), (y - cy) / Math.max(0.001, ry));
  const t = clamp(1 - d);
  return t * t * (3 - 2 * t);
};

/** MediaPipe eyelid rings, corner to corner. Left/right are the model's names. */
export const EYELIDS = {
  left: { lower: [33, 7, 163, 144, 145, 153, 154, 155, 133], upper: [133, 173, 157, 158, 159, 160, 161, 246, 33] },
  right: { lower: [263, 249, 390, 373, 374, 380, 381, 382, 362], upper: [362, 398, 384, 385, 386, 387, 388, 466, 263] },
} as const;

/** How far the lower lid rises in a blink, as a fraction of the local opening. */
export const LOWER_LID_RISE = 0.15;
/** How far above the upper lid the eyelid skin is drawn down, in openings. */
const UPPER_LID_REACH = 1.2;
const LOWER_LID_REACH = 0.8;

interface LidModel {
  upper: [number, number][];
  lower: [number, number][];
  xMin: number;
  xMax: number;
  gapMax: number;
}

const smoothFade = (t: number) => {
  const u = clamp(t);
  return 1 - u * u * (3 - 2 * u);
};

function lidModel(p: (index: number) => Point3, rings: { upper: readonly number[]; lower: readonly number[] }): LidModel {
  const curve = (ring: readonly number[]) => ring.map((i) => [p(i).x, p(i).y] as [number, number]).sort((a, b) => a[0] - b[0]);
  const upper = curve(rings.upper);
  const lower = curve(rings.lower);
  const xMin = Math.max(upper[0]![0], lower[0]![0]);
  const xMax = Math.min(upper[upper.length - 1]![0], lower[lower.length - 1]![0]);
  let gapMax = 0;
  for (let k = 0; k <= 16; k++) {
    const x = xMin + ((xMax - xMin) * k) / 16;
    gapMax = Math.max(gapMax, curveY(lower, x) - curveY(upper, x));
  }
  return { upper, lower, xMin, xMax, gapMax: Math.max(0.002, gapMax) };
}

function curveY(curve: [number, number][], x: number): number {
  if (x <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]!;
    if (x <= x1) {
      const [x0, y0] = curve[i - 1]!;
      return x1 - x0 < 1e-9 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1]![1];
}

/**
 * Downward displacement (image y) of a point at a FULL blink.
 *
 * A blink is the upper lid descending almost the whole opening — the lower lid
 * rises only a little — and what covers the eye is upper-lid SKIN, lashes at
 * its lower edge. The old field met the lids at the eye's centre, squashing
 * iris, white and lashes into a dark band that read as a sleepy half-blink;
 * MediaPipe itself scored a "full" blink at 0.29.
 *
 * Built on the eye's real lid curves at this x, not a rectangle:
 *   inside the opening   every point converges on the closure line, set
 *                        LOWER_LID_RISE of the opening above the lower lid;
 *   above the upper lid  the lid's travel fades out over UPPER_LID_REACH
 *                        openings, stretching the eyelid skin over the eye
 *                        and leaving the brow where it is;
 *   below the lower lid  a short fade, so the lower lid's small rise blends.
 * Each piece is monotonic in y, so nothing folds, and the field is continuous
 * across the lids. At the corners the opening narrows to nothing, so motion
 * fades out there with no boundary.
 */
function lidDisplacement(x: number, y: number, lid: LidModel, lowerFraction = LOWER_LID_RISE): number {
  const xc = Math.min(lid.xMax, Math.max(lid.xMin, x));
  const yu = curveY(lid.upper, xc);
  const yl = curveY(lid.lower, xc);
  const gap = Math.max(0, yl - yu);
  const closure = yl - lowerFraction * gap;
  // Beyond the corners, fade within half an eye width rather than stop dead.
  const beyond = Math.max(lid.xMin - x, x - lid.xMax, 0);
  const across = smoothFade(beyond / Math.max(0.002, (lid.xMax - lid.xMin) * 0.5));
  if (y < yu) return across * (closure - yu) * smoothFade((yu - y) / (UPPER_LID_REACH * lid.gapMax));
  if (y <= yl) return across * (closure - y);
  return across * (closure - yl) * smoothFade((y - yl) / (LOWER_LID_REACH * lid.gapMax));
}

/**
 * Source-local deformation. Weights are computed once against the source
 * landmarks; each frame only updates an existing position Float32Array.
 * UVs and triangle indices are never written here.
 */
export class ExpressionDeformer {
  private readonly mouthRegion:MouthRegionDeformer;
  private readonly noseRegion:NoseRegionDeformer;
  private readonly eyeFields: Float32Array;
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
    landmarks = mesh.localLandmarks ?? landmarks;
    this.mouthRegion = new MouthRegionDeformer(mesh, landmarks);
    this.noseRegion = new NoseRegionDeformer(mesh, landmarks);
    this.base = mesh.positions;
    this.basePositions = mesh.positions;
    this.positions = mesh.positions.slice();
    this.weights = new Float32Array((mesh.positions.length / 3) * 16);
    this.eyeFields = new Float32Array((mesh.positions.length / 3) * 4);
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
    const lidLeft = lidModel(p, EYELIDS.left);
    const lidRight = lidModel(p, EYELIDS.right);
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
      const x = mesh.localLandmarks ? mesh.positions[i * 3]! : mesh.uvs[i * 2]!;
      const y = mesh.localLandmarks ? -mesh.positions[i * 3 + 1]! : mesh.uvs[i * 2 + 1]!;
      const w = i * 16;
      // Image-down displacement at a full blink; local to each eye, so the
      // nose, brows and the other eye are untouched.
      this.weights[w] = lidDisplacement(x, y, lidLeft);
      this.weights[w + 1] = lidDisplacement(x, y, lidRight);
      // Linear difference between the two closure endpoints lets measured lid
      // travel select the meeting line without rebuilding fields each frame.
      for (const [eyeIndex, lid] of [lidLeft, lidRight].entries()) {
        this.eyeFields[i * 4 + eyeIndex] = lidDisplacement(x, y, lid, 1) - lidDisplacement(x, y, lid, 0);
        const xc = Math.min(lid.xMax, Math.max(lid.xMin, x));
        const yu = curveY(lid.upper, xc), yl = curveY(lid.lower, xc);
        const middle = (yu + yl) / 2;
        const orbital = x >= lid.xMin && x <= lid.xMax ? smoothFade(Math.max(0, Math.abs(y - middle) - (yl - yu) / 2) / (lid.gapMax * 0.65)) : 0;
        // Expand around the existing aperture centre, bounded to 25% of its
        // gap. This moves source lids/lashes; it never scales the iris.
        this.eyeFields[i * 4 + 2 + eyeIndex] = (y - middle) * 0.25 * orbital;
      }
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
      this.weights[w + 9] = falloff(x, y, mx, my, this.mouthWidth * 1.4, this.mouthWidth * 0.85)
        * clamp((y - my) / Math.max(0.001, this.mouthWidth * 0.5));
      const setSmileField = (eye: typeof left | typeof right, cheekIndex: number, foldIndex: number,
        cheekSlot: number, foldSlot: number, lidSlot: number) => {
        const center = eyeCenter(eye);
        const cheek = p(cheekIndex);
        const fold = p(foldIndex);
        const lowerEyeGate = clamp((y - center.y) / Math.max(0.006, center.gap * 1.25));
        this.weights[w + cheekSlot] = falloff(x, y, cheek.x, cheek.y, this.faceWidth * 0.16, this.faceWidth * 0.14);
        this.weights[w + foldSlot] = falloff(x, y, fold.x, fold.y, this.faceWidth * 0.075, this.faceWidth * 0.095);
        this.weights[w + lidSlot] = falloff(x, y, center.x, center.y + center.gap * 0.68,
          center.width * 0.42, center.gap * 0.95) * lowerEyeGate;
      };
      setSmileField(left, EXPRESSION_LANDMARKS.cheek.left, EXPRESSION_LANDMARKS.nasolabial.left, 10, 12, 14);
      setSmileField(right, EXPRESSION_LANDMARKS.cheek.right, EXPRESSION_LANDMARKS.nasolabial.right, 11, 13, 15);
    }
    // The source-aperture fill is pinned: the teeth a photograph shows belong
    // to the upper jaw, so a dropping jaw uncovers the cavity instead of
    // stretching them. The cavity keeps its lip weights and opens with the lips.
    if (mesh.mouth) this.weights.fill(0, mesh.mouth.fillStart * 16, (mesh.mouth.fillStart + mesh.mouth.fillCount) * 16);
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
     * 1 is a closed eye: the weights already hold each point's full-blink
     * travel along the source's own lid curves (see `lidDisplacement`).
     */
    blink: 1,
    /** Lower lip travel, as a fraction of mouth width. */
    jawLip: 0.5,
    /** Chin and jawline follow, as a fraction of face width. */
    jawChin: 0.15,
    /** A subtle downward follow through the lower cheek, as a fraction of face width. */
    jawCheek: 0.025,
    /** Mouth corners outwards, as a fraction of mouth width. */
    smileLateral: 0.1,
    /** And upwards, which is what actually reads as a smile. */
    smileVertical: 0.2,
    /** Soft cheek rise, as a fraction of face width. */
    smileCheek: 0.025,
    /** Subtle nasolabial softening, as a fraction of face width. */
    smileFold: 0.008,
    /** Lower eyelid lift, as a fraction of the measured eye opening. */
    smileLowerLid: 0.08,
    /** Brow travel, as a fraction of face width. */
    browInner: 0.085,
    browOuter: 0.095,
  } as const;

  update(expression: ExpressionValues): Float32Array {
    const e = expression;
    const a = ExpressionDeformer.AMPLITUDE;
    const lidFraction = (eye: CanonicalEyeState | undefined) => {
      if (!eye) return LOWER_LID_RISE; // compatibility for legacy/manual controls
      const upper = Math.max(0, eye.upperLid), lower = Math.max(0, eye.lowerLid);
      return upper + lower > 0.06 ? Math.max(0.05, Math.min(0.45, lower / (upper + lower))) : LOWER_LID_RISE;
    };
    const lowerL = lidFraction(e.eyes?.[EYE_RENDER_CHANNELS.left]), lowerR = lidFraction(e.eyes?.[EYE_RENDER_CHANNELS.right]);
    for (let i = 0; i < this.positions.length / 3; i++) {
      const p = i * 3;
      const w = i * 16;
      const smileL = this.weights[w + 4]! * (e.mouth ? 0 : e.smileLeft);
      const smileR = this.weights[w + 5]! * (e.mouth ? 0 : e.smileRight);
      const cheekL = this.weights[w + 10]! * e.smileLeft;
      const cheekR = this.weights[w + 11]! * e.smileRight;
      const foldL = this.weights[w + 12]! * e.smileLeft;
      const foldR = this.weights[w + 13]! * e.smileRight;
      const lidL = this.weights[w + 14]! * e.smileLeft;
      const lidR = this.weights[w + 15]! * e.smileRight;
      this.positions[p] = this.base[p]!
        - smileL * this.mouthWidth * a.smileLateral + smileR * this.mouthWidth * a.smileLateral;
      this.positions[p + 1] = this.base[p + 1]!
        // Weights are image-down displacements; world y grows up.
        - this.weights[w]! * clamp(e.blinkLeft) * a.blink
        - this.weights[w + 1]! * clamp(e.blinkRight) * a.blink
        - this.eyeFields[i * 4]! * (lowerL - LOWER_LID_RISE) * clamp(e.blinkLeft)
        - this.eyeFields[i * 4 + 1]! * (lowerR - LOWER_LID_RISE) * clamp(e.blinkRight)
        - this.eyeFields[i * 4 + 2]! * clamp(e.eyes?.[EYE_RENDER_CHANNELS.left].wideOpen ?? 0) * (1 - clamp(e.blinkLeft))
        - this.eyeFields[i * 4 + 3]! * clamp(e.eyes?.[EYE_RENDER_CHANNELS.right].wideOpen ?? 0) * (1 - clamp(e.blinkRight))
        - this.weights[w + 2]! * (e.mouth ? 0 : e.jawOpen) * this.mouthWidth * a.jawLip
        - this.weights[w + 3]! * (e.mouth ? 0 : e.jawOpen) * this.faceWidth * a.jawChin
        - this.weights[w + 9]! * (e.mouth ? 0 : e.jawOpen) * this.faceWidth * a.jawCheek
        + (smileL + smileR) * this.mouthWidth * a.smileVertical
        + (cheekL + cheekR) * this.faceWidth * a.smileCheek
        + (foldL + foldR) * this.faceWidth * a.smileFold
        + lidL * this.eyeGapLeft * a.smileLowerLid
        + lidR * this.eyeGapRight * a.smileLowerLid
        + this.weights[w + 6]! * e.browInnerUp * this.faceWidth * a.browInner
        + this.weights[w + 7]! * e.browOuterUpLeft * this.faceWidth * a.browOuter
        + this.weights[w + 8]! * e.browOuterUpRight * this.faceWidth * a.browOuter;
      this.positions[p + 2] = this.base[p + 2]!;
    }
    if(e.mouth)this.mouthRegion.apply(this.positions,e.mouth);
    if(e.nose)this.noseRegion.apply(this.positions,e.nose);
    return this.positions;
  }
}
