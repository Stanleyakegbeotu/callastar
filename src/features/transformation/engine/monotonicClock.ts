/**
 * Strictly increasing timestamps for MediaPipe video inference.
 *
 * `detectForVideo` throws on a repeated or regressing timestamp, and the values
 * a live studio produces are not naturally monotonic: a camera flip restarts
 * `video.currentTime` at zero, a pause and resume can replay one, and two
 * callbacks in the same millisecond are ordinary at 60Hz.
 *
 * Shared by the face and pose trackers rather than duplicated. In Milestone 4
 * both run over the same frame, and they must agree about when that frame was —
 * two independent clocks would let their results drift apart by a millisecond
 * that nothing could reconcile. Each MediaPipe task still tracks its own last
 * value internally, so handing both the same stamp is correct.
 */
export class MonotonicClock {
  private last = 0;
  private lastFrameId: number | null = null;

  /**
   * The next usable timestamp.
   *
   * Returns the requested value when it genuinely advances, and otherwise the
   * smallest value that does. The caller is told what was used, so anything
   * downstream reasons about the timeline MediaPipe actually saw rather than the
   * one the camera claimed.
   */
  next(requestedMs: number, frameId?: number): number {
    if (frameId !== undefined && frameId === this.lastFrameId) return this.last;
    const usable = Number.isFinite(requestedMs) && requestedMs > this.last ? requestedMs : this.last + 1;
    this.last = usable;
    this.lastFrameId = frameId ?? null;
    return usable;
  }

  /** The most recent stamp issued. */
  get current(): number {
    return this.last;
  }

  /**
   * Deliberately absent: there is no reset.
   *
   * Rewinding would reintroduce exactly the regression this exists to prevent —
   * a camera flip is the obvious case, and it is also the one most likely to
   * tempt a reset. The clock only ever moves forward, for the life of the
   * session.
   */
}
