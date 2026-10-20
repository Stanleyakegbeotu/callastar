import { isUsableSourceVideo } from "@/services/media/sourcePlayback";
import { isInsideInterruption, type SourceInterruption } from "@/services/media/interruptionTimeline";
import { useCallback, useEffect, useRef, useState } from "react";
import { productionDiagnostic } from "@/lib/productionDiagnostics";

interface UploadedCallVideoProps {
  url: string | null;
  failed: boolean;
  onRetry: () => void;
  onEnded?: () => void;
  onPlaying?: () => void;
  onMediaError?: () => void;
  className: string;
  interruptions?: SourceInterruption[];
}

export function UploadedCallVideo({ url, failed, onRetry, onEnded, onPlaying, onMediaError, className, interruptions = [] }: UploadedCallVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [ended, setEnded] = useState(false);
  const [interruptionActive, setInterruptionActive] = useState(false);
  const interruptionRef = useRef(false);
  const rangesRef = useRef(interruptions);
  rangesRef.current = interruptions;

  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    ref.current = video;
    if (video) video.muted = isInsideInterruption(video.currentTime * 1000, rangesRef.current);
  }, []);

  useEffect(() => {
    setReady(false); setError(false); setBlocked(false); setEnded(false);
    setInterruptionActive(false); interruptionRef.current = false;
  }, [url]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    let frameId: number | null = null;
    let animationFrame = 0;
    const requestFrame = video.requestVideoFrameCallback?.bind(video);
    const report = (time: number) => {
      const active = isInsideInterruption(time * 1000, rangesRef.current);
      video.muted = active;
      if (interruptionRef.current !== active) {
        interruptionRef.current = active;
        setInterruptionActive(active);
      }
    };
    const onTimeUpdate = () => report(video.currentTime);
    video.addEventListener("timeupdate", onTimeUpdate);
    report(video.currentTime);

    if (requestFrame) {
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        if (cancelled) return;
        report(metadata.mediaTime);
        frameId = requestFrame(onFrame);
      };
      frameId = requestFrame(onFrame);
    } else {
      const tick = () => {
        if (cancelled) return;
        report(video.currentTime);
        animationFrame = requestAnimationFrame(tick);
      };
      animationFrame = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
      cancelAnimationFrame(animationFrame);
    };
  }, [url]);

  const play = () => { void ref.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true)); };
  return <>
    {url && <video ref={attachVideo} src={url} className={className} crossOrigin="anonymous" loop={false} autoPlay playsInline preload="auto" onEnded={() => { setEnded(true); onEnded?.(); }} onPlaying={() => { const v = ref.current; if (v && isUsableSourceVideo(v)) onPlaying?.(); else onMediaError?.(); }}
      onCanPlay={() => {
        const v = ref.current;
        if (!v?.videoWidth || !v.videoHeight) return;
        setReady(true); productionDiagnostic("CALL_MEDIA_READY", { width: v.videoWidth, height: v.videoHeight, readyState: v.readyState }); play();
      }}
      onError={() => { setError(true); onMediaError?.(); productionDiagnostic("MEDIA_LOAD_FAILED", { kind: "call" }); }} />}
    {interruptionActive && <div className="source-interruption-overlay" role="status" aria-live="polite"><span className="source-interruption-spinner" aria-hidden="true" /><span>Resuming call…</span></div>}
    {(failed || error) ? <div className="live-call-media-status" role="alert">Unable to load the host video.<button onClick={() => { setError(false); onRetry(); }}>Retry</button></div>
      : ended ? <div className="live-call-media-status" role="status">Host video has ended.</div>
      : blocked ? <button className="live-call-unmute" onClick={play}>Tap to play host video</button>
      : !ready ? <div className="live-call-media-status" role="status">Loading host video…</div> : null}
  </>;
}
export default UploadedCallVideo;
