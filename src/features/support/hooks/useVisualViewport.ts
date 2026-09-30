import { useEffect } from "react";

/**
 * Keep a chat usable while the on-screen keyboard is open.
 *
 * On iOS the keyboard does not shrink the layout viewport: `100vh` stays the
 * full screen height, so a composer pinned to the bottom ends up underneath the
 * keyboard. The visual viewport does report the real visible height, so it is
 * published as `--app-visual-height` for the chat shell to size itself with.
 *
 * `offsetTop` matters too: iOS scrolls the whole page when a focused field would
 * be hidden, and without compensating for that the header drifts off the top.
 */
export function useVisualViewport(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const apply = () => {
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--app-visual-height", `${Math.round(height)}px`);
      root.style.setProperty("--app-visual-offset", `${Math.round(viewport?.offsetTop ?? 0)}px`);
    };

    apply();

    viewport?.addEventListener("resize", apply);
    viewport?.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);

    return () => {
      viewport?.removeEventListener("resize", apply);
      viewport?.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      // Hand the height back, so a screen that is not a chat is not constrained
      // by whatever the keyboard last left behind.
      root.style.removeProperty("--app-visual-height");
      root.style.removeProperty("--app-visual-offset");
    };
  }, [enabled]);
}
