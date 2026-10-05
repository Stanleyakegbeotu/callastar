import { useState } from "react";

import { formatDateTime, formatFileSize } from "@/lib/utils";
import { describeAspect } from "@/services/admin/mediaFiles";
import { mediaAssetProvider } from "@/services/media/mediaAssetProvider";
import { adminRepository } from "@/services/admin/repository";
import type { HostProfile } from "@/services/admin/types";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { MediaBadge } from "../components/StatusBadge";
import { useToast } from "../components/ToastProvider";
import { useAssetMeta, useAssetUrl, useFilePreview } from "../hooks/useAdminData";
import { VideoUpload } from "./VideoUpload";

interface RemoteVideoCardProps {
  profile: HostProfile;
  onChanged: (profile: HostProfile) => void;
}

function describeDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The one active remote-call video for a profile.
 *
 * Replacement is a two-step action: choose the file, then confirm. The
 * repository writes the new video and drops the old one in a single
 * transaction, so a failed replacement leaves the working video in place.
 */
export function RemoteVideoCard({ profile, onChanged }: RemoteVideoCardProps) {
  const toast = useToast();
  const videoUrl = useAssetUrl(profile.remoteVideoAssetId);
  const { data: meta } = useAssetMeta(profile.remoteVideoAssetId);

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
      const updated = await adminRepository.setRemoteVideo(profile.id, pendingFile);
      onChanged(updated);
      toast.success(profile.remoteVideoAssetId ? "Remote call video updated." : "Remote call video uploaded.");
      closeReplace();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that video.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const updated = await adminRepository.removeRemoteVideo(profile.id);
      onChanged(updated);
      toast.success("Remote call video removed.");
      setRemoveOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that video.");
    } finally {
      setBusy(false);
    }
  };

  const duration = describeDuration(meta?.durationSeconds ?? null);

  /** A stored clip can only appear on calls from a remote-reachable provider. */
  const reachable = mediaAssetProvider.reachableAcrossDevices;

  return (
    <section className="admin-card">
      <div className="admin-card-heading">
        <h2 className="admin-card-label">Remote call video</h2>
        <MediaBadge present={profile.remoteVideoAssetId !== null} />
      </div>
      <p className="admin-hint">This video is displayed as the other participant after a call connects.</p>

      {profile.remoteVideoAssetId ? (
        <>
          {/* Native controls on purpose: this is a review of a file, not a call. */}
          {videoUrl ? (
            <video className="admin-video-preview" src={videoUrl} controls playsInline preload="metadata" />
          ) : (
            <div className="admin-video-placeholder">Loading video…</div>
          )}

          {meta && (
            <>
            <p className={`source-status is-${reachable ? "ready" : "local"}`} role="status">
              {!reachable
                ? "Local only — stored in this browser, so another device cannot load it yet. Remote storage is required before Uploaded Source works on a real call."
                : "Ready for calls"}
            </p>

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
              {meta.width && meta.height && (
                <div>
                  <dt>Aspect ratio</dt>
                  <dd>{describeAspect(meta.width, meta.height)}</dd>
                </div>
              )}
              {meta.width && meta.height && (
                <div>
                  <dt>Dimensions</dt>
                  <dd>
                    {meta.width} × {meta.height}
                  </dd>
                </div>
              )}
              <div>
                <dt>Updated</dt>
                <dd>{formatDateTime(meta.updatedAt)}</dd>
              </div>
            </dl>
            </>
          )}

          <div className="admin-card-actions">
            <button type="button" className="admin-button admin-button-secondary" onClick={() => setReplaceOpen(true)}>
              Replace video
            </button>
            <button type="button" className="admin-button admin-button-ghost" onClick={() => setRemoveOpen(true)}>
              Remove video
            </button>
          </div>
        </>
      ) : (
        <div className="admin-inline-empty">
          <p>No video yet. This profile is not ready for calls until one is uploaded.</p>
          <button type="button" className="admin-button admin-button-primary" onClick={() => setReplaceOpen(true)}>
            Upload video
          </button>
        </div>
      )}

      <ConfirmDialog
        open={replaceOpen}
        title={profile.remoteVideoAssetId ? "Replace remote call video" : "Upload remote call video"}
        confirmLabel={profile.remoteVideoAssetId ? "Replace video" : "Upload video"}
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
        <VideoUpload file={pendingFile} previewUrl={pendingPreview} onSelect={setPendingFile} disabled={busy} />
        {profile.remoteVideoAssetId && (
          <p className="admin-warning">
            Replacing this video changes what users see when calls to this profile connect.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={removeOpen}
        title="Remove remote call video?"
        confirmLabel="Remove video"
        destructive
        busy={busy}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => void remove()}
      >
        <p>This profile will no longer be ready for video calls until another video is uploaded.</p>
      </ConfirmDialog>
    </section>
  );
}

export default RemoteVideoCard;
