import { describe, expect, it, vi } from "vitest";

import type { DisplayGeometry } from "../engine/coordinateMapping";
import type { FaceTrackingResult } from "../engine/faceTypes";
import { POSE_LANDMARKS } from "../engine/poseGeometry";
import type { PoseLandmark, PoseTrackingResult } from "../engine/poseTypes";

import {
  DEFAULT_OVERLAY_STYLE,
  DRAW_VISIBILITY,
  POSE_SEGMENTS,
  drawTrackingOverlay,
  faceDotStride,
} from "./overlayDrawing";

/**
 * The overlay.
 *
 * Verified against a recording context rather than pixels: what matters is that
 * every point went through the shared mapping, that nothing is drawn from an
 * invisible landmark, and that the canvas is cleared before each frame. A stale
 * mesh is the failure that looks most like success.
 */

interface DrawCall {
  op: string;
  args: number[];
}

/** A 2D context that records the calls instead of rasterising them. */
function recordingContext(width = 780, height = 1688) {
  const calls: DrawCall[] = [];
  const record = (op: string) => (...args: number[]) => calls.push({ op, args });

  const context = {
    canvas: { width, height },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt" as CanvasLineCap,
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    beginPath: vi.fn(() => calls.push({ op: "beginPath", args: [] })),
    stroke: vi.fn(() => calls.push({ op: "stroke", args: [] })),
    fill: vi.fn(() => calls.push({ op: "fill", args: [] })),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn((...args: number[]) => calls.push({ op: "setTransform", args })),
  };

  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const GEOMETRY: DisplayGeometry = {
  sourceWidth: 720,
  sourceHeight: 1280,
  displayWidth: 390,
  displayHeight: 694,
  objectFit: "cover",
  mirrored: false,
};

const STYLE = { ...DEFAULT_OVERLAY_STYLE, ratio: 2 };

function face(overrides: Partial<FaceTrackingResult> = {}): FaceTrackingResult {
  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    confidence: 0.9,
    landmarks: [
      { x: 0.4, y: 0.3, z: 0 },
      { x: 0.5, y: 0.3, z: 0 },
      { x: 0.6, y: 0.3, z: 0 },
    ],
    blendshapes: {},
    facialTransformationMatrix: null,
    derived: null,
    ...overrides,
  };
}

/** A pose whose named upper-body landmarks are all present and visible. */
function pose(overrides: { visibility?: number; only?: number[] } = {}): PoseTrackingResult {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, (_unused, index) => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: overrides.only && !overrides.only.includes(index) ? 0 : (overrides.visibility ?? 0.9),
  }));

  return {
    timestampMs: 0,
    status: "tracked",
    detected: true,
    landmarks,
    worldLandmarks: [],
    segmentation: { available: false, width: null, height: null, representation: null },
    derived: null,
  };
}

function options(overrides: Partial<Parameters<typeof drawTrackingOverlay>[3]> = {}) {
  return { geometry: GEOMETRY, style: STYLE, showFace: true, showPose: true, ...overrides };
}

describe("clearing", () => {
  it("clears the whole backing store before every frame", () => {
    // Not the CSS box: the transform for the pixel ratio has not been applied
    // yet, so clearing in CSS pixels would leave a quarter of the canvas dirty.
    const { context, calls } = recordingContext(780, 1688);
    drawTrackingOverlay(context, face(), null, options());

    const clear = calls.find((call) => call.op === "clearRect");
    expect(clear?.args).toEqual([0, 0, 780, 1688]);
    expect(calls[0]?.op).toBe("clearRect");
  });

  it("clears and draws nothing when there is no result", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, null, options());

    expect(calls.filter((call) => call.op === "clearRect")).toHaveLength(1);
    expect(calls.some((call) => call.op === "fillRect" || call.op === "stroke")).toBe(false);
  });

  it("clears and gives up when the video has no dimensions yet", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, face(), pose(), options({ geometry: { ...GEOMETRY, sourceWidth: 0 } }));

    expect(calls.some((call) => call.op === "clearRect")).toBe(true);
    expect(calls.some((call) => call.op === "fillRect")).toBe(false);
  });
});

describe("pixel ratio", () => {
  it("applies the ratio once, as a transform", () => {
    /*
     * Everything after this is written in CSS pixels, which is what the
     * coordinate mapping returns. Scaling each point by hand as well would
     * double the ratio and put the overlay at twice the distance from the face.
     */
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, face(), null, options());

    const transforms = calls.filter((call) => call.op === "setTransform");
    expect(transforms).toHaveLength(1);
    expect(transforms[0]?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });
});

describe("face layer", () => {
  it("draws one dot per landmark, positioned by the shared mapping", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, face(), null, options());

    const dots = calls.filter((call) => call.op === "fillRect");
    expect(dots).toHaveLength(3);

    // The camera is 720x1280 in a 390x694 box — the same 9:16, so cover neither
    // crops nor offsets, and a landmark at x=0.5 lands at the centre.
    const centre = dots[1]!;
    expect(centre.args[0]! + 1).toBeCloseTo(195, 1);
  });

  it("mirrors with the preview", () => {
    const plain = recordingContext();
    const flipped = recordingContext();

    drawTrackingOverlay(plain.context, face(), null, options());
    drawTrackingOverlay(flipped.context, face(), null, options({ geometry: { ...GEOMETRY, mirrored: true } }));

    const left = plain.calls.filter((call) => call.op === "fillRect")[0]!;
    const right = flipped.calls.filter((call) => call.op === "fillRect")[0]!;

    // A landmark at x=0.4 unmirrored and the same landmark mirrored must sit
    // symmetrically about the display width.
    expect(left.args[0]! + right.args[0]! + 2).toBeCloseTo(390, 1);
    expect(left.args[1]).toBeCloseTo(right.args[1]!, 6);
  });

  it("draws the bounds box only when the geometry supplied one", () => {
    const without = recordingContext();
    drawTrackingOverlay(without.context, face(), null, options());
    expect(without.calls.some((call) => call.op === "strokeRect")).toBe(false);

    const with_ = recordingContext();
    drawTrackingOverlay(
      with_.context,
      face({
        derived: {
          center: { x: 0.5, y: 0.35, z: 0 },
          scale: 0.1,
          yaw: 0,
          pitch: 0,
          roll: 0,
          eyeOpenness: 0.8,
          eyeOpennessLeft: 0.8,
          eyeOpennessRight: 0.8,
          mouthOpenness: 0.1,
          bounds: { minX: 0.4, minY: 0.2, maxX: 0.6, maxY: 0.5 },
        },
      }),
      null,
      options(),
    );

    const box = with_.calls.find((call) => call.op === "strokeRect");
    expect(box).toBeDefined();
    /*
     * 390x694 is very slightly taller than 9:16, so cover scales by 694/1280
     * and the frame becomes 390.375 wide — a third of a pixel is cropped. The
     * box is 0.2 of that width and 0.3 of the height, and the fractional part
     * is the crop showing up exactly where it should.
     */
    expect(box!.args[2]).toBeCloseTo(78.075, 2);
    expect(box!.args[3]).toBeCloseTo(208.2, 2);
  });

  it("respects the face toggle", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, face(), null, options({ showFace: false }));
    expect(calls.some((call) => call.op === "fillRect")).toBe(false);
  });

  it("subsamples when a budget is set", () => {
    const many = face({
      landmarks: Array.from({ length: 478 }, (_unused, index) => ({ x: index / 478, y: 0.5, z: 0 })),
    });

    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, many, null, options({ faceDotBudget: 100 }));

    const dots = calls.filter((call) => call.op === "fillRect");
    expect(dots.length).toBeLessThanOrEqual(100);
    expect(dots.length).toBeGreaterThan(90);
  });
});

describe("dot stride", () => {
  it("draws every landmark when the budget allows", () => {
    expect(faceDotStride(478, 478)).toBe(1);
    expect(faceDotStride(478, 1000)).toBe(1);
  });

  it("skips proportionally when it does not", () => {
    expect(faceDotStride(478, 100)).toBe(5);
    expect(faceDotStride(478, 239)).toBe(2);
  });

  it("never divides by zero", () => {
    expect(faceDotStride(478, 0)).toBe(1);
    expect(faceDotStride(0, 100)).toBe(1);
  });
});

describe("pose layer", () => {
  it("draws the upper-body segments and the named joints", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, pose(), options());

    expect(calls.filter((call) => call.op === "stroke")).toHaveLength(POSE_SEGMENTS.length);
    // One filled circle per named landmark, plus a stroked ring for the
    // shoulder centre when the geometry has one (it does not here).
    expect(calls.filter((call) => call.op === "fill")).toHaveLength(Object.keys(POSE_LANDMARKS).length);
  });

  it("omits a segment whose landmark is not visible", () => {
    /*
     * Half a line reads as an arm pointing somewhere it is not.
     *
     * With only the two shoulders visible, exactly one segment — the shoulder
     * line — can be drawn.
     */
    const { context, calls } = recordingContext();
    drawTrackingOverlay(
      context,
      null,
      pose({ only: [POSE_LANDMARKS.leftShoulder, POSE_LANDMARKS.rightShoulder] }),
      options(),
    );

    expect(calls.filter((call) => call.op === "stroke")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fill")).toHaveLength(2);
  });

  it("draws a landmark exactly at the visibility threshold", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, pose({ visibility: DRAW_VISIBILITY }), options());
    expect(calls.filter((call) => call.op === "stroke").length).toBeGreaterThan(0);
  });

  it("trusts a build that reports no visibility at all", () => {
    // Inventing a score would be worse than accepting the model's silence.
    const silent = pose();
    const landmarks = silent.landmarks.map((point) => ({ x: point.x, y: point.y, z: point.z }));

    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, { ...silent, landmarks }, options());
    expect(calls.filter((call) => call.op === "stroke")).toHaveLength(POSE_SEGMENTS.length);
  });

  it("marks the shoulder centre when the geometry has one", () => {
    const withCentre: PoseTrackingResult = {
      ...pose(),
      derived: {
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
      },
    };

    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, withCentre, options());

    const rings = calls.filter((call) => call.op === "arc" && call.args[2] === 7);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.args[0]).toBeCloseTo(195, 1);
  });

  it("respects the pose toggle", () => {
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, null, pose(), options({ showPose: false }));
    expect(calls.some((call) => call.op === "stroke")).toBe(false);
  });
});

describe("both layers", () => {
  it("draws the face over the pose", () => {
    // The face is the smaller, denser layer; under the skeleton it disappears.
    const { context, calls } = recordingContext();
    drawTrackingOverlay(context, face(), pose(), options());

    const lastStroke = calls.map((call) => call.op).lastIndexOf("stroke");
    const firstDot = calls.findIndex((call) => call.op === "fillRect");
    expect(firstDot).toBeGreaterThan(lastStroke);
  });

  it("restores the context even when a layer throws", () => {
    // A lost GPU context throws mid-draw. Leaving the pixel-ratio transform in
    // place would double it on the next frame that succeeded.
    const { context } = recordingContext();
    const restore = vi.fn();
    const failing = Object.assign(Object.create(Object.getPrototypeOf(context)), context, {
      restore,
      fillRect: () => {
        throw new Error("context lost");
      },
    }) as CanvasRenderingContext2D;

    expect(() => drawTrackingOverlay(failing, face(), null, options())).toThrow(/context lost/);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
