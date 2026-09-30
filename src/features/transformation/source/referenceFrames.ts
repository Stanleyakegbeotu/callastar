import type { DerivedFaceGeometry } from "../engine/faceTypes";
import type { PoseDerivedGeometry } from "../engine/poseTypes";

import { SOURCE_RULES } from "./sourceQuality";
import type { ReferenceAngle, ReferenceFrame } from "./sourceTypes";

/**
 * Sorting sampled frames into a small bank of useful head angles.
 *
 * Two jobs, kept apart because they fail differently: deciding WHICH angle a
 * frame shows, and deciding which of several frames showing that angle is the
 * best one to keep.
 *
 * Classification uses the head pose the model solved for — never a filename,
 * never a position in the timeline. "The frame a third of the way through is
 * probably the left-turn one" is the kind of assumption that produces a bank
 * which is confidently wrong.
 *
 * The yaw sign convention is the one `faceTypes` documents and the Milestone 5
 * browser proof measured against real model output: POSITIVE yaw is the head
 * turned towards the SUBJECT'S LEFT. A frame with positive yaw is therefore a
 * `slight-left` reference. Getting this backwards would build a bank whose
 * every label is mirrored, and the renderer would reach for the wrong cheek.
 */

export const CLASSIFICATION = {
  /**
   * Inside this, a head is facing front.
   *
   * ~9°. Generous enough that an ordinary near-front frame is not pushed into a
   * side bucket, tight enough that a real turn is not called front.
   */
  frontYaw: 0.16,
  frontPitch: 0.13,
  /**
   * A turn has to be at least this much to be worth a bucket of its own.
   *
   * Below it the frame is nearly front-facing and adds nothing a front
   * reference does not already give.
   */
  minSideYaw: 0.16,
  minVerticalPitch: 0.13,
  /** Past this the far side of the face is hidden and the frame is unusable. */
  maxUsableYaw: 0.7,
  maxUsablePitch: 0.5,
} as const;

/** The angle each bucket aims at, for scoring how close a candidate is. */
const TARGET: Record<ReferenceAngle, { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 0 },
  "slight-left": { yaw: 0.35, pitch: 0 },
  "slight-right": { yaw: -0.35, pitch: 0 },
  "slight-up": { yaw: 0, pitch: 0.28 },
  "slight-down": { yaw: 0, pitch: -0.28 },
};

/**
 * Which bucket a frame belongs to, or none.
 *
 * Yaw is considered before pitch: a head that is both turned and tilted reads
 * primarily as turned, and horizontal coverage is what a renderer most needs.
 * Returning null is a real answer — a frame at an extreme angle belongs in no
 * bucket rather than being forced into the nearest one.
 */
export function classifyAngle(face: DerivedFaceGeometry): ReferenceAngle | null {
  const { yaw, pitch } = face;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;

  if (Math.abs(yaw) > CLASSIFICATION.maxUsableYaw) return null;
  if (Math.abs(pitch) > CLASSIFICATION.maxUsablePitch) return null;

  if (Math.abs(yaw) >= CLASSIFICATION.minSideYaw) {
    // Positive yaw is the subject turning towards their own left.
    return yaw > 0 ? "slight-left" : "slight-right";
  }

  if (Math.abs(pitch) >= CLASSIFICATION.minVerticalPitch) {
    // Positive pitch is the head tilted back, which is looking up.
    return pitch > 0 ? "slight-up" : "slight-down";
  }

  if (Math.abs(yaw) <= CLASSIFICATION.frontYaw && Math.abs(pitch) <= CLASSIFICATION.frontPitch) {
    return "front";
  }

  // Between the front envelope and the side threshold: a real angle, but not
  // one of the five this bank is organised by.
  return null;
}

export interface CandidateInput {
  timestampSeconds: number;
  face: DerivedFaceGeometry;
  pose: PoseDerivedGeometry | null;
}

export type CandidateRejection =
  | "invalid-geometry"
  | "face-too-small"
  | "face-at-edge"
  | "extreme-angle"
  | "no-bucket";

/**
 * Whether a sampled frame may compete at all.
 *
 * Deliberately strict. One terrible frame does not belong in the bank merely
 * because the sampler happened to land on it: a renderer asked for "the left
 * reference" gets whatever is there, and a half-cropped face at the edge of
 * frame would be handed over as though it were a considered choice.
 */
export function screenCandidate(candidate: CandidateInput): CandidateRejection | null {
  const face = candidate.face;

  if (
    !Number.isFinite(face.scale) ||
    !Number.isFinite(face.yaw) ||
    !Number.isFinite(face.pitch) ||
    !Number.isFinite(face.roll) ||
    !Number.isFinite(face.center.x) ||
    !Number.isFinite(face.center.y)
  ) {
    return "invalid-geometry";
  }

  if (face.scale < SOURCE_RULES.minFaceScale) return "face-too-small";

  const margin = SOURCE_RULES.edgeMargin;
  if (
    face.center.x < margin ||
    face.center.x > 1 - margin ||
    face.center.y < margin ||
    face.center.y > 1 - margin
  ) {
    return "face-at-edge";
  }

  if (Math.abs(face.yaw) > CLASSIFICATION.maxUsableYaw || Math.abs(face.pitch) > CLASSIFICATION.maxUsablePitch) {
    return "extreme-angle";
  }

  if (classifyAngle(face) === null) return "no-bucket";

  return null;
}

/**
 * How good a candidate is for its bucket. Higher wins.
 *
 * Deterministic and explicit, because "best" has to mean something a person can
 * check. Four factors, weighted by how much each affects what a renderer can do
 * with the frame:
 *
 *  - closeness to the bucket's target angle, which is the whole point of the
 *    bucket;
 *  - how centred the face is, since a face at the edge is partly outside the
 *    information the source contains;
 *  - whether both shoulders are there, because a reference without them cannot
 *    contribute upper-body geometry;
 *  - face size, as a proxy for how much detail the frame actually carries.
 */
export function scoreCandidate(candidate: CandidateInput, angle: ReferenceAngle): number {
  const target = TARGET[angle];
  const face = candidate.face;

  // Normalised against the widest miss that could still be in this bucket, so
  // the term stays in 0..1 rather than dominating everything else.
  const yawMiss = Math.abs(face.yaw - target.yaw) / (CLASSIFICATION.maxUsableYaw * 2);
  const pitchMiss = Math.abs(face.pitch - target.pitch) / (CLASSIFICATION.maxUsablePitch * 2);
  const angleScore = Math.max(0, 1 - (yawMiss + pitchMiss));

  const offCentre = Math.hypot(face.center.x - 0.5, face.center.y - 0.5);
  // 0.5 is a corner; anything approaching it is badly framed.
  const framingScore = Math.max(0, 1 - offCentre / 0.5);

  const poseScore = candidate.pose?.trackability === "tracked" ? 1 : candidate.pose?.trackability === "partial" ? 0.5 : 0;

  // Saturating rather than linear: past a comfortable size, more does not help.
  const scaleScore = Math.max(0, Math.min(1, face.scale / SOURCE_RULES.smallFaceScale));

  return angleScore * 0.5 + framingScore * 0.2 + poseScore * 0.2 + scaleScore * 0.1;
}

export interface SelectionResult {
  frames: ReferenceFrame[];
  rejections: Partial<Record<CandidateRejection, number>>;
}

/**
 * Builds the bank.
 *
 * One frame per bucket, and only buckets the source actually fills. A missing
 * angle stays missing: filling `slight-up` with the least-downward frame
 * available would hand a renderer something labelled as an angle the source
 * never contained.
 *
 * At most five entries by construction, which is the answer to keeping fifty
 * near-identical frames — the future renderer needs meaningful alternatives,
 * not a small copy of the video.
 *
 * Ties break on the earlier timestamp, so the same input always gives the same
 * bank.
 */
export function selectReferenceFrames(
  candidates: readonly CandidateInput[],
  build: (candidate: CandidateInput, angle: ReferenceAngle, score: number) => ReferenceFrame,
): SelectionResult {
  const rejections: Partial<Record<CandidateRejection, number>> = {};
  const best = new Map<ReferenceAngle, { candidate: CandidateInput; score: number }>();

  for (const candidate of candidates) {
    const rejection = screenCandidate(candidate);
    if (rejection) {
      rejections[rejection] = (rejections[rejection] ?? 0) + 1;
      continue;
    }

    const angle = classifyAngle(candidate.face);
    if (!angle) {
      rejections["no-bucket"] = (rejections["no-bucket"] ?? 0) + 1;
      continue;
    }

    const score = scoreCandidate(candidate, angle);
    const incumbent = best.get(angle);

    if (
      !incumbent ||
      score > incumbent.score ||
      (score === incumbent.score && candidate.timestampSeconds < incumbent.candidate.timestampSeconds)
    ) {
      best.set(angle, { candidate, score });
    }
  }

  const frames = [...best.entries()]
    .map(([angle, entry]) => build(entry.candidate, angle, entry.score))
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  return { frames, rejections };
}

/** Which angles a bank covers, for the envelope and the results panel. */
export function coveredAngles(frames: readonly ReferenceFrame[]): {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  front: boolean;
  count: number;
} {
  const has = (angle: ReferenceAngle) => frames.some((frame) => frame.angle === angle);
  return {
    front: has("front"),
    left: has("slight-left"),
    right: has("slight-right"),
    up: has("slight-up"),
    down: has("slight-down"),
    count: frames.length,
  };
}
