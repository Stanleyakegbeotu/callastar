import { Link } from "react-router-dom";

import { formatDateTime, formatFileSize } from "@/lib/utils";

import { EmptyState } from "../components/EmptyState";
import { ProfileAvatar } from "../components/ProfileAvatar";
import { MediaBadge } from "../components/StatusBadge";
import { useRemoteVideos } from "../hooks/useAdminData";
import { AdminPageHeader } from "../layout/AdminPageHeader";

/**
 * Remote call video across every profile.
 *
 * Built from file metadata only — no video blob is read to render this page,
 * so the list stays fast however large the uploads are.
 */
export function MediaPage() {
  const { data: rows, loading, error, reload } = useRemoteVideos();

  return (
    <>
      <AdminPageHeader
        title="Media"
        description="What each profile plays once a call connects: video for a video call, audio for an audio call."
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
          <button className="admin-button admin-button-secondary" onClick={reload}>Retry</button>
        </p>
      )}

      {loading ? (
        <p className="admin-hint">Loading media…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No media added yet."
          description="Create a profile and upload its remote call video to see it here."
          action={
            <Link className="admin-button admin-button-primary" to="/admin/profiles/new">
              Create profile
            </Link>
          }
        />
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Video file</th>
                <th scope="col">Size</th>
                <th scope="col">Video</th>
                <th scope="col">Audio file</th>
                <th scope="col">Audio</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ profile, video, audio }) => (
                <tr key={profile.id}>
                  <td data-label="Profile">
                    <Link className="admin-profile-cell" to={`/admin/profiles/${profile.id}`}>
                      <ProfileAvatar name={profile.displayName} assetId={profile.avatarAssetId} size="sm" />
                      <span>
                        <strong>{profile.displayName}</strong>
                        <small>{profile.callId}</small>
                      </span>
                    </Link>
                  </td>
                  <td data-label="Video file">{video ? video.fileName : "—"}</td>
                  <td data-label="Size">{video ? formatFileSize(video.fileSize) : "—"}</td>
                  <td data-label="Video">
                    <MediaBadge present={video !== null} />
                  </td>
                  <td data-label="Audio file">{audio ? audio.fileName : "—"}</td>
                  <td data-label="Audio">
                    {/* Optional: an audio call without one uses the video's
                        soundtrack, so this is not a readiness failure. */}
                    <span className={`admin-badge ${audio ? "admin-badge-ready" : "admin-badge-neutral"}`}>
                      {audio ? "Ready" : "Uses video"}
                    </span>
                  </td>
                  <td data-label="Updated">{video ? formatDateTime(video.updatedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default MediaPage;
