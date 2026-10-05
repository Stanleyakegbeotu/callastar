/** The one live configuration consumed by tracking and the face renderer. */
export interface TransformationControls {
  faceFit: {
    width: number;
    height: number;
    scale: number;
    x: number;
    y: number;
    rotation: number;
  };
  tracking: {
    stability: number;
    yawResponse: number;
    pitchResponse: number;
    scaleFollow: number;
    facialResponse: number;
    faceLock: boolean;
    rawDirect: boolean;
  };
  coverage: {
    overall: number;
    forehead: number;
    temple: number;
    jaw: number;
    chin: number;
  };
  blending: {
    feather: number;
    skinMatch: number;
    luminanceMatch: number;
    chromaMatch: number;
    shadowCorrection: number;
    sourceOpacity: number;
  };
  appearance: {
    facialHairStrength: number;
    preserveSourceTexture: boolean;
  };
}

export type TransformationControlsRef = { current: TransformationControls };

export const DEFAULT_TRANSFORMATION_CONTROLS: TransformationControls = {
  faceFit: { width: 100, height: 100, scale: 100, x: 0, y: 0, rotation: 0 },
  tracking: {
    stability: 72, yawResponse: 70, pitchResponse: 70, scaleFollow: 72,
    facialResponse: 70, faceLock: true, rawDirect: false,
  },
  coverage: { overall: 88, forehead: 82, temple: 76, jaw: 84, chin: 84 },
  blending: {
    feather: 24, skinMatch: 68, luminanceMatch: 68, chromaMatch: 68,
    shadowCorrection: 40, sourceOpacity: 100,
  },
  appearance: { facialHairStrength: 100, preserveSourceTexture: true },
};

export function clampControl(value: number, min = 0, max = 100): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

/** Keep the accepted tracking response exactly at its existing UI default. */
export function responseGain(value: number, defaultValue: number): number {
  return Math.max(0.75, Math.min(1.25, clampControl(value) / defaultValue));
}

export function scaleFollowRatio(rawRatio: number, value: number): number {
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) return 1;
  return Math.max(0.2, Math.min(5, 1 + (rawRatio - 1) * responseGain(value, 72)));
}

export function boundaryCorrectionLimit(skinMatch: number, preserveSourceTexture: boolean): number {
  return Math.min(0.3, 0.12 * clampControl(skinMatch) / 100 * (preserveSourceTexture ? 1 : 2));
}

/** Alpha used by the source shell; zero global opacity always reveals raw camera. */
export function sourceSurfaceAlpha(
  maskAlpha: number,
  sourceOpacity: number,
  facialHairWeight = 0,
  facialHairStrength = 100,
  sourceHasFacialHair = false,
): number {
  const mask = Math.max(0, Math.min(1, Number.isFinite(maskAlpha) ? maskAlpha : 0));
  const opacity = clampControl(sourceOpacity) / 100;
  const hair = sourceHasFacialHair ? Math.max(0, Math.min(1, facialHairWeight)) : 0;
  const strength = clampControl(facialHairStrength) / 100;
  return mask * opacity * (1 - hair * (1 - strength));
}

/** 0 responds quickly, 100 damps more, while remaining bounded against freezing. */
export function stabilityCutoff(value: number): number {
  return 16 - clampControl(value) * (8 / 72);
}

/** Face edge extension and its feather remain within the prebuilt shell. */
export function coverageExtensionScale(overall: number, region: number): number {
  return Math.max(0, Math.min(1, clampControl(overall) / 100 * clampControl(region) / 100));
}

export function featherExtensionScale(value: number): number {
  return 0.35 + clampControl(value) / 100 * 1.25;
}
