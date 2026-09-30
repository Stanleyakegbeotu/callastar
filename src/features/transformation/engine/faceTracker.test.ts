import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tracker wrapper, against a stubbed MediaPipe.
 *
 * The real model is exercised in the browser suite; what is tested here is
 * everything around it, which is where the bugs that matter live: creating the
 * task exactly once, never handing MediaPipe a repeated timestamp, dropping
 * frames rather than queueing them, and surviving a disposal that lands while
 * work is still in flight.
 *
 * None of that needs a 3.6 MB model to prove, and none of it is observable from
 * a browser test without a lot of contrivance.
 */

/** Records every call so the test can assert on how MediaPipe was driven. */
interface StubTask {
  detectForVideo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let created: StubTask[] = [];
let createOptions: unknown[] = [];
let nextResult: unknown = {};
let createDelayMs = 0;

vi.mock("../loaders", () => ({
  loadMediaPipeVision: async () => ({
    FilesetResolver: {
      forVisionTasks: async (base: string) => ({ base }),
    },
    FaceLandmarker: {
      createFromOptions: async (_fileset: unknown, options: unknown) => {
        createOptions.push(options);
        if (createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
        const task: StubTask = {
          detectForVideo: vi.fn(() => nextResult),
          close: vi.fn(),
        };
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

const { FaceTracker } = await import("./faceTracker");

/** 478 landmarks describing a plausible forward-facing face. */
function landmarkResult() {
  const faceLandmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  faceLandmarks[1] = { x: 0.5, y: 0.5, z: 0 };
  faceLandmarks[152] = { x: 0.5, y: 0.7, z: 0 };
  faceLandmarks[10] = { x: 0.5, y: 0.3, z: 0 };
  faceLandmarks[234] = { x: 0.35, y: 0.5, z: 0 };
  faceLandmarks[454] = { x: 0.65, y: 0.5, z: 0 };
  faceLandmarks[33] = { x: 0.4, y: 0.45, z: 0 };
  faceLandmarks[133] = { x: 0.46, y: 0.45, z: 0 };
  faceLandmarks[159] = { x: 0.43, y: 0.437, z: 0 };
  faceLandmarks[145] = { x: 0.43, y: 0.464, z: 0 };
  faceLandmarks[263] = { x: 0.6, y: 0.45, z: 0 };
  faceLandmarks[362] = { x: 0.54, y: 0.45, z: 0 };
  faceLandmarks[386] = { x: 0.57, y: 0.437, z: 0 };
  faceLandmarks[374] = { x: 0.57, y: 0.464, z: 0 };
  faceLandmarks[13] = { x: 0.5, y: 0.618, z: 0 };
  faceLandmarks[14] = { x: 0.5, y: 0.622, z: 0 };
  faceLandmarks[61] = { x: 0.44, y: 0.62, z: 0 };
  faceLandmarks[291] = { x: 0.56, y: 0.62, z: 0 };

  return {
    faceLandmarks: [faceLandmarks],
    faceBlendshapes: [
      {
        categories: [
          { categoryName: "jawOpen", score: 0.25 },
          { categoryName: "eyeBlinkLeft", score: 0.05 },
          { categoryName: "eyeBlinkRight", score: 0.04 },
        ],
      },
    ],
    facialTransformationMatrixes: [{ data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
}

/** A frame stand-in; the stub never inspects it. */
const FRAME = {} as CanvasImageSource;

beforeEach(() => {
  created = [];
  createOptions = [];
  nextResult = landmarkResult();
  createDelayMs = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("face tracker setup", () => {
  it("configures the outputs the model was chosen for", async () => {
    // Blendshapes and the transformation matrix are the whole reason this model
    // was selected over a bare mesh; a build without them would silently lose
    // expression and head pose.
    const tracker = new FaceTracker();
    await tracker.initialize();

    const options = createOptions[0] as Record<string, unknown>;
    expect(options.outputFaceBlendshapes).toBe(true);
    expect(options.outputFacialTransformationMatrixes).toBe(true);
    expect(options.runningMode).toBe("VIDEO");
    // One operator, not a crowd: every extra face is another mesh per frame.
    expect(options.numFaces).toBe(1);

    tracker.dispose();
  });

  it("creates the task once and reuses it for every frame", async () => {
    // Creating a MediaPipe task costs a WASM instantiation and a model parse.
    // Doing it per frame is the single most expensive mistake available here.
    const tracker = new FaceTracker();
    await tracker.initialize();
    await tracker.initialize();

    for (let i = 0; i < 5; i += 1) tracker.detect(FRAME, i * 33);

    expect(created).toHaveLength(1);
    expect(created[0]?.detectForVideo).toHaveBeenCalledTimes(5);

    tracker.dispose();
  });

  it("shares one initialisation between concurrent callers", async () => {
    createDelayMs = 20;
    const tracker = new FaceTracker();

    await Promise.all([tracker.initialize(), tracker.initialize(), tracker.initialize()]);

    expect(created).toHaveLength(1);
    tracker.dispose();
  });

  it("fails clearly when the model has not been fetched", async () => {
    vi.resetModules();
    vi.doMock("../modelAssets", () => ({
      transformationModelAssets: { faceLandmarker: null, poseLandmarker: null, imageSegmenter: null },
      transformationWasmBasePath: "/transformation/wasm/1.0.1",
    }));

    const { FaceTracker: Unconfigured } = await import("./faceTracker");
    const tracker = new Unconfigured();

    await expect(tracker.initialize()).rejects.toThrow(/assets:transformation/);
    vi.doUnmock("../modelAssets");
  });
});

describe("face tracker results", () => {
  it("normalises a tracked face into the CallaStar contract", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();

    const result = tracker.detect(FRAME, 100);

    expect(result.status).toBe("tracked");
    expect(result.detected).toBe(true);
    expect(result.landmarks).toHaveLength(478);
    expect(result.confidence).toBeGreaterThan(0);

    // Blendshapes arrive as a name→score map, not MediaPipe's category array.
    expect(result.blendshapes.jawOpen).toBeCloseTo(0.25, 2);
    expect(result.facialTransformationMatrix).toHaveLength(16);
    expect(result.derived).not.toBeNull();

    tracker.dispose();
  });

  it("copies landmarks and the matrix out of MediaPipe's reused buffers", async () => {
    // MediaPipe reuses its result buffers between frames. Holding the originals
    // would mean last frame's data silently changing underneath us.
    const tracker = new FaceTracker();
    await tracker.initialize();

    const source = landmarkResult();
    nextResult = source;
    const result = tracker.detect(FRAME, 100);

    source.faceLandmarks[0]![0] = { x: 999, y: 999, z: 999 };
    source.facialTransformationMatrixes[0]!.data[0] = 999;

    expect(result.landmarks[0]?.x, "landmarks must be copied").toBe(0.5);
    expect(result.facialTransformationMatrix?.[0], "matrix must be copied").toBe(1);

    tracker.dispose();
  });

  it("reports no face without treating it as an error", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();

    nextResult = { faceLandmarks: [] };
    const result = tracker.detect(FRAME, 100);

    expect(result.status).toBe("no-face");
    expect(result.detected).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.landmarks).toHaveLength(0);
    expect(result.derived).toBeNull();

    tracker.dispose();
  });

  it("survives a frame MediaPipe throws on", async () => {
    // A single bad frame must not stop the loop.
    const tracker = new FaceTracker();
    await tracker.initialize();

    created[0]!.detectForVideo.mockImplementationOnce(() => {
      throw new Error("decode failed");
    });

    expect(() => tracker.detect(FRAME, 100)).not.toThrow();
    expect(tracker.detect(FRAME, 200).status, "the next frame still works").toBe("tracked");

    tracker.dispose();
  });

  it("works when the build returns no blendshapes or matrix", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();

    nextResult = { faceLandmarks: landmarkResult().faceLandmarks };
    const result = tracker.detect(FRAME, 100);

    expect(result.status).toBe("tracked");
    expect(result.blendshapes).toEqual({});
    expect(result.facialTransformationMatrix).toBeNull();
    // Pose falls back to the landmark estimate rather than failing.
    expect(result.derived).not.toBeNull();

    tracker.dispose();
  });
});

describe("timestamp ordering", () => {
  it("never hands MediaPipe a repeated or regressing timestamp", async () => {
    /*
     * `detectForVideo` throws on a non-increasing timestamp. A camera flip
     * restarts `video.currentTime` at zero and a pause/resume can replay one,
     * so the caller's value cannot be passed straight through.
     */
    const tracker = new FaceTracker();
    await tracker.initialize();

    tracker.detect(FRAME, 1000);
    tracker.detect(FRAME, 1000); // repeated
    tracker.detect(FRAME, 5); // regressed, as after a camera flip
    tracker.detect(FRAME, 1001);

    const stamps = created[0]!.detectForVideo.mock.calls.map((call) => call[1] as number);
    expect(stamps).toHaveLength(4);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]!, `stamp ${i} must exceed ${stamps[i - 1]}`).toBeGreaterThan(stamps[i - 1]!);
    }

    tracker.dispose();
  });

  it("reports the corrected timestamp back to the caller", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();

    tracker.detect(FRAME, 1000);
    const corrected = tracker.detect(FRAME, 5);

    // The result carries the stamp actually used, so downstream smoothing is
    // not working from a timeline MediaPipe never saw.
    expect(corrected.timestampMs).toBeGreaterThan(1000);

    tracker.dispose();
  });
});

describe("disposal", () => {
  it("closes the task and refuses further work", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();
    tracker.dispose();

    expect(created[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracker.ready).toBe(false);

    const result = tracker.detect(FRAME, 100);
    expect(result.status).toBe("skipped");
    expect(result.detected).toBe(false);
  });

  it("is idempotent, because teardown and unmount both arrive", async () => {
    // And under StrictMode they arrive twice.
    const tracker = new FaceTracker();
    await tracker.initialize();

    tracker.dispose();
    tracker.dispose();

    expect(created[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("closes a task that finishes building after disposal", async () => {
    /*
     * Disposal routinely lands mid-initialisation — an operator leaving the
     * Studio while the model is still loading. Without this the WASM instance
     * would be built and then leaked with nothing holding a reference.
     */
    createDelayMs = 30;
    const tracker = new FaceTracker();
    const pending = tracker.initialize();

    tracker.dispose();
    await pending;

    expect(created).toHaveLength(1);
    expect(created[0]?.close, "a task completed after disposal must still be closed").toHaveBeenCalledTimes(1);
    expect(tracker.ready).toBe(false);
  });

  it("refuses to initialise after disposal", async () => {
    const tracker = new FaceTracker();
    tracker.dispose();
    await expect(tracker.initialize()).rejects.toThrow(/disposed/i);
  });
});

describe("timings", () => {
  it("records initialisation and inference timings", async () => {
    const tracker = new FaceTracker();
    await tracker.initialize();

    expect(tracker.getTimings().initMs).not.toBeNull();

    tracker.detect(FRAME, 100);
    tracker.detect(FRAME, 200);

    const timings = tracker.getTimings();
    expect(timings.inferenceCount).toBe(2);
    expect(timings.firstInferenceMs).not.toBeNull();
    expect(timings.averageInferenceMs).not.toBeNull();

    tracker.dispose();
  });
});
