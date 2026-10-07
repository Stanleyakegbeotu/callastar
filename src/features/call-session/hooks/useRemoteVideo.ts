import { useEffect, useState } from "react";

import { logDiagnostic } from "@/lib/utils";
import { callBackend } from "@/services/callBackend";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";

export interface RemoteVideoState {
  status: "idle" | "loading" | "ready" | "unavailable";
  url: string | null;
  hasAudio: boolean;
}

const IDLE: RemoteVideoState = { status: "idle", url: null, hasAudio: false };

/**
 * The remote participant's video, fetched only once a call is actually active.
 *
 * Nothing is loaded while connecting or ringing: those screens show the host
 * avatar, and pulling a video file early would both waste bandwidth and risk it
 * starting before anyone has answered.
 *
 * The object URL created here is revoked when the call ends, when the host
 * changes, or when this screen unmounts — there is exactly one per blob.
 */
export function useRemoteVideo(host: HostPreview | null, enabled: boolean, callType: CallType, sessionId?: string): RemoteVideoState {
  const [state, setState] = useState<RemoteVideoState>(IDLE);

  useEffect(() => {
    if (!enabled || !host) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading", url: null, hasAudio: false });

    void callBackend
      .getRemoteMedia(host, callType, sessionId)
      .then((media) => {
        if (cancelled) return;

        if (!media.available) {
          setState({ status: "unavailable", url: null, hasAudio: false });
          return;
        }

        if (media.blob) {
          objectUrl = URL.createObjectURL(media.blob);
          setState({ status: "ready", url: objectUrl, hasAudio: media.hasAudio });
          return;
        }

        // A signed URL from a backend: nothing local to revoke.
        setState({ status: media.url ? "ready" : "unavailable", url: media.url ?? null, hasAudio: media.hasAudio });
      })
      .catch((error: unknown) => {
        logDiagnostic("remote-video", error);
        if (!cancelled) setState({ status: "unavailable", url: null, hasAudio: false });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setState(IDLE);
    };
    // `host` lives in reducer state, so its identity only changes when the
    // session actually points at a different profile.
  }, [callType, enabled, host, sessionId]);

  return state;
}
