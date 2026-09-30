import { describe, expect, it } from "vitest";

import { checkPortraitSource, describeAspect } from "./mediaFiles";

/**
 * The portrait rule for a call source.
 *
 * Tested from the dimensions rather than from a file, because the dimensions are
 * the whole rule — a filename proves nothing, and a `.mp4` extension is not a
 * shape. `validateCallSourceVideo` reads real dimensions out of the browser and
 * then asks exactly this function.
 */
describe("portrait call-source validation", () => {
  it("accepts the recommended and common portrait encodes", () => {
    // Section 46. 1080×1920 is exactly 9:16; 720×1280 is too.
    expect(checkPortraitSource(1080, 1920).ok).toBe(true);
    expect(checkPortraitSource(720, 1280).ok).toBe(true);
    expect(checkPortraitSource(540, 960).ok).toBe(true);
  });

  it("rejects landscape outright", () => {
    // There is no honest way to rescue these: stretching distorts a face and
    // letterboxing leaves a small picture in a black field.
    for (const [width, height] of [
      [1920, 1080],
      [1280, 720],
      [640, 480],
    ] as const) {
      const result = checkPortraitSource(width, height);
      expect(result.ok, `${width}×${height} should be rejected`).toBe(false);
      if (!result.ok) expect(result.reason).toBe("landscape");
    }
  });

  it("rejects a square video, which is not portrait", () => {
    const result = checkPortraitSource(1080, 1080);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("landscape");
  });

  it("rejects portrait shapes that are too far from 9:16", () => {
    // 3:4 is portrait but nothing like 9:16, and filling a 9:16 frame with it
    // would crop most of a face away.
    const threeFour = checkPortraitSource(1080, 1440);
    expect(threeFour.ok).toBe(false);
    if (!threeFour.ok) expect(threeFour.reason).toBe("aspect");

    // Taller than 9:16 is equally wrong in the other direction.
    const tall = checkPortraitSource(1080, 2400);
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.reason).toBe("aspect");
  });

  it("tolerates the small drift real encoders produce", () => {
    // The tolerance exists for crops and odd encoder output, not for 3:4.
    expect(checkPortraitSource(720, 1281).ok).toBe(true);
    expect(checkPortraitSource(1080, 1850).ok).toBe(true);
    expect(checkPortraitSource(1170, 2032).ok).toBe(true);
  });

  it("reports unknown dimensions separately from a wrong shape", () => {
    // An unreadable header is our limitation, not the operator's, so it must be
    // distinguishable from a video that is genuinely the wrong shape.
    for (const [width, height] of [
      [null, null],
      [1080, null],
      [null, 1920],
      [0, 0],
    ] as const) {
      const result = checkPortraitSource(width, height);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unknown");
    }
  });
});

describe("aspect description", () => {
  it("reduces real dimensions to a readable ratio", () => {
    expect(describeAspect(1080, 1920)).toBe("9:16");
    expect(describeAspect(1920, 1080)).toBe("16:9");
    expect(describeAspect(1080, 1440)).toBe("3:4");
    expect(describeAspect(1080, 1080)).toBe("1:1");
  });

  it("says so when it cannot tell", () => {
    expect(describeAspect(null, null)).toBe("Unknown");
    expect(describeAspect(0, 1920)).toBe("Unknown");
  });
});
