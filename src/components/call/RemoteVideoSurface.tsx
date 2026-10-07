import { useEffect, useRef, type MutableRefObject } from "react";

import { logDiagnostic } from "@/lib/utils";

interface RemoteVideoSurfaceProps {
  url: string;
  className: string;
  /** Whether to try playing with sound. Muted playback is the fallback. */
  wantsAudio: boolean;
  /** Pauses only this uploaded source while its preview reconnects. */
  paused?: boolean;
  /** Bumped by a user gesture to retry unmuted playback. */
  unmuteSignal: number;
  /**
   * Shared playback position. The element is remounted when the call swaps the
   * main surface and the tile, so the position is restored rather than restarted.
   */
  positionRef: MutableRefObject<number>;
  onAudioBlocked: (blocked: boolean) => void;
  onReady?: () => void;
  /**
   * The clip has reached its natural end.
   *
   * Owned above this component so it survives the remount that swapping the
   * surfaces causes, and passed back down so playback is not attempted again
   * on the new element.
   */
  ended?: boolean;
  /** Fired when the media reaches its natural end. */
  onEnded?: () => void;
  /** Playback time and duration, used for source-preview interruptions. */
  onPlaybackProgress?: (currentTime: number, duration: number) => void;
}

/**
 * The remote participant during a call.
 *
 * No controls: this is a person on a call, not a media player.
 *
 * It does NOT loop. The clip stands in for a person, and restarting them from
 * the top when the file runs out would be a visible lie about who is there —
 * what happens instead is the reconnecting state over the last frame they were
 * seen in. During a free uploaded-source preview, this element pauses briefly
 * at playback intervals while the rest of the call keeps running.
 *
 * Pausing is limited to the source itself; camera, call controls and the call
 * timer keep running through the reconnecting interlude.
 */
export function RemoteVideoSurface({
  url,
  className,
  wantsAudio,
  paused = false,
  unmuteSignal,
  positionRef,
  onAudioBlocked,
  onReady,
  ended = false,
  onEnded,
  onPlaybackProgress,
}: RemoteVideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    // Continue where the other surface left off.
    if (positionRef.current > 0) {
      try {
        element.currentTime = positionRef.current;
      } catch (error) {
        logDiagnostic("remote-video-seek", error);
      }
    }

    let cancelled = false;

    // Already finished. Leave the last frame exactly where it is: this runs
    // again after a swap remounts the element, and playing here would restart
    // someone who has stopped.
    if (ended || paused) return;

    const attempt = async () => {
      element.muted = !wantsAudio;
      // Belt and braces: a element left at volume 0 by anything else would be
      // silent even unmuted, and that failure is invisible.
      element.volume = 1;

      try {
        await element.play();
        if (!cancelled) onAudioBlocked(false);
      } catch (error) {
        if (cancelled) return;
        // Autoplay with sound is commonly refused. Fall back to muted playback
        // and let the caller offer a tap, rather than showing a frozen frame.
        logDiagnostic("remote-video-play", error);
        element.muted = true;
        try {
          await element.play();
          // Only "blocked" when sound was actually wanted: a source with no
          // audio track playing muted is not something to offer a tap for.
          if (!cancelled) onAudioBlocked(wantsAudio);
        } catch (mutedError) {
          logDiagnostic("remote-video-play-muted", mutedError);
        }
      }
    };

    void attempt();

    return () => {
      cancelled = true;
      positionRef.current = element.currentTime;
      element.pause();
      // Nothing may still be heard after this surface goes away. Pausing alone
      // leaves a decoded buffer attached; clearing the source releases it.
      element.muted = true;
    };
  }, [ended, onAudioBlocked, paused, positionRef, unmuteSignal, url, wantsAudio]);

  return (
    <video
      ref={videoRef}
      className={className}
      src={url}
      /*
       * Deliberately NOT `autoPlay`.
       *
       * The attribute makes the browser start playback the moment the source is
       * attached — before the effect above has decided whether this should be
       * audible. Chrome answers that unmuted attempt by refusing it, and the
       * element can then stay paused or silently muted with no rejection for us
       * to handle. Starting playback ourselves, after setting `muted`, means one
       * attempt whose outcome we actually see.
       */
      playsInline
      preload="auto"
      onTimeUpdate={(event) => {
        positionRef.current = event.currentTarget.currentTime;
        onPlaybackProgress?.(event.currentTarget.currentTime, event.currentTarget.duration);
      }}
      onCanPlay={onReady}
      onEnded={onEnded}
    />
  );
}

export default RemoteVideoSurface;
