import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POSE_LANDMARKS } from "./poseGeometry";

/**
 * The pose wrapper, against a stubbed MediaPipe.
 *
 * The concern unique to this tracker is the segmentation mask. MediaPipe's mask
 * objects own WASM memory and must be closed; a per-frame loop that retained
 * them would leak steadily until the tab died. That is not observable from a
 * browser test, so it is pinned here — every mask handed in must come back
 * closed, including on the frame that throws.
 */

interface StubMask {
  width: number;
  height: number;
  hasUint8Array: boolean;
  close: ReturnType<typeof vi.fn>;
}

interface StubTask {
  detectForVideo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let created: StubTask[] = [];
let createOptions: unknown[] = [];
let nextResult: unknown = {};
let createDelayMs = 0;
let issuedMasks: StubMask[] = [];

vi.mock("../loaders", () => ({
  loadMediaPipeVision: async () => ({
    FilesetResolver: { forVisionTasks: async (base: string) => ({ base }) },
    PoseLandmarker: {
      createFromOptions: async (_fileset: unknown, options: unknown) => {
        createOptions.push(options);
        if (createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
        const task: StubTask = { detectForVideo: vi.fn(() => nextResult), close: vi.fn() };
        created.push(task);
        return task;
      },
    },
  }),
}));

vi.mock("../modelAssets", () => ({
  transformationModelAssets: {
    faceLandmarker: "/transformation/models/face_landmarker.task",
    poseLandmarker: "/transformation/models/pose_landmarker_lite.task",
    imageSegmenter: null,
  },
  transformationWasmBasePath: "/transformation/wasm/1.0.1",
}));

const { PoseTracker } = await import("./poseTracker");
const { MonotonicClock } = await import("./monotonicClock");

function makeMask(): StubMask {
  const mask: StubMask = { width: 256, height: 256, hasUint8Array: true, close: vi.fn() };
  issuedMasks.push(mask);
  return mask;
}

/** 33 landmarks describing an upright person. */
function poseResult(options: { withMask?: boolean; withWorld?: boolean } = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  landmarks[POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.4, z: 0, visibility: 0.98 };
  landmarks[POSE_LANDMARKS.rightShoulder] = { x: 0.38, y: 0.4, z: 0, visibility: 0.97 };
  landmarks[POSE_LANDMARKS.leftHip] = { x: 0.58, y: 0.75, z: 0, visibility: 0.9 };
  landmarks[POSE_LANDMARKS.rightHip] = { x: 0.42, y: 0.75, z: 0, visibility: 0.9 };

  return {
    landmarks: [landmarks],
    ...(options.withWorld ? { worldLandmarks: [landmarks.map((p) => ({ ...p, z: 0.1 }))] } : {}),
    ...(options.withMask ? { segmentationMasks: [makeMask()] } : {}),
  };
}

const FRAME = {} as CanvasImageSource;

beforeEach(() => {
  created = [];
  createOptions = [];
  issuedMasks = [];
  nextResult = poseResult();
  createDelayMs = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pose tracker setup", () => {
  it("configures single-person video tracking", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    const options = createOptions[0] as Record<string, unknown>;
    expect(options.runningMode).toBe("VIDEO");
    expect(options.numPoses).toBe(1);
    // Off unless asked: it costs work per frame and nothing consumes it yet.
    expect(options.outputSegmentationMasks).toBe(false);

    tracker.dispose();
  });

  it("requests the mask only when asked", async () => {
    const tracker = new PoseTracker({ outputSegmentationMasks: true });
    await tracker.initialize();

    expect((createOptions[0] as Record<string, unknown>).outputSegmentationMasks).toBe(true);
    tracker.dispose();
  });

  it("creates the task once and reuses it", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();
    await tracker.initialize();

    for (let i = 0; i < 5; i += 1) tracker.detect(FRAME, i * 33);

    expect(created).toHaveLength(1);
    expect(created[0]?.detectForVideo).toHaveBeenCalledTimes(5);
    tracker.dispose();
  });

  it("fails clearly when the model has not been fetched", async () => {
    vi.resetModules();
    vi.doMock("../modelAssets", () => ({
      transformationModelAssets: { faceLandmarker: null, poseLandmarker: null, imageSegmenter: null },
      transformationWasmBasePath: "/transformation/wasm/1.0.1",
    }));

    const { PoseTracker: Unconfigured } = await import("./poseTracker");
    await expect(new Unconfigured().initialize()).rejects.toThrow(/assets:transformation/);
    vi.doUnmock("../modelAssets");
  });
});

describe("pose tracker results", () => {
  it("normalises a tracked pose into the CallaStar contract", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    const result = tracker.detect(FRAME, 100);

    expect(result.status).toBe("tracked");
    expect(result.detected).toBe(true);
    expect(result.landmarks).toHaveLength(33);
    expect(result.derived?.trackability).toBe("tracked");
    expect(result.derived?.shoulderWidth).toBeGreaterThan(0);
    expect(result.derived?.visibility).toBeGreaterThan(0.9);

    tracker.dispose();
  });

  it("copies landmarks out of MediaPipe's reused buffers", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    const source = poseResult({ withWorld: true });
    nextResult = source;
    const result = tracker.detect(FRAME, 100);

    source.landmarks[0]![POSE_LANDMARKS.leftShoulder] = { x: 999, y: 999, z: 999, visibility: 0 };
    source.worldLandmarks![0]![0] = { x: 999, y: 999, z: 999, visibility: 0 };

    expect(result.landmarks[POSE_LANDMARKS.leftShoulder]?.x, "landmarks must be copied").toBe(0.62);
    expect(result.worldLandmarks[0]?.x, "world landmarks must be copied").toBe(0.5);

    tracker.dispose();
  });

  it("reports no pose without treating it as an error", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    nextResult = { landmarks: [] };
    const result = tracker.detect(FRAME, 100);

    expect(result.status).toBe("no-pose");
    expect(result.detected).toBe(false);
    expect(result.derived).toBeNull();

    tracker.dispose();
  });

  it("reports a partial pose rather than failing", async () => {
    // Somebody half out of frame is an ordinary moment, not an exception.
    const tracker = new PoseTracker();
    await tracker.initialize();

    const partial = poseResult();
    partial.landmarks[0]![POSE_LANDMARKS.leftShoulder] = { x: 0.62, y: 0.4, z: 0, visibility: 0.1 };
    nextResult = partial;

    const result = tracker.detect(FRAME, 100);
    expect(result.status).toBe("tracked");
    expect(result.derived?.trackability).toBe("partial");
    expect(result.derived?.leftShoulder).toBeNull();

    tracker.dispose();
  });

  it("survives a frame MediaPipe throws on", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    created[0]!.detectForVideo.mockImplementationOnce(() => {
      throw new Error("decode failed");
    });

    expect(() => tracker.detect(FRAME, 100)).not.toThrow();
    expect(tracker.detect(FRAME, 200).status).toBe("tracked");

    tracker.dispose();
  });
});

describe("segmentation mask ownership", () => {
  it("describes a mask and closes it within the same call", async () => {
    /*
     * The leak this prevents.
     *
     * Mask objects own WASM memory. A per-frame loop retaining them would grow
     * until the tab died, and nothing in the UI would show it happening.
     */
    const tracker = new PoseTracker({ outputSegmentationMasks: true });
    await tracker.initialize();

    nextResult = poseResult({ withMask: true });
    const result = tracker.detect(FRAME, 100);

    expect(result.segmentation.available).toBe(true);
    expect(result.segmentation.width).toBe(256);
    expect(result.segmentation.representation).toBe("uint8");

    expect(issuedMasks).toHaveLength(1);
    expect(issuedMasks[0]?.close, "the mask must be closed before the call returns").toHaveBeenCalledTimes(1);

    tracker.dispose();
  });

  it("closes a mask on every frame, not just the first", async () => {
    const tracker = new PoseTracker({ outputSegmentationMasks: true });
    await tracker.initialize();

    for (let i = 0; i < 5; i += 1) {
      nextResult = poseResult({ withMask: true });
      tracker.detect(FRAME, i * 33);
    }

    expect(issuedMasks).toHaveLength(5);
    for (const [index, mask] of issuedMasks.entries()) {
      expect(mask.close, `mask ${index} must be closed`).toHaveBeenCalledTimes(1);
    }

    tracker.dispose();
  });

  it("closes the mask even when the frame throws afterwards", async () => {
    // A mask stranded by an exception leaks exactly as badly as one retained.
    const tracker = new PoseTracker({ outputSegmentationMasks: true });
    await tracker.initialize();

    const mask = makeMask();
    created[0]!.detectForVideo.mockImplementationOnce(() => {
      const result = { segmentationMasks: [mask] };
      // Landmarks access throws, after the mask exists.
      Object.defineProperty(result, "landmarks", {
        get() {
          throw new Error("result read failed");
        },
      });
      return result;
    });

    const result = tracker.detect(FRAME, 100);
    expect(result.status).toBe("skipped");
    expect(mask.close, "a stranded mask must still be closed").toHaveBeenCalled();

    tracker.dispose();
  });

  it("reports no mask when the model was not asked for one", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    const result = tracker.detect(FRAME, 100);
    expect(result.segmentation.available).toBe(false);
    expect(result.segmentation.width).toBeNull();

    tracker.dispose();
  });
});

describe("timestamps", () => {
  it("never hands MediaPipe a repeated or regressing timestamp", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();

    tracker.detect(FRAME, 1000);
    tracker.detect(FRAME, 1000);
    tracker.detect(FRAME, 5);
    tracker.detect(FRAME, 1001);

    const stamps = created[0]!.detectForVideo.mock.calls.map((call) => call[1] as number);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }

    tracker.dispose();
  });

  it("shares a clock with the face tracker when one is supplied", async () => {
    // Both models see the same frame in Milestone 4 and must agree about when.
    const shared = new MonotonicClock();
    const tracker = new PoseTracker({}, shared);
    await tracker.initialize();

    shared.next(5000);
    const result = tracker.detect(FRAME, 100);

    expect(result.timestampMs, "the shared clock must not go backwards").toBeGreaterThan(5000);
    tracker.dispose();
  });
});

describe("disposal", () => {
  it("closes the task and refuses further work", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();
    tracker.dispose();

    expect(created[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracker.ready).toBe(false);
    expect(tracker.detect(FRAME, 100).status).toBe("skipped");
  });

  it("is idempotent", async () => {
    const tracker = new PoseTracker();
    await tracker.initialize();
    tracker.dispose();
    tracker.dispose();
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("closes a task that finishes building after disposal", async () => {
    createDelayMs = 30;
    const tracker = new PoseTracker();
    const pending = tracker.initialize();

    tracker.dispose();
    await pending;

    expect(created[0]?.close, "a task completed after disposal must still be closed").toHaveBeenCalledTimes(1);
    expect(tracker.ready).toBe(false);
  });

  it("refuses to initialise after disposal", async () => {
    const tracker = new PoseTracker();
    tracker.dispose();
    await expect(tracker.initialize()).rejects.toThrow(/disposed/i);
  });
});
