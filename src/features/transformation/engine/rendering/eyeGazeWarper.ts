import type { Point3 } from "../faceTypes";
import type { NormalizedGaze } from "../eyeGaze";

interface EyeField {
  center: { x: number; y: number };
  u: { x: number; y: number };
  v: { x: number; y: number };
  width: number;
  height: number;
  irisRadius: number;
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
  return { center: { x: (inner.x + outer.x) / 2, y: (inner.y + outer.y) / 2 }, u, v: { x: vx, y: vy }, width, height, irisRadius };
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

  constructor(baseUvs: Float32Array, sourceLandmarks: readonly Point3[]) {
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

  update(gaze: NormalizedGaze | null): Float32Array {
    this.output.set(this.base);
    if (!gaze) return this.output;
    const vertexCount = Math.min(468, this.base.length / 2);
    for (let i = 0; i < vertexCount; i++) {
      const x = this.base[i * 2]!;
      const y = this.base[i * 2 + 1]!;
      for (const side of ["left", "right"] as const) {
        const eye = this.fields[side];
        if (!eye) continue;
        const dx = x - eye.center.x;
        const dy = y - eye.center.y;
        const localX = (dx * eye.u.x + dy * eye.u.y) / (eye.width * 0.58);
        const localY = (dx * eye.v.x + dy * eye.v.y) / (eye.height * 0.8);
        const radiusSquared = localX * localX + localY * localY;
        if (radiusSquared >= 1) continue;
        const t = 1 - radiusSquared;
        const weight = t * t * (3 - 2 * t);
        const motion = gaze[side];
        // Source iris follows the controller gaze: change the sampled source
        // pixel in the opposite direction within the current geometry point.
        const travel = eye.irisRadius * 1.25 * weight;
        this.output[i * 2] = x - (eye.u.x * motion.x + eye.v.x * motion.y) * travel;
        this.output[i * 2 + 1] = y - (eye.u.y * motion.x + eye.v.y * motion.y) * travel;
      }
    }
    return this.output;
  }
}
