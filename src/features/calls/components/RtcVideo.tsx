import { useEffect, useRef, useState } from "react";

import { callError } from "@/lib/callDiagnostics";

interface RtcVideoProps {
  stream: MediaStream | null;
  className?: string;
  /** A self-view is muted: playing your own microphone back is feedback. */
  muted?: boolean;
  /** Self-views are mirrored, the way every call app shows you to yourself. */
  mirrored?: boolean;
  /** Bumped by a tap, to retry playback the browser refused. */
  playSignal?: number;
  /** Told when autoplay was blocked, so the UI can offer a tap. */
  onBlocked?: (blocked: boolean) => void;
}

/**
 * A live WebRTC stream in a video element.
 *
 * Attached with `srcObject`, never an object URL — a MediaStream is a live handle,
 * not a file, and `createObjectURL` on one has been removed from browsers.
 *
 * The element is deliberately stable: the stream is assigned through a ref in an
 * effect, so a re-render from the call timer ticking cannot remount it. Remounting
 * a video element mid-call is a black flash and, on iOS, a fresh autoplay fight.
 */
export function RtcVideo({
  stream,
  className = "",
  muted = false,
  mirrored = false,
  playSignal = 0,
  onBlocked,
}: RtcVideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Kept in a ref so changing the callback cannot re-run the attach effect.
  const report = useRef(onBlocked);
  report.current = onBlocked;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Only reassign when it is genuinely a different stream. Setting srcObject to
    // the same object restarts playback for no reason.
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    if (!stream) return;

    /**
     * Autoplay with sound is refused unless the browser is satisfied a person
     * asked for it. Here they did — they tapped Call or Answer — but that gesture
     * does not always carry this far, so a refusal is handled rather than thrown.
     */
    const attempt = () => {
      void element.play().then(
        () => {
          setBlocked(false);
          report.current?.(false);
        },
        (error: unknown) => {
          setBlocked(true);
          report.current?.(true);
          callError("video-play", error);
        },
      );
    };

    attempt();
  }, [stream, playSignal]);

  return (
    <video
      ref={ref}
      className={`${className} ${mirrored ? "is-mirrored" : ""} ${blocked ? "is-blocked" : ""}`.trim()}
      // playsInline on both sides: without it iOS takes a call fullscreen into
      // its native player and the call UI disappears behind it.
      playsInline
      autoPlay
      muted={muted}
      // Nothing here is a file, so there is nothing to download or cast.
      disablePictureInPicture
      controls={false}
    />
  );
}

export default RtcVideo;
