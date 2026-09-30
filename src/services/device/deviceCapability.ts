/**
 * Which kind of device this is, for product capability gating and nothing else.
 *
 * CallaStar video calls are a mobile-phone product: the composition is 9:16 and
 * both participants hold a phone. Audio calls have no such constraint and run
 * everywhere. This module is the single place that decides which is which.
 *
 * Deliberately NOT fingerprinting. Every signal read here is a coarse capability
 * the browser advertises for exactly this purpose — is this a handheld, is the
 * pointer a finger, how big is the screen. Nothing is hashed, combined into an
 * identifier, stored or sent anywhere: the only output is one of four words.
 *
 * Viewport width is deliberately not a signal. A desktop browser narrowed to
 * 390px is still a desktop, and resizing a window must never turn an unsupported
 * device into a supported one — so classification reads the physical screen,
 * which a resize does not change.
 */

export type CallDeviceClass = "mobile-phone" | "tablet" | "desktop" | "unknown";

/**
 * Longest short-edge, in CSS pixels, that still reads as a phone.
 *
 * The largest phones sit around 430 (iPhone Pro Max); the smallest tablets
 * around 744 (iPad mini). 500 divides them with room on both sides.
 */
const PHONE_MAX_SHORT_EDGE = 500;

/** The slice of the UA-Client-Hints API worth reading; not in lib.dom yet. */
interface UserAgentDataLike {
  mobile?: boolean;
  platform?: string;
}

function readUserAgentData(): UserAgentDataLike | null {
  if (typeof navigator === "undefined") return null;
  const hint = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData;
  return hint ?? null;
}

function matchesMedia(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * Shortest edge of the physical screen, not of the window. This is what makes
 * the classification survive a resize.
 */
function screenShortEdge(): number {
  if (typeof window === "undefined" || !window.screen) return 0;
  const { width, height } = window.screen;
  if (!width || !height) return 0;
  return Math.min(width, height);
}

function touchPoints(): number {
  if (typeof navigator === "undefined") return 0;
  return navigator.maxTouchPoints ?? 0;
}

/**
 * Everything the classification is allowed to look at.
 *
 * Gathered by `classify()` and passed in explicitly so the decision itself is a
 * pure function — which is what makes it testable, and what keeps the list of
 * signals honest and visible in one place.
 */
export interface DeviceSignals {
  userAgent: string;
  maxTouchPoints: number;
  coarsePointer: boolean;
  /** Shortest edge of the PHYSICAL screen, not of the window. */
  screenShortEdge: number;
  /** `navigator.userAgentData.mobile`, where the browser provides it. */
  uaDataMobile: boolean | undefined;
}

export function classifyDevice(signals: DeviceSignals): CallDeviceClass {
  const { userAgent: ua, maxTouchPoints: points, screenShortEdge: shortEdge, uaDataMobile } = signals;

  if (ua === "") return "unknown";

  // Android states its own form factor: the "Mobile" token means a phone, and
  // its absence on an Android browser means a tablet.
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "mobile-phone" : "tablet";

  if (/iPhone|iPod/i.test(ua)) return "mobile-phone";
  if (/iPad/i.test(ua)) return "tablet";

  // iPadOS 13+ presents itself as desktop Safari on a Macintosh. No Mac has a
  // touchscreen, so a Macintosh reporting multiple touch points is an iPad.
  if (/Macintosh/i.test(ua) && points > 1) return "tablet";

  if (/Windows Phone|IEMobile/i.test(ua)) return "mobile-phone";

  // The client hint knows handheld from not, but not phone from tablet.
  if (uaDataMobile === true) {
    return shortEdge > 0 && shortEdge <= PHONE_MAX_SHORT_EDGE ? "mobile-phone" : "tablet";
  }
  if (uaDataMobile === false) return "desktop";

  if (/Mobi/i.test(ua)) return "mobile-phone";

  // Nothing identified itself. A finger-driven touchscreen on a small physical
  // screen is a phone whose UA we simply do not recognise; larger is a tablet.
  if (signals.coarsePointer && points > 0) {
    return shortEdge > 0 && shortEdge <= PHONE_MAX_SHORT_EDGE ? "mobile-phone" : "tablet";
  }

  return "desktop";
}

function readSignals(): DeviceSignals {
  return {
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent || "",
    maxTouchPoints: touchPoints(),
    coarsePointer: matchesMedia("(pointer: coarse)"),
    screenShortEdge: screenShortEdge(),
    uaDataMobile: readUserAgentData()?.mobile,
  };
}

function classify(): CallDeviceClass {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "unknown";
  return classifyDevice(readSignals());
}

export interface DeviceCapabilities {
  deviceClass: CallDeviceClass;
  /** A finger rather than a mouse. */
  coarsePointer: boolean;
  touchCapable: boolean;
  /** Shortest edge of the physical screen, in CSS pixels. 0 when unknown. */
  screenShortEdge: number;
  /** getUserMedia and WebRTC both require one. `localhost` counts. */
  secureContext: boolean;
  hasGetUserMedia: boolean;
  hasPeerConnection: boolean;
}

function detect(): DeviceCapabilities {
  return {
    deviceClass: classify(),
    coarsePointer: matchesMedia("(pointer: coarse)"),
    touchCapable: touchPoints() > 0,
    screenShortEdge: screenShortEdge(),
    secureContext: typeof window !== "undefined" ? window.isSecureContext === true : false,
    hasGetUserMedia:
      typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
    hasPeerConnection: typeof window !== "undefined" && typeof window.RTCPeerConnection === "function",
  };
}

/**
 * Detected once per page load.
 *
 * None of the inputs change while a tab is open — the UA does not change, and
 * neither does the physical screen — so re-reading them would only invite a
 * resize to produce a different answer than the one the call started with.
 */
let cached: DeviceCapabilities | null = null;

export function getDeviceCapabilities(): DeviceCapabilities {
  cached ??= detect();
  return cached;
}

export function getCallDeviceClass(): CallDeviceClass {
  return getDeviceCapabilities().deviceClass;
}

/**
 * Why a call type cannot run here.
 *
 * `device-class` is a product decision and gets the "open this on your phone"
 * screen. The other two are genuine technical dead ends and have to read
 * differently: telling somebody to use their phone when the real problem is that
 * the page is not on HTTPS would send them in the wrong direction.
 */
export type CallSupportReason = "device-class" | "insecure-context" | "unsupported-browser";

export type CallSupportVerdict = { supported: true } | { supported: false; reason: CallSupportReason };

const SUPPORTED: CallSupportVerdict = { supported: true };

function technicalVerdict(capabilities: DeviceCapabilities): CallSupportVerdict | null {
  if (!capabilities.hasGetUserMedia || !capabilities.hasPeerConnection) {
    return { supported: false, reason: "unsupported-browser" };
  }
  if (!capabilities.secureContext) return { supported: false, reason: "insecure-context" };
  return null;
}

/**
 * Video calling is a phone product, on both sides of the call.
 *
 * Tablet is deliberately excluded. The requirement names iPhone and Android
 * phones, and quietly widening a product rule to "anything with a touchscreen"
 * is not this module's decision to make. Audio remains available there.
 */
export function videoCallSupport(
  capabilities: DeviceCapabilities = getDeviceCapabilities(),
): CallSupportVerdict {
  const technical = technicalVerdict(capabilities);
  if (technical) return technical;
  if (capabilities.deviceClass !== "mobile-phone") return { supported: false, reason: "device-class" };
  return SUPPORTED;
}

/** Audio calling runs on every device class, phone through desktop. */
export function audioCallSupport(
  capabilities: DeviceCapabilities = getDeviceCapabilities(),
): CallSupportVerdict {
  return technicalVerdict(capabilities) ?? SUPPORTED;
}

export function callSupport(
  callType: "video" | "audio",
  capabilities: DeviceCapabilities = getDeviceCapabilities(),
): CallSupportVerdict {
  return callType === "video" ? videoCallSupport(capabilities) : audioCallSupport(capabilities);
}

/** Test seam: drops the cached detection so a suite can vary the environment. */
export function resetDeviceCapabilitiesForTest(): void {
  cached = null;
}
