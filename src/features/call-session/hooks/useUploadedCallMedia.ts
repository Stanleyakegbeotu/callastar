import { useCallback, useEffect, useState } from "react";
import { callBackend, getCloudCallSessionCredentials } from "@/services/callBackend";
import { productionDiagnostic } from "@/lib/productionDiagnostics";
import { withDeadline } from "@/lib/withDeadline";

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
    })()).then((media) => { if (!cancelled) setState({ ...media, error: false }); })
      .catch(() => { productionDiagnostic("SIGNED_URL_FAILED", { kind: "call" }); if (!cancelled) setState({ url: null, error: true }); });
    return () => { cancelled = true; };
  }, [enabled, sessionId, suppliedUrl, nonce]);
  return { ...state, retry: useCallback(() => setNonce((n) => n + 1), []) };
}
