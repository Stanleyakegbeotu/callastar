import { useCallback, useEffect, useState } from "react";
import { callBackend, getCloudCallSessionCredentials } from "@/services/callBackend";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { withDeadline } from "@/lib/withDeadline";
import { waitForRenderedFrame, videoHasFrame } from "@/services/media/renderedFrame";

export function useUploadedCallMedia(sessionId: string, enabled: boolean, suppliedUrl: string | null) {
  const [state, setState] = useState<{ url: string | null; error: boolean; hasAudio?: boolean }>({ url: null, error: false });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ url: null, error: false });
    if (!enabled) return;
    void withDeadline((async () => {
      if (suppliedUrl && nonce === 0) return { url: suppliedUrl };
      const credentials = await getCloudCallSessionCredentials(sessionId);
      if (!credentials) throw new Error("session_unavailable");
      const media = await callBackend.getSessionMedia(credentials);
      if (!media.available || !media.url) throw new Error("source_unavailable");
      return { url: media.url, hasAudio: media.hasAudio };
    })()).then(async (resolved) => {
      if (!resolved.url || cancelled) return;
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.playsInline = true;
      video.muted = true;
      video.preload = "auto";
      video.src = resolved.url;
      video.load();
      const started = performance.now();
      await video.play().catch(() => undefined);
      const metadata = new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { video.removeEventListener("loadeddata", ready); video.removeEventListener("canplay", ready); video.removeEventListener("error", failed); error ? reject(error) : resolve(); };
        const ready = () => { if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish(); };
        const failed = () => finish(new Error("source_video_failed"));
        video.addEventListener("loadeddata", ready); video.addEventListener("canplay", ready); video.addEventListener("error", failed);
        ready();
      });
      await withDeadline(metadata, 12_000);
      if (!video.paused) await waitForRenderedFrame(video, 2_000);
      if (!videoHasFrame(video)) throw new Error("source_video_frame_unavailable");
      if (!cancelled) {
        productionDiagnostic("CALL_MEDIA_READY", { kind: "call", stage: "first_frame", durationMs: performance.now() - started, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState });
        setState({ ...resolved, error: false });
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    })
      .catch(() => { productionDiagnostic("SIGNED_URL_FAILED", { kind: "call" }); if (!cancelled) setState({ url: null, error: true }); });
    return () => { cancelled = true; };
  }, [enabled, sessionId, suppliedUrl, nonce]);
  return { ...state, retry: useCallback(() => setNonce((n) => n + 1), []) };
}
