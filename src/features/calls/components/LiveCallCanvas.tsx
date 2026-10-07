import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { formatDuration, getInitials } from "@/lib/utils";

import { RtcVideo } from "./RtcVideo";
import { UploadedCallVideo } from "./UploadedCallVideo";
import { ReconnectingOverlay } from "./CallOverlays";

export interface LiveCallCanvasProps {
  uploadedSource?: boolean;
  uploadedUrl?: string | null;
  uploadedError?: boolean;
  onRetryUploaded?: () => void;
  /** Who is on the other end, for the top bar and the waiting state. */
  remoteName: string;
  remoteShortName: string;
  remoteAvatarUrl?: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** True once a remote track has actually arrived. */
  hasRemoteMedia: boolean;
  /** Seconds since the call connected. */
  seconds: number;
  micEnabled: boolean;
  cameraEnabled: boolean;
  canSwitchCamera: boolean;
  /** Video calls show camera controls; audio calls do not. */
  showCameraControls: boolean;
  /** Real RTC trouble, already debounced by the engine. */
  reconnecting: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onEnd: () => void;
  /** The subscription checkpoint, which renders over a call that keeps running. */
  overlay?: React.ReactNode;
  /** True while the checkpoint owns the screen, so it outranks reconnecting. */
  checkpointVisible?: boolean;
}

/**
 * The live call, edge to edge on phones and computers.
 *
 * Used by both the caller and the operator. The composition is identical on both
 * screens — the remote participant fills the frame and you are in the corner — so
 * there is one canvas and the two sides simply pass different streams to it.
 */
export function LiveCallCanvas({
  uploadedSource = false,
  uploadedUrl = null,
  uploadedError = false,
  onRetryUploaded = () => {},
  remoteName,
  remoteShortName,
  remoteAvatarUrl,
  localStream,
  remoteStream,
  hasRemoteMedia,
  seconds,
  micEnabled,
  cameraEnabled,
  canSwitchCamera,
  showCameraControls,
  reconnecting,
  onToggleMic,
  onToggleCamera,
  onSwitchCamera,
  onEnd,
  overlay,
  checkpointVisible = false,
}: LiveCallCanvasProps) {
  const { t } = useTranslation();
  /**
   * Which participant is large. Presentation only — swapping reassigns two
   * streams between two elements and touches nothing else: no getUserMedia, no
   * renegotiation, no timer reset.
   */
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [playSignal, setPlaySignal] = useState(0);

  const mainStream = remoteStream;

  /**
   * The checkpoint takes visual priority over reconnecting, so the two are never
   * on screen together saying different things about the same call.
   */
  const showReconnecting = reconnecting && !checkpointVisible;

  return (
    <main className="live-call">
      <div className="live-call-stage">
        {uploadedSource ? <UploadedCallVideo url={uploadedUrl} failed={uploadedError} onRetry={onRetryUploaded} className="live-call-main" /> : hasRemoteMedia ? (
          <RtcVideo
            key="main-remote"
            stream={mainStream}
            className="live-call-main"
            muted={false}
            mirrored={false}
            playSignal={playSignal}
            onBlocked={setAudioBlocked}
          />
        ) : (
          // Before the first remote frame: the person, not a black rectangle.
          <div className="live-call-waiting">
            {remoteAvatarUrl ? (
              <img className="live-call-waiting-backdrop" src={remoteAvatarUrl} alt="" aria-hidden="true" />
            ) : null}
            <span className="live-call-waiting-avatar">
              {remoteAvatarUrl ? <img src={remoteAvatarUrl} alt="" /> : getInitials(remoteName)}
            </span>
            <p className="live-call-waiting-name">{remoteName}</p>
            <p className="live-call-waiting-status" role="status" aria-live="polite">
              {t("liveCall.connecting")}
            </p>
          </div>
        )}
        <div className="live-call-vignette" aria-hidden="true" />
      </div>

      <header className="live-call-topbar">
        <span className="live-call-identity">{remoteName}</span>
        <span className="live-call-meta">
          <span className="live-call-secure">
            <Icon name="lock" className="size-3" />
            {t("liveCall.encrypted")}
          </span>
          {/* Not a live region: announcing a timer every second would make the
              screen reader useless for anything else. */}
          <span className="live-call-timer">{formatDuration(seconds)}</span>
        </span>
      </header>

      {audioBlocked && (
        <button type="button" className="live-call-unmute" onClick={() => setPlaySignal((value) => value + 1)}>
          {t("call.tapToHear")}
        </button>
      )}

      {showCameraControls && (
        <div className="live-call-pip" aria-label={`${t("liveCall.you")}; ${remoteShortName} is in the main view`}>
          {localStream ? (
            <RtcVideo
              key="pip-local"
              stream={localStream}
              className="live-call-pip-video"
              muted
              mirrored
            />
          ) : (
            <span className="live-call-pip-off">
              <Icon name="cameraOff" className="size-5" />
            </span>
          )}
          <span className="live-call-pip-name">{t("liveCall.you")}</span>
        </div>
      )}

      <div className="live-call-controls">
        <button
          type="button"
          className={`call-control ${micEnabled ? "" : "is-on"}`.trim()}
          onClick={onToggleMic}
          aria-pressed={!micEnabled}
          aria-label={micEnabled ? t("call.microphoneOn") : t("call.microphoneMuted")}
        >
          <Icon name={micEnabled ? "mic" : "micOff"} className="size-6" />
        </button>

        {showCameraControls && (
          <button
            type="button"
            className={`call-control ${cameraEnabled ? "" : "is-on"}`.trim()}
            onClick={onToggleCamera}
            aria-pressed={!cameraEnabled}
            aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
          >
            <Icon name={cameraEnabled ? "camera" : "cameraOff"} className="size-6" />
          </button>
        )}

        {showCameraControls && canSwitchCamera && (
          <button type="button" className="call-control" onClick={onSwitchCamera} aria-label="Flip camera">
            <Icon name="flip" className="size-6" />
          </button>
        )}

        <button
          type="button"
          className="call-control is-end"
          onClick={onEnd}
          aria-label={t("liveCall.endedTitle")}
        >
          <Icon name="phoneOff" className="size-6" />
        </button>
      </div>

      {showReconnecting && <ReconnectingOverlay />}
      {overlay}
    </main>
  );
}

export default LiveCallCanvas;
