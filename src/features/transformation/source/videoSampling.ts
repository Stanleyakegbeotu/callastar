/**
 * Which moments of a video to look at.
 *
 * The rule that shapes everything: analysis cost must NOT be proportional to
 * the length of the video. A minute of footage at 30fps is 1800 frames, and at
 * roughly 50ms of face-plus-pose inference each that is a minute and a half of
 * somebody watching a spinner to learn what a dozen frames would have told
 * them.
 *
 * So a bounded number of timestamps is chosen up front, spread across the
 * usable middle of the clip, and that is the entire cost.
 */

export const SAMPLING = {
  /** Fewer than this and a bank cannot offer meaningful alternatives. */
  minSamples: 8,
  /**
   * The ceiling, whatever the duration.
   *
   * Twenty frames is already more head angles than a short clip contains; past
   * that the extra frames are near-duplicates of ones already taken.
   */
  maxSamples: 20,
  /** Roughly one sample per this many seconds, between the bounds above. */
  secondsPerSample: 1.5,
  /**
   * Skipped at each end.
   *
   * The first and last moments of a clip are the ones most likely to catch
   * somebody reaching for the camera, mid-blink, or already walking away.
   */
  edgeTrimFraction: 0.06,
  /** Never trim more than this from either end of a long clip. */
  maxEdgeTrimSeconds: 1.5,
  /** Two samples closer than this are the same moment. */
  minSpacingSeconds: 0.12,
} as const;

/**
 * How many frames to sample for a given duration.
 *
 * Bounded at both ends: a two-second clip still gets enough samples for a
 * bank, and a ten-minute one gets no more than a twenty-second one.
 */
export function sampleCountFor(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  const byDuration = Math.round(durationSeconds / SAMPLING.secondsPerSample);
  return Math.max(SAMPLING.minSamples, Math.min(SAMPLING.maxSamples, byDuration));
}

/**
 * The timestamps themselves.
 *
 * Deterministic: the same duration always produces the same list, so a failing
 * analysis can be reproduced exactly. Evenly spaced across the trimmed middle,
 * with the ends inset rather than sampled — a sample exactly at `duration` is a
 * seek past the last decodable frame on plenty of files.
 *
 * Duplicates are removed rather than tolerated. A very short clip can otherwise
 * produce eight timestamps that round to the same three moments, and the
 * sampler would then spend three quarters of its budget re-analysing one frame.
 */
export function sampleTimestamps(durationSeconds: number): number[] {
  const count = sampleCountFor(durationSeconds);
  if (count === 0) return [];

  const trim = Math.min(durationSeconds * SAMPLING.edgeTrimFraction, SAMPLING.maxEdgeTrimSeconds);
  const start = trim;
  const end = Math.max(start, durationSeconds - trim);
  const span = end - start;

  // A clip too short to trim meaningfully is sampled from its own midpoint
  // outwards rather than refused.
  if (span <= 0) return [Number((durationSeconds / 2).toFixed(3))];

  const timestamps: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // Midpoints of `count` equal slices, so no sample sits on either boundary.
    const position = (index + 0.5) / count;
    timestamps.push(Number((start + span * position).toFixed(3)));
  }

  return dedupeTimestamps(timestamps);
}

/** Removes samples too close together to be different moments. */
export function dedupeTimestamps(timestamps: readonly number[]): number[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const kept: number[] = [];

  for (const timestamp of sorted) {
    if (!Number.isFinite(timestamp) || timestamp < 0) continue;
    const previous = kept[kept.length - 1];
    if (previous !== undefined && timestamp - previous < SAMPLING.minSpacingSeconds) continue;
    kept.push(timestamp);
  }

  return kept;
}
