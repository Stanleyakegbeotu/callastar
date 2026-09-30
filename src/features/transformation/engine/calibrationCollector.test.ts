import { describe, expect, it } from "vitest";

import { COLLECTION, CalibrationCollector, gradeCalibration, type CalibrationContext } from "./calibrationCollector";
import { CALIBRATION_PROFILE_VERSION } from "./calibrationTypes";
import type { DerivedFaceGeometry, FaceTrackingResult } from "./faceTypes";
import type { PoseDerivedGeometry, PoseTrackingResult } from "./poseTypes";

/**
 * Capturing a baseline.
 *
 * The cases that matter are the ones that should NOT produce a profile: a
 * window the operator moved through, a window too short to mean anything, and a
 * frame carrying a NaN. Every one of those, averaged quietly, becomes a
 * permanent bias in everything the pipeline does afterwards.
 */

const CONTEXT: CalibrationContext = {
  cameraFacing: "user",
  trackingWidth: 360,
  trackingHeight: 640,
  mirrored: true,
};

function faceGeometry(overrides: Partial<DerivedFaceGeometry> = {}): DerivedFaceGeometry {
  return {
    center: { x: 0.5, y: 0.45, z: 0 },
    scale: 0.1,
    yaw: 0.04,
    pitch: -0.02,
    roll: 0.01,
    eyeOpenness: 0.8,
    eyeOpennessLeft: 0.8,
    eyeOpennessRight: 0.8,
    mouthOpenness: 0.05,
    bounds: { minX: 0.35, minY: 0.2, maxX: 0.65, maxY: 0.7 },
    ...overrides,
  };
}

function face(overrides: Partial<FaceTrackingResult> = {}, geometry: Partial<DerivedFaceGeometry> = {}): FaceTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    confidence: 0.9,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    blendshapes: {},
    facialTransformationMatrix: null,
    derived: faceGeometry(geometry),
    ...overrides,
  };
}

function poseGeometry(overrides: Partial<PoseDerivedGeometry> = {}): PoseDerivedGeometry {
  return {
    leftShoulder: { x: 0.35, y: 0.72, z: 0 },
    rightShoulder: { x: 0.65, y: 0.72, z: 0 },
    shoulderCenter: { x: 0.5, y: 0.72, z: 0 },
    shoulderWidth: 0.3,
    shoulderAngle: 0.02,
    torsoCenter: null,
    torsoScale: null,
    torsoLean: null,
    trackability: "tracked",
    visibility: 0.9,
    ...overrides,
  };
}

function pose(overrides: Partial<PoseTrackingResult> = {}, geometry: Partial<PoseDerivedGeometry> = {}): PoseTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    worldLandmarks: [],
    segmentation: { available: false, width: null, height: null, representation: null },
    derived: poseGeometry(geometry),
    ...overrides,
  };
}

/**
 * Feeds frames at a fixed cadence.
 *
 * 33ms apart, so twelve frames span 363ms — which is deliberately NOT enough on
 * its own. Both the frame count and the elapsed time have to be satisfied, and
 * this harness is how that is proved rather than assumed.
 */
function feed(
  collector: CalibrationCollector,
  count: number,
  build: (index: number) => { face: FaceTrackingResult | null; pose: PoseTrackingResult | null },
  options: { startMs?: number; stepMs?: number } = {},
): number {
  const step = options.stepMs ?? 33;
  let now = options.startMs ?? 0;

  for (let index = 0; index < count; index += 1) {
    const frame = build(index);
    collector.accept(frame.face, frame.pose, now);
    now += step;
  }
  return now;
}

/** A still operator: sub-tolerance jitter on every axis. */
function stillFrame(index: number) {
  const jitter = index % 2 === 0 ? 0.0008 : -0.0008;
  return {
    face: face({}, { center: { x: 0.5 + jitter, y: 0.45, z: 0 }, scale: 0.1 + jitter / 4 }),
    pose: pose({}, { shoulderCenter: { x: 0.5 + jitter, y: 0.72, z: 0 }, shoulderWidth: 0.3 + jitter / 2 }),
  };
}

function runStillCalibration(collector: CalibrationCollector, frames = 40, stepMs = 60): number {
  collector.start("full", CONTEXT, 0);
  return feed(collector, frames, stillFrame, { stepMs });
}

describe("a steady operator", () => {
  it("produces a baseline once both the frame count and the duration are met", () => {
    const collector = new CalibrationCollector();
    runStillCalibration(collector);

    const state = collector.getState();
    expect(state.phase).toBe("ready");
    expect(state.profile).not.toBeNull();
    expect(state.profile!.version).toBe(CALIBRATION_PROFILE_VERSION);
    expect(state.profile!.quality.frameCount).toBeGreaterThanOrEqual(COLLECTION.minFrames);
  });

  it("records the resting pose rather than zero", () => {
    /*
     * The entire reason calibration exists.
     *
     * This operator rests at 0.04 rad of yaw. A baseline of zero would make
     * their neutral face read as a permanent two-degree turn for the whole
     * session.
     */
    const collector = new CalibrationCollector();
    runStillCalibration(collector);

    const profile = collector.getState().profile!;
    expect(profile.face.yaw).toBeCloseTo(0.04, 4);
    expect(profile.face.pitch).toBeCloseTo(-0.02, 4);
    expect(profile.face.scale).toBeCloseTo(0.1, 3);
    // Within the harness's own ±0.0008 jitter: with an odd-sized window the
    // median is a real sample, so it sits on one side of the centre rather than
    // averaging to it.
    expect(profile.face.center.x).toBeCloseTo(0.5, 2);
  });

  it("captures the shoulders and records the camera and tracking space", () => {
    const collector = new CalibrationCollector();
    runStillCalibration(collector);

    const profile = collector.getState().profile!;
    expect(profile.pose.shoulderWidth).toBeCloseTo(0.3, 3);
    expect(profile.pose.shoulderAngle).toBeCloseTo(0.02, 4);
    expect(profile.cameraFacing).toBe("user");
    expect(profile.trackingSpace).toEqual({ width: 360, height: 640, mirrorMode: "mirrored" });
    expect(profile.quality.poseAvailable).toBe(true);
  });

  it("keeps no frame-by-frame history in the profile", () => {
    // Privacy is structural here: the samples are dropped when the baseline is
    // computed, and there is nowhere in the contract for them to survive.
    const collector = new CalibrationCollector();
    runStillCalibration(collector);

    const profile = collector.getState().profile!;
    const serialised = JSON.stringify(profile);
    expect(serialised).not.toContain("landmark");
    expect(serialised).not.toContain("samples");
    expect(Object.keys(profile).sort()).toEqual(
      ["cameraFacing", "createdAt", "face", "mode", "pose", "quality", "trackingSpace", "version"].sort(),
    );
  });
});

describe("outliers", () => {
  it("is not shifted by a single bad frame", () => {
    /*
     * One frame where the model lost an eye reports a wildly different scale
     * and centre. A mean baseline would carry it forever; the median does not
     * move.
     */
    const clean = new CalibrationCollector();
    runStillCalibration(clean);
    const expected = clean.getState().profile!;

    const withOutlier = new CalibrationCollector();
    withOutlier.start("full", CONTEXT, 0);
    feed(
      withOutlier,
      40,
      (index) =>
        index === 17
          ? { face: face({}, { scale: 0.2, center: { x: 0.62, y: 0.3, z: 0 } }), pose: pose() }
          : stillFrame(index),
      { stepMs: 60 },
    );

    const actual = withOutlier.getState().profile!;
    expect(actual.face.scale).toBeCloseTo(expected.face.scale, 3);
    expect(actual.face.center.x).toBeCloseTo(expected.face.center.x, 3);
  });

  it("refuses a frame carrying a NaN rather than averaging it", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, (index) =>
      index % 4 === 0
        ? { face: face({}, { scale: Number.NaN }), pose: pose() }
        : stillFrame(index),
      { stepMs: 60 },
    );

    const state = collector.getState();
    expect(state.rejectionCounts["invalid-geometry"]).toBeGreaterThan(0);
    // Whatever it did with the rest, no NaN reached the baseline.
    if (state.profile) {
      expect(Number.isFinite(state.profile.face.scale)).toBe(true);
      expect(Number.isFinite(state.profile.face.yaw)).toBe(true);
    }
  });
});

describe("movement", () => {
  it("does not calibrate an operator who is turning", () => {
    // Averaging a movement produces a neutral the operator was never in.
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);

    feed(collector, 40, (index) => ({
      face: face({}, { yaw: 0.02 * index }),
      pose: pose(),
    }), { stepMs: 60 });

    const state = collector.getState();
    expect(state.phase).not.toBe("ready");
    expect(state.profile).toBeNull();
  });

  it("keeps watching rather than failing, so steadying up just works", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);

    // Moving for a while...
    const after = feed(collector, 20, (index) => ({ face: face({}, { yaw: 0.03 * index }), pose: pose() }), {
      stepMs: 60,
    });
    expect(collector.getState().phase).toBe("waiting-for-stable-tracking");

    // ...then settling, with no restart needed.
    feed(collector, 40, stillFrame, { startMs: after, stepMs: 60 });
    expect(collector.getState().phase).toBe("ready");
  });

  it("abandons a part-collected window after a run of refusals", () => {
    /*
     * A blink or two mid-collection is not a problem. A run of refused frames
     * means the operator moved, and the samples already taken no longer
     * describe where they are now.
     */
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 11, stillFrame, { stepMs: 60 });
    expect(collector.getState().phase).toBe("collecting");

    feed(collector, COLLECTION.maxConsecutiveRejections, () => ({ face: null, pose: null }), {
      startMs: 660,
      stepMs: 60,
    });

    expect(collector.getState().phase).toBe("waiting-for-stable-tracking");
  });
});

describe("window length", () => {
  it("needs elapsed time, not just a frame count", () => {
    /*
     * At 240fps the minimum frame count is reached in 50ms, which is a
     * snapshot, not a pose. Both conditions are required, and neither assumes
     * a frame rate.
     */
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, COLLECTION.minFrames + 10, stillFrame, { stepMs: 4 });

    const state = collector.getState();
    expect(state.acceptedFrames).toBeGreaterThan(COLLECTION.minFrames);
    expect(state.phase).toBe("collecting");
    expect(state.profile).toBeNull();
  });

  it("needs a frame count, not just elapsed time", () => {
    // Three frames over two seconds is a slow tracker, not a steady pose.
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 6, stillFrame, { stepMs: 400 });

    expect(collector.getState().profile).toBeNull();
  });

  it("finishes in about a second and a half, not five", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);

    let completedAt: number | null = null;
    let now = 0;
    for (let index = 0; index < 200 && completedAt === null; index += 1) {
      collector.accept(stillFrame(index).face, stillFrame(index).pose, now);
      if (collector.getState().phase === "ready") completedAt = now;
      now += 33;
    }

    expect(completedAt).not.toBeNull();
    expect(completedAt!).toBeGreaterThanOrEqual(COLLECTION.minDurationMs);
    expect(completedAt!, "calibration should not feel like a scan").toBeLessThan(2500);
  });

  it("gives up rather than waiting forever", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    collector.accept(null, null, COLLECTION.timeoutMs + 1);

    const state = collector.getState();
    expect(state.phase).toBe("failed");
    expect(state.failure).toBe("no-face");
  });
});

describe("partial pose", () => {
  it("succeeds when the hips are not visible", () => {
    // A seated operator close to the camera usually has no visible hips, and
    // requiring a full torso would make calibration fail for most desks.
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, (index) => ({
      face: stillFrame(index).face,
      pose: pose({}, { torsoCenter: null, torsoScale: null, torsoLean: null }),
    }), { stepMs: 60 });

    const profile = collector.getState().profile!;
    expect(profile.quality.poseAvailable).toBe(true);
    expect(profile.pose.shoulderWidth).not.toBeNull();
    expect(profile.pose.torsoCenter).toBeNull();
    expect(profile.pose.torsoScale).toBeNull();
  });

  it("refuses a full calibration with only one shoulder, and offers face-only", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, (index) => ({
      face: stillFrame(index).face,
      pose: pose({}, { trackability: "partial" }),
    }), { stepMs: 60 });
    collector.accept(null, null, COLLECTION.timeoutMs + 1);

    const state = collector.getState();
    expect(state.phase).toBe("failed");
    expect(state.failure).toBe("pose-unavailable");
    expect(state.faceOnlyAvailable).toBe(true);
  });

  it("calibrates face-only when asked, and says it is limited", () => {
    const collector = new CalibrationCollector();
    collector.start("face-only", CONTEXT, 0);
    feed(collector, 40, (index) => ({ face: stillFrame(index).face, pose: null }), { stepMs: 60 });

    const profile = collector.getState().profile!;
    expect(profile.mode).toBe("face-only");
    expect(profile.quality.poseAvailable).toBe(false);
    expect(profile.pose.shoulderCenter).toBeNull();
    // Never dressed up as equivalent to a full calibration.
    expect(profile.quality.quality).toBe("limited");
    expect(profile.quality.warnings).toContain("upper-body-unavailable");
  });

  it("cannot calibrate with no face at all", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, () => ({ face: null, pose: pose() }), { stepMs: 60 });

    expect(collector.getState().profile).toBeNull();
    expect(collector.getState().rejectionCounts["no-face"]).toBeGreaterThan(0);
  });
});

describe("warnings", () => {
  it("flags a strongly angled resting head without failing", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, (index) => ({
      face: face({}, { ...faceGeometry({ yaw: 0.35 }), center: stillFrame(index).face!.derived!.center }),
      pose: pose(),
    }), { stepMs: 60 });

    const profile = collector.getState().profile!;
    expect(profile.quality.warnings).toContain("head-strongly-angled");
    // Informational, not an engine failure.
    expect(collector.getState().phase).toBe("ready");
  });

  it("flags shoulders that already reach the frame edge", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 40, (index) => ({
      face: stillFrame(index).face,
      pose: pose({}, { shoulderCenter: { x: 0.5, y: 0.72, z: 0 }, shoulderWidth: 0.99 }),
    }), { stepMs: 60 });

    expect(collector.getState().profile!.quality.warnings).toContain("shoulders-outside-frame");
  });
});

describe("quality grading", () => {
  it("reserves excellent for a clean full capture", () => {
    expect(
      gradeCalibration({ poseAvailable: true, stabilityScore: 0.8, frameCount: 25, mode: "full", warningCount: 0 }),
    ).toBe("excellent");
  });

  it("drops to good when something was worth warning about", () => {
    expect(
      gradeCalibration({ poseAvailable: true, stabilityScore: 0.8, frameCount: 25, mode: "full", warningCount: 1 }),
    ).toBe("good");
  });

  it("calls face-only limited however steady it was", () => {
    expect(
      gradeCalibration({
        poseAvailable: false,
        stabilityScore: 0.99,
        frameCount: 60,
        mode: "face-only",
        warningCount: 0,
      }),
    ).toBe("limited");
  });

  it("calls a shaky capture limited", () => {
    expect(
      gradeCalibration({ poseAvailable: true, stabilityScore: 0.3, frameCount: 40, mode: "full", warningCount: 0 }),
    ).toBe("limited");
  });
});

describe("recalibration", () => {
  it("replaces the baseline without any other state surviving", () => {
    const collector = new CalibrationCollector();
    runStillCalibration(collector);
    const first = collector.getState().profile!;

    // The operator has moved and asks again.
    collector.start("full", CONTEXT, 10_000);
    expect(collector.getState().profile, "the old baseline is dropped immediately").toBeNull();
    expect(collector.getState().acceptedFrames).toBe(0);

    feed(collector, 40, (index) => ({
      face: face({}, { ...faceGeometry({ yaw: 0.2, scale: 0.14 }), center: { x: 0.44, y: 0.5, z: 0 } }),
      pose: pose(),
    }), { startMs: 10_000, stepMs: 60 });

    const second = collector.getState().profile!;
    expect(second.face.yaw).toBeCloseTo(0.2, 3);
    expect(second.face.yaw).not.toBeCloseTo(first.face.yaw, 2);
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
  });

  it("clears to idle on demand", () => {
    // The camera-flip path: the baseline goes, the engine does not.
    const collector = new CalibrationCollector();
    runStillCalibration(collector);
    expect(collector.getState().phase).toBe("ready");

    collector.clear();
    const state = collector.getState();
    expect(state.phase).toBe("idle");
    expect(state.profile).toBeNull();
    expect(state.failure).toBeNull();
  });

  it("can be cancelled mid-capture", () => {
    const collector = new CalibrationCollector();
    collector.start("full", CONTEXT, 0);
    feed(collector, 5, stillFrame, { stepMs: 60 });

    collector.cancel();
    expect(collector.getState().phase).toBe("failed");
    expect(collector.getState().failure).toBe("cancelled");
    expect(collector.isRunning).toBe(false);
  });

  it("ignores frames when nothing is running", () => {
    // The scheduler keeps calling; calibration must cost nothing when idle.
    const collector = new CalibrationCollector();
    expect(collector.accept(face(), pose(), 0)).toBe(false);
    expect(collector.getState().acceptedFrames).toBe(0);
  });
});
