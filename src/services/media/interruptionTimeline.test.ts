import { describe, expect, it } from "vitest";
import { formatTimelineTime, isInsideInterruption, normalizeInterruptions } from "./interruptionTimeline";

describe("source interruption timeline", () => {
  it("sorts and merges overlapping or touching markers deterministically", () => {
    expect(normalizeInterruptions([
      { startMs: 8000, endMs: 10000 },
      { startMs: 5000, endMs: 8000 },
      { startMs: 7000, endMs: 9000 },
    ], 20000)).toEqual([{ startMs: 5000, endMs: 10000, type: "connection" }]);
  });

  it("rejects negative, empty, reversed and over-duration ranges", () => {
    for (const range of [
      { startMs: -1, endMs: 100 },
      { startMs: 100, endMs: 100 },
      { startMs: 200, endMs: 100 },
      { startMs: 100, endMs: 20001 },
    ]) expect(() => normalizeInterruptions([range], 20000)).toThrow();
  });

  it("uses inclusive start and exclusive end boundaries", () => {
    const ranges = [{ startMs: 5000, endMs: 7000 }];
    expect(isInsideInterruption(4999, ranges)).toBe(false);
    expect(isInsideInterruption(5000, ranges)).toBe(true);
    expect(isInsideInterruption(6999, ranges)).toBe(true);
    expect(isInsideInterruption(7000, ranges)).toBe(false);
  });

  it("formats media positions to milliseconds", () => {
    expect(formatTimelineTime(5123)).toBe("00:05.123");
    expect(formatTimelineTime(125678)).toBe("02:05.678");
  });
});
