export interface MouthPoint { x: number; y: number }

/** Triangles from a centroid through the ordered inner-lip contour. */
export function mouthFanTriangles(count: number): [number, number, number][] {
  if (count < 3) return [];
  return Array.from({ length: count }, (_, i) => [count, i, (i + 1) % count]);
}

/**
 * Draws only the live inner-mouth polygon into a transparent target canvas.
 * Each triangle maps three live landmarks to their source-mouth counterpart;
 * no pixels outside the lip contour are copied.
 */
export function drawWarpedMouth(
  context: CanvasRenderingContext2D,
  video: CanvasImageSource,
  liveRing: readonly MouthPoint[],
  targetRing: readonly MouthPoint[],
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
): boolean {
  if (liveRing.length < 3 || liveRing.length !== targetRing.length || width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) return false;
  const liveCentre = centroid(liveRing);
  const targetCentre = centroid(targetRing);
  const source = [...liveRing.map(p => ({ x: p.x * videoWidth, y: p.y * videoHeight })),
    { x: liveCentre.x * videoWidth, y: liveCentre.y * videoHeight }];
  const targetPixels = targetRing.map(p => ({ x: p.x * width, y: p.y * height }));
  const centrePixels = { x: targetCentre.x * width, y: targetCentre.y * height };
  // Keep the antialiased clip edge a pixel inside the lip boundary so no live
  // skin contributes outside the source aperture.
  const radius = Math.min(...targetPixels.map(p => Math.hypot(p.x - centrePixels.x, p.y - centrePixels.y)));
  const insetScale = Math.max(0, 1 - 1.5 / Math.max(1.5, radius));
  const target = [...targetPixels.map(p => ({
    x: centrePixels.x + (p.x - centrePixels.x) * insetScale,
    y: centrePixels.y + (p.y - centrePixels.y) * insetScale,
  })), centrePixels];
  context.clearRect(0, 0, width, height);
  for (const [centre, first, second] of mouthFanTriangles(liveRing.length)) {
    const a = affine(source[centre]!, source[first]!, source[second]!, target[centre]!, target[first]!, target[second]!);
    if (!a) continue;
    const t0 = target[centre]!, t1 = target[first]!, t2 = target[second]!;
    context.save();
    context.beginPath();
    context.moveTo(t0.x, t0.y);
    context.lineTo(t1.x, t1.y);
    context.lineTo(t2.x, t2.y);
    context.closePath();
    context.clip();
    context.setTransform(a.a, a.b, a.c, a.d, a.e, a.f);
    context.drawImage(video, 0, 0, videoWidth, videoHeight);
    context.restore();
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  return true;
}

function centroid(points: readonly MouthPoint[]): MouthPoint {
  const sum = points.reduce((value, point) => ({ x: value.x + point.x, y: value.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function affine(s0: MouthPoint, s1: MouthPoint, s2: MouthPoint, d0: MouthPoint, d1: MouthPoint, d2: MouthPoint) {
  const x1 = s1.x - s0.x, y1 = s1.y - s0.y;
  const x2 = s2.x - s0.x, y2 = s2.y - s0.y;
  const det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-8) return null;
  const X1 = d1.x - d0.x, Y1 = d1.y - d0.y;
  const X2 = d2.x - d0.x, Y2 = d2.y - d0.y;
  const a = (X1 * y2 - X2 * y1) / det;
  const c = (x1 * X2 - x2 * X1) / det;
  const b = (Y1 * y2 - Y2 * y1) / det;
  const d = (x1 * Y2 - x2 * Y1) / det;
  return { a, b, c, d, e: d0.x - a * s0.x - c * s0.y, f: d0.y - b * s0.x - d * s0.y };
}
