import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";
import { PresenceBadge } from "@/features/host-calls/components/PresenceBadge";
import { copyText } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import type { HostProfile } from "@/services/admin/types";

import { ProfileAvatar } from "../components/ProfileAvatar";
import { useToast } from "../components/ToastProvider";

interface ProfileAvailabilityCardProps {
  profile: HostProfile;
  onChanged: (profile: HostProfile) => void;
}

/**
 * One host in the availability list.
 *
 * The toggle is the point of this card. Whether somebody is taking calls is the
 * thing an operator changes most often and it decides whether a caller gets
 * through at all, so it belongs here rather than three taps away inside an edit
 * form.
 */
export function ProfileAvailabilityCard({ profile, onChanged }: ProfileAvailabilityCardProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const active = profile.status === "active";

  const toggle = async () => {
    if (busy) return;
    const next = active ? "inactive" : "active";
    setBusy(true);

    try {
      const updated = await adminRepository.updateProfile(profile.id, { status: next });
      // Told by the repository, not assumed: the list reflects what was stored.
      onChanged(updated);
      toast.success(
        next === "active" ? `${updated.displayName} is now active.` : `${updated.displayName} is now inactive.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const copyCallId = async () => {
    const copied = await copyText(profile.callId);
    if (copied) toast.success("Call ID copied.");
    else toast.error("Could not copy the Call ID.");
  };

  return (
    <li className={`availability-card ${active ? "" : "is-inactive"}`.trim()}>
      <div className="availability-main">
        <span className="availability-avatar">
          <ProfileAvatar name={profile.displayName} assetId={profile.avatarAssetId} size="md" />
          <span className={`availability-dot availability-dot-${active ? "active" : "inactive"}`} aria-hidden="true" />
        </span>

        <div className="availability-text">
          <strong className="availability-name">{profile.displayName}</strong>

          <span className="availability-callid">
            Call ID: <code>{profile.callId}</code>
            <button type="button" onClick={() => void copyCallId()} aria-label={`Copy Call ID for ${profile.displayName}`}>
              <Icon name="copy" className="size-4" />
            </button>
          </span>

          {/* Status reads from the words as well as the colour. */}
          <span className={`availability-status availability-status-${active ? "active" : "inactive"}`}>
            <span className="availability-status-dot" aria-hidden="true" />
            {active ? "Active" : "Inactive"}
          </span>
          {/*
            Two separate facts, never one badge.

            The status above is the profile's Active setting, which survives the
            browser closing. This is realtime presence, which does not. A caller
            needs both, so an operator has to be able to see both — collapsing
            them into one green dot is exactly how somebody ends up ringing a
            profile nobody is sitting behind.
          */}
          <span className="availability-presence">
            <PresenceBadge profileId={profile.id} />
          </span>

          <span className="availability-note">{active ? "Available for calls" : "Not available for calls"}</span>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={active}
          aria-label={`${profile.displayName} is ${active ? "available" : "not available"} for calls`}
          className={`availability-switch ${active ? "is-on" : ""}`.trim()}
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span className="availability-switch-knob" aria-hidden="true" />
        </button>
      </div>

      <div className="availability-actions">
        <Link className="availability-action" to={`/admin/profiles/${profile.id}`}>
          <Icon name="eye" className="size-4" />
          View
        </Link>
        <Link className="availability-action" to={`/admin/profiles/${profile.id}/edit`}>
          <Icon name="pencil" className="size-4" />
          Edit
        </Link>
        <Link className="availability-action" to={`/admin/profiles/${profile.id}#media`}>
          <Icon name="image" className="size-4" />
          Media
        </Link>
      </div>
    </li>
  );
}

export default ProfileAvailabilityCard;
