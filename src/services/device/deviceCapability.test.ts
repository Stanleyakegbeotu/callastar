import { describe, expect, it } from "vitest";

import {
  audioCallSupport,
  callSupport,
  classifyDevice,
  videoCallSupport,
  type DeviceCapabilities,
  type DeviceSignals,
} from "./deviceCapability";

/** Real user-agent strings, so the patterns are tested against what browsers send. */
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  androidTabletChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipadOsDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
} as const;

function signals(overrides: Partial<DeviceSignals> = {}): DeviceSignals {
  return {
    userAgent: UA.windowsChrome,
    maxTouchPoints: 0,
    coarsePointer: false,
    screenShortEdge: 1080,
    uaDataMobile: undefined,
    ...overrides,
  };
}

function capabilities(overrides: Partial<DeviceCapabilities> = {}): DeviceCapabilities {
  return {
    deviceClass: "mobile-phone",
    coarsePointer: true,
    touchCapable: true,
    screenShortEdge: 390,
    secureContext: true,
    hasGetUserMedia: true,
    hasPeerConnection: true,
    ...overrides,
  };
}

describe("device classification", () => {
  it("recognises the two phone browsers the product targets", () => {
    expect(classifyDevice(signals({ userAgent: UA.iphoneSafari, maxTouchPoints: 5, coarsePointer: true, screenShortEdge: 393 }))).toBe(
      "mobile-phone",
    );
    expect(classifyDevice(signals({ userAgent: UA.androidChrome, maxTouchPoints: 5, coarsePointer: true, screenShortEdge: 412 }))).toBe(
      "mobile-phone",
    );
  });

  it("separates an Android tablet from an Android phone by its own token", () => {
    expect(classifyDevice(signals({ userAgent: UA.androidTabletChrome, maxTouchPoints: 5, coarsePointer: true, screenShortEdge: 800 }))).toBe(
      "tablet",
    );
  });

  it("recognises an iPad even in desktop mode", () => {
    // iPadOS 13+ sends a Macintosh user agent. No Mac has a touchscreen, so the
    // touch points are what give it away.
    expect(classifyDevice(signals({ userAgent: UA.ipadSafari, maxTouchPoints: 5, coarsePointer: true, screenShortEdge: 820 }))).toBe("tablet");
    expect(
      classifyDevice(signals({ userAgent: UA.ipadOsDesktopMode, maxTouchPoints: 5, coarsePointer: true, screenShortEdge: 820 })),
    ).toBe("tablet");
  });

  it("keeps a real Mac a desktop", () => {
    expect(classifyDevice(signals({ userAgent: UA.macSafari, maxTouchPoints: 0, screenShortEdge: 900 }))).toBe("desktop");
  });

  it("stays desktop when the window is narrowed to phone width", () => {
    // Classification reads the physical screen, independently of browser width.
    const narrowed = signals({
      userAgent: UA.windowsChrome,
      screenShortEdge: 1080,
      maxTouchPoints: 0,
      coarsePointer: false,
    });
    expect(classifyDevice(narrowed)).toBe("desktop");
    expect(videoCallSupport(capabilities({ deviceClass: "desktop" }))).toEqual({ supported: true });
  });

  it("does not let a desktop touchscreen become a phone", () => {
    // A touch-enabled laptop has a coarse pointer available but a large screen.
    expect(classifyDevice(signals({ userAgent: UA.windowsChrome, maxTouchPoints: 10, coarsePointer: true, screenShortEdge: 1080 }))).toBe(
      "tablet",
    );
  });

  it("trusts the client hint when it says not handheld", () => {
    expect(classifyDevice(signals({ uaDataMobile: false, coarsePointer: true, maxTouchPoints: 5 }))).toBe("desktop");
  });

  it("uses the screen to split a handheld hint into phone or tablet", () => {
    expect(classifyDevice(signals({ userAgent: "Opaque/1.0", uaDataMobile: true, screenShortEdge: 390 }))).toBe("mobile-phone");
    expect(classifyDevice(signals({ userAgent: "Opaque/1.0", uaDataMobile: true, screenShortEdge: 834 }))).toBe("tablet");
  });

  it("answers unknown rather than guessing with no user agent", () => {
    expect(classifyDevice(signals({ userAgent: "" }))).toBe("unknown");
  });
});

describe("call support policy", () => {
  it("allows video on every device class with browser media support", () => {
    for (const deviceClass of ["mobile-phone", "tablet", "desktop", "unknown"] as const) {
      expect(videoCallSupport(capabilities({ deviceClass }))).toEqual({ supported: true });
    }
  });

  it("allows audio on every device class", () => {
    // Section 4: desktop must not be accidentally blocked from audio calling.
    for (const deviceClass of ["mobile-phone", "tablet", "desktop", "unknown"] as const) {
      expect(audioCallSupport(capabilities({ deviceClass }))).toEqual({ supported: true });
    }
  });

  it("reports an insecure context as its own problem, not as a device problem", () => {
    // Section 101: telling somebody to use their phone when the real issue is
    // that the page is not on HTTPS sends them in the wrong direction.
    const insecure = capabilities({ deviceClass: "mobile-phone", secureContext: false });
    expect(videoCallSupport(insecure)).toEqual({ supported: false, reason: "insecure-context" });
    expect(audioCallSupport(insecure)).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("reports a browser without WebRTC as unsupported", () => {
    const noRtc = capabilities({ hasPeerConnection: false });
    expect(videoCallSupport(noRtc)).toEqual({ supported: false, reason: "unsupported-browser" });

    const noMedia = capabilities({ hasGetUserMedia: false });
    expect(audioCallSupport(noMedia)).toEqual({ supported: false, reason: "unsupported-browser" });
  });

  it("requires a secure context on every device class", () => {
    const both = capabilities({ deviceClass: "desktop", secureContext: false });
    expect(videoCallSupport(both)).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("routes by call type", () => {
    const desktop = capabilities({ deviceClass: "desktop" });
    expect(callSupport("video", desktop).supported).toBe(true);
    expect(callSupport("audio", desktop).supported).toBe(true);
  });
});
