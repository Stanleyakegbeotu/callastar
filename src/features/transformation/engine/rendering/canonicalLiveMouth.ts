import type { Point3 } from "../faceTypes";
import { INNER_LIP_RING, OUTER_LIP_RING } from "./sourceMesh";

export interface MouthMeasurements {
  width: number;
  outerHeight: number;
  openingHeight: number;
  openingWidth: number;
  center: Point3;
  leftCorner: Point3;
  rightCorner: Point3;
  openRatio: number;
  heightRatio: number;
}

export interface MouthRings {
  outer: Point3[];
  inner: Point3[];
}

const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point3, b: Point3): Point3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/** Measurements use separate lip rings; the inner opening never sizes the outer lips. */
export function measureLiveMouth(points: readonly Point3[]): MouthMeasurements | null {
  if (points.length < 468) return null;
  const get = (index: number) => points[index]!;
  const width = distance(get(61), get(291));
  if (!Number.isFinite(width) || width < 1e-5) return null;
  const outerHeight = distance(get(0), get(17));
  const openingHeight = Math.max(0, get(14).y - get(13).y);
  const openingWidth = distance(get(78), get(308));
  return {
    width, outerHeight, openingHeight, openingWidth,
    center: midpoint(get(61), get(291)),
    leftCorner: get(61), rightCorner: get(291),
    openRatio: openingHeight / width, heightRatio: outerHeight / width,
  };
}

/** Exactly the inverse rotation and normalization used by live source-mesh projection. */
export function mouthPointToFaceLocal(
  point: Point3, center: Point3, faceWidth: number, aspect: number,
  inverseRotation: ArrayLike<number>, canonicalWidth = 0.44,
): Point3 {
  const x = (point.x - center.x) / faceWidth * canonicalWidth;
  const y = -(point.y - center.y) / (faceWidth * aspect) * canonicalWidth;
  const z = -(point.z - center.z) / faceWidth * canonicalWidth;
  return {
    x: inverseRotation[0]! * x + inverseRotation[4]! * y + inverseRotation[8]! * z,
    y: inverseRotation[1]! * x + inverseRotation[5]! * y + inverseRotation[9]! * z,
    z: inverseRotation[2]! * x + inverseRotation[6]! * y + inverseRotation[10]! * z,
  };
}

export function canonicalMouthRings(
  points: readonly Point3[], center: Point3, faceWidth: number, aspect: number,
  inverseRotation: ArrayLike<number>,
): MouthRings | null {
  if (points.length < 468 || faceWidth <= 1e-6 || aspect <= 1e-6) return null;
  const project = (index: number) => mouthPointToFaceLocal(points[index]!, center, faceWidth, aspect, inverseRotation);
  const outer = OUTER_LIP_RING.map(project), inner = INNER_LIP_RING.map(project);
  if ([...outer, ...inner].some(point => ![point.x, point.y, point.z].every(Number.isFinite))) return null;
  return { outer, inner };
}

const widthOf = (ring: readonly Point3[]) => distance(ring[0]!, ring[10]!);
const blend = (a: Point3, b: Point3, alpha: number): Point3 => ({
  x: a.x + (b.x - a.x) * alpha,
  y: a.y + (b.y - a.y) * alpha,
  z: a.z + (b.z - a.z) * alpha,
});

export interface MouthFilterStats {
  alpha: number;
  rawMotion: number;
  filteredMotion: number;
  rejectedPoints: number;
  widthRatio: number;
}

/** Filters only expression geometry, after global head pose has been removed. */
export class CanonicalMouthStabilizer {
  private previous: MouthRings | null = null;
  private timestampMs = -1;
  stats: MouthFilterStats = { alpha: 1, rawMotion: 0, filteredMotion: 0, rejectedPoints: 0, widthRatio: 1 };

  reset(): void { this.previous = null; this.timestampMs = -1; }

  update(raw: MouthRings, timestampMs: number): MouthRings {
    const width = widthOf(raw.outer);
    if (!this.previous || timestampMs <= this.timestampMs || timestampMs - this.timestampMs > 500 || width < 1e-5) {
      this.previous = { outer: raw.outer.map(p => ({ ...p })), inner: raw.inner.map(p => ({ ...p })) };
      this.timestampMs = timestampMs;
      this.stats = { alpha: 1, rawMotion: 0, filteredMotion: 0, rejectedPoints: 0, widthRatio: 1 };
      return this.previous;
    }
    const previous = this.previous;
    const allRaw = [...raw.outer, ...raw.inner], allPrevious = [...previous.outer, ...previous.inner];
    const displacement = allRaw.map((point, i) => distance(point, allPrevious[i]!) / width);
    const sorted = [...displacement].sort((a, b) => a - b);
    const coherentMotion = sorted[Math.floor(sorted.length * .65)]!;
    const openingChange = Math.abs((raw.inner[5]!.y - raw.inner[15]!.y) -
      (previous.inner[5]!.y - previous.inner[15]!.y)) / width;
    const coordinated = Math.max(coherentMotion, openingChange);
    const frameFactor = Math.min(2, Math.max(.65, (timestampMs - this.timestampMs) / 33));
    const baseAlpha = Math.min(.86, .26 + coordinated * 6.5);
    let rejectedPoints = 0;
    const filterRing = (ring: readonly Point3[], old: readonly Point3[], inner: boolean): Point3[] => ring.map((point, i) => {
      const jump = distance(point, old[i]!) / width;
      const n = ring.length;
      const neighborMotion = (distance(ring[(i + n - 1) % n]!, old[(i + n - 1) % n]!) +
        distance(ring[(i + 1) % n]!, old[(i + 1) % n]!)) / (2 * width);
      const isolated = jump > .16 && jump > neighborMotion * 2.6 + .08 && coordinated < .1;
      let target = point;
      if (isolated) {
        rejectedPoints++;
        const limit = width * (.07 + neighborMotion);
        target = blend(old[i]!, point, Math.min(1, limit / Math.max(1e-6, distance(point, old[i]!))));
      }
      const alpha = Math.min(.95, Math.max(.2, (baseAlpha + (inner ? .12 : i === 0 || i === 10 ? .07 : 0)) * frameFactor));
      return blend(old[i]!, target, alpha);
    });
    const outer = filterRing(raw.outer, previous.outer, false);
    const inner = filterRing(raw.inner, previous.inner, true);
    // A single-frame filter should not make a smile look 30-50% too wide or narrow.
    const filteredWidth = widthOf(outer);
    const ratio = filteredWidth / width;
    if (ratio > 1.06 || ratio < .94) {
      const desired = width * Math.max(.94, Math.min(1.06, ratio));
      const scale = desired / Math.max(1e-6, filteredWidth);
      const center = midpoint(outer[0]!, outer[10]!);
      for (const point of [...outer, ...inner]) {
        point.x = center.x + (point.x - center.x) * scale;
        point.y = center.y + (point.y - center.y) * scale;
      }
    }
    // Paired upper/lower inner points must not cross while the lips close.
    for (let lower = 1; lower <= 9; lower++) {
      const upper = 20 - lower;
      if (inner[upper]!.y < inner[lower]!.y) {
        const middle = midpoint(inner[upper]!, inner[lower]!);
        inner[upper]!.y = middle.y;
        inner[lower]!.y = middle.y;
      }
    }
    const rawGap = Math.max(0, raw.inner[15]!.y - raw.inner[5]!.y);
    const filteredGap = Math.max(0, inner[15]!.y - inner[5]!.y);
    const desiredGap = rawGap < width * .005
      ? Math.min(filteredGap, width * .008)
      : Math.max(rawGap * .92, Math.min(rawGap * 1.08, filteredGap));
    if (filteredGap > 1e-6 && Math.abs(desiredGap - filteredGap) > 1e-6) {
      const middleY = (inner[15]!.y + inner[5]!.y) / 2;
      const scale = desiredGap / filteredGap;
      for (const point of inner) point.y = middleY + (point.y - middleY) * scale;
    }
    const result = { outer, inner };
    this.stats = {
      alpha: baseAlpha, rawMotion: coordinated,
      filteredMotion: Math.max(...[...outer, ...inner].map((p, i) => distance(p, allPrevious[i]!))) / width,
      rejectedPoints, widthRatio: widthOf(outer) / width,
    };
    this.previous = result;
    this.timestampMs = timestampMs;
    return result;
  }
}

/** Small face-local feather ring. The actual lip vertices retain the measured width. */
export function perioralLocalRing(outer: readonly Point3[], faceWidth: number): Point3[] {
  const xs = outer.map(p => p.x), ys = outer.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const centerX = (minX + maxX) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const width = maxX - minX;
  return outer.map(point => ({
    x: centerX + (point.x - centerX) * 1.16,
    y: point.y + (point.y >= centerY ? faceWidth * .03 : -faceWidth * .035),
    z: point.z,
  }));
}

export function mouthMeshIndices(ringLength = 20): Uint16Array {
  const indices: number[] = [];
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i < ringLength; i++) {
    const next = (i + 1) % ringLength, a = ring * ringLength + i, b = ring * ringLength + next;
    indices.push(a, b, a + ringLength, b, b + ringLength, a + ringLength);
  }
  const center = ringLength * 3;
  for (let i = 0; i < ringLength; i++) indices.push(center, ringLength * 2 + i, ringLength * 2 + (i + 1) % ringLength);
  return new Uint16Array(indices);
}
