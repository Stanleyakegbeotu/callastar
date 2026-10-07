import { useEffect, useRef, useState } from "react";
import { productionDiagnostic } from "@/lib/productionDiagnostics";

export function UploadedCallVideo({ url, failed, onRetry, className }: { url: string | null; failed: boolean; onRetry: () => void; className: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [ended, setEnded] = useState(false);
  useEffect(() => { setReady(false); setError(false); setBlocked(false); setEnded(false); }, [url]);
  const play = () => { void ref.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true)); };
  return <>
    {url && <video ref={ref} src={url} className={className} crossOrigin="anonymous" autoPlay playsInline preload="auto" onEnded={() => setEnded(true)}
      onCanPlay={() => {
        const v = ref.current;
        if (!v?.videoWidth || !v.videoHeight) return;
        setReady(true); productionDiagnostic("CALL_MEDIA_READY", { width: v.videoWidth, height: v.videoHeight, readyState: v.readyState }); play();
      }}
      onError={() => { setError(true); productionDiagnostic("MEDIA_LOAD_FAILED", { kind: "call" }); }} />}
    {(failed || error) ? <div className="live-call-media-status" role="alert">Unable to load the host video.<button onClick={() => { setError(false); onRetry(); }}>Retry</button></div>
      : ended ? <div className="live-call-media-status" role="status">Host video has ended.</div>
      : blocked ? <button className="live-call-unmute" onClick={play}>Tap to play host video</button>
      : !ready ? <div className="live-call-media-status" role="status">Loading host video…</div> : null}
  </>;
}
export default UploadedCallVideo;
