import { useEffect, useState } from "react";

/**
 * Whether a portrait-only call is currently being held sideways.
 *
 * The web cannot be trusted to lock orientation. `screen.orientation.lock()` is
 * unavailable in ordinary mobile browsing on iOS and requires fullscreen on
 * Android, so it is not a solution — it is an optimisation that sometimes
 * applies. The UI guard is authoritative, and this hook is what drives it.
 *
 * Crucially it only reports. Nothing here touches the peer connection, the
 * microphone or the session: turning a phone sideways must never drop a call.
 */

function isLandscape(): boolean {
  if (typeof window === "undefined") return false;

  // Prefer the media query: it is the same signal CSS sees, so the overlay and
  // the layout can never disagree about which way up the phone is.
  if (typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(orientation: landscape)").matches;
    } catch {
      // Fall through to the dimensions.
    }
  }

  return window.innerWidth > window.innerHeight;
}

export function useOrientationGuard(armed: boolean): boolean {
  const [landscape, setLandscape] = useState(() => armed && isLandscape());

  useEffect(() => {
    if (!armed) {
      setLandscape(false);
      return undefined;
    }

    const update = () => setLandscape(isLandscape());
    update();

    // Several signals because no single one fires reliably everywhere: iOS
    // Safari is late with `orientationchange`, and some Android browsers only
    // resize.
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(orientation: landscape)") : null;
    query?.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    return () => {
      query?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [armed]);

  return armed && landscape;
}

/**
 * Asks the browser to stay portrait, where it is allowed to.
 *
 * Entirely best-effort and feature-detected. A refusal is the normal case in a
 * browser tab, which is exactly why the visual guard above is the real mechanism
 * rather than a fallback.
 */
export function requestPortraitLock(): void {
  if (typeof screen === "undefined") return;

  const orientation = (
    screen as Screen & {
      orientation?: { lock?: (value: string) => Promise<void> };
    }
  ).orientation;

  if (typeof orientation?.lock !== "function") return;

  // A rejection is expected and deliberately swallowed: no call depends on this.
  void orientation.lock("portrait").catch(() => {});
}
