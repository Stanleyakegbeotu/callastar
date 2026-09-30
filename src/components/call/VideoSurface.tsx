import { useEffect, useRef } from "react";

import { logDiagnostic } from "@/lib/utils";

interface VideoSurfaceProps {
  /** Live local media. Ignored when `demoSrc` is set. */
  stream: MediaStream | null;
  className?: string;
  /** Self-view is normally mirrored so movement matches what the caller expects. */
  mirrored?: boolean;
  /** Development fallback: play a file instead of a MediaStream. */
  demoSrc?: string;
  title?: string;
}

/**
 * Renders a video surface, always muted.
 *
 * The local microphone track stays live for the call; it is only this element
 * that is silent, which is what prevents the caller hearing themselves. The
 * stream is attached through `srcObject` — never converted to a blob or URL.
 */
export function VideoSurface({ stream, className = "", mirrored = false, demoSrc, title }: VideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const classes = [className, mirrored ? "video-mirrored" : ""].filter(Boolean).join(" ");

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    // Belt and braces for iOS: React sets `muted` as a property, and inline
    // playback of an unmuted video is refused outright.
    element.muted = true;

    if (demoSrc) return;

    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }

    if (stream) {
      // Autoplay can still be refused (backgrounded tab, reduced power mode).
      // An AbortError just means the element was re-attached mid-play, which is
      // exactly what a picture-in-picture swap does, so it is not worth logging.
      void Promise.resolve(element.play()).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        logDiagnostic("video-play", error);
      });
    }

    return () => {
      element.srcObject = null;
    };
  }, [stream, demoSrc]);

  return (
    <video
      ref={videoRef}
      className={classes}
      src={demoSrc}
      loop={demoSrc ? true : undefined}
      autoPlay
      muted
      playsInline
      preload="auto"
      title={title}
    />
  );
}

export default VideoSurface;
