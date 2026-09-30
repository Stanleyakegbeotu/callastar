import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Point3 } from "../engine/faceTypes";

import type { SourceAsset } from "./sourceAsset";
import { SourceAnalyzer, isSourceProfileCurrent, profileMatchesSource } from "./sourceAnalyzer";
import { SOURCE_ANALYSIS_VERSION, type SourceAnalysisProgress, type TransformationSourceProfile } from "./sourceTypes";

/**
 * The analyser, with the models and the decoder stubbed.
 *
 * The browser proofs run the real MediaPipe tasks against real pixels. What can
 * only be tested here is the orchestration: that a cancelled run releases what
 * it held, that a late result cannot mark a replaced source ready, and that
 * nothing about the live operator can reach a source profile.
 */

const { tasksSpy, readerSpy, bitmapSpy } = vi.hoisted(() => ({
  tasksSpy: { instances: [] as unknown[] },
  readerSpy: { instances: [] as unknown[] },
  bitmapSpy: { created: 0, closed: 0 },
}));

/** A face the geometry layer will accept. */
function landmarkGrid(): Point3[] {
  return Array.from({ length: 478 }, (_unused, index) => ({
    x: 0.42 + (index % 20) * 0.008,
    y: 0.3 + Math.floor(index / 20) * 0.012,
    z: 0,
  }));
}

const DERIVED_FACE = {
  center: { x: 0.5, y: 0.42, z: 0 },
  scale: 0.1,
  yaw: 0.05,
  pitch: -0.02,
  roll: 0.01,
  eyeOpenness: 0.8,
  eyeOpennessLeft: 0.8,
  eyeOpennessRight: 0.8,
  mouthOpenness: 0.05,
  bounds: { minX: 0.38, minY: 0.25, maxX: 0.62, maxY: 0.6 },
};

const DERIVED_POSE = {
  leftShoulder: { x: 0.3, y: 0.78, z: 0 },
  rightShoulder: { x: 0.7, y: 0.78, z: 0 },
  shoulderCenter: { x: 0.5, y: 0.78, z: 0 },
  shoulderWidth: 0.4,
  shoulderAngle: 0.01,
  torsoCenter: null,
  torsoScale: null,
  torsoLean: null,
  trackability: "tracked" as const,
  visibility: 0.9,
};

/** Controls what the stubbed models return, per test. */
const behaviour = {
  faceDetected: true,
  poseDetected: true,
  initFails: false,
  /** Called before each face detection, so a test can cancel mid-analysis. */
  onDetect: null as null | ((call: number) => void),
  faceYawForFrame: null as null | ((call: number) => number),
};

vi.mock("./sourceTrackers", () => {
  class FakeTasks {
    disposed = false;
    private detectCalls = 0;

    constructor() {
      tasksSpy.instances.push(this);
    }

    get ready() {
      return !this.disposed;
    }
    get poseReady() {
      return !this.disposed;
    }

    async initialize() {
      if (behaviour.initFails) throw new Error("models unavailable");
    }

    detectFace() {
      this.detectCalls += 1;
      behaviour.onDetect?.(this.detectCalls);
      if (!behaviour.faceDetected) {
        return { detected: false, landmarks: [], blendshapes: {}, facialTransformationMatrix: null, derived: null };
      }
      const yaw = behaviour.faceYawForFrame?.(this.detectCalls) ?? DERIVED_FACE.yaw;
      return {
        detected: true,
        landmarks: landmarkGrid(),
        blendshapes: { jawOpen: 0.05 },
        facialTransformationMatrix: null,
        derived: { ...DERIVED_FACE, yaw },
      };
    }

    detectPose() {
      if (!behaviour.poseDetected) {
        return { detected: false, landmarks: [], worldLandmarks: [], derived: null, segmentationAvailable: false };
      }
      return {
        detected: true,
        landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
        worldLandmarks: [],
        derived: DERIVED_POSE,
        segmentationAvailable: true,
      };
    }

    dispose() {
      this.disposed = true;
    }
  }

  return { SourceAnalysisTasks: FakeTasks };
});

vi.mock("./videoFrameReader", async () => {
  const actual = await vi.importActual<typeof import("./videoFrameReader")>("./videoFrameReader");

  class FakeReader {
    disposed = false;
    seeks: number[] = [];

    constructor() {
      readerSpy.instances.push(this);
    }

    async open() {
      return { durationSeconds: 12, width: 720, height: 1280 };
    }

    async frameAt(timestamp: number) {
      if (this.disposed) throw new actual.VideoSeekError("disposed", "cancelled");
      this.seeks.push(timestamp);
      return {} as HTMLCanvasElement;
    }

    dispose() {
      this.disposed = true;
    }
  }

  return { ...actual, VideoFrameReader: FakeReader };
});

function imageAsset(overrides: Partial<SourceAsset> = {}): SourceAsset {
  return {
    kind: "image",
    mimeType: "image/jpeg",
    fileName: "source.jpg",
    blob: new Blob(["x"], { type: "image/jpeg" }),
    assetId: null,
    ...overrides,
  };
}

function videoAsset(overrides: Partial<SourceAsset> = {}): SourceAsset {
  return {
    kind: "video",
    mimeType: "video/mp4",
    fileName: "clip.mp4",
    blob: new Blob(["x"], { type: "video/mp4" }),
    assetId: null,
    ...overrides,
  };
}

beforeEach(() => {
  tasksSpy.instances = [];
  readerSpy.instances = [];
  bitmapSpy.created = 0;
  bitmapSpy.closed = 0;
  behaviour.faceDetected = true;
  behaviour.poseDetected = true;
  behaviour.initFails = false;
  behaviour.onDetect = null;
  behaviour.faceYawForFrame = null;

  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      bitmapSpy.created += 1;
      return {
        width: 1080,
        height: 1440,
        close: () => {
          bitmapSpy.closed += 1;
        },
      } as unknown as ImageBitmap;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image analysis", () => {
  it("produces a profile from a source with a face and shoulders", async () => {
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.sourceKind).toBe("image");
    expect(result.profile.dimensions).toEqual({ width: 1080, height: 1440, aspectRatio: 0.75 });
    expect(result.profile.primaryFace.landmarks).toHaveLength(478);
    expect(result.profile.primaryPose?.shoulderWidth).toBe(0.4);
    expect(result.profile.quality.capabilities.upperBody).toBe(true);
  });

  it("keeps raw model output separate from derived geometry", async () => {
    // A later change to how yaw is computed must not be able to corrupt the
    // landmarks it was computed from.
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    if (!result.ok) throw new Error("expected a profile");
    expect(result.profile.primaryFace.landmarks.length).toBeGreaterThan(0);
    expect(result.profile.primaryFace.yaw).toBe(DERIVED_FACE.yaw);
  });

  it("carries no reference bank for a still", async () => {
    /*
     * An image has one angle, not a choice between alternatives. A
     * single-entry bank would invite a renderer to treat it as one.
     */
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    if (!result.ok) throw new Error("expected a profile");
    expect(result.profile.referenceFrames).toEqual([]);
    expect(result.profile.durationSeconds).toBeNull();
    expect(result.profile.movementEnvelope.basis).toBe("single-image");
  });

  it("fails gracefully when there is no face", async () => {
    behaviour.faceDetected = false;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    expect(result).toMatchObject({ ok: false, failure: "no-face" });
    if (!result.ok) expect(result.message).toMatch(/no clear face/i);
    // The runtime is healthy: another source can be analysed immediately.
    expect(tasksSpy.instances.every((task) => (task as { disposed: boolean }).disposed)).toBe(true);
  });

  it("succeeds face-only when there are no shoulders", async () => {
    // Do not reject an otherwise useful image.
    behaviour.poseDetected = false;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.primaryPose).toBeNull();
    expect(result.profile.quality.grade).toBe("limited");
    expect(result.profile.quality.capabilities.face).toBe(true);
    expect(result.profile.quality.warnings).toContain("shoulders-not-visible");
  });

  it("reports a decode failure rather than throwing", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("corrupt");
    }));

    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    expect(result).toMatchObject({ ok: false, failure: "decode-failed" });
  });

  it("reports a model failure as its own case", async () => {
    behaviour.initFails = true;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    expect(result).toMatchObject({ ok: false, failure: "model-load-failed" });
  });

  it("reports real stages, in order", async () => {
    // Nothing advances on a timer: each stage is entered when that work begins.
    const stages: SourceAnalysisProgress["stage"][] = [];
    const analyzer = new SourceAnalyzer();
    await analyzer.analyze({
      asset: imageAsset(),
      profileId: "profile-a",
      onProgress: (progress) => stages.push(progress.stage),
    });

    expect(stages).toEqual(["decoding", "loading-models", "analyzing-face", "analyzing-pose", "evaluating", "done"]);
  });
});

describe("video analysis", () => {
  it("samples a bounded number of frames and builds a bank", async () => {
    // A different yaw per frame, so the bank has angles to sort into.
    behaviour.faceYawForFrame = (call) => [0, 0.35, -0.35, 0, 0.3][call % 5] ?? 0;

    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.sourceKind).toBe("video");
    expect(result.profile.durationSeconds).toBe(12);
    expect(result.profile.referenceFrames.length).toBeGreaterThan(0);
    // At most one per angle, by construction.
    expect(result.profile.referenceFrames.length).toBeLessThanOrEqual(5);

    const reader = readerSpy.instances[0] as { seeks: number[] };
    expect(reader.seeks.length).toBeLessThanOrEqual(20);
  });

  it("holds geometry and timestamps, never decoded pixels", async () => {
    /*
     * Twenty full-resolution frames is not a reference bank, it is a small copy
     * of the video held in memory. The renderer decodes the frame it wants.
     */
    behaviour.faceYawForFrame = (call) => [0, 0.35, -0.35][call % 3] ?? 0;

    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    for (const frame of result.profile.referenceFrames) {
      expect(typeof frame.timestampSeconds).toBe("number");
      expect(frame).not.toHaveProperty("bitmap");
      expect(frame).not.toHaveProperty("pixels");
      expect(frame).not.toHaveProperty("canvas");
    }
  });

  it("reports frame progress as frames are actually analysed", async () => {
    const frames: (number | null)[] = [];
    const analyzer = new SourceAnalyzer();
    await analyzer.analyze({
      asset: videoAsset(),
      profileId: "profile-a",
      onProgress: (progress) => {
        if (progress.stage === "analyzing-frames") frames.push(progress.frame);
      },
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toBe(1);
    // Monotonic, and never ahead of the work.
    expect(frames).toEqual([...frames].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("fails when no frame contains a face", async () => {
    behaviour.faceDetected = false;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });
    expect(result).toMatchObject({ ok: false, failure: "no-face" });
  });

  it("records average time per analysed frame", async () => {
    const analyzer = new SourceAnalyzer();
    await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });

    const timings = analyzer.getTimings();
    expect(timings.framesAnalyzed).toBeGreaterThan(0);
    expect(timings.perFrameMs).not.toBeNull();
    expect(Number.isFinite(timings.totalMs ?? Number.NaN)).toBe(true);
  });
});

describe("cancellation", () => {
  it("stops mid-analysis and releases the models", async () => {
    const analyzer = new SourceAnalyzer();

    // Cancel once the third frame has been reached.
    behaviour.onDetect = (call) => {
      if (call === 3) analyzer.cancel();
    };

    const result = await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });

    expect(result).toMatchObject({ ok: false, failure: "cancelled" });
    expect(tasksSpy.instances.every((task) => (task as { disposed: boolean }).disposed)).toBe(true);
    expect(readerSpy.instances.every((reader) => (reader as { disposed: boolean }).disposed)).toBe(true);
  });

  it("stops seeking once cancelled", async () => {
    const analyzer = new SourceAnalyzer();
    behaviour.onDetect = (call) => {
      if (call === 2) analyzer.cancel();
    };

    await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });

    const reader = readerSpy.instances[0] as { seeks: number[] };
    // Two frames reached, and the sampler did not work through the rest.
    expect(reader.seeks.length).toBeLessThan(8);
  });

  it("releases a decoded image when cancelled during an image analysis", async () => {
    const analyzer = new SourceAnalyzer();
    behaviour.onDetect = () => analyzer.cancel();

    await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    expect(bitmapSpy.closed).toBe(bitmapSpy.created);
  });

  it("cannot let a late result mark the next source ready", async () => {
    /*
     * The failure this guards against.
     *
     * A cancelled run may still be inside an await when the operator picks
     * another source. Its result must not arrive later and overwrite the new
     * one — a caller would be shown somebody else's face as ready.
     */
    const analyzer = new SourceAnalyzer();
    const progress: string[] = [];

    behaviour.onDetect = (call) => {
      if (call === 2) analyzer.cancel();
    };
    const abandoned = analyzer.analyze({
      asset: videoAsset({ fileName: "first.mp4" }),
      profileId: "profile-a",
      onProgress: (update) => progress.push(`first:${update.stage}`),
    });

    const replacement = await analyzer.analyze({
      asset: imageAsset({ fileName: "second.jpg" }),
      profileId: "profile-a",
      onProgress: (update) => progress.push(`second:${update.stage}`),
    });

    const first = await abandoned;
    expect(first.ok).toBe(false);
    expect(replacement.ok).toBe(true);
    if (replacement.ok) expect(replacement.profile.asset.fileName).toBe("second.jpg");

    // The abandoned run reported nothing after it was replaced.
    const lastFirst = progress.lastIndexOf(progress.filter((entry) => entry.startsWith("first:")).pop() ?? "");
    const firstSecond = progress.findIndex((entry) => entry.startsWith("second:"));
    expect(lastFirst).toBeLessThan(firstSecond);
  });
});

describe("resource cleanup", () => {
  it("disposes the models when an analysis finishes", async () => {
    // Source analysis is finite. Leaving a second pair of models resident would
    // double the Studio's memory for something nothing is using.
    const analyzer = new SourceAnalyzer();
    await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    expect(tasksSpy.instances).toHaveLength(1);
    expect((tasksSpy.instances[0] as { disposed: boolean }).disposed).toBe(true);
  });

  it("does not accumulate across repeated source changes", async () => {
    const analyzer = new SourceAnalyzer();

    for (let index = 0; index < 5; index += 1) {
      await analyzer.analyze({ asset: imageAsset({ fileName: `${index}.jpg` }), profileId: "profile-a" });
    }

    expect(bitmapSpy.closed).toBe(bitmapSpy.created);
    expect(tasksSpy.instances.every((task) => (task as { disposed: boolean }).disposed)).toBe(true);
    expect(tasksSpy.instances).toHaveLength(5);
  });

  it("releases the video reader after a video analysis", async () => {
    const analyzer = new SourceAnalyzer();
    await analyzer.analyze({ asset: videoAsset(), profileId: "profile-a" });

    expect(readerSpy.instances.every((reader) => (reader as { disposed: boolean }).disposed)).toBe(true);
  });
});

describe("the profile itself", () => {
  it("records which admin profile it was prepared for", async () => {
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });

    if (!result.ok) throw new Error("expected a profile");
    expect(result.profile.profileId).toBe("profile-a");
  });

  it("does not let one profile's source become another's", async () => {
    /*
     * The single worst thing this feature could do is give one person another
     * person's face. Scoping is checked, never assumed.
     */
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    expect(profileMatchesSource(result.profile, "profile-a")).toBe(true);
    expect(profileMatchesSource(result.profile, "profile-b")).toBe(false);
    expect(profileMatchesSource(result.profile, null)).toBe(false);
    expect(profileMatchesSource(null, "profile-a")).toBe(false);
  });

  it("references a stored asset by the id the admin repository already uses", async () => {
    // Not a second media-storage subsystem.
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({
      asset: imageAsset({ assetId: "asset-42" }),
      profileId: "profile-a",
    });

    if (!result.ok) throw new Error("expected a profile");
    expect(result.profile.asset).toMatchObject({ origin: "stored", assetId: "asset-42" });
  });

  it("carries a version that can invalidate a stale profile", async () => {
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    expect(isSourceProfileCurrent(result.profile)).toBe(true);
    expect(
      isSourceProfileCurrent({ ...result.profile, analysisVersion: SOURCE_ANALYSIS_VERSION - 1 }),
    ).toBe(false);
  });

  it("contains nothing about the live operator", async () => {
    /*
     * This describes the SELECTED SOURCE ASSET. A live camera frame, a live
     * landmark or anything derived from the person using the Studio belongs to
     * calibration, which is a separate object with a separate lifetime.
     */
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    const keys = Object.keys(result.profile).sort();
    expect(keys).toEqual(
      [
        "analysisVersion",
        "asset",
        "createdAt",
        "dimensions",
        "durationSeconds",
        "expression",
        "movementEnvelope",
        "primaryFace",
        "primaryPose",
        "profileId",
        "quality",
        "referenceFrames",
        "regions",
        "sourceKind",
        "version",
      ].sort(),
    );

    const serialised = JSON.stringify(result.profile);
    expect(serialised).not.toMatch(/calibration|neutralYaw|stabilityScore|cameraFacing|mirrorMode/i);
  });

  it("carries no renderer types", async () => {
    // A later milestone builds vertices and textures FROM this; it does not
    // find them in it.
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    const serialised = JSON.stringify(result.profile);
    expect(serialised).not.toMatch(/geometry.*BufferAttribute|texture|uv|mesh|material|shader/i);
  });
});

/** A profile that would be handed straight to a renderer. */
function renderableProfile(profile: TransformationSourceProfile) {
  return {
    hasFace: profile.quality.capabilities.face,
    hasUpperBody: profile.quality.capabilities.upperBody,
    headRoom: profile.movementEnvelope,
    regions: profile.regions,
  };
}

describe("the renderer contract", () => {
  it("answers what geometry a renderer has, without saying how to draw it", async () => {
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: imageAsset(), profileId: "profile-a" });
    if (!result.ok) throw new Error("expected a profile");

    const plan = renderableProfile(result.profile);
    expect(plan.hasFace).toBe(true);
    expect(plan.regions.head).toBeDefined();
    expect(plan.regions.headClipped).toBe(false);
    expect(plan.headRoom.yawLeft).toBeGreaterThan(0);
  });
});
