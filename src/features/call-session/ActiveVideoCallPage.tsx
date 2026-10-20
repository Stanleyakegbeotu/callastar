import { useCallback, useEffect, useRef, useState } from "react";

import { CallControls } from "@/components/call/CallControls";
import { CallStatus } from "@/components/call/CallStatus";
import { ParticipantTile } from "@/components/call/ParticipantTile";
import { RemoteVideoSurface } from "@/components/call/RemoteVideoSurface";
import { VideoSurface } from "@/components/call/VideoSurface";
import { Icon } from "@/components/ui/Icon";
import { config } from "@/lib/config";
import type { CallType } from "@/types/call";
import type { HostPreview } from "@/types/host";
import type { LocalMediaController } from "@/types/media";
import { isInsideInterruption, type SourceInterruption } from "@/services/media/interruptionTimeline";

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
  onSourcePlaying?: () => void;
  onSourceError?: () => void;
  /** Private uploaded source playback for production calls. */
  uploadedMedia?: { url: string | null; error: boolean; hasAudio?: boolean; interruptions?: SourceInterruption[]; retry: () => void };
}

/**
 * The live call.
 *
 * The main surface is the selected host source. The caller's camera stays in PiP.
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
  onSourcePlaying,
  onSourceError,
  uploadedMedia,
}: ActiveVideoCallPageProps) {
  // The self-view tile: which corner it is parked in, and its drag gestures.
  const pip = useDraggablePip();
  // Intent only: browsers cannot route audio output the way a native app can.
  // See the note in CallControls.
  const [speakerOn, setSpeakerOn] = useState(true);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [unmuteSignal, setUnmuteSignal] = useState(0);
  const [remotePlayable, setRemotePlayable] = useState(false);
  const [interruptionActive, setInterruptionActive] = useState(false);
  /**
   * The remote clip has run out.
   *
   * Owned here rather than inside the surface, because swapping the
   * participants remounts that element — the state has to follow the remote
   * PERSON, not whichever box they happen to be in.
   */
  const [remoteEnded, setRemoteEnded] = useState(false);
  const remoteEndedRef = useRef(false);
  const onRemoteEndedRef = useRef(onRemoteEnded);
  onRemoteEndedRef.current = onRemoteEnded;
  // Survives the remount that swapping causes, so the clip does not restart.
  const remotePosition = useRef(0);
  const seconds = useCallTimer(startedAt, callStatus === "active" && startedAt !== null);

  const isVideoCall = callType === "video";
  const showLocalVideo = media.cameraEnabled && media.stream !== null;
  const effectiveRemoteUrl = uploadedMedia ? uploadedMedia.url : remote.url;
  const remoteReady = callStatus === "active" && (uploadedMedia ? effectiveRemoteUrl !== null : remote.status === "ready" && effectiveRemoteUrl !== null);

  const handleAudioBlocked = useCallback((blocked: boolean) => setAudioBlocked(blocked), []);
  const handleRemoteReady = useCallback(() => setRemotePlayable(true), []);
  const interruptionRanges = uploadedMedia?.interruptions ?? remote.interruptions ?? [];
  const handlePlaybackProgress = useCallback((currentTime: number) => {
    setInterruptionActive(isInsideInterruption(currentTime * 1000, interruptionRanges));
  }, [interruptionRanges]);
  const handleRemoteEnded = useCallback(() => {
    // StrictMode and surface swaps can repeat `ended`; record only the edge.
    if (remoteEndedRef.current) return;
    remoteEndedRef.current = true;
    setRemoteEnded(true);
    onRemoteEndedRef.current?.();
  }, []);

  useEffect(() => {
    remoteEndedRef.current = false;
    setRemoteEnded(false);
  }, [effectiveRemoteUrl]);

  const localVideo = (className: string) => <VideoSurface className={className} stream={media.stream} mirrored={config.mirrorLocalVideo} />;

  const remoteVideo = (className: string) =>
    remoteReady && effectiveRemoteUrl ? (
      <RemoteVideoSurface
        url={effectiveRemoteUrl}
        className={`${className} remote-fade-in`}
        wantsAudio={speakerOn && (uploadedMedia?.hasAudio ?? remote.hasAudio)}
        paused={remoteEnded}
        unmuteSignal={unmuteSignal}
        positionRef={remotePosition}
        onAudioBlocked={handleAudioBlocked}
        onReady={handleRemoteReady}
        ended={remoteEnded}
        onEnded={handleRemoteEnded}
        onPlaying={onSourcePlaying}
        onError={onSourceError}
        onPlaybackProgress={handlePlaybackProgress}
        interruptions={interruptionRanges}
      />
    ) : null;

  const hostImage = (className: string) => (
    <img className={className} src={host.avatarUrl} alt={`${host.shortName} on camera`} />
  );

  const uploadedSourceStatus = uploadedMedia && callStatus === "active" && !remoteReady
    ? uploadedMedia.error
      ? <div className="remote-source-status" role="status"><span>Video could not be loaded.</span><button type="button" onClick={uploadedMedia.retry}>Retry</button></div>
      : <div className="remote-source-status" role="status"><span>Loading video…</span></div>
    : null;

  /** The host's selected source always occupies the main surface. */
  const mainSurface = () => {
    return (
      <>
          {/* The avatar fills the frame behind the fitted video, blurred, so
              the letterboxing reads as depth rather than as black bars. */}
          {hostImage("main-video main-video-backdrop")}
          {remoteVideo("main-video main-video-overlay")}
          {uploadedSourceStatus}
      </>
    );
  };

  return (
    <main className="active-call">
      <div className="call-main-slot">
        {mainSurface()}
        <div className="video-vignette" />
        {interruptionActive && callStatus === "active" && (
          <div className="source-interruption-overlay" role="status" aria-live="polite">
            <span className="source-interruption-spinner" aria-hidden="true" />
            <span>Resuming call…</span>
          </div>
        )}
      </div>
      <CallStatus displayName={host.displayName} seconds={seconds} status={callStatus} />

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
        <ParticipantTile label="You" pip={pip}>
          {showLocalVideo ? localVideo("pip-video") : <span className="pip-camera-off"><Icon name="cameraOff" className="size-5" /></span>}
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
