import type { Point3 } from "../faceTypes";
import type { NormalizedGaze } from "../eyeGaze";

interface EyeField {
  center: { x: number; y: number };
  u: { x: number; y: number };
  v: { x: number; y: number };
  width: number;
  height: number;
  irisRadius: number;
  contour: { x: number; y: number }[];
}

function average(points: readonly Point3[]) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function makeEyeField(points: readonly Point3[], side: "left" | "right"): EyeField | null {
  const innerIndex = side === "left" ? 133 : 362;
  const outerIndex = side === "left" ? 33 : 263;
  const upperIndices = side === "left" ? [159, 158, 157] : [386, 385, 384];
  const lowerIndices = side === "left" ? [145, 153, 154] : [374, 380, 381];
  const irisStart = side === "left" ? 468 : 473;
  const inner = points[innerIndex];
  const outer = points[outerIndex];
  const irisCenter = points[irisStart];
  const irisRing = points.slice(irisStart + 1, irisStart + 5);
  if (!inner || !outer || !irisCenter || irisRing.length < 4) return null;
  const upper = average(upperIndices.map((index) => points[index]!));
  const lower = average(lowerIndices.map((index) => points[index]!));
  const dx = outer.x - inner.x;
  const dy = outer.y - inner.y;
  const width = Math.hypot(dx, dy);
  const u = { x: dx / width, y: dy / width };
  const vRaw = { x: lower.x - upper.x, y: lower.y - upper.y };
  const vProjection = vRaw.x * u.x + vRaw.y * u.y;
  let vx = vRaw.x - vProjection * u.x;
  let vy = vRaw.y - vProjection * u.y;
  const vLength = Math.hypot(vx, vy);
  if (width < 1e-5 || vLength < 1e-5) return null;
  vx /= vLength;
  vy /= vLength;
  const height = Math.hypot(lower.x - upper.x, lower.y - upper.y);
  const irisRadius = irisRing.reduce((sum, point) => sum + Math.hypot(point.x - irisCenter.x, point.y - irisCenter.y), 0) / irisRing.length;
  if (height < 1e-5 || irisRadius < 1e-5) return null;
  const ring = side === 'left' ? [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246] : [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  return { center: { x: (inner.x + outer.x) / 2, y: (inner.y + outer.y) / 2 }, u, v: { x: vx, y: vy }, width, height, irisRadius, contour: ring.map(i => points[i]!) };
}

function inside(x: number, y: number, ring: EyeField['contour']): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * Locally shifts the source texture sampling inside each eye while leaving the
 * face geometry, lids and all non-eye pixels fixed. It uses the source's own
 * iris landmarks to bound travel, so the source iris colour and appearance are
 * retained. This is a texture-coordinate field, not a live-camera eye patch.
 */
export class EyeGazeWarper {
  private readonly base: Float32Array;
  private readonly fields: { left: EyeField | null; right: EyeField | null };
  private readonly output: Float32Array;

  constructor(baseUvs: Float32Array, sourceLandmarks: readonly Point3[], private readonly interior?: { start: number; count: number }) {
    this.base = baseUvs.slice();
    this.output = baseUvs.slice();
    this.fields = {
      left: makeEyeField(sourceLandmarks, "left"),
      right: makeEyeField(sourceLandmarks, "right"),
    };
  }

  get available(): { left: boolean; right: boolean } {
    return { left: this.fields.left !== null, right: this.fields.right !== null };
  }

  update(gaze: NormalizedGaze | null, wide?: { left: number; right: number }): Float32Array {
    this.output.set(this.base);
    if (!gaze && !wide) return this.output;
    // On production meshes only interior eye vertices may sample different
    // pixels. Rim, lashes, glasses, and all original face UVs stay fixed.
    const start = this.interior?.start ?? 0;
    const end = this.interior ? start + this.interior.count : Math.min(468, this.base.length / 2);
    for (let i = start; i < end; i++) {
      const x = this.base[i * 2]!;
      const y = this.base[i * 2 + 1]!;
      for (const side of ["left", "right"] as const) {
        const eye = this.fields[side];
        if (!eye) continue;
        if (this.interior && !inside(x, y, eye.contour)) continue;
        const dx = x - eye.center.x;
        const dy = y - eye.center.y;
        const localX = (dx * eye.u.x + dy * eye.u.y) / (eye.width * 0.58);
        const localY = (dx * eye.v.x + dy * eye.v.y) / (eye.height * 0.8);
        const radiusSquared = localX * localX + localY * localY;
        if (radiusSquared >= 1) continue;
        const t = 1 - radiusSquared;
        const weight = t * t * (3 - 2 * t);
        const motion = gaze?.[side] ?? { x: 0, y: 0 };
        // Source iris follows the controller gaze: change the sampled source
        // pixel in the opposite direction within the current geometry point.
        const tx = Math.min(eye.irisRadius * 0.85, eye.width * 0.1) * weight;
        const ty = Math.min(eye.irisRadius * 0.6, eye.height * 0.22) * weight;
        const wideY = (dx * eye.v.x + dy * eye.v.y) * 0.25 * Math.max(0, Math.min(1, wide?.[side] ?? 0)) * weight;
        let nx = x - eye.u.x * motion.x * tx - eye.v.x * motion.y * ty + eye.v.x * wideY;
        let ny = y - eye.u.y * motion.x * tx - eye.v.y * motion.y * ty + eye.v.y * wideY;
        // Never sample outside the source aperture. Reduce travel toward this
        // original interior pixel rather than dragging eyelid/glasses pixels in.
        if (this.interior) for (let step = 0; step < 8 && !inside(nx, ny, eye.contour); step++) { nx = (nx + x) / 2; ny = (ny + y) / 2; }
        this.output[i * 2] = nx;
        this.output[i * 2 + 1] = ny;
      }
    }
    return this.output;
  }
}
