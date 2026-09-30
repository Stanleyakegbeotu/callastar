import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { formatDuration, getInitials } from "@/lib/utils";

import { RtcVideo } from "./RtcVideo";
import { ReconnectingOverlay } from "./CallOverlays";

export interface AudioCallCanvasProps {
  remoteName: string;
  remoteAvatarUrl?: string;
  /** Carries the remote audio. Attached to a hidden element — see below. */
  remoteStream: MediaStream | null;
  seconds: number;
  micEnabled: boolean;
  /** Whether the browser exposes any audio output routing at all. */
  canSelectOutput: boolean;
  reconnecting: boolean;
  onToggleMic: () => void;
  onEnd: () => void;
  overlay?: React.ReactNode;
  checkpointVisible?: boolean;
}

/**
 * An audio call, on any device.
 *
 * Deliberately NOT the video canvas with the picture switched off. There is no
 * stage, no self-view and no camera controls, because none of those mean anything
 * here — a call with no video should not look like a video call that has failed.
 *
 * The composition is centred and identical on a phone and a desktop; only the
 * scale changes. That is what makes this feel like one product rather than a
 * mobile screen stretched across a monitor.
 */
export function AudioCallCanvas({
  remoteName,
  remoteAvatarUrl,
  remoteStream,
  seconds,
  micEnabled,
  canSelectOutput,
  reconnecting,
  onToggleMic,
  onEnd,
  overlay,
  checkpointVisible = false,
}: AudioCallCanvasProps) {
  const { t } = useTranslation();
  const showReconnecting = reconnecting && !checkpointVisible;

  return (
    <main className="audio-call">
      {/* The host's picture, blurred far past recognition, so the screen has depth
          without pretending to be a video call. */}
      {remoteAvatarUrl && (
        <div
          className="audio-call-backdrop"
          aria-hidden="true"
          style={{ backgroundImage: `url(${remoteAvatarUrl})` }}
        />
      )}
      <div className="audio-call-veil" aria-hidden="true" />

      {/*
        The remote audio has to live in a media element to be heard. A <video>
        element with no video track plays audio perfectly well and, unlike
        <audio>, reliably honours `playsInline` on iOS — so this is one element
        that behaves the same everywhere rather than two code paths.
      */}
      <RtcVideo stream={remoteStream} className="audio-call-sink" />

      <div className="audio-call-body">
        <span className={`audio-call-avatar ${showReconnecting ? "" : "is-live"}`.trim()}>
          {remoteAvatarUrl ? <img src={remoteAvatarUrl} alt="" /> : getInitials(remoteName)}
        </span>

        <h1 className="audio-call-name">{remoteName}</h1>

        <p className="audio-call-kind">
          <Icon name="audio" className="size-4" />
          {t("audioCall.label")}
        </p>

        {/* Not a live region: a timer announced every second would make a screen
            reader useless for anything else on the call. */}
        <p className="audio-call-timer">{formatDuration(seconds)}</p>

        <p className="audio-call-secure">
          <Icon name="lock" className="size-3" />
          {t("liveCall.encrypted")}
        </p>
      </div>

      <div className="audio-call-controls">
        <div className="audio-call-control">
          <button
            type="button"
            className={`call-control ${micEnabled ? "" : "is-on"}`.trim()}
            onClick={onToggleMic}
            aria-pressed={!micEnabled}
            aria-label={micEnabled ? t("call.microphoneOn") : t("call.microphoneMuted")}
          >
            <Icon name={micEnabled ? "mic" : "micOff"} className="size-6" />
          </button>
          <span className="call-round-label">{micEnabled ? t("audioCall.mute") : t("audioCall.unmute")}</span>
        </div>

        {/*
          Output routing is only offered where the browser actually exposes it.
          `setSinkId` does not exist in iOS Safari, and a speaker button that
          silently does nothing is worse than no button — so it is absent rather
          than disabled, and the call never depends on it.
        */}
        {canSelectOutput && (
          <div className="audio-call-control">
            <button type="button" className="call-control" aria-label={t("audioCall.output")}>
              <Icon name="speaker" className="size-6" />
            </button>
            <span className="call-round-label">{t("audioCall.output")}</span>
          </div>
        )}

        <div className="audio-call-control">
          <button
            type="button"
            className="call-control is-end"
            onClick={onEnd}
            aria-label={t("liveCall.endedTitle")}
          >
            <Icon name="phoneOff" className="size-6" />
          </button>
          <span className="call-round-label">{t("audioCall.end")}</span>
        </div>
      </div>

      {showReconnecting && <ReconnectingOverlay />}
      {overlay}
    </main>
  );
}

export default AudioCallCanvas;
