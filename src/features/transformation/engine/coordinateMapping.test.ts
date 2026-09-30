import { describe, expect, it } from "vitest";

import {
  computeFitRect,
  computeOverlayCanvasSize,
  computeTrackingSize,
  isPointVisible,
  mapNormalizedToDisplay,
  type DisplayGeometry,
} from "./coordinateMapping";

/**
 * Coordinate mapping.
 *
 * An overlay offset by twenty pixels is not acceptable, and every way it goes
 * wrong is invisible until someone looks at their own face: the crop from
 * `object-fit: cover`, the front camera's mirroring, a phone's pixel ratio.
 * Each is pinned here with arithmetic that can be checked by hand.
 */

function geometry(overrides: Partial<DisplayGeometry> = {}): DisplayGeometry {
  return {
    sourceWidth: 640,
    sourceHeight: 480,
    displayWidth: 640,
    displayHeight: 480,
    objectFit: "cover",
    mirrored: false,
    ...overrides,
  };
}

describe("exact-fit mapping", () => {
  it("maps the corners and centre when source and display match", () => {
    const g = geometry();

    expect(mapNormalizedToDisplay({ x: 0, y: 0 }, g)).toEqual({ x: 0, y: 0 });
    expect(mapNormalizedToDisplay({ x: 1, y: 1 }, g)).toEqual({ x: 640, y: 480 });
    expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g)).toEqual({ x: 320, y: 240 });
  });
});

describe("object-fit cover", () => {
  it("crops the wider axis when a landscape camera fills a portrait box", () => {
    /*
     * A 640×480 camera in a 390×844 portrait preview.
     *
     * Cover scales by the larger factor — 844/480 = 1.7583 — so the frame
     * becomes 1125.33×844. That is 735.33px wider than the box, and the offset
     * centres it: −367.67 on each side. A landmark at the centre stays centred;
     * one at the left edge sits off screen.
     */
    const g = geometry({ displayWidth: 390, displayHeight: 844 });
    const rect = computeFitRect(g);

    expect(rect.scale).toBeCloseTo(844 / 480, 4);
    expect(rect.width).toBeCloseTo(1125.33, 1);
    expect(rect.height).toBeCloseTo(844, 1);
    expect(rect.offsetX).toBeCloseTo((390 - 1125.33) / 2, 1);
    expect(rect.offsetY).toBeCloseTo(0, 5);

    expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g).x).toBeCloseTo(195, 1);
    expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g).y).toBeCloseTo(422, 1);

    // The left edge of the frame was cropped away.
    expect(mapNormalizedToDisplay({ x: 0, y: 0.5 }, g).x).toBeLessThan(0);
  });

  it("crops the taller axis when a portrait camera fills a landscape box", () => {
    // 720×1280 phone camera into a 1280×720 desktop preview.
    const g = geometry({ sourceWidth: 720, sourceHeight: 1280, displayWidth: 1280, displayHeight: 720 });
    const rect = computeFitRect(g);

    expect(rect.scale).toBeCloseTo(1280 / 720, 4);
    expect(rect.offsetY).toBeLessThan(0);
    expect(rect.offsetX).toBeCloseTo(0, 5);

    expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g)).toEqual({ x: 640, y: 360 });
  });
});

describe("object-fit contain", () => {
  it("letterboxes instead of cropping", () => {
    // Same 640×480 camera in a 390×844 box, but contained: scale 390/640, so
    // the frame is 390×292.5 with bars above and below.
    const g = geometry({ displayWidth: 390, displayHeight: 844, objectFit: "contain" });
    const rect = computeFitRect(g);

    expect(rect.scale).toBeCloseTo(390 / 640, 4);
    expect(rect.offsetX).toBeCloseTo(0, 5);
    expect(rect.offsetY).toBeGreaterThan(0);

    // Every landmark is on screen, because nothing was cropped.
    expect(mapNormalizedToDisplay({ x: 0, y: 0 }, g).x).toBeCloseTo(0, 5);
    expect(mapNormalizedToDisplay({ x: 1, y: 1 }, g).x).toBeCloseTo(390, 5);
  });
});

describe("front-camera mirroring", () => {
  it("flips horizontally and leaves the vertical alone", () => {
    /*
     * The model never sees the mirrored image.
     *
     * The flip belongs here, at the display boundary — mirroring the video with
     * CSS *and* the landmarks separately is how an overlay ends up correct on
     * one axis and inverted on the other.
     */
    const g = geometry({ mirrored: true });

    expect(mapNormalizedToDisplay({ x: 0, y: 0.25 }, g)).toEqual({ x: 640, y: 120 });
    expect(mapNormalizedToDisplay({ x: 1, y: 0.25 }, g)).toEqual({ x: 0, y: 120 });
    // The centre is its own mirror image.
    expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g)).toEqual({ x: 320, y: 240 });
  });

  it("is the exact inverse of the unmirrored mapping", () => {
    const plain = geometry({ displayWidth: 390, displayHeight: 844 });
    const flipped = geometry({ displayWidth: 390, displayHeight: 844, mirrored: true });

    for (const nx of [0, 0.2, 0.5, 0.8, 1]) {
      const a = mapNormalizedToDisplay({ x: nx, y: 0.5 }, plain);
      const b = mapNormalizedToDisplay({ x: nx, y: 0.5 }, flipped);
      expect(a.x + b.x, `x=${nx} should mirror about the display width`).toBeCloseTo(390, 4);
      expect(a.y).toBeCloseTo(b.y, 6);
    }
  });

  it("leaves a rear camera unmirrored", () => {
    const g = geometry({ mirrored: false });
    expect(mapNormalizedToDisplay({ x: 0, y: 0 }, g).x).toBe(0);
  });
});

describe("visibility", () => {
  it("reports a cropped landmark as off screen", () => {
    // With cover, a landmark can be perfectly valid and still not be visible —
    // drawing it anyway puts a dot on the bezel.
    const g = geometry({ displayWidth: 390, displayHeight: 844 });

    expect(isPointVisible(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, g), g)).toBe(true);
    expect(isPointVisible(mapNormalizedToDisplay({ x: 0.02, y: 0.5 }, g), g)).toBe(false);
  });
});

describe("degenerate geometry", () => {
  it("returns a zero rect rather than NaN before the video has dimensions", () => {
    // A video element reports 0×0 until metadata loads, and the overlay may
    // measure before then.
    for (const bad of [
      geometry({ sourceWidth: 0 }),
      geometry({ sourceHeight: 0 }),
      geometry({ displayWidth: 0 }),
      geometry({ displayHeight: 0 }),
    ]) {
      const rect = computeFitRect(bad);
      expect(rect.scale).toBe(0);
      expect(mapNormalizedToDisplay({ x: 0.5, y: 0.5 }, bad)).toEqual({ x: 0, y: 0 });
    }
  });
});

describe("tracking frame size", () => {
  it("preserves aspect ratio for a portrait phone camera", () => {
    /*
     * The decision that keeps the mapping simple.
     *
     * Forcing 720×1280 into a 640×480 landscape surface would squash every face
     * by 40% before the model saw it, and no mapping afterwards could undo that.
     */
    const size = computeTrackingSize(720, 1280, 640);

    expect(size.height).toBe(640);
    expect(size.width).toBe(360);
    expect(size.width / size.height).toBeCloseTo(720 / 1280, 3);
  });

  it("preserves aspect ratio for a landscape webcam", () => {
    const size = computeTrackingSize(1920, 1080, 640);
    expect(size.width).toBe(640);
    expect(size.height).toBe(360);
    expect(size.width / size.height).toBeCloseTo(16 / 9, 2);
  });

  it("never upscales a camera smaller than the cap", () => {
    // Enlarging costs inference time for no extra detail.
    const size = computeTrackingSize(320, 240, 640);
    expect(size).toEqual({ width: 320, height: 240 });
  });

  it("gives a portrait and a landscape camera a comparable pixel budget", () => {
    const portrait = computeTrackingSize(720, 1280, 640);
    const landscape = computeTrackingSize(1280, 720, 640);
    expect(portrait.width * portrait.height).toBe(landscape.width * landscape.height);
  });

  it("returns zero for degenerate input", () => {
    expect(computeTrackingSize(0, 480, 640)).toEqual({ width: 0, height: 0 });
    expect(computeTrackingSize(640, 480, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("overlay canvas backing store", () => {
  it("scales by device pixel ratio so lines are not soft", () => {
    const size = computeOverlayCanvasSize(390, 844, 3);
    // Capped at 2: 3× of a large canvas is a lot of pixels to clear per frame
    // for a few dots.
    expect(size.ratio).toBe(2);
    expect(size.width).toBe(780);
    expect(size.height).toBe(1688);
  });

  it("never drops below 1×", () => {
    const size = computeOverlayCanvasSize(390, 844, 0.5);
    expect(size.ratio).toBe(1);
    expect(size.width).toBe(390);
  });

  it("survives an undefined pixel ratio", () => {
    const size = computeOverlayCanvasSize(390, 844, Number.NaN);
    expect(size.ratio).toBe(1);
    expect(Number.isFinite(size.width)).toBe(true);
  });
});
