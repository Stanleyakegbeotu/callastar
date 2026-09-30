import { useCallback, useEffect, useRef, useState } from "react";

import { CallControls } from "@/components/call/CallControls";
import { RemoteVideoSurface } from "@/components/call/RemoteVideoSurface";
import { Avatar } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { formatDuration } from "@/lib/utils";
import type { HostPreview } from "@/types/host";
import type { LocalMediaController } from "@/types/media";

import { useCallTimer } from "./hooks/useCallTimer";
import type { RemoteVideoState } from "./hooks/useRemoteVideo";

interface ActiveAudioCallPageProps {
  host: HostPreview;
  media: LocalMediaController;
  remote: RemoteVideoState;
  callStatus: "connecting" | "ringing" | "active";
  startedAt: number | null;
  onEnd: () => void;
  /** Rendered over the call, which keeps running underneath it. */
  accessOverlay?: React.ReactNode;
  /** Suppresses reconnecting while the subscription checkpoint is visible. */
  subscriptionChecking?: boolean;
  /** Natural clip end is recorded by the route, as with video calls. */
  onRemoteEnded?: () => void;
}

/**
 * The audio call.
 *
 * No camera is ever requested for this flow, so there is nothing to show but
 * the person being called: avatar, name, state, and how long it has been going.
 *
 * The host profile may have an uploaded video. Its picture is deliberately not
 * shown here — that would make an audio call look like a video one — but its
 * sound is played, hidden behind the avatar, so the call is not silent. A
 * browser may still refuse to start audio without a gesture, which is what the
 * "Tap to hear audio" control is for; real two-way audio arrives with WebRTC.
 */
export function ActiveAudioCallPage({
  host,
  media,
  remote,
  callStatus,
  startedAt,
  onEnd,
  accessOverlay,
  subscriptionChecking = false,
  onRemoteEnded,
}: ActiveAudioCallPageProps) {
  const [speakerOn, setSpeakerOn] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [unmuteSignal, setUnmuteSignal] = useState(0);
  const remotePosition = useRef(0);
  const remoteEndedRef = useRef(false);
  const [remoteEnded, setRemoteEnded] = useState(false);
  const seconds = useCallTimer(startedAt, callStatus === "active" && startedAt !== null);

  const handleAudioBlocked = useCallback((blocked: boolean) => setAudioBlocked(blocked), []);

  const active = callStatus === "active";
  const showReconnecting = remoteEnded && active && !subscriptionChecking;
  const remoteAudioReady = active && remote.status === "ready" && remote.url !== null && remote.hasAudio;
  const handleRemoteEnded = useCallback(() => {
    if (remoteEndedRef.current) return;
    remoteEndedRef.current = true;
    setRemoteEnded(true);
    onRemoteEnded?.();
  }, [onRemoteEnded]);

  useEffect(() => {
    remoteEndedRef.current = false;
    setRemoteEnded(false);
  }, [remote.url]);

  const statusLine = active
    ? formatDuration(seconds)
    : callStatus === "connecting"
      ? "Connecting…"
      : "Ringing…";

  return (
    <main className="audio-call">
      <div className="audio-call-body">
        <Avatar src={host.avatarUrl} alt="" pulse={callStatus === "ringing"} />
        <h1 className="audio-call-name">{host.displayName}</h1>
        <p className="audio-call-status" role="status" aria-live="polite">
          {active ? <span className="admin-visually-hidden">Call duration </span> : null}
          {statusLine}
        </p>

        {!active && (
          <span className="wave-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}

        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          {media.micEnabled ? "Microphone on" : "Microphone muted"}
        </div>

        {remoteAudioReady && (
          <p className="audio-preview-note">
            <Icon name="info" className="size-4" />
            Preview session
          </p>
        )}

        {audioBlocked && (
          <button type="button" className="audio-unmute" onClick={() => setUnmuteSignal((value) => value + 1)}>
            Tap to hear audio
          </button>
        )}

        {showReconnecting && (
          <p className="audio-reconnecting" role="status" aria-live="polite">
            Reconnecting… <span>Restoring your connection</span>
          </p>
        )}
      </div>

      {remoteAudioReady && remote.url && (
        // Present for its sound only: it stays transparent behind the avatar
        // rather than being removed from layout, which keeps playback reliable.
        <RemoteVideoSurface
          url={remote.url}
          className="audio-remote-media"
          wantsAudio={speakerOn}
          unmuteSignal={unmuteSignal}
          positionRef={remotePosition}
          onAudioBlocked={handleAudioBlocked}
          ended={remoteEnded}
          onEnded={handleRemoteEnded}
        />
      )}

      <CallControls
        media={media}
        speakerOn={speakerOn}
        onToggleSpeaker={() => setSpeakerOn(!speakerOn)}
        onEnd={onEnd}
        showCameraControls={false}
        className="audio-call-controls"
      />

      {accessOverlay}
    </main>
  );
}

export default ActiveAudioCallPage;
