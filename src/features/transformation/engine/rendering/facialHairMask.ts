import type { Point3 } from "../faceTypes";

export interface FacialHairEstimate {
  weights: Float32Array;
  confidence: number;
  present: boolean;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

function patchLuminance(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number): number | null {
  const cx = Math.round(x * (width - 1)), cy = Math.round(y * (height - 1));
  const samples: number[] = [];
  for (let py = Math.max(0, cy - 1); py <= Math.min(height - 1, cy + 1); py++) {
    for (let px = Math.max(0, cx - 1); px <= Math.min(width - 1, cx + 1); px++) {
      const at = (py * width + px) * 4;
      if ((pixels[at + 3] ?? 0) < 16) continue;
      samples.push(0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!);
    }
  }
  return samples.length ? median(samples) : null;
}

/**
 * Conservative source-only appearance estimate. It compares lower-face pixels
 * with cheek skin at analysis/render initialization; it is not semantic hair
 * segmentation and is never run in the camera frame loop.
 */
export function estimateFacialHairMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  landmarks: readonly Point3[],
): FacialHairEstimate {
  const weights = new Float32Array(landmarks.length);
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4 || landmarks.length < 468) {
    return { weights, confidence: 0, present: false };
  }
  const cheeks = [123, 352, 205, 425].flatMap(index => {
    const point = landmarks[index];
    const value = point ? patchLuminance(pixels, width, height, point.x, point.y) : null;
    return value === null ? [] : [value];
  });
  const cheekLuminance = cheeks.length ? median(cheeks) : null;
  const mouth = landmarks[13], chin = landmarks[152], left = landmarks[234], right = landmarks[454];
  if (cheekLuminance === null || !mouth || !chin || !left || !right || cheekLuminance < 12) {
    return { weights, confidence: 0, present: false };
  }
  const faceWidth = Math.max(1e-4, Math.abs(right.x - left.x));
  const faceCenterX = (right.x + left.x) / 2;
  const lowerHeight = Math.max(1e-4, chin.y - mouth.y);
  let weightTotal = 0, candidateCount = 0, darkCount = 0;
  for (let index = 0; index < Math.min(468, landmarks.length); index++) {
    const point = landmarks[index]!;
    const lower = Math.max(0, Math.min(1, (point.y - (mouth.y - lowerHeight * 0.12)) / lowerHeight));
    const lateral = Math.max(0, Math.min(1, 1.12 - Math.abs(point.x - faceCenterX) / (faceWidth * 0.56)));
    if (lower <= 0 || lateral <= 0) continue;
    const luminance = patchLuminance(pixels, width, height, point.x, point.y);
    if (luminance === null) continue;
    const darkness = Math.max(0, Math.min(1, (cheekLuminance - luminance - 12) / Math.max(18, cheekLuminance * 0.45)));
    const weight = darkness * lateral * Math.min(1, lower * 1.8);
    weights[index] = weight;
    candidateCount++;
    weightTotal += weight;
    if (weight > 0.38) darkCount++;
  }
  const meanDarkness = candidateCount ? weightTotal / candidateCount : 0;
  const density = candidateCount ? darkCount / candidateCount : 0;
  const confidence = Math.max(0, Math.min(1, meanDarkness * 1.25 + density * 0.45));
  return { weights, confidence, present: confidence >= 0.22 };
}
