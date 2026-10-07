import { useState } from "react";

import { formatDateTime, formatFileSize } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import type { HostProfile } from "@/services/admin/types";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { MediaBadge } from "../components/StatusBadge";
import { useToast } from "../components/ToastProvider";
import { useAssetMeta, useAssetPlayback, useFilePreview } from "../hooks/useAdminData";
import { AudioUpload } from "./AudioUpload";

interface RemoteAudioCardProps {
  profile: HostProfile;
  onChanged: (profile: HostProfile) => void;
}

function describeDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The one voice a profile is heard with on an audio call.
 *
 * Same shape as the video card, and for the same reason: replacement is choose
 * then confirm, and the repository swaps the file in one transaction so a
 * failed replacement leaves the working audio in place.
 *
 * Unlike the video this is optional. A profile with no audio is still reachable
 * — an audio call to it falls back to the soundtrack of its video.
 */
export function RemoteAudioCard({ profile, onChanged }: RemoteAudioCardProps) {
  const toast = useToast();
  const playback = useAssetPlayback(profile.remoteAudioAssetId);
  const audioUrl = playback.url;
  const { data: meta } = useAssetMeta(profile.remoteAudioAssetId);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingPreview = useFilePreview(pendingFile);

  const closeReplace = () => {
    setReplaceOpen(false);
    setPendingFile(null);
  };

  const save = async () => {
    if (!pendingFile) return;
    setBusy(true);
    try {
      const updated = await adminRepository.setRemoteAudio(profile.id, pendingFile);
      onChanged(updated);
      toast.success(profile.remoteAudioAssetId ? "Audio call voice updated." : "Audio call voice uploaded.");
      closeReplace();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that audio file.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const updated = await adminRepository.removeRemoteAudio(profile.id);
      onChanged(updated);
      toast.success("Audio call voice removed.");
      setRemoveOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that audio file.");
    } finally {
      setBusy(false);
    }
  };

  const duration = describeDuration(meta?.durationSeconds ?? null);

  return (
    <section className="admin-card">
      <div className="admin-card-heading">
        <h2 className="admin-card-label">Audio call voice</h2>
        <MediaBadge present={profile.remoteAudioAssetId !== null} />
      </div>
      <p className="admin-hint">Played as the other participant once an audio call connects.</p>

      {profile.remoteAudioAssetId ? (
        <>
          {audioUrl ? (
            <audio className="admin-audio-preview" src={audioUrl} onError={playback.fail} controls preload="metadata" />
          ) : (
            <div className="admin-audio-placeholder">{playback.error ?? "Loading audio…"}{playback.error && <button className="admin-button admin-button-secondary" onClick={playback.retry}>Retry</button>}</div>
          )}

          {meta && (
            <dl className="admin-meta-grid">
              <div>
                <dt>File</dt>
                <dd>{meta.fileName}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatFileSize(meta.fileSize)}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>{meta.mimeType || "Unknown"}</dd>
              </div>
              {duration && (
                <div>
                  <dt>Duration</dt>
                  <dd>{duration}</dd>
                </div>
              )}
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(meta.updatedAt)}</dd>
              </div>
            </dl>
          )}

          <div className="admin-card-actions">
            <button type="button" className="admin-button admin-button-secondary" onClick={() => setReplaceOpen(true)}>
              Replace audio
            </button>
            <button type="button" className="admin-button admin-button-ghost" onClick={() => setRemoveOpen(true)}>
              Remove audio
            </button>
          </div>
        </>
      ) : (
        <div className="admin-inline-empty">
          <p>No audio yet. Audio calls will use the soundtrack of this profile&apos;s video instead.</p>
          <button type="button" className="admin-button admin-button-primary" onClick={() => setReplaceOpen(true)}>
            Upload audio
          </button>
        </div>
      )}

      <ConfirmDialog
        open={replaceOpen}
        title={profile.remoteAudioAssetId ? "Replace audio call voice" : "Upload audio call voice"}
        confirmLabel={profile.remoteAudioAssetId ? "Replace audio" : "Upload audio"}
        confirmDisabled={!pendingFile}
        busy={busy}
        onCancel={closeReplace}
        onConfirm={() => void save()}
      >
        {meta && (
          <p className="admin-hint">
            Current: {meta.fileName} · {formatFileSize(meta.fileSize)}
          </p>
        )}
        <AudioUpload file={pendingFile} previewUrl={pendingPreview} onSelect={setPendingFile} disabled={busy} />
        {profile.remoteAudioAssetId && (
          <p className="admin-warning">Replacing this changes what callers hear on audio calls to this profile.</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={removeOpen}
        title="Remove audio call voice?"
        confirmLabel="Remove audio"
        destructive
        busy={busy}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => void remove()}
      >
        <p>Audio calls to this profile will fall back to the soundtrack of its video.</p>
      </ConfirmDialog>
    </section>
  );
}

export default RemoteAudioCard;
