import { Link, useParams } from "react-router-dom";

import { formatDateTime, formatDuration, formatTimeOfDay } from "@/lib/utils";
import { describeCallEvent, getCallDuration } from "@/services/admin/sessionInsights";

import { ProfileAvatar } from "../components/ProfileAvatar";
import { CallTypeBadge, SessionStatusBadge } from "../components/StatusBadge";
import { useCallEvents, useCallSession, useProfile } from "../hooks/useAdminData";
import { useSessionSubscriptionRequests } from "../hooks/useCrmData";
import { REQUEST_STATUS_LABELS } from "../subscriptions/subscriptionInsights";
import { AdminPageHeader } from "../layout/AdminPageHeader";

/** Only metadata a person would act on; raw payloads never reach the screen. */
function describeMetadata(metadata: Record<string, string | number | boolean | null> | undefined): string | null {
  if (!metadata) return null;
  if (typeof metadata.durationSeconds === "number") return `Lasted ${formatDuration(metadata.durationSeconds)}`;
  if (typeof metadata.callType === "string") return metadata.callType === "audio" ? "Audio call" : "Video call";
  return null;
}

/**
 * One call, as an activity record: who called whom, what happened and when.
 */
export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { data: session, loading, error } = useCallSession(sessionId);
  const { data: events } = useCallEvents(sessionId);
  const { data: profile } = useProfile(session?.profileId);
  const { data: requests } = useSessionSubscriptionRequests(sessionId);

  if (loading) return <p className="admin-hint">Loading call session…</p>;
  if (error) {
    return (
      <p className="admin-error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!session) {
    return (
      <>
        <AdminPageHeader title="Call session not found" description="This call is no longer in local history." />
        <Link className="admin-button admin-button-primary" to="/admin/sessions">
          Back to call sessions
        </Link>
      </>
    );
  }

  const duration = getCallDuration(session);

  return (
    <>
      <AdminPageHeader
        title="Call session"
        description={formatDateTime(session.createdAt)}
        eyebrow={
          <Link className="admin-link" to="/admin/sessions">
            Call sessions
          </Link>
        }
        actions={
          <>
            <SessionStatusBadge status={session.status} />
            <CallTypeBadge callType={session.callType} />
          </>
        }
      />

      <div className="admin-record-grid">
        <div className="admin-record-main">
          <section className="admin-card">
            <h2 className="admin-card-label">Caller</h2>
            <dl className="admin-meta-grid">
              <div>
                <dt>Name</dt>
                <dd>{session.caller.fullName || "Not provided"}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{session.caller.email || "Not provided"}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{session.caller.phone || "Not provided"}</dd>
              </div>
            </dl>
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Timeline</h2>
            {events.length === 0 ? (
              <p className="admin-hint">No events were recorded for this call.</p>
            ) : (
              <ol className="admin-timeline">
                {events.map((event) => {
                  const detail = describeMetadata(event.metadata);
                  return (
                    <li key={event.id}>
                      <span className="admin-timeline-time">{formatTimeOfDay(event.occurredAt)}</span>
                      <span className="admin-timeline-body">
                        <span className="admin-timeline-label">{describeCallEvent(event.type, session.callType)}</span>
                        {detail && <span className="admin-timeline-detail">{detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        <aside className="admin-record-side">
          <section className="admin-card">
            <h2 className="admin-card-label">Host</h2>
            <div className="admin-record-head admin-record-head-inline">
              <ProfileAvatar name={session.profileName} assetId={profile?.avatarAssetId ?? null} size="md" />
              <div>
                <strong>{profile?.displayName ?? session.profileName}</strong>
                {profile ? (
                  <Link className="admin-link" to={`/admin/profiles/${session.profileId}`}>
                    View profile
                  </Link>
                ) : (
                  <span className="admin-hint">This profile has been removed.</span>
                )}
              </div>
            </div>
            {session.callIdSnapshot && (
              <p className="admin-hint">
                Dialled <code>{session.callIdSnapshot}</code>
              </p>
            )}
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Subscription</h2>
            {requests.length === 0 ? (
              <p className="admin-hint">
                No access plan was requested during this call.
              </p>
            ) : (
              <ul className="admin-plan-summary">
                {requests.map((request) => (
                  <li key={request.id}>
                    <span>
                      <strong>{request.planNameSnapshot}</strong>
                      <small>{REQUEST_STATUS_LABELS[request.status]}</small>
                    </span>
                    <Link className="admin-link" to={`/admin/subscriptions/${request.id}`}>
                      {request.reference}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="admin-card">
            <h2 className="admin-card-label">Call</h2>
            <dl className="admin-meta-grid">
              <div>
                <dt>Type</dt>
                <dd>{session.callType === "video" ? "Video" : "Audio"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <SessionStatusBadge status={session.status} />
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(session.createdAt)}</dd>
              </div>
              <div>
                <dt>Connected</dt>
                <dd>{session.connectedAt ? formatDateTime(session.connectedAt) : "Never connected"}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd>{session.endedAt ? formatDateTime(session.endedAt) : "—"}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{duration === null ? "—" : formatDuration(duration)}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

export default SessionDetailPage;
