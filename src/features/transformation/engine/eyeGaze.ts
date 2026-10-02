import type { Point3 } from "./faceTypes";

export interface EyeGazePoint {
  x: number;
  y: number;
}

export interface BinocularGaze {
  left: EyeGazePoint;
  right: EyeGazePoint;
  quality: { left: number; right: number };
}

const EYES = {
  left: { inner: 133, outer: 33, upper: [159, 158, 157], lower: [145, 153, 154], iris: 468 },
  right: { inner: 362, outer: 263, upper: [386, 385, 384], lower: [374, 380, 381], iris: 473 },
} as const;

function mean(points: readonly Point3[]): Point3 {
  const result = { x: 0, y: 0, z: 0 };
  for (const point of points) {
    result.x += point.x / points.length;
    result.y += point.y / points.length;
    result.z += point.z / points.length;
  }
  return result;
}

/**
 * Measures iris displacement in a head-canonical face mesh. Callers must first
 * remove translation, scale and head rotation with `canonicalFaceLandmarks`.
 * Eye channels remain separate so a wink or asymmetric glance is retained.
 * The mesh's iris centre points (468 and 473) are required; absent iris data is
 * missing, never a neutral reading.
 */
export function measureBinocularGaze(points: readonly Point3[]): BinocularGaze | null {
  if (points.length < 478) return null;

  const measure = (side: "left" | "right"): { gaze: EyeGazePoint; quality: number } | null => {
    const eye = EYES[side];
    const inner = points[eye.inner];
    const outer = points[eye.outer];
    const iris = points[eye.iris];
    if (!inner || !outer || !iris) return null;

    const upper = mean(eye.upper.map((index) => points[index]).filter((p): p is Point3 => !!p));
    const lower = mean(eye.lower.map((index) => points[index]).filter((p): p is Point3 => !!p));
    const widthX = outer.x - inner.x;
    const widthY = outer.y - inner.y;
    const eyeWidth = Math.hypot(widthX, widthY);
    const verticalX = lower.x - upper.x;
    const verticalY = lower.y - upper.y;
    const eyeHeight = Math.hypot(verticalX, verticalY);
    if (eyeWidth < 1e-5 || eyeHeight < 1e-5) return null;

    const u = { x: widthX / eyeWidth, y: widthY / eyeWidth };
    let v = { x: verticalX / eyeHeight, y: verticalY / eyeHeight };
    // Keep the vertical basis perpendicular to the eye axis, and orient it
    // toward the lower lid. This rejects residual camera roll and lid slope.
    const projected = v.x * u.x + v.y * u.y;
    v = { x: v.x - projected * u.x, y: v.y - projected * u.y };
    const vLength = Math.hypot(v.x, v.y);
    if (vLength < 1e-5) return null;
    v.x /= vLength;
    v.y /= vLength;
    if (v.x * verticalX + v.y * verticalY < 0) {
      v.x *= -1;
      v.y *= -1;
    }

    const center = { x: (inner.x + outer.x) / 2, y: (inner.y + outer.y) / 2 };
    const dx = iris.x - center.x;
    const dy = iris.y - center.y;
    const x = (dx * u.x + dy * u.y) / eyeWidth;
    // Fixed width-derived reference, not the moving lid aperture. Closure and
    // wide eyes cannot amplify vertical gaze by changing its denominator.
    const y = (dx * v.x + dy * v.y) / (eyeWidth * 0.45);
    if (![x, y].every(Number.isFinite)) return null;

    // A centre outside the eye or a collapsed aperture is low quality. Retain
    // valid motion but expose the confidence so callers can briefly hold then
    // relax it instead of freezing an eyelid or forcing a blink.
    const aperture = Math.min(1, eyeHeight / (eyeWidth * 0.45));
    const radial = Math.hypot(x / 0.55, y / 1.5);
    return { gaze: { x, y }, quality: Math.max(0, Math.min(1, aperture * (1 - Math.max(0, radial - 0.7)))) };
  };

  const left = measure("left");
  const right = measure("right");
  if (!left || !right) return null;
  return { left: left.gaze, right: right.gaze, quality: { left: left.quality, right: right.quality } };
}

export interface NormalizedGaze {
  left: EyeGazePoint;
  right: EyeGazePoint;
  clamped: boolean;
}

export class GazeSmoother {
  private applied: NormalizedGaze = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 }, clamped: false };
  private lastAt: number | null = null;
  private lastValidAt: { left: number | null; right: number | null } = { left: null, right: null };

  update(
    gaze: NormalizedGaze | null,
    quality: { left: number; right: number } | null,
    nowMs: number,
    blinking: { left: boolean; right: boolean } = { left: false, right: false },
    trustedLids: { left: boolean; right: boolean } = { left: true, right: true },
  ): NormalizedGaze {
    const dt = this.lastAt === null ? 1 / 30 : Math.max(0, Math.min(0.1, (nowMs - this.lastAt) / 1000));
    this.lastAt = nowMs;
    const blendEye = (side: "left" | "right"): EyeGazePoint => {
      const valid = !!gaze && !!quality && quality[side] >= 0.2 && !blinking[side];
      const trustedBlink = blinking[side] && trustedLids[side];
      if (valid || trustedBlink) this.lastValidAt[side] = nowMs;
      const holdMs = trustedBlink ? 300 : 80;
      const hold = this.lastValidAt[side] !== null && nowMs - this.lastValidAt[side]! <= holdMs;
      const target = valid ? gaze![side] : hold ? this.applied[side] : { x: 0, y: 0 };
      // Eye motion responds quickly (~35ms); a lost iris relaxes after a short
      // hold (~90ms). Blink deliberately holds gaze until the lid reopens.
      const movement = Math.hypot(target.x - this.applied[side].x, target.y - this.applied[side].y);
      const tau = valid ? (movement > 0.12 ? 0.008 : movement > 0.025 ? 0.022 : 0.065) : hold ? Number.POSITIVE_INFINITY : 0.09;
      const alpha = Number.isFinite(tau) ? 1 - Math.exp(-dt / tau) : 0;
      return {
        x: this.applied[side].x + (target.x - this.applied[side].x) * alpha,
        y: this.applied[side].y + (target.y - this.applied[side].y) * alpha,
      };
    };
    this.applied = { left: blendEye("left"), right: blendEye("right"), clamped: gaze?.clamped ?? false };
    return this.applied;
  }

  reset(): void {
    this.applied = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 }, clamped: false };
    this.lastAt = null;
    this.lastValidAt = { left: null, right: null };
  }
}

/** Normalize around a per-eye neutral, suppress small jitter, and cap to a
 * plausible iris travel inside the source aperture. */
export function normalizeBinocularGaze(
  gaze: BinocularGaze,
  neutral: { left: EyeGazePoint; right: EyeGazePoint },
): NormalizedGaze {
  let clamped = false;
  const normalize = (value: EyeGazePoint, base: EyeGazePoint): EyeGazePoint => {
    const dead = (n: number) => Math.abs(n) < 0.018 ? 0 : n - Math.sign(n) * 0.018;
    const x = dead((value.x - base.x) / 0.13);
    const y = dead((value.y - base.y) / 0.28);
    const cx = Math.max(-1, Math.min(1, x));
    const cy = Math.max(-1, Math.min(1, y));
    clamped ||= cx !== x || cy !== y;
    return { x: cx, y: cy };
  };
  return {
    left: normalize(gaze.left, neutral.left),
    right: normalize(gaze.right, neutral.right),
    clamped,
  };
}
