export interface BoundaryRgb {
  r: number;
  g: number;
  b: number;
}

export interface BoundaryColorCorrection extends BoundaryRgb {}

export const BOUNDARY_SKIN_REGIONS = [
  { name: "forehead", landmark: 10 },
  { name: "left-temple", landmark: 234 },
  { name: "right-temple", landmark: 454 },
  { name: "left-cheek", landmark: 127 },
  { name: "right-cheek", landmark: 356 },
  { name: "chin", landmark: 152 },
] as const;

export const NEUTRAL_BOUNDARY_CORRECTION: readonly BoundaryColorCorrection[] =
  BOUNDARY_SKIN_REGIONS.map(() => ({ r: 1, g: 1, b: 1 }));

function srgbToLinear(value: number): number {
  const channel = Math.max(0, Math.min(1, value / 255));
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/** Bounded low-frequency source-to-live correction; no pixels or texture are replaced. */
export function estimateBoundaryCorrections(
  sourceSamples: readonly (BoundaryRgb | null)[],
  liveSamples: readonly (BoundaryRgb | null)[],
  maxChange = 0.12,
): BoundaryColorCorrection[] {
  const bound = Math.max(0, Math.min(0.3, maxChange));
  return BOUNDARY_SKIN_REGIONS.map((_, index) => {
    const source = sourceSamples[index], live = liveSamples[index];
    if (!source || !live) return { r: 1, g: 1, b: 1 };
    const channel = (key: keyof BoundaryRgb) => {
      const src = srgbToLinear(source[key]), dst = srgbToLinear(live[key]);
      if (src < 0.002 || dst < 0.002) return 1;
      return Math.max(1 - bound, Math.min(1 + bound, dst / src));
    };
    return { r: channel("r"), g: channel("g"), b: channel("b") };
  });
}

/** Smooths only appearance parameters. Geometry and facial expression are untouched. */
export function smoothBoundaryCorrections(
  previous: readonly BoundaryColorCorrection[],
  target: readonly BoundaryColorCorrection[],
  deltaMs: number,
  timeConstantMs = 650,
): BoundaryColorCorrection[] {
  const alpha = 1 - Math.exp(-Math.max(0, Math.min(250, deltaMs)) / Math.max(1, timeConstantMs));
  return BOUNDARY_SKIN_REGIONS.map((_, index) => {
    const from = previous[index] ?? { r: 1, g: 1, b: 1 };
    const to = target[index] ?? from;
    return {
      r: from.r + (to.r - from.r) * alpha,
      g: from.g + (to.g - from.g) * alpha,
      b: from.b + (to.b - from.b) * alpha,
    };
  });
}

/** Applies the regional color delta only through the mesh's existing edge feather. */
export function applyBoundaryCorrections(
  output: Float32Array,
  baseColors: Float32Array,
  coverage: Float32Array,
  vertexPositions: Float32Array,
  regionAnchors: readonly { x: number; y: number }[],
  corrections: readonly BoundaryColorCorrection[],
): void {
  const vertices = Math.min(output.length, baseColors.length) / 4;
  for (let vertex = 0; vertex < vertices; vertex++) {
    const offset = vertex * 4;
    const alpha = coverage[vertex] ?? 1;
    const edgeWeight = Math.pow(Math.max(0, Math.min(1, 1 - alpha)), 1.5);
    if (edgeWeight < 0.001 || regionAnchors.length === 0) {
      output.set(baseColors.subarray(offset, offset + 4), offset);
      continue;
    }
    const x = vertexPositions[vertex * 3] ?? 0;
    const y = vertexPositions[vertex * 3 + 1] ?? 0;
    let total = 0, r = 0, g = 0, b = 0;
    for (let region = 0; region < regionAnchors.length; region++) {
      const anchor = regionAnchors[region]!;
      const distance = Math.hypot(x - anchor.x, y - anchor.y);
      const weight = Math.exp(-distance * distance / (2 * 0.12 * 0.12));
      const correction = corrections[region] ?? { r: 1, g: 1, b: 1 };
      total += weight;
      r += correction.r * weight;
      g += correction.g * weight;
      b += correction.b * weight;
    }
    const correction = total > 0 ? { r: r / total, g: g / total, b: b / total } : { r: 1, g: 1, b: 1 };
    output[offset] = baseColors[offset]! * (1 + (correction.r - 1) * edgeWeight);
    output[offset + 1] = baseColors[offset + 1]! * (1 + (correction.g - 1) * edgeWeight);
    output[offset + 2] = baseColors[offset + 2]! * (1 + (correction.b - 1) * edgeWeight);
    output[offset + 3] = baseColors[offset + 3]!;
  }
}

/** Median RGB of a small pixel neighborhood at one normalized image location. */
export function sampleImageRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  point: { x: number; y: number },
  radius = 1,
): BoundaryRgb | null {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4 ||
      !Number.isFinite(point.x + point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const cx = Math.round(point.x * (width - 1)), cy = Math.round(point.y * (height - 1));
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3]! < 16) continue;
      channels[0].push(pixels[offset]!);
      channels[1].push(pixels[offset + 1]!);
      channels[2].push(pixels[offset + 2]!);
    }
  }
  if (!channels[0].length) return null;
  return { r: median(channels[0]), g: median(channels[1]), b: median(channels[2]) };
}
