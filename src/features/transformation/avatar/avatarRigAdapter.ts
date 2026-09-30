import { EXPRESSION_KEYS, type ExpressionKey } from "../engine/expressionMotion";

import type { AvatarCapabilities, AvatarMotion, MorphTargetLocation } from "./avatarTypes";

/**
 * CallaStar expressions, as influences on whatever the loaded model calls them.
 *
 * The single translation point between this pipeline's eight expressions and a
 * model's own morph vocabulary. Both live tracking and the manual rig panel go
 * through here, deliberately: if the manual slider used a different path, a
 * working slider next to a dead live input would prove nothing about which half
 * was broken.
 *
 * Pure. It takes the mapping the analyzer discovered and returns numbers, so it
 * is testable without Three.js and without a GLB.
 */

/**
 * Per-expression gain.
 *
 * Models disagree about what a morph influence of 1 means: some are calibrated
 * so 1 is a full ARKit blink, others are modelled loosely and barely move. These
 * are starting points of 1.0 — an honest default that changes nothing — and exist
 * so a model can be tuned later without touching the adapter.
 */
export type AvatarGains = Record<ExpressionKey, number>;

export const DEFAULT_AVATAR_GAINS: AvatarGains = {
  blinkLeft: 1,
  blinkRight: 1,
  jawOpen: 1,
  smileLeft: 1,
  smileRight: 1,
  browInnerUp: 1,
  browOuterUpLeft: 1,
  browOuterUpRight: 1,
};

/** One morph influence to write, resolved to a mesh and an index. */
export interface MorphInfluence {
  meshName: string;
  index: number;
  /** 0..1. Clamped, because a morph driven past 1 tears most rigs. */
  value: number;
  /** Which expression produced it, for diagnostics. */
  key: ExpressionKey;
}

export interface RigApplication {
  influences: MorphInfluence[];
  /** Jaw rotation in radians, for a model with a jaw bone but no jawOpen morph. */
  jawBoneRotation: number | null;
  /** Requested against applied, per expression, for the diagnostics trace. */
  requested: Record<ExpressionKey, number>;
  applied: Record<ExpressionKey, number>;
  /** Expressions the model cannot perform, so a live value has nowhere to go. */
  unsupported: ExpressionKey[];
}

export interface AvatarRigAdapterOptions {
  mappedMorphs: Partial<Record<ExpressionKey, MorphTargetLocation[]>>;
  capabilities: AvatarCapabilities;
  gains?: Partial<AvatarGains>;
  /** Radians of jaw-bone rotation at full jawOpen, when driving a bone. */
  jawBoneRange?: number;
}

/** A jaw bone at full open. Roughly what a wide human jaw does; short of a yawn. */
const DEFAULT_JAW_BONE_RANGE = 0.32;

export class AvatarRigAdapter {
  private readonly gains: AvatarGains;

  constructor(private readonly options: AvatarRigAdapterOptions) {
    this.gains = { ...DEFAULT_AVATAR_GAINS, ...options.gains };
  }

  get capabilities(): AvatarCapabilities {
    return this.options.capabilities;
  }

  setGain(key: ExpressionKey, gain: number): void {
    if (!Number.isFinite(gain)) return;
    this.gains[key] = Math.max(0, Math.min(4, gain));
  }

  getGains(): AvatarGains {
    return { ...this.gains };
  }

  /**
   * Turns one frame of avatar motion into rig writes.
   *
   * An expression with no morph and no bone produces nothing and is listed as
   * unsupported. That is reported rather than silently dropped — an operator
   * watching a live blink value arrive while the avatar's eyes stay open needs to
   * know the rig has nowhere to send it.
   */
  apply(motion: AvatarMotion): RigApplication {
    const influences: MorphInfluence[] = [];
    const requested = {} as Record<ExpressionKey, number>;
    const applied = {} as Record<ExpressionKey, number>;
    const unsupported: ExpressionKey[] = [];

    for (const key of EXPRESSION_KEYS) {
      const raw = motion.face[key];
      const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      requested[key] = value;

      const locations = this.options.mappedMorphs[key];
      if (!locations || locations.length === 0) {
        applied[key] = 0;
        unsupported.push(key);
        continue;
      }

      // Clamped after the gain, so a gain above 1 raises a weak rig's response
      // without ever driving a morph past its modelled extreme.
      const driven = Math.max(0, Math.min(1, value * this.gains[key]));
      applied[key] = driven;

      /*
       * Written to EVERY mesh carrying that morph.
       *
       * A head is frequently split across meshes — face, eyes, teeth, tongue,
       * brows — and an eyelid morph may exist on more than one of them. Driving
       * only the first would close the skin and leave the eyeball open.
       */
      for (const location of locations) {
        influences.push({ meshName: location.meshName, index: location.index, value: driven, key });
      }
    }

    return {
      influences,
      jawBoneRotation: this.jawRotation(applied, requested),
      requested,
      applied,
      unsupported,
    };
  }

  /**
   * Jaw from a bone, only where there is no morph to do the job.
   *
   * A rigged head with no facial morphs can still open its mouth if the skeleton
   * exposes a jaw. Driving both a morph and the bone would open it twice.
   */
  private jawRotation(
    applied: Record<ExpressionKey, number>,
    requested: Record<ExpressionKey, number>,
  ): number | null {
    if (!this.options.capabilities.jawBone) return null;
    const hasMorph = (this.options.mappedMorphs.jawOpen?.length ?? 0) > 0;
    if (hasMorph) return null;

    const value = Math.max(0, Math.min(1, requested.jawOpen * this.gains.jawOpen));
    applied.jawOpen = value;
    return value * (this.options.jawBoneRange ?? DEFAULT_JAW_BONE_RANGE);
  }
}

/**
 * Which expressions a discovered mapping can actually serve.
 *
 * Derived from the mapping rather than declared alongside it, so a capability
 * and the morph behind it cannot disagree.
 */
export function capabilitiesFromMapping(
  mappedMorphs: Partial<Record<ExpressionKey, MorphTargetLocation[]>>,
  options: { hasSkeleton: boolean; jawBone: boolean },
): AvatarCapabilities {
  const expressions = {} as Record<ExpressionKey, boolean>;
  for (const key of EXPRESSION_KEYS) {
    expressions[key] = (mappedMorphs[key]?.length ?? 0) > 0;
  }

  // A jaw bone gives jawOpen even with no morph for it.
  if (!expressions.jawOpen && options.jawBone) expressions.jawOpen = true;

  return {
    // Any model can be rotated and moved as a whole; these need no rig.
    headPose: true,
    headTransform: true,
    expressions,
    jawBone: options.jawBone,
  };
}
