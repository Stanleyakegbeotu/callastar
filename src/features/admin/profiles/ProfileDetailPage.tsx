import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { formatDateTime } from "@/lib/utils";
import { adminRepository } from "@/services/admin/repository";
import type { HostProfile } from "@/services/admin/types";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProfileAvatar } from "../components/ProfileAvatar";
import { StatusBadge } from "../components/StatusBadge";
import { useToast } from "../components/ToastProvider";
import { useProfile, useProfileSessions } from "../hooks/useAdminData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { RemoteAudioCard } from "../media/RemoteAudioCard";
import { RemoteVideoCard } from "../media/RemoteVideoCard";
import { SubscriptionAccessCard } from "../subscriptions/SubscriptionAccessCard";
import { LiveCallingCard } from "@/features/host-calls/components/LiveCallingCard";

import { SessionTable } from "../sessions/SessionTable";
import { CallIdCard } from "./CallIdCard";
import { ProfileReadiness } from "./ProfileReadiness";

type PendingAction = "regenerate" | "delete" | null;

/** The CRM record: who the profile is, what plays on a call, and its Call ID. */
export function ProfileDetailPage() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { data, loading, error } = useProfile(profileId);
  const { data: sessions, loading: sessionsLoading } = useProfileSessions(profileId, 5);

  const [profile, setProfile] = useState<HostProfile | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  // Mutations return the updated record, so the page never re-reads to catch up.
  useEffect(() => setProfile(data), [data]);

  const justCreated = (location.state as { created?: boolean } | null)?.created === true;

  if (loading) return <p className="admin-hint">Loading profile…</p>;
  if (error) {
    return (
      <p className="admin-error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!profile) {
    return (
      <>
        <AdminPageHeader title="Profile not found" description="This profile no longer exists." />
        <Link className="admin-button admin-button-primary" to="/admin/profiles">
          Back to profiles
        </Link>
      </>
    );
  }

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "That action could not be completed.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const toggleStatus = () =>
    run(async () => {
      const next = profile.status === "active" ? "inactive" : "active";
      const updated = await adminRepository.updateProfile(profile.id, { status: next });
      setProfile(updated);
      toast.success(next === "active" ? "Profile activated." : "Profile deactivated.");
    });

  const regenerate = () =>
    run(async () => {
      const updated = await adminRepository.regenerateCallId(profile.id);
      setProfile(updated);
      toast.success("Call ID regenerated.");
    });

  const remove = () =>
    run(async () => {
      await adminRepository.deleteProfile(profile.id);
      toast.success("Profile deleted.");
      navigate("/admin/profiles", { replace: true });
    });

  return (
    <>
      <AdminPageHeader
        title={profile.displayName}
        eyebrow={
          <Link className="admin-link" to="/admin/profiles">
            Profiles
          </Link>
        }
        actions={
          <>
            <Link className="admin-button admin-button-secondary" to={`/admin/profiles/${profile.id}/edit`}>
              Edit profile
            </Link>
            <button type="button" className="admin-button admin-button-ghost" onClick={toggleStatus} disabled={busy}>
              {profile.status === "active" ? "Deactivate" : "Activate"}
            </button>
          </>
        }
      />

      <div className="admin-record-head admin-card">
        <ProfileAvatar name={profile.displayName} assetId={profile.avatarAssetId} size="lg" />
        <div>
          <h2>{profile.displayName}</h2>
          {profile.shortBio ? <p>{profile.shortBio}</p> : <p className="admin-hint">No bio yet.</p>}
          <StatusBadge status={profile.status} />
        </div>
      </div>

      <div className="admin-record-grid">
        <div className="admin-record-main">
          <RemoteVideoCard profile={profile} onChanged={setProfile} />
          <RemoteAudioCard profile={profile} onChanged={setProfile} />
          <SubscriptionAccessCard profile={profile} />

          <section className="admin-card">
            <div className="admin-card-heading">
              <h2 className="admin-card-label">Recent calls</h2>
              <Link className="admin-link" to={`/admin/sessions?profileId=${profile.id}`}>
                View all calls
              </Link>
            </div>
            {sessionsLoading ? (
              <p className="admin-hint">Loading calls…</p>
            ) : sessions.length === 0 ? (
              <p className="admin-hint">No calls to this profile yet.</p>
            ) : (
              <SessionTable sessions={sessions} showHost={false} compact />
            )}
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Profile information</h2>
            <dl className="admin-meta-grid">
              <div>
                <dt>Display name</dt>
                <dd>{profile.displayName}</dd>
              </div>
              <div>
                <dt>Short bio</dt>
                <dd>{profile.shortBio || "Not set"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{profile.status === "active" ? "Active" : "Inactive"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(profile.createdAt)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatDateTime(profile.updatedAt)}</dd>
              </div>
            </dl>
            <div className="admin-card-actions">
              <Link className="admin-button admin-button-secondary" to={`/admin/profiles/${profile.id}/edit`}>
                Edit
              </Link>
            </div>
          </section>
        </div>

        <aside className="admin-record-side">
          <CallIdCard
            callId={profile.callId}
            highlight={justCreated}
            footer={
              <button
                type="button"
                className="admin-button admin-button-ghost"
                onClick={() => setPending("regenerate")}
                disabled={busy}
              >
                Regenerate
              </button>
            }
          />

          {/* Live calling sits beside the Call ID, because the two answer the same
              question together: who can be reached, and on what code. */}
          <LiveCallingCard profile={profile} hasCallSource={profile.remoteVideoAssetId !== null} />

          <ProfileReadiness profile={profile} />

          <section className="admin-card admin-danger-zone">
            <h2 className="admin-card-label">Danger zone</h2>
            <p className="admin-hint">
              Deactivating keeps the record and stops new calls. Deleting removes the profile and its media for good.
            </p>
            <button
              type="button"
              className="admin-button admin-button-danger"
              onClick={() => setPending("delete")}
              disabled={busy}
            >
              Delete profile
            </button>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={pending === "regenerate"}
        title="Regenerate Call ID?"
        confirmLabel="Regenerate"
        destructive
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={regenerate}
      >
        <p>The current Call ID will stop working immediately. Anyone holding it will need the new one.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === "delete"}
        title="Delete this profile?"
        confirmLabel="Delete profile"
        destructive
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={remove}
      >
        <p>
          {profile.displayName}, its Call ID, avatar and remote call video will be removed. This cannot be undone —
          deactivating instead keeps the record and simply stops new calls.
        </p>
      </ConfirmDialog>
    </>
  );
}

export default ProfileDetailPage;
