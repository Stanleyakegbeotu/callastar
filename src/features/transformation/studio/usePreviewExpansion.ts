import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Expand / minimize for the Studio preview.
 *
 * Expanding restyles the SAME stage element — the camera `<video>`, the
 * renderer canvas and its WebGL context stay mounted, so nothing restarts and
 * no second camera stream is opened. The CSS state is the source of truth; the
 * Fullscreen API is layered on where it exists. iPhone Safari has no element
 * fullscreen, so there the CSS layer alone fills the viewport.
 */
export function usePreviewExpansion(stageRef: RefObject<HTMLElement | null>) {
  const [expanded, setExpanded] = useState(false);

  const expand = useCallback(() => {
    setExpanded(true);
    const stage = stageRef.current;
    if (stage && document.fullscreenEnabled && typeof stage.requestFullscreen === "function") {
      // A refusal (no user gesture, embedded frame) leaves the CSS layer in place.
      stage.requestFullscreen().catch(() => undefined);
    }
  }, [stageRef]);

  const minimize = useCallback(() => {
    setExpanded(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    // Leaving browser fullscreen by its own gesture (Esc, swipe) minimizes too,
    // or the page would be left in a fixed overlay the browser no longer frames.
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") minimize();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, minimize]);

  // Leaving the Studio while expanded must not strand the document in fullscreen.
  useEffect(() => () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  }, []);

  return { expanded, expand, minimize };
}
