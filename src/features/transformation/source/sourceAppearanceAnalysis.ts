import type { Point3 } from "../engine/faceTypes";
import { estimateFacialHairMask } from "../engine/rendering/facialHairMask";
import { BOUNDARY_SKIN_REGIONS, sampleImageRegion } from "../engine/rendering/boundaryHarmonization";

export interface SourceAppearanceProfile {
  hairline: {
    /** Estimated normalized image y positions; MediaPipe has no hairline class. */
    foreheadTop: number;
    leftTemple: number;
    rightTemple: number;
    confidence: number;
  };
  facialHair: {
    present: boolean;
    confidence: number;
    /** Compact source-space likelihood per face landmark, normalized 0..1. */
    mask: number[];
    beardExtent: number;
    mustacheExtent: number;
    sideburnExtent: number;
  };
  skinStatistics: {
    representativeLuminance: number | null;
    representativeChroma: number | null;
  };
}

function luminance(rgb: { r: number; g: number; b: number }): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

/** Lightweight pixel profile run once for the selected source frame. */
export function analyzeSourceAppearance(
  image: CanvasImageSource,
  width: number,
  height: number,
  landmarks: readonly Point3[],
): SourceAppearanceProfile | undefined {
  if (width <= 0 || height <= 0 || landmarks.length < 468 || typeof document === "undefined") return undefined;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const hair = estimateFacialHairMask(pixels, canvas.width, canvas.height, landmarks);
    const cheekSamples = BOUNDARY_SKIN_REGIONS.filter(region => region.name.includes("cheek"))
      .flatMap(region => {
        const point = landmarks[region.landmark];
        const sample = point ? sampleImageRegion(pixels, canvas.width, canvas.height, point, 2) : null;
        return sample ? [sample] : [];
      });
    const representativeLuminance = cheekSamples.length
      ? cheekSamples.reduce((sum, sample) => sum + luminance(sample), 0) / cheekSamples.length
      : null;
    const representativeChroma = cheekSamples.length
      ? cheekSamples.reduce((sum, sample) => sum + Math.max(sample.r, sample.g, sample.b) - Math.min(sample.r, sample.g, sample.b), 0) / cheekSamples.length
      : null;

    // Landmark 10 is the upper forehead anchor. A small, source-only vertical
    // gradient scan looks for a skin-to-hair luminance transition nearby; on a
    // weak/occluded transition, the landmark estimate remains the fallback.
    const top = landmarks[10]!;
    const browY = [105, 66, 107, 336, 296, 334].map(index => landmarks[index]!.y).sort((a, b) => a - b)[2]!;
    const faceHeight = Math.max(1e-4, landmarks[152]!.y - top.y);
    const step = Math.max(1, Math.round(faceHeight * 0.035 * canvas.height));
    const searchTop = Math.max(0, top.y - faceHeight * 0.08);
    const searchBottom = Math.min(browY, top.y + faceHeight * 0.08);
    const estimateAt = (x: number): { y: number; strength: number } => {
      let best = { y: top.y, strength: 0 };
      const start = Math.max(0, Math.floor(searchTop * canvas.height));
      const end = Math.min(canvas.height - step - 1, Math.ceil(searchBottom * canvas.height));
      for (let row = start; row <= end; row++) {
        const before = sampleImageRegion(pixels, canvas.width, canvas.height, { x, y: row / canvas.height }, 1);
        const after = sampleImageRegion(pixels, canvas.width, canvas.height, { x, y: (row + step) / canvas.height }, 1);
        if (!before || !after) continue;
        const contrast = Math.max(0, luminance(after) - luminance(before));
        if (contrast > best.strength) best = { y: (row + step / 2) / canvas.height, strength: contrast };
      }
      return { y: best.strength >= 12 ? best.y : top.y, strength: Math.min(1, best.strength / 64) };
    };
    const sourceFaceWidth = Math.max(1e-4, landmarks[454]!.x - landmarks[234]!.x);
    const centerX = (landmarks[454]!.x + landmarks[234]!.x) / 2;
    const center = estimateAt(centerX);
    const left = estimateAt(Math.max(0, centerX - sourceFaceWidth * 0.29));
    const right = estimateAt(Math.min(1, centerX + sourceFaceWidth * 0.29));
    const confidence = (center.strength + left.strength + right.strength) / 3;
    let beard = 0, beardCount = 0, moustache = 0, sideburn = 0;
    const mouth = landmarks[13]!;
    for (let index = 0; index < Math.min(468, hair.weights.length); index++) {
      const weight = hair.weights[index]!;
      const point = landmarks[index]!;
      if (point.y >= mouth.y + faceHeight * 0.12) { beard += weight; beardCount++; }
      if (Math.abs(point.y - mouth.y) <= faceHeight * 0.08) moustache = Math.max(moustache, weight);
      if (Math.abs(point.x - centerX) >= sourceFaceWidth * 0.32 && point.y >= mouth.y) sideburn = Math.max(sideburn, weight);
    }
    return {
      hairline: { foreheadTop: center.y, leftTemple: left.y, rightTemple: right.y, confidence },
      facialHair: {
        present: hair.present,
        confidence: hair.confidence,
        mask: Array.from(hair.weights.slice(0, 468), value => Math.round(value * 1000) / 1000),
        beardExtent: beardCount ? Math.min(1, beard / beardCount * 2) : 0,
        mustacheExtent: moustache,
        sideburnExtent: sideburn,
      },
      skinStatistics: { representativeLuminance, representativeChroma },
    };
  } catch {
    return undefined;
  }
}
