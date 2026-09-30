import { useCallback, useEffect, useRef, useState } from "react";

import { CallControls } from "@/components/call/CallControls";
import { CallStatus } from "@/components/call/CallStatus";
import { ParticipantTile } from "@/components/call/ParticipantTile";
import { RemoteConnectionState } from "@/components/call/RemoteConnectionState";
import { RemoteVideoSurface } from "@/components/call/RemoteVideoSurface";
import { VideoSurface } from "@/components/call/VideoSurface";
import { Icon } from "@/components/ui/Icon";
import { DEMO_VIDEO_SRC, config } from "@/lib/config";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";
import type { LocalMediaController } from "@/types/media";

import { useCallTimer } from "./hooks/useCallTimer";
import { useDraggablePip } from "./hooks/useDraggablePip";
import type { CallAccessGate } from "./hooks/useCallAccessGate";
import type { RemoteVideoState } from "./hooks/useRemoteVideo";

interface ActiveVideoCallPageProps {
  host: HostPreview;
  media: LocalMediaController;
  remote: RemoteVideoState;
  callType: CallType;
  callStatus: "connecting" | "ringing" | "active";
  startedAt: number | null;
  onEnd: () => void;
  /** Rendered over the call canvas, which keeps running underneath it. */
  accessOverlay?: React.ReactNode;
  /**
   * True while the subscription checkpoint is on screen. It takes precedence
   * over the reconnecting state, so the two are never shown together.
   */
  subscriptionChecking?: boolean;
  /** Told when the remote clip reaches its natural end. */
  onRemoteEnded?: () => void;
}

/**
 * The live call.
 *
 * The main surface is the caller's own camera, straight from the MediaStream.
 * The remote participant is the video uploaded for this profile in the admin
 * dashboard; before the call is active — and until the video can actually
 * play — the profile avatar holds the frame and the video fades in over it.
 */
export function ActiveVideoCallPage({
  host,
  media,
  remote,
  callType,
  callStatus,
  startedAt,
  onEnd,
  accessOverlay,
  subscriptionChecking = false,
  onRemoteEnded,
}: ActiveVideoCallPageProps) {
  const [swapped, setSwapped] = useState(false);
  // The self-view tile: which corner it is parked in, and its drag gestures.
  const pip = useDraggablePip();
  // Intent only: browsers cannot route audio output the way a native app can.
  // See the note in CallControls.
  const [speakerOn, setSpeakerOn] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [unmuteSignal, setUnmuteSignal] = useState(0);
  const [remotePlayable, setRemotePlayable] = useState(false);
  /**
   * The remote clip has run out.
   *
   * Owned here rather than inside the surface, because swapping the
   * participants remounts that element — the state has to follow the remote
   * PERSON, not whichever box they happen to be in.
   */
  const [remoteEnded, setRemoteEnded] = useState(false);
  const remoteEndedRef = useRef(false);
  // Survives the remount that swapping causes, so the clip does not restart.
  const remotePosition = useRef(0);
  const seconds = useCallTimer(startedAt, callStatus === "active" && startedAt !== null);

  const isVideoCall = callType === "video";
  const showLocalVideo = media.cameraEnabled && (config.enableDemoVideo || media.stream !== null);
  const remoteReady = callStatus === "active" && remote.status === "ready" && remote.url !== null;
  const showReconnecting = remoteEnded && callStatus === "active" && !subscriptionChecking;

  const handleAudioBlocked = useCallback((blocked: boolean) => setAudioBlocked(blocked), []);
  const handleRemoteReady = useCallback(() => setRemotePlayable(true), []);
  const handleRemoteEnded = useCallback(() => {
    // StrictMode and surface swaps can repeat `ended`; record only the edge.
    if (remoteEndedRef.current) return;
    remoteEndedRef.current = true;
    setRemoteEnded(true);
    onRemoteEnded?.();
  }, [onRemoteEnded]);

  useEffect(() => {
    remoteEndedRef.current = false;
    setRemoteEnded(false);
  }, [remote.url]);

  const localVideo = (className: string) =>
    config.enableDemoVideo ? (
      <VideoSurface className={className} stream={null} demoSrc={DEMO_VIDEO_SRC} title="Demo footage" />
    ) : (
      <VideoSurface className={className} stream={media.stream} mirrored={config.mirrorLocalVideo} />
    );

  const remoteVideo = (className: string) =>
    remoteReady && remote.url ? (
      <RemoteVideoSurface
        url={remote.url}
        className={`${className} remote-fade-in ${swapped ? "main-video-fit" : ""}`.trim()}
        wantsAudio={speakerOn && remote.hasAudio}
        unmuteSignal={unmuteSignal}
        positionRef={remotePosition}
        onAudioBlocked={handleAudioBlocked}
        onReady={handleRemoteReady}
        ended={remoteEnded}
        onEnded={handleRemoteEnded}
      />
    ) : null;

  const hostImage = (className: string) => (
    <img className={className} src={host.avatarUrl} alt={`${host.shortName} on camera`} />
  );

  /** Whichever participant is currently large. */
  const mainSurface = () => {
    if (!isVideoCall || swapped) {
      return (
        <>
          {/* The avatar fills the frame behind the fitted video, blurred, so
              the letterboxing reads as depth rather than as black bars. */}
          {hostImage("main-video main-video-backdrop")}
          {remoteVideo("main-video main-video-overlay")}
          {showReconnecting && <RemoteConnectionState variant="main" />}
        </>
      );
    }

    if (showLocalVideo) return localVideo("main-video");

    return (
      <div className="camera-off-state">
        <div className="camera-off-icon">
          <Icon name="cameraOff" className="size-8" />
        </div>
        <div>Your camera is off</div>
      </div>
    );
  };

  return (
    <main className="active-call">
      <div className="call-main-slot">
        {mainSurface()}
        <div className="video-vignette" />
      </div>
      {config.enableDemoVideo && isVideoCall && !swapped && (
        <div className="demo-badge">Demo footage — live camera disabled</div>
      )}
      <CallStatus displayName={host.displayName} seconds={seconds} status={callStatus} />

      {callStatus === "active" && remoteReady && (
        <p className="preview-chip">
          <Icon name="info" className="size-4" />
          Preview session
        </p>
      )}

      {audioBlocked && remotePlayable && (
        <button type="button" className="remote-audio-chip" onClick={() => setUnmuteSignal((value) => value + 1)}>
          Tap to hear audio
        </button>
      )}

      {isVideoCall && callStatus !== "active" && (
        <div className="remote-connecting-tile" aria-live="polite">
          <img src={host.avatarUrl} alt="" />
          <div className="remote-connecting-overlay">
            <span className="remote-connecting-spinner" aria-hidden="true" />
            <span>{callStatus === "connecting" ? "Connecting…" : "Ringing…"}</span>
          </div>
          <span className="pip-name">{host.shortName}</span>
        </div>
      )}

      {isVideoCall && callStatus === "active" && (
        <ParticipantTile label={swapped ? "You" : host.shortName} pip={pip} onSwap={() => setSwapped(!swapped)}>
          {swapped ? (
            showLocalVideo ? (
              // Same MediaStream as the main surface, simply attached to the
              // smaller element — the camera is never opened twice.
              localVideo("pip-video")
            ) : (
              <span className="pip-camera-off">
                <Icon name="cameraOff" className="size-5" />
              </span>
            )
          ) : (
            <>
              <img src={host.avatarUrl} alt={`${host.shortName} video preview`} />
              {remoteVideo("pip-video pip-video-overlay")}
              {showReconnecting && <RemoteConnectionState variant="tile" />}
              {remote.status === "unavailable" && <span className="pip-note">No video</span>}
            </>
          )}
        </ParticipantTile>
      )}

      <CallControls
        media={media}
        speakerOn={speakerOn}
        onToggleSpeaker={() => setSpeakerOn(!speakerOn)}
        onEnd={onEnd}
        showCameraControls={isVideoCall}
      />

      {accessOverlay}
    </main>
  );
}

export default ActiveVideoCallPage;
