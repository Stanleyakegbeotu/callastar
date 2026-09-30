import { Link } from "react-router-dom";

import { copyText, formatDate } from "@/lib/utils";
import type { HostProfile } from "@/services/admin/types";

import { ProfileAvatar } from "../components/ProfileAvatar";
import { PresenceBadge } from "@/features/host-calls/components/PresenceBadge";

import { MediaBadge, StatusBadge } from "../components/StatusBadge";
import { useToast } from "../components/ToastProvider";

/**
 * The profile list.
 *
 * One table drives both layouts: below the tablet breakpoint the CSS turns each
 * row into a stacked card, using the `data-label` on every cell for its heading.
 * That keeps a single accessible DOM instead of two copies of the same data.
 */
export function ProfileTable({ profiles }: { profiles: HostProfile[] }) {
  const toast = useToast();

  const copy = async (callId: string) => {
    const copied = await copyText(callId);
    if (copied) toast.success("Call ID copied.");
    else toast.error("Copying is blocked in this browser.");
  };

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Profile</th>
            <th scope="col">Call ID</th>
            <th scope="col">Status</th>
            <th scope="col">Live calling</th>
            <th scope="col">Remote video</th>
            <th scope="col">Created</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="admin-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.id}>
              <td data-label="Profile">
                <Link className="admin-profile-cell" to={`/admin/profiles/${profile.id}`}>
                  <ProfileAvatar name={profile.displayName} assetId={profile.avatarAssetId} size="sm" />
                  <span>
                    <strong>{profile.displayName}</strong>
                    {profile.shortBio && <small>{profile.shortBio}</small>}
                  </span>
                </Link>
              </td>
              <td data-label="Call ID">
                <span className="admin-callid-inline">
                  <code>{profile.callId}</code>
                  <button
                    type="button"
                    className="admin-icon-button admin-icon-button-sm"
                    onClick={() => void copy(profile.callId)}
                    aria-label={`Copy Call ID for ${profile.displayName}`}
                  >
                    Copy
                  </button>
                </span>
              </td>
              <td data-label="Status">
                <StatusBadge status={profile.status} />
              </td>
              {/*
                Presence, which is a different question from Active.
                Active is an operator's setting that survives the browser
                closing; presence is a live socket that does not. One badge for
                both is how a caller ends up ringing a profile nobody is behind.
              */}
              <td data-label="Live calling">
                <PresenceBadge profileId={profile.id} />
              </td>
              <td data-label="Remote video">
                <MediaBadge present={profile.remoteVideoAssetId !== null} />
              </td>
              <td data-label="Created">{formatDate(profile.createdAt)}</td>
              <td data-label="Updated">{formatDate(profile.updatedAt)}</td>
              <td data-label="Actions" className="admin-row-actions">
                <Link className="admin-button admin-button-ghost" to={`/admin/profiles/${profile.id}`}>
                  View
                </Link>
                <Link className="admin-button admin-button-ghost" to={`/admin/profiles/${profile.id}/edit`}>
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default ProfileTable;
