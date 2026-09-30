import {
  EXPRESSION_KEYS,
  NEUTRAL_EXPRESSION,
  type ExpressionKey,
  type ExpressionMotion,
} from "../engine/expressionMotion";
import type { CalibrationMotion } from "../engine/relativeMotion";
import { rendererMotionFromTracking } from "../engine/rendering/rendererMotion";

import type { AvatarCapabilities, AvatarMotion } from "./avatarTypes";

/**
 * Live tracking, as avatar motion.
 *
 * Deliberately thin, and deliberately built on `rendererMotion.ts` rather than
 * beside it. That file is already the one authoritative place where a tracking
 * sign becomes a renderer sign — it was written after a physical iPhone showed
 * head movement rendering backwards on two axes, and duplicating its reasoning
 * here would recreate exactly the scattered-negation problem it solved.
 *
 * So the avatar gets its yaw, pitch, roll and translation from the same
 * function the face renderer uses. Both surfaces therefore turn the same way,
 * and there is still only one place to look if a direction is ever wrong again.
 *
 * Everything is relative to CALIBRATION. The avatar's neutral is the operator's
 * calibrated neutral, never a raw absolute head pose — a person whose resting
 * head sits four degrees off centre must not drive a permanently turned avatar.
 */

export const NEUTRAL_AVATAR_MOTION: AvatarMotion = {
  head: { translationX: 0, translationY: 0, translationZ: 0, scale: 1, yaw: 0, pitch: 0, roll: 0 },
  face: { ...NEUTRAL_EXPRESSION },
  tracking: { faceTracked: false, calibrated: false, quality: null },
};

export interface AvatarMotionInput {
  motion: CalibrationMotion | null;
  expression: ExpressionMotion | null;
  calibrated: boolean;
  /** 0..1 from the tracker, or null when it reported none. Never invented. */
  quality?: number | null;
}

/**
 * Depth from apparent size.
 *
 * A single camera cannot measure distance, but apparent scale is a faithful
 * proxy: leaning in makes the face larger. Converted to a small z offset so a
 * model moves towards the viewer as well as growing, which reads as depth
 * without pretending to be a measurement.
 */
const DEPTH_FROM_SCALE = 0.35;

export function avatarMotionFromTracking(input: AvatarMotionInput): AvatarMotion {
  const rendered = rendererMotionFromTracking(input.motion);
  const faceTracked = !!input.motion?.head;

  return {
    head: {
      translationX: rendered.x,
      translationY: rendered.y,
      // Derived, not measured. Zero when there is nothing to derive it from.
      translationZ: faceTracked ? (rendered.scale - 1) * DEPTH_FROM_SCALE : 0,
      scale: rendered.scale,
      // The one place these come from, for both renderers.
      yaw: rendered.rotationY,
      pitch: rendered.rotationX,
      roll: rendered.rotationZ,
    },
    face: expressionValues(input.expression),
    tracking: {
      faceTracked,
      calibrated: input.calibrated,
      quality: typeof input.quality === "number" && Number.isFinite(input.quality) ? input.quality : null,
    },
  };
}

function expressionValues(expression: ExpressionMotion | null): Record<ExpressionKey, number> {
  if (!expression) return { ...NEUTRAL_EXPRESSION };
  const values = {} as Record<ExpressionKey, number>;
  for (const key of EXPRESSION_KEYS) {
    const value = expression[key];
    values[key] = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }
  return values;
}

/**
 * Silences expressions the loaded model cannot perform.
 *
 * Applied so diagnostics can show a live blink value arriving while the rig has
 * nowhere to send it — which is the difference between "your wink is not being
 * tracked" and "this model has no eyelid morph", and the operator deserves to
 * know which.
 */
export function restrictToCapabilities(motion: AvatarMotion, capabilities: AvatarCapabilities): AvatarMotion {
  const face = {} as Record<ExpressionKey, number>;
  for (const key of EXPRESSION_KEYS) {
    face[key] = capabilities.expressions[key] ? motion.face[key] : 0;
  }
  return { ...motion, face };
}

/**
 * Eases towards neutral after tracking is lost.
 *
 * A frozen avatar is worse than a neutral one: held mid-blink or mid-turn it
 * reads as a crash, and the operator cannot tell whether the renderer died or
 * they simply left the frame. `progress` runs 0..1 across the hold-then-release
 * window the caller owns.
 */
export function easeTowardsNeutral(motion: AvatarMotion, progress: number): AvatarMotion {
  const t = Math.max(0, Math.min(1, progress));
  if (t <= 0) return motion;

  const blend = (value: number, target: number) => value + (target - value) * t;
  const face = {} as Record<ExpressionKey, number>;
  for (const key of EXPRESSION_KEYS) face[key] = blend(motion.face[key], 0);

  return {
    head: {
      translationX: blend(motion.head.translationX, 0),
      translationY: blend(motion.head.translationY, 0),
      translationZ: blend(motion.head.translationZ, 0),
      scale: blend(motion.head.scale, 1),
      yaw: blend(motion.head.yaw, 0),
      pitch: blend(motion.head.pitch, 0),
      roll: blend(motion.head.roll, 0),
    },
    face,
    tracking: motion.tracking,
  };
}

/**
 * Smoothing, with head and expressions on different characters.
 *
 * Head motion wants to be stable, because yaw jitter on a rendered head reads as
 * a shiver. Expressions want to be quick, because a blink that takes 200ms to
 * arrive is not a blink. Blink is faster still on the way up than the way down,
 * which is how real eyelids move.
 */
export const AVATAR_SMOOTHING = {
  headTauMs: 60,
  /** Expression time constants, in ms. */
  blinkAttackMs: 24,
  blinkReleaseMs: 55,
  jawMs: 42,
  otherMs: 70,
} as const;

export function smoothAvatarMotion(previous: AvatarMotion, target: AvatarMotion, elapsedMs: number): AvatarMotion {
  const clampedElapsed = Math.min(80, Math.max(0, elapsedMs));
  const alphaFor = (tau: number) => 1 - Math.exp(-clampedElapsed / tau);
  const headAlpha = alphaFor(AVATAR_SMOOTHING.headTauMs);
  const blend = (from: number, to: number, alpha: number) => from + (to - from) * alpha;

  const face = {} as Record<ExpressionKey, number>;
  for (const key of EXPRESSION_KEYS) {
    const rising = target.face[key] > previous.face[key];
    const tau = key.startsWith("blink")
      ? rising
        ? AVATAR_SMOOTHING.blinkAttackMs
        : AVATAR_SMOOTHING.blinkReleaseMs
      : key === "jawOpen"
        ? AVATAR_SMOOTHING.jawMs
        : AVATAR_SMOOTHING.otherMs;
    face[key] = blend(previous.face[key], target.face[key], alphaFor(tau));
  }

  return {
    head: {
      translationX: blend(previous.head.translationX, target.head.translationX, headAlpha),
      translationY: blend(previous.head.translationY, target.head.translationY, headAlpha),
      translationZ: blend(previous.head.translationZ, target.head.translationZ, headAlpha),
      scale: blend(previous.head.scale, target.head.scale, headAlpha),
      yaw: blend(previous.head.yaw, target.head.yaw, headAlpha),
      pitch: blend(previous.head.pitch, target.head.pitch, headAlpha),
      roll: blend(previous.head.roll, target.head.roll, headAlpha),
    },
    face,
    tracking: target.tracking,
  };
}
