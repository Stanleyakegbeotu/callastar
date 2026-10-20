export interface SourceInterruption {
  startMs: number;
  endMs: number;
  type?: "connection";
}

/** Validate, sort and coalesce touching/overlapping intervals deterministically. */
export function normalizeInterruptions(
  ranges: readonly SourceInterruption[],
  durationMs: number,
): SourceInterruption[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("The source video duration is unavailable.");
  const sorted = ranges.map(({ startMs, endMs }) => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs) {
      throw new Error("Each interruption must start at or after zero and end after its start, within the video duration.");
    }
    return { startMs: Math.round(startMs), endMs: Math.round(endMs), type: "connection" as const };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: SourceInterruption[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push(range);
  }
  return merged;
}

export function isInsideInterruption(timeMs: number, ranges: readonly SourceInterruption[]): boolean {
  return ranges.some((range) => timeMs >= range.startMs && timeMs < range.endMs);
}

export function formatTimelineTime(timeMs: number): string {
  const safe = Math.max(0, timeMs);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = Math.floor(safe % 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
