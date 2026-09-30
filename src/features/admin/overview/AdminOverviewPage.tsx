import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { formatDate, formatDuration } from "@/lib/utils";
import { getProfileStats } from "@/services/admin/profileInsights";
import { subscriptionRepository } from "@/services/subscriptions/repository";

import { EmptyState } from "../components/EmptyState";
import { ProfileAvatar } from "../components/ProfileAvatar";
import { StatCard } from "../components/StatCard";
import { MediaBadge, StatusBadge } from "../components/StatusBadge";
import { useCallSessions, useProfiles, useSessionMetrics } from "../hooks/useAdminData";
import { useCrmBadges, useSupportConversations } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";
import { SessionTable } from "../sessions/SessionTable";

const RECENT_LIMIT = 5;

/**
 * Operations overview.
 *
 * Every number is counted from stored profiles through the shared selectors —
 * nothing here is illustrative or hard-coded.
 */
export function AdminOverviewPage() {
  const { data: profiles, loading, error } = useProfiles();
  const { data: metrics, loading: metricsLoading } = useSessionMetrics();
  const { data: recentCalls, loading: callsLoading } = useCallSessions({ limit: RECENT_LIMIT });
  const { data: conversations, loading: conversationsLoading } = useSupportConversations({ limit: RECENT_LIMIT });
  const badges = useCrmBadges();
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const stats = getProfileStats(profiles);

  useEffect(() => {
    let cancelled = false;
    void subscriptionRepository
      .countRequestsByStatus("confirmed")
      .then((count) => {
        if (!cancelled) setConfirmedCount(count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const recent = profiles.slice(0, RECENT_LIMIT);
  const averageDuration =
    metrics?.averageConnectedSeconds === null || metrics === null
      ? "—"
      : formatDuration(metrics.averageConnectedSeconds);

  return (
    <>
      <AdminPageHeader
        title="Overview"
        description="How CallaStar profiles are set up right now."
        actions={
          <Link className="admin-button admin-button-primary" to="/admin/profiles/new">
            New profile
          </Link>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="admin-stat-grid">
        <StatCard label="Total profiles" value={loading ? "—" : stats.total} />
        <StatCard label="Active profiles" value={loading ? "—" : stats.active} hint="Reachable by Call ID" />
        <StatCard label="Ready for calls" value={loading ? "—" : stats.ready} hint="Active, with avatar and video" />
        <StatCard
          label="Missing video"
          value={loading ? "—" : stats.missingVideo}
          tone={stats.missingVideo > 0 ? "warning" : "default"}
          hint="Cannot show a remote participant"
        />
      </div>

      <div className="admin-stat-grid">
        <StatCard label="Calls today" value={metricsLoading ? "—" : (metrics?.callsToday ?? 0)} />
        <StatCard
          label="Completed calls"
          value={metricsLoading ? "—" : (metrics?.completed ?? 0)}
          hint="Connected, then ended"
        />
        <StatCard
          label="Cancelled or failed"
          value={metricsLoading ? "—" : (metrics?.cancelledOrFailed ?? 0)}
          tone={(metrics?.cancelledOrFailed ?? 0) > 0 ? "warning" : "default"}
        />
        <StatCard label="Average call length" value={metricsLoading ? "—" : averageDuration} hint="Connected calls only" />
      </div>

      {/* What is waiting on a person, rather than what has already happened. */}
      <div className="admin-stat-grid">
        <StatCard
          label="Open requests"
          value={badges.openRequests}
          tone={badges.openRequests > 0 ? "warning" : "default"}
          hint="Subscriptions to review or confirm"
        />
        <StatCard
          label="Unread conversations"
          value={badges.unreadConversations}
          tone={badges.unreadConversations > 0 ? "warning" : "default"}
          hint="Customers waiting for a reply"
        />
        <StatCard label="Confirmed subscriptions" value={confirmedCount === null ? "—" : confirmedCount} />
        <StatCard label="Notifications" value={badges.unreadNotifications} hint="Unread" />
      </div>

      <div className="admin-overview-grid">
      <section className="admin-card">
        <div className="admin-card-heading">
          <h2 className="admin-card-label">Recent support activity</h2>
          <Link className="admin-link" to="/admin/support">
            View customer care
          </Link>
        </div>
        {conversationsLoading ? (
          <p className="admin-hint">Loading conversations…</p>
        ) : conversations.length === 0 ? (
          <p className="admin-hint">Customer care conversations will appear here.</p>
        ) : (
          <ul className="admin-inbox">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link className="admin-inbox-row" to={`/admin/support/${conversation.id}`}>
                  <span className="admin-inbox-main">
                    <span className="admin-inbox-head">
                      <strong>{conversation.customerName || conversation.customerEmail}</strong>
                      {conversation.unreadForAdmin > 0 && (
                        <span className="admin-inbox-unread">{conversation.unreadForAdmin}</span>
                      )}
                    </span>
                    <span className="admin-inbox-preview">
                      {conversation.lastMessagePreview || "No messages yet"}
                    </span>
                  </span>
                  <span className="admin-inbox-meta">
                    <small>{formatDate(conversation.lastMessageAt)}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-card">
        <div className="admin-card-heading">
          <h2 className="admin-card-label">Recent calls</h2>
          <Link className="admin-link" to="/admin/sessions">
            View all calls
          </Link>
        </div>
        {callsLoading ? (
          <p className="admin-hint">Loading calls…</p>
        ) : recentCalls.length === 0 ? (
          <p className="admin-hint">Calls made through CallaStar will appear here.</p>
        ) : (
          <SessionTable sessions={recentCalls} compact />
        )}
      </section>

      <section className="admin-card">
        <div className="admin-card-heading">
          <h2 className="admin-card-label">Recent profiles</h2>
          <Link className="admin-link" to="/admin/profiles">
            View all
          </Link>
        </div>

        {loading ? (
          <p className="admin-hint">Loading profiles…</p>
        ) : recent.length === 0 ? (
          <EmptyState
            title="No profiles yet"
            description="Create your first CallaStar profile to generate a Call ID and assign remote call media."
            action={
              <Link className="admin-button admin-button-primary" to="/admin/profiles/new">
                Create profile
              </Link>
            }
          />
        ) : (
          <ul className="admin-recent-list">
            {recent.map((profile) => (
              <li key={profile.id}>
                <Link to={`/admin/profiles/${profile.id}`} className="admin-recent-item">
                  <ProfileAvatar name={profile.displayName} assetId={profile.avatarAssetId} size="sm" />
                  <span className="admin-recent-name">
                    <strong>{profile.displayName}</strong>
                    <code>{profile.callId}</code>
                  </span>
                  <span className="admin-recent-badges">
                    <StatusBadge status={profile.status} />
                    <MediaBadge present={profile.remoteVideoAssetId !== null} />
                  </span>
                  <span className="admin-recent-date">{formatDate(profile.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!loading && stats.total > 0 && (stats.missingAvatar > 0 || stats.missingVideo > 0 || stats.inactive > 0) && (
        <section className="admin-card">
          <h2 className="admin-card-label">Setup health</h2>
          <ul className="admin-health-list">
            {stats.missingAvatar > 0 && (
              <li>
                <strong>{stats.missingAvatar}</strong> without an avatar
              </li>
            )}
            {stats.missingVideo > 0 && (
              <li>
                <strong>{stats.missingVideo}</strong> without a remote call video
              </li>
            )}
            {stats.inactive > 0 && (
              <li>
                <strong>{stats.inactive}</strong> inactive
              </li>
            )}
          </ul>
        </section>
      )}
      </div>
    </>
  );
}

export default AdminOverviewPage;
