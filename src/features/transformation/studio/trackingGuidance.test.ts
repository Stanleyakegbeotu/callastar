import { describe, expect, it } from "vitest";

import type { DerivedFaceGeometry, FaceTrackingResult } from "../engine/faceTypes";
import type { PoseDerivedGeometry, PoseTrackingResult } from "../engine/poseTypes";

import {
  LOW_FACE_CONFIDENCE,
  MAX_COMFORTABLE_YAW,
  MAX_FACE_SCALE,
  MIN_FACE_SCALE,
  describeTracking,
  shouldDrawFace,
  shouldDrawPose,
} from "./trackingGuidance";

/**
 * Guidance.
 *
 * The thing worth pinning here is tone as much as logic: an ordinary moment —
 * leaning out of frame, turning to look at something — must produce advice, not
 * an error. Nothing below should ever read as a crash.
 */

function faceGeometry(overrides: Partial<DerivedFaceGeometry> = {}): DerivedFaceGeometry {
  return {
    center: { x: 0.5, y: 0.5, z: 0 },
    scale: 0.1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    eyeOpenness: 0.8,
    eyeOpennessLeft: 0.8,
    eyeOpennessRight: 0.8,
    mouthOpenness: 0.1,
    bounds: { minX: 0.35, minY: 0.2, maxX: 0.65, maxY: 0.7 },
    ...overrides,
  };
}

function face(overrides: Partial<FaceTrackingResult> = {}): FaceTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    confidence: 0.9,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    blendshapes: {},
    facialTransformationMatrix: null,
    derived: faceGeometry(),
    ...overrides,
  };
}

function poseGeometry(overrides: Partial<PoseDerivedGeometry> = {}): PoseDerivedGeometry {
  return {
    leftShoulder: { x: 0.35, y: 0.7, z: 0 },
    rightShoulder: { x: 0.65, y: 0.7, z: 0 },
    shoulderCenter: { x: 0.5, y: 0.7, z: 0 },
    shoulderWidth: 0.3,
    shoulderAngle: 0,
    torsoCenter: null,
    torsoScale: null,
    torsoLean: null,
    trackability: "tracked",
    visibility: 0.9,
    ...overrides,
  };
}

function pose(overrides: Partial<PoseTrackingResult> = {}): PoseTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
    worldLandmarks: [],
    segmentation: { available: false, width: null, height: null, representation: null },
    derived: poseGeometry(),
    ...overrides,
  };
}

const RUNNING = { running: true };

describe("when nothing is running", () => {
  it("says so instead of reporting a problem", () => {
    const result = describeTracking(null, null, { running: false });
    expect(result.quality).toBe("idle");
    expect(result.detail).toMatch(/start the camera/i);
  });

  it("stays idle even with a result held over from before", () => {
    const result = describeTracking(face(), pose(), { running: false });
    expect(result.quality).toBe("idle");
  });

  it("does not claim a problem before the first frame", () => {
    // Between the camera starting and the first inference there is genuinely
    // nothing known, and "no face" would be a guess.
    const result = describeTracking(null, null, RUNNING);
    expect(result.quality).toBe("idle");
    expect(result.label).toBe("Starting");
  });
});

describe("face problems come first", () => {
  it("asks the operator to look at the camera when no face is found", () => {
    const result = describeTracking(face({ detected: false, landmarks: [], derived: null }), pose(), RUNNING);
    expect(result.quality).toBe("poor");
    expect(result.label).toBe("No face");
  });

  it("blames the lighting rather than the person when confidence is low", () => {
    const result = describeTracking(face({ confidence: LOW_FACE_CONFIDENCE - 0.01 }), pose(), RUNNING);
    expect(result.quality).toBe("poor");
    expect(result.detail).toMatch(/lighting/i);
  });

  it("accepts confidence exactly at the threshold", () => {
    const result = describeTracking(face({ confidence: LOW_FACE_CONFIDENCE }), pose(), RUNNING);
    expect(result.quality).toBe("good");
  });
});

describe("framing", () => {
  it("says move closer when the face is small", () => {
    const result = describeTracking(
      face({ derived: faceGeometry({ scale: MIN_FACE_SCALE - 0.01 }) }),
      pose(),
      RUNNING,
    );
    expect(result.quality).toBe("fair");
    expect(result.detail).toMatch(/closer/i);
  });

  it("leaves an ordinary head-and-shoulders call framing alone", () => {
    // Measured from a real portrait through the Studio camera: eye span 0.23.
    const result = describeTracking(face({ derived: faceGeometry({ scale: 0.23 }) }), pose(), RUNNING);
    expect(result.label).not.toBe("Too close");
  });

  it("calls a face cropped at the top or bottom too close, whatever its size", () => {
    const result = describeTracking(
      face({ derived: faceGeometry({ bounds: { minX: 0.2, minY: 0.0, maxX: 0.8, maxY: 0.8 } }) }),
      pose(),
      RUNNING,
    );
    expect(result.label).toBe("Too close");
    expect(result.detail).toMatch(/tracking continues/i);
  });

  it("says move back when the face fills the frame", () => {
    const result = describeTracking(
      face({ derived: faceGeometry({ scale: MAX_FACE_SCALE + 0.01 }) }),
      pose(),
      RUNNING,
    );
    expect(result.quality).toBe("fair");
    expect(result.detail).toMatch(/back/i);
  });

  it("notices a profile view in either direction", () => {
    for (const yaw of [MAX_COMFORTABLE_YAW + 0.1, -(MAX_COMFORTABLE_YAW + 0.1)]) {
      const result = describeTracking(face({ derived: faceGeometry({ yaw }) }), pose(), RUNNING);
      expect(result.label, `yaw ${yaw}`).toBe("Turned away");
    }
  });

  it("leaves an ordinary glance alone", () => {
    const result = describeTracking(face({ derived: faceGeometry({ yaw: 0.3 }) }), pose(), RUNNING);
    expect(result.quality).toBe("good");
  });
});

describe("face-only guidance", () => {
  it("reports active face tracking without referring to shoulders", () => {
    const result = describeTracking(face(), pose({ detected: false, derived: null }), RUNNING);
    expect(result.quality).toBe("good");
    expect(result.label).toBe("Tracking");
    expect(result.detail).toBe("Face tracking active.");
  });

  it("does not let body pose results affect face tracking guidance", () => {
    const result = describeTracking(face(), pose({ detected: false, derived: null }), RUNNING);
    expect(result.detail).not.toMatch(/shoulder|torso|body/i);
  });
});

describe("drawing decisions", () => {
  it("draws nothing when there is nothing to draw", () => {
    // A mesh left on screen after tracking drops looks like it is still working.
    expect(shouldDrawFace(null)).toBe(false);
    expect(shouldDrawFace(face({ detected: false }))).toBe(false);
    expect(shouldDrawFace(face({ landmarks: [] }))).toBe(false);

    expect(shouldDrawPose(null)).toBe(false);
    expect(shouldDrawPose(pose({ detected: false }))).toBe(false);
    expect(shouldDrawPose(pose({ landmarks: [] }))).toBe(false);
  });

  it("draws when there is", () => {
    expect(shouldDrawFace(face())).toBe(true);
    expect(shouldDrawPose(pose())).toBe(true);
  });
});
