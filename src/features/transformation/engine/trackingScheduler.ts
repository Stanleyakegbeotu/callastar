import type { FaceTrackingResult } from "./faceTypes";
import type { PoseTrackingResult } from "./poseTypes";

/**
 * The single owner of the live frame loop.
 *
 * Exactly one scheduler drives both trackers. Letting each model run its own
 * loop would mean two callbacks racing for the same GPU, two different ideas of
 * what "now" is, and no way to say "skip pose this frame" — so they are driven
 * from here, off one clock, with one drop policy.
 *
 * The drop policy is the important part. Real-time tracking wants the LATEST
 * frame, not every frame: queueing work behind a slow inference builds latency
 * that never recovers, and on a phone it turns into a preview running visibly
 * behind the person in it. A frame that arrives while inference is still running
 * is counted and discarded.
 */

export type QualityMode = "performance" | "balanced" | "quality";

export interface SchedulerCadence {
  /** Longest edge of the frame handed to the models, in pixels. */
  trackingSize: number;
  /** Run the face model every Nth scheduled frame. 1 is every frame. */
  faceInterval: number;
  /**
   * Run the pose model every Nth scheduled frame.
   *
   * Higher than the face's because shoulders move slowly compared with a blink,
   * and pose costs about as much per inference. These are starting points to be
   * tuned against real hardware, not measured conclusions.
   */
  poseInterval: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityMode, SchedulerCadence>> = {
  performance: { trackingSize: 320, faceInterval: 2, poseInterval: 6 },
  balanced: { trackingSize: 480, faceInterval: 1, poseInterval: 3 },
  quality: { trackingSize: 640, faceInterval: 1, poseInterval: 2 },
};

export interface SchedulerStats {
  /** Camera frames presented since the prior callback (rVFC can coalesce while inference blocks). */
  cameraFrames: number;
  cameraCallbacks: number;
  /** Frames on which at least one model ran. */
  trackingFrames: number;
  /** Frames skipped because inference was still busy. */
  droppedFrames: number;
  droppedInputFrames: number;
  droppedTrackingFrames: number;
  cameraTimestampMs: number | null;
  faceStartMs: number | null;
  faceEndMs: number | null;
  poseStartMs: number | null;
  poseEndMs: number | null;
  cameraToFaceMs: number | null;
  faceInferences: number;
  poseInferences: number;
  /** Rolling averages in ms; null until measured. */
  faceAverageMs: number | null;
  poseAverageMs: number | null;
  loopAverageMs: number | null;
  /** Frames per second, measured over a rolling window. */
  cameraFps: number | null;
  acceptedCameraFps: number | null;
  faceFps: number | null;
  poseFps: number | null;
}

export interface TrackingSnapshot {
  face: FaceTrackingResult | null;
  pose: PoseTrackingResult | null;
  stats: SchedulerStats;
}

/**
 * What the scheduler drives.
 *
 * An interface rather than the concrete trackers, so the scheduler is testable
 * without MediaPipe and so a worker-backed tracker could be substituted later
 * without touching the loop.
 */
export interface SchedulableTracker<TResult> {
  readonly ready: boolean;
  detect(frame: CanvasImageSource, timestampMs: number): TResult;
}

export interface TrackingSchedulerOptions {
  face: SchedulableTracker<FaceTrackingResult>;
  pose: SchedulableTracker<PoseTrackingResult>;
  /** Draws the camera frame at tracking resolution. Supplied by the studio. */
  prepareFrame: (video: HTMLVideoElement) => CanvasImageSource | null;
  onUpdate: (snapshot: TrackingSnapshot) => void;
  cadence?: SchedulerCadence;
  /** Injected in tests; defaults to the browser's own. */
  now?: () => number;
}

/** Keeps a bounded rolling mean without retaining every sample. */
class RollingAverage {
  private readonly samples: number[] = [];

  constructor(private readonly size = 30) {}

  add(value: number): void {
    this.samples.push(value);
    if (this.samples.length > this.size) this.samples.shift();
  }

  get mean(): number | null {
    if (this.samples.length === 0) return null;
    return this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

/** Counts events per second over a sliding window. */
class RateCounter {
  private stamps: number[] = [];

  mark(now: number, count = 1): void {
    for (let i = 0; i < count; i++) this.stamps.push(now);
    const cutoff = now - 1000;
    while (this.stamps.length > 0 && this.stamps[0]! < cutoff) this.stamps.shift();
  }

  rate(now: number): number | null {
    const cutoff = now - 1000;
    while (this.stamps.length > 0 && this.stamps[0]! < cutoff) this.stamps.shift();
    return this.stamps.length === 0 ? null : this.stamps.length;
  }

  clear(): void {
    this.stamps = [];
  }
}

export class TrackingScheduler {
  private video: HTMLVideoElement | null = null;
  private running = false;
  private disposed = false;

  /** Set while inference is in flight; the drop policy keys on it. */
  private busy = false;

  private frameHandle: number | null = null;
  private rafHandle: number | null = null;
  /** True when `requestVideoFrameCallback` is driving the loop. */
  private usingVideoFrameCallback = false;

  private cadence: SchedulerCadence;
  private frameIndex = 0;

  private lastFace: FaceTrackingResult | null = null;
  private lastPose: PoseTrackingResult | null = null;

  private readonly faceMs = new RollingAverage();
  private readonly poseMs = new RollingAverage();
  private readonly loopMs = new RollingAverage();
  private readonly cameraRate = new RateCounter();
  private readonly acceptedCameraRate = new RateCounter();
  private readonly faceRate = new RateCounter();
  private readonly poseRate = new RateCounter();

  private counts = { cameraFrames: 0, cameraCallbacks: 0, trackingFrames: 0, droppedFrames: 0,
    droppedInputFrames: 0, droppedTrackingFrames: 0, faceInferences: 0, poseInferences: 0 };
  private cameraTimestampMs: number | null = null;
  private faceStartMs: number | null = null;
  private faceEndMs: number | null = null;
  private poseStartMs: number | null = null;
  private poseEndMs: number | null = null;
  private cameraToFaceMs: number | null = null;
  private lastPresentedFrames: number | null = null;

  private readonly now: () => number;

  constructor(private readonly options: TrackingSchedulerOptions) {
    this.cadence = options.cadence ?? QUALITY_PRESETS.balanced;
    this.now = options.now ?? (() => performance.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  getStats(): SchedulerStats {
    const now = this.now();
    return {
      ...this.counts,
      faceAverageMs: this.faceMs.mean,
      poseAverageMs: this.poseMs.mean,
      loopAverageMs: this.loopMs.mean,
      cameraFps: this.cameraRate.rate(now),
      acceptedCameraFps: this.acceptedCameraRate.rate(now),
      faceFps: this.faceRate.rate(now),
      poseFps: this.poseRate.rate(now),
      cameraTimestampMs: this.cameraTimestampMs,
      faceStartMs: this.faceStartMs,
      faceEndMs: this.faceEndMs,
      poseStartMs: this.poseStartMs,
      poseEndMs: this.poseEndMs,
      cameraToFaceMs: this.cameraToFaceMs,
    };
  }

  /** Changing quality mid-session keeps the trackers; only cadence changes. */
  setCadence(cadence: SchedulerCadence): void {
    this.cadence = cadence;
  }

  getCadence(): SchedulerCadence {
    return this.cadence;
  }

  start(video: HTMLVideoElement): void {
    if (this.disposed || this.running) return;
    this.video = video;
    this.running = true;
    this.schedule();
  }

  /**
   * Stops inference while leaving the camera alone.
   *
   * Deliberate: the preview staying live while tracking pauses is what makes
   * this useful for debugging, and it drops the expensive half of the load.
   */
  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.cancel();
  }

  resume(): void {
    if (this.disposed || this.running || !this.video) return;
    this.running = true;
    this.schedule();
  }

  /**
   * Swaps the video element without disturbing anything else.
   *
   * A camera flip replaces the track, not the models: reloading MediaPipe for a
   * flip would cost seconds and throw away the session.
   */
  setVideo(video: HTMLVideoElement): void {
    this.video = video;
    // presentedFrames is scoped to one media timeline; a flipped camera may
    // reset it, so the first frame of the new track is a new baseline.
    this.lastPresentedFrames = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.cancel();
    this.video = null;
    this.lastFace = null;
    this.lastPose = null;
    this.faceMs.clear();
    this.poseMs.clear();
    this.loopMs.clear();
    this.cameraRate.clear();
    this.acceptedCameraRate.clear();
    this.faceRate.clear();
    this.poseRate.clear();
  }

  private cancel(): void {
    const video = this.video;
    if (this.frameHandle !== null && video && this.usingVideoFrameCallback) {
      const cancelVideoFrame = (
        video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }
      ).cancelVideoFrameCallback;
      cancelVideoFrame?.call(video, this.frameHandle);
    }
    this.frameHandle = null;

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /**
   * Queues the next frame.
   *
   * `requestVideoFrameCallback` is preferred: it fires once per decoded camera
   * frame, so the loop follows the camera rather than the display. A 30fps
   * camera on a 120Hz screen would otherwise wake four times per frame with
   * nothing new to do.
   */
  private schedule(): void {
    if (!this.running || this.disposed || !this.video) return;

    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void) => number;
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      this.usingVideoFrameCallback = true;
      this.frameHandle = video.requestVideoFrameCallback((_now, metadata) => {
        this.frameHandle = null;
        // `mediaTime` is the frame's own presentation time, which is a truer
        // timestamp for inference than the wall clock.
        this.cameraTimestampMs = metadata?.mediaTime !== undefined ? metadata.mediaTime * 1000 : null;
        const presented = metadata?.presentedFrames;
        const frameDelta = presented !== undefined && this.lastPresentedFrames !== null
          ? Math.max(1, presented - this.lastPresentedFrames)
          : 1;
        if (presented !== undefined) this.lastPresentedFrames = presented;
        this.onFrame(metadata?.mediaTime !== undefined ? metadata.mediaTime * 1000 : this.now(), frameDelta);
      });
      return;
    }

    this.usingVideoFrameCallback = false;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.cameraTimestampMs = null;
      this.onFrame(this.now(), 1);
    });
  }

  private onFrame(timestampMs: number, presentedFrames = 1): void {
    if (!this.running || this.disposed) return;

    const loopStart = this.now();
    this.counts.cameraCallbacks += 1;
    this.counts.cameraFrames += presentedFrames;
    this.cameraRate.mark(loopStart, presentedFrames);
    if (presentedFrames > 1) this.counts.droppedInputFrames += presentedFrames - 1;

    /*
     * The drop.
     *
     * Inference is synchronous in this build, so `busy` can only be true if a
     * callback fired re-entrantly — but the guard is kept because a worker-backed
     * tracker would make it genuinely asynchronous, and the counter is what
     * surfaces a model that cannot keep up.
     */
    if (this.busy) {
      this.counts.droppedFrames += 1;
      this.counts.droppedTrackingFrames += 1;
      // Deliberately does NOT re-arm: `busy` can only be true while an earlier
      // frame is still inside `onFrame`, and that frame's `finally` schedules
      // the next one. Scheduling here as well would leave two callbacks
      // outstanding — the second loop this class exists to prevent.
      return;
    }

    const frame = this.options.prepareFrame(this.video!);
    if (!frame) {
      this.schedule();
      return;
    }

    this.busy = true;
    this.frameIndex += 1;

    try {
      let ranSomething = false;

      if (this.options.face.ready && this.frameIndex % this.cadence.faceInterval === 0) {
        const started = this.now();
        this.faceStartMs = started;
        this.lastFace = this.options.face.detect(frame, timestampMs);
        this.faceEndMs = this.now();
        this.cameraToFaceMs = this.faceEndMs - loopStart;
        this.faceMs.add(this.faceEndMs - started);
        this.counts.faceInferences += 1;
        this.faceRate.mark(started);
        ranSomething = true;
      }

      if (this.options.pose.ready && this.frameIndex % this.cadence.poseInterval === 0) {
        const started = this.now();
        this.poseStartMs = started;
        this.lastPose = this.options.pose.detect(frame, timestampMs);
        this.poseEndMs = this.now();
        this.poseMs.add(this.poseEndMs - started);
        this.counts.poseInferences += 1;
        this.poseRate.mark(started);
        ranSomething = true;
      }

      if (ranSomething) {
        this.counts.trackingFrames += 1;
        this.acceptedCameraRate.mark(loopStart);
        this.loopMs.add(this.now() - loopStart);
      }

      // Published every frame, even when neither model ran, so the overlay
      // keeps drawing the most recent result rather than flickering.
      this.options.onUpdate({ face: this.lastFace, pose: this.lastPose, stats: this.getStats() });
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
