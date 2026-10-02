import type { Point3 } from "./faceTypes";

export const EYE_SIDES = ["left", "right"] as const;
export type EyeSide = typeof EYE_SIDES[number];
/** The baseline renderer names channels by image side. Canonical eye controls
 * use anatomy: subject LEFT is 263/473, RIGHT is 33/468. This is the sole adapter
 * between those conventions; mirroring is still only a display operation. */
export const EYE_RENDER_CHANNELS = { left: 'right', right: 'left' } as const;
export const EYE_ANCHORS = {
  left: { inner: 362, outer: 263, upper: [387, 386, 385], lower: [373, 374, 380], iris: 473 },
  right: { inner: 133, outer: 33, upper: [160, 159, 158], lower: [144, 145, 153], iris: 468 },
} as const;

export interface EyeGeometry {
  /** All distances are ratios of this eye's width, in head-local space. */
  width: number; height: number; aperture: number; upper: number; lower: number;
  irisX: number | null; irisY: number | null; confidence: number;
}
export type EyeCalibration = Pick<EyeGeometry, "width" | "height" | "aperture" | "upper" | "lower" | "irisX" | "irisY">;
export interface CanonicalEyeState {
  openness: number; blink: number; wideOpen: number;
  gazeX: number; gazeY: number; irisX: number | null; irisY: number | null;
  /** Signed travel: positive closes; negative widens. Ratios of neutral aperture. */
  upperLid: number; lowerLid: number; confidence: number;
}
export interface EyeControlFrame { left: CanonicalEyeState; right: CanonicalEyeState }
export const eyeGazeForRenderer = (eyes: EyeControlFrame) => Object.fromEntries(EYE_SIDES.map(side => {
  const eye = eyes[EYE_RENDER_CHANNELS[side]];
  return [side, { x: eye.gazeX, y: eye.gazeY }];
})) as { left: { x: number; y: number }; right: { x: number; y: number } };
const unit = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Input MUST be canonicalFaceLandmarks output. Vertical gaze uses eye WIDTH,
 * never the moving lid gap; a blink therefore cannot divide gaze by near zero.
 * The corner line is a stable origin even when the two lids move asymmetrically. */
export function measureEyeGeometry(points: readonly Point3[], side: EyeSide): EyeGeometry | null {
  const a = EYE_ANCHORS[side];
  const inner = points[a.inner], outer = points[a.outer];
  const lidPoints = [...a.upper, ...a.lower].map(i => points[i]);
  if (!inner || !outer || lidPoints.some(p => !p || !Number.isFinite(p.x + p.y + p.z))) return null;
  const dx = outer.x - inner.x, dy = outer.y - inner.y;
  const width = Math.hypot(dx, dy);
  if (!Number.isFinite(width) || width < 1e-5) return null;
  const ux = dx / width, uy = dy / width;
  // Orient down in canonical image space, independent of which eye this is.
  const vx = -uy * Math.sign(ux || 1), vy = ux * Math.sign(ux || 1);
  const cx = (inner.x + outer.x) / 2, cy = (inner.y + outer.y) / 2;
  const projectY = (p: Point3) => ((p.x - cx) * vx + (p.y - cy) * vy) / width;
  const upper = a.upper.reduce((sum, i) => sum + projectY(points[i]!), 0) / 3;
  const lower = a.lower.reduce((sum, i) => sum + projectY(points[i]!), 0) / 3;
  const aperture = Math.max(0, lower - upper);
  const iris = points[a.iris];
  const irisX = iris && Number.isFinite(iris.x + iris.y) ? ((iris.x - cx) * ux + (iris.y - cy) * uy) / width : null;
  const irisY = iris && Number.isFinite(iris.x + iris.y) ? projectY(iris) : null;
  // Closure is valid geometry; it must NOT lower lid confidence. Iris quality
  // is evaluated separately by the gaze path while the lids are shut.
  const plausible = aperture <= 0.9 && lower >= upper && Math.abs(upper) < 0.7 && Math.abs(lower) < 0.7;
  return { width, height: aperture * width, aperture, upper, lower, irisX, irisY, confidence: plausible ? 1 : 0 };
}

export function eyeStateFromGeometry(
  geometry: EyeGeometry | null, neutral: EyeCalibration | undefined,
  blink: number, faceConfidence: number, gaze: { x: number; y: number } | null,
): CanonicalEyeState {
  const base = Math.max(0.01, neutral?.aperture ?? geometry?.aperture ?? 0.2);
  const ratio = geometry ? geometry.aperture / base : 1 - blink;
  // A measured 8% neutral envelope rejects small aperture jitter. Full wide
  // is 40% above neutral. This is independent of brow position and eye iris size.
  const wideOpen = geometry && neutral ? unit((ratio - 1.08) / 0.32) * (1 - unit(blink)) : 0;
  return {
    openness: (1 - unit(blink)) * (1 + wideOpen * 0.4), blink: unit(blink), wideOpen,
    gazeX: gaze?.x ?? 0, gazeY: gaze?.y ?? 0,
    irisX: geometry?.irisX ?? null, irisY: geometry?.irisY ?? null,
    upperLid: geometry && neutral ? (geometry.upper - neutral.upper) / base : blink,
    lowerLid: geometry && neutral ? (neutral.lower - geometry.lower) / base : 0,
    confidence: unit(faceConfidence) * (geometry?.confidence ?? 0),
  };
}

const REST: CanonicalEyeState = { openness: 1, blink: 0, wideOpen: 0, gazeX: 0, gazeY: 0, irisX: null, irisY: null, upperLid: 0, lowerLid: 0, confidence: 0 };

/** One instance per runtime. Advance only on a fresh face inference. Small
 * jitter is stabilized; decisive blink/gaze steps get an 8ms time constant.
 * Low-confidence data holds 120ms, then decays; it cannot freeze indefinitely. */
export class EyeControlFilter {
  private state: EyeControlFrame = { left: { ...REST }, right: { ...REST } };
  private lastAt: number | null = null;
  private validAt: Record<EyeSide, number | null> = { left: null, right: null };
  update(input: EyeControlFrame | null, now: number): EyeControlFrame {
    const dt = this.lastAt === null ? 33 : Math.max(0, Math.min(100, now - this.lastAt));
    this.lastAt = now;
    for (const side of EYE_SIDES) {
      const before = this.state[side], next = input?.[side];
      const valid = !!next && next.confidence >= 0.35;
      if (valid) this.validAt[side] = now;
      const holding = !valid && this.validAt[side] !== null && now - this.validAt[side]! <= 120;
      if (holding) { this.state[side] = { ...before, confidence: next?.confidence ?? 0 }; continue; }
      const target = valid ? next : REST;
      const filtered = { ...target };
      for (const key of ["blink", "wideOpen", "gazeX", "gazeY", "openness", "upperLid", "lowerLid"] as const) {
        const delta = Math.abs(target[key] - before[key]);
        const tau = !valid ? 180 : delta > 0.12 ? 8 : delta > 0.025 ? 22 : 65;
        const alpha = 1 - Math.exp(-dt / tau);
        filtered[key] = before[key] + (target[key] - before[key]) * alpha;
        if (key === "blink" && valid && target.blink >= 0.99) filtered.blink = 1;
        if (key === "openness" && valid && target.blink >= 0.99) filtered.openness = 0;
        if (delta < 0.001) filtered[key] = target[key];
      }
      this.state[side] = filtered;
    }
    return { left: { ...this.state.left }, right: { ...this.state.right } };
  }
  reset(): void {
    this.state = { left: { ...REST }, right: { ...REST } };
    this.lastAt = null; this.validAt = { left: null, right: null };
  }
}
