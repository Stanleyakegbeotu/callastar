import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  QUALITY_PRESETS,
  TrackingScheduler,
  type SchedulableTracker,
  type TrackingSnapshot,
} from "./trackingScheduler";
import type { FaceTrackingResult } from "./faceTypes";
import type { PoseTrackingResult } from "./poseTypes";

/**
 * The frame loop.
 *
 * Driven by a fake `requestVideoFrameCallback` so frames can be delivered one at
 * a time and the loop's decisions inspected. What matters here is that there is
 * exactly one owner, that work is dropped rather than queued when inference is
 * slow, and that pause, resume and disposal leave nothing running — a loop still
 * inferring after the operator left the Studio would hold the camera and drain
 * the battery with nothing on screen.
 */

type FrameCallback = (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void;

/**
 * A video element whose frame callbacks the test delivers by hand.
 *
 * `replay` re-invokes the most recently requested callback without going through
 * the queue. That is how a frame arriving mid-inference is simulated: the real
 * API hands each callback out once, so a synchronous tracker can never see it
 * happen, but a worker-backed one would.
 */
function makeVideo() {
  const pending = new Map<number, FrameCallback>();
  let nextHandle = 1;
  let lastRequested: FrameCallback | null = null;

  const video = {
    requestVideoFrameCallback(callback: FrameCallback) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      lastRequested = callback;
      return handle;
    },
    cancelVideoFrameCallback(handle: number) {
      pending.delete(handle);
    },
  };

  return {
    video: video as unknown as HTMLVideoElement,
    /** Delivers one frame to whatever callback is currently queued. */
    deliver(mediaTimeSeconds: number, presentedFrames?: number): boolean {
      const entry = [...pending.entries()][0];
      if (!entry) return false;
      const [handle, callback] = entry;
      pending.delete(handle);
      callback(mediaTimeSeconds * 1000, { mediaTime: mediaTimeSeconds, presentedFrames });
      return true;
    },
    /** Fires the last-requested callback again, queue untouched. */
    replay(mediaTimeSeconds: number, presentedFrames?: number): void {
      lastRequested?.(mediaTimeSeconds * 1000, { mediaTime: mediaTimeSeconds, presentedFrames });
    },
    get queued() {
      return pending.size;
    },
  };
}

/** Typed parameters, so the assertions can read back the frame and timestamp. */
function makeTracker<T>(result: T) {
  const detect = vi.fn((_frame: CanvasImageSource, _timestampMs: number, _frameId?: number) => result);
  return { tracker: { ready: true, detect } as unknown as SchedulableTracker<T>, detect };
}

function idleTracker<T>() {
  const detect = vi.fn((_frame: CanvasImageSource, _timestampMs: number, _frameId?: number) => undefined as T);
  return { tracker: { ready: false, detect } as unknown as SchedulableTracker<T>, detect };
}

const FACE = { status: "tracked", detected: true } as unknown as FaceTrackingResult;
const POSE = { status: "tracked", detected: true } as unknown as PoseTrackingResult;
const FRAME = {} as CanvasImageSource;

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(options: { faceInterval?: number; poseInterval?: number } = {}) {
  const harness = makeVideo();
  const face = makeTracker(FACE);
  const pose = makeTracker(POSE);
  const updates: TrackingSnapshot[] = [];

  const scheduler = new TrackingScheduler({
    face: face.tracker,
    pose: pose.tracker,
    prepareFrame: () => FRAME,
    onUpdate: (snapshot) => updates.push(snapshot),
    cadence: {
      trackingSize: 480,
      faceInterval: options.faceInterval ?? 1,
      poseInterval: options.poseInterval ?? 1,
    },
    now,
  });

  return { harness, face, pose, updates, scheduler };
}

describe("single frame owner", () => {
  it("stamps both models with one camera-frame id and media timestamp", () => {
    const { harness, scheduler, face, pose, updates } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.125, 1);
    expect(face.detect.mock.calls[0]?.[1]).toBe(125);
    expect(pose.detect.mock.calls[0]?.[1]).toBe(125);
    expect(face.detect.mock.calls[0]?.[2]).toBe(1);
    expect(pose.detect.mock.calls[0]?.[2]).toBe(1);
    expect(updates[0]?.face?.frameId).toBe(1);
    expect(updates[0]?.pose?.frameId).toBe(1);
    scheduler.dispose();
  });

  it("counts camera frames skipped while synchronous inference occupies the main thread", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.1, 10);
    harness.deliver(0.2, 13);
    const stats = scheduler.getStats();
    expect(stats.cameraFrames).toBe(4);
    expect(stats.cameraCallbacks).toBe(2);
    expect(stats.droppedInputFrames).toBe(2);
    expect(stats.droppedTrackingFrames).toBe(0);
    expect(stats.cameraTimestampMs).toBe(200);
    scheduler.dispose();
  });

  it("keeps exactly one frame callback outstanding", () => {
    // Two loops racing for the same GPU is the failure this prevents.
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);

    expect(harness.queued).toBe(1);

    harness.deliver(0.1);
    expect(harness.queued, "one frame in flight at a time").toBe(1);

    harness.deliver(0.2);
    expect(harness.queued).toBe(1);

    scheduler.dispose();
  });

  it("ignores a repeated start rather than opening a second loop", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);
    scheduler.start(harness.video);

    expect(harness.queued).toBe(1);
    scheduler.dispose();
  });

  it("runs both trackers from the one loop, on the same frame", () => {
    const { harness, face, pose, scheduler } = setup();
    scheduler.start(harness.video);

    harness.deliver(0.1);

    expect(face.detect).toHaveBeenCalledTimes(1);
    expect(pose.detect).toHaveBeenCalledTimes(1);

    expect(face.detect.mock.calls[0]?.[0]).toBe(FRAME);
    expect(pose.detect.mock.calls[0]?.[0]).toBe(FRAME);
    // One clock: two trackers disagreeing about "now" is how overlays drift
    // apart from each other.
    expect(face.detect.mock.calls[0]?.[1]).toBe(pose.detect.mock.calls[0]?.[1]);

    scheduler.dispose();
  });

  it("uses the frame's own presentation time, not the wall clock", () => {
    const { harness, face, scheduler } = setup();
    clock = 9999;
    scheduler.start(harness.video);

    harness.deliver(0.25);
    expect(face.detect.mock.calls[0]?.[1]).toBe(250);

    scheduler.dispose();
  });
});

describe("cadence", () => {
  it("runs pose less often than face", () => {
    // Shoulders move slowly compared with a blink, and pose costs about as much
    // per inference.
    const { harness, face, pose, scheduler } = setup({ faceInterval: 1, poseInterval: 3 });
    scheduler.start(harness.video);

    for (let i = 1; i <= 6; i += 1) harness.deliver(i * 0.033);

    expect(face.detect).toHaveBeenCalledTimes(6);
    expect(pose.detect).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it("can skip face frames too", () => {
    const { harness, face, scheduler } = setup({ faceInterval: 2, poseInterval: 6 });
    scheduler.start(harness.video);

    for (let i = 1; i <= 6; i += 1) harness.deliver(i * 0.033);
    expect(face.detect).toHaveBeenCalledTimes(3);

    scheduler.dispose();
  });

  it("changes cadence mid-session without disturbing the trackers", () => {
    // Switching quality mode must not reload models — that costs seconds.
    const { harness, face, pose, scheduler } = setup({ faceInterval: 1, poseInterval: 1 });
    scheduler.start(harness.video);
    harness.deliver(0.033);

    scheduler.setCadence(QUALITY_PRESETS.performance);
    expect(scheduler.getCadence()).toEqual(QUALITY_PRESETS.performance);

    for (let i = 2; i <= 7; i += 1) harness.deliver(i * 0.033);

    // frameIndex 2..7 under faceInterval 2 / poseInterval 6: face on 2, 4 and 6;
    // pose on 6 alone.
    expect(face.detect).toHaveBeenCalledTimes(1 + 3);
    expect(pose.detect).toHaveBeenCalledTimes(1 + 1);

    scheduler.dispose();
  });

  it("publishes an update every frame, even when neither model ran", () => {
    // Otherwise the overlay flickers off on the frames that skipped inference.
    const { harness, updates, scheduler } = setup({ faceInterval: 3, poseInterval: 3 });
    scheduler.start(harness.video);

    for (let i = 1; i <= 4; i += 1) harness.deliver(i * 0.033);
    expect(updates).toHaveLength(4);
    // The last result is held between inferences rather than going null.
    expect(updates[3]?.face?.status).toBe(FACE.status);
    expect(updates[3]?.face?.frameId).toBe(updates[2]?.face?.frameId);

    scheduler.dispose();
  });
});

describe("drop policy", () => {
  it("drops a frame that arrives mid-inference instead of queueing it", () => {
    /*
     * Real-time tracking wants the LATEST frame, not every frame. Queueing
     * builds latency that never recovers — on a phone it becomes a preview
     * running visibly behind the person in it.
     */
    const harness = makeVideo();

    let reentered = false;
    const detect = vi.fn((_frame: CanvasImageSource, _timestampMs: number) => {
      if (!reentered) {
        reentered = true;
        // A second frame lands while this inference is still running.
        harness.replay(0.2);
      }
      return FACE;
    });

    const scheduler = new TrackingScheduler({
      face: { ready: true, detect } as unknown as SchedulableTracker<FaceTrackingResult>,
      pose: idleTracker<PoseTrackingResult>().tracker,
      prepareFrame: () => FRAME,
      onUpdate: () => {},
      now,
    });

    scheduler.start(harness.video);
    harness.deliver(0.1);

    const stats = scheduler.getStats();
    expect(stats.droppedFrames).toBe(1);
    expect(stats.cameraFrames).toBe(2);
    expect(stats.trackingFrames).toBe(1);
    expect(detect, "the dropped frame must not start a second inference").toHaveBeenCalledTimes(1);
    // And the drop must not leave a second callback armed.
    expect(harness.queued).toBe(1);

    scheduler.dispose();
  });

  it("counts camera frames separately from tracking frames", () => {
    const { harness, scheduler } = setup({ faceInterval: 2, poseInterval: 4 });
    scheduler.start(harness.video);

    for (let i = 1; i <= 4; i += 1) harness.deliver(i * 0.033);

    const stats = scheduler.getStats();
    expect(stats.cameraFrames).toBe(4);
    expect(stats.trackingFrames).toBe(2);
    expect(stats.faceInferences).toBe(2);
    expect(stats.poseInferences).toBe(1);
    expect(stats.droppedFrames).toBe(0);

    scheduler.dispose();
  });

  it("skips a frame the studio could not prepare, without stalling", () => {
    // The video has no dimensions yet, or the canvas is not ready.
    const harness = makeVideo();
    const face = makeTracker(FACE);

    const scheduler = new TrackingScheduler({
      face: face.tracker,
      pose: idleTracker<PoseTrackingResult>().tracker,
      prepareFrame: () => null,
      onUpdate: () => {},
      now,
    });

    scheduler.start(harness.video);
    harness.deliver(0.1);

    expect(face.detect).not.toHaveBeenCalled();
    expect(harness.queued, "the loop must keep going").toBe(1);

    scheduler.dispose();
  });

  it("does not run a tracker that is not ready", () => {
    const harness = makeVideo();
    const face = makeTracker(FACE);
    const pose = idleTracker<PoseTrackingResult>();

    const scheduler = new TrackingScheduler({
      face: face.tracker,
      pose: pose.tracker,
      prepareFrame: () => FRAME,
      onUpdate: () => {},
      now,
    });

    scheduler.start(harness.video);
    harness.deliver(0.1);

    expect(face.detect).toHaveBeenCalled();
    expect(pose.detect, "an uninitialised tracker must be skipped").not.toHaveBeenCalled();

    scheduler.dispose();
  });
});

describe("pause and resume", () => {
  it("stops inference and leaves nothing scheduled", () => {
    const { harness, face, scheduler } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.1);

    scheduler.pause();

    expect(scheduler.isRunning).toBe(false);
    expect(harness.queued, "pausing must leave no frame callback outstanding").toBe(0);
    expect(face.detect).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it("resumes the same session rather than restarting it", () => {
    const { harness, face, scheduler } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.1);
    scheduler.pause();

    scheduler.resume();
    expect(scheduler.isRunning).toBe(true);
    expect(harness.queued).toBe(1);

    harness.deliver(0.2);
    expect(face.detect).toHaveBeenCalledTimes(2);
    // Counters continue: the session did not restart.
    expect(scheduler.getStats().cameraFrames).toBe(2);

    scheduler.dispose();
  });

  it("ignores pause when it was never started", () => {
    const { scheduler } = setup();
    expect(() => scheduler.pause()).not.toThrow();
    expect(scheduler.isRunning).toBe(false);
  });

  it("ignores resume when it was never started", () => {
    // Nothing to resume, and no video to resume against.
    const { scheduler } = setup();
    scheduler.resume();
    expect(scheduler.isRunning).toBe(false);
  });

  it("ignores a repeated pause", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);
    scheduler.pause();
    expect(() => scheduler.pause()).not.toThrow();
    expect(harness.queued).toBe(0);
  });
});

describe("camera flip", () => {
  it("swaps the video element without reloading the models", () => {
    const { harness, face, scheduler } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.1);

    const replacement = makeVideo();
    scheduler.setVideo(replacement.video);

    // The callback already armed belongs to the old element; once it fires the
    // loop re-arms against the new one.
    harness.deliver(0.2);
    expect(replacement.queued).toBe(1);

    replacement.deliver(0.3);
    expect(face.detect).toHaveBeenCalledTimes(3);

    scheduler.dispose();
  });
});

describe("disposal", () => {
  it("stops the loop and refuses to restart", () => {
    const { harness, face, scheduler } = setup();
    scheduler.start(harness.video);
    harness.deliver(0.1);

    scheduler.dispose();

    expect(harness.queued).toBe(0);
    expect(scheduler.isRunning).toBe(false);

    scheduler.resume();
    scheduler.start(harness.video);
    expect(harness.queued, "a disposed scheduler must not restart").toBe(0);
    expect(face.detect).toHaveBeenCalledTimes(1);
  });

  it("ignores a frame callback that fires after disposal", () => {
    /*
     * The late callback.
     *
     * A frame already in flight when the operator leaves the Studio will still
     * fire on some browsers. It must do nothing — inference against a disposed
     * MediaPipe task, or a React update against an unmounted tree, both start
     * here.
     */
    const harness = makeVideo();
    const face = makeTracker(FACE);
    const updates: TrackingSnapshot[] = [];

    const scheduler = new TrackingScheduler({
      face: face.tracker,
      pose: idleTracker<PoseTrackingResult>().tracker,
      prepareFrame: () => FRAME,
      onUpdate: (snapshot) => updates.push(snapshot),
      now,
    });

    scheduler.start(harness.video);
    scheduler.dispose();

    // Cancelled, so nothing is left in the queue...
    expect(harness.deliver(0.1)).toBe(false);
    // ...and firing it anyway changes nothing.
    harness.replay(0.1);

    expect(face.detect).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("is idempotent", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);
    scheduler.dispose();
    expect(() => scheduler.dispose()).not.toThrow();
  });
});

describe("statistics", () => {
  it("reports nothing rather than fabricating a zero before measuring", () => {
    const { scheduler } = setup();
    const initial = scheduler.getStats();

    expect(initial.faceAverageMs).toBeNull();
    expect(initial.poseAverageMs).toBeNull();
    expect(initial.loopAverageMs).toBeNull();
    expect(initial.cameraFps).toBeNull();
  });

  it("measures once frames have run", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);
    clock = 10;
    harness.deliver(0.1);

    const stats = scheduler.getStats();
    expect(Number.isFinite(stats.faceAverageMs ?? Number.NaN)).toBe(true);
    expect(stats.cameraFps).toBe(1);

    scheduler.dispose();
  });

  it("keeps rates over a sliding window rather than growing forever", () => {
    const { harness, scheduler } = setup();
    scheduler.start(harness.video);

    for (let i = 1; i <= 5; i += 1) {
      clock = i * 10;
      harness.deliver(i * 0.033);
    }
    expect(scheduler.getStats().cameraFps).toBe(5);

    // Two seconds later those marks have aged out; the counter does not retain
    // every frame of a long session.
    clock = 3000;
    expect(scheduler.getStats().cameraFps).toBeNull();

    scheduler.dispose();
  });
});
