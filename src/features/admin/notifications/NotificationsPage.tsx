import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "@/components/ui/Icon";
import { formatDateTime } from "@/lib/utils";
import { notificationRepository } from "@/services/notifications/repository";
import type { AdminNotification, NotificationType } from "@/services/notifications/types";

import { EmptyState } from "../components/EmptyState";
import { useCrmBadges, useNotifications } from "../hooks/useCrmData";
import { AdminPageHeader } from "../layout/AdminPageHeader";

const ICONS: Record<NotificationType, IconName> = {
  subscription_requested: "crown",
  payment_proof_submitted: "image",
  support_message_received: "chat",
  support_conversation_started: "chat",
};

/** Where a notification leads. Each one is about something you can go and do. */
function destination(notification: AdminNotification): string {
  return notification.entityKind === "subscription_request"
    ? `/admin/subscriptions/${notification.entityId}`
    : `/admin/support/${notification.entityId}`;
}

/**
 * Admin → Notifications.
 *
 * Only things somebody has to act on, and each one opens the record it is about.
 * Reading a notification is a side effect of following it — nothing is marked
 * read just for having been on screen.
 */
export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data: notifications, loading, error, reload } = useNotifications(unreadOnly);
  const badges = useCrmBadges();

  const markAllRead = async () => {
    await notificationRepository.markAllRead();
    reload();
    badges.reload();
  };

  return (
    <>
      <AdminPageHeader
        title="Notifications"
        description="Payments waiting to be confirmed, and customers waiting for a reply."
        actions={
          <button
            type="button"
            className="admin-button admin-button-secondary"
            disabled={badges.unreadNotifications === 0}
            onClick={() => void markAllRead()}
          >
            Mark all as read
          </button>
        }
      />

      {error && (
        <p className="admin-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="admin-toolbar">
        <div className="admin-filters" role="group" aria-label="Filter notifications">
          <button
            type="button"
            className={`admin-filter ${unreadOnly ? "" : "is-active"}`}
            aria-pressed={!unreadOnly}
            onClick={() => setUnreadOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            className={`admin-filter ${unreadOnly ? "is-active" : ""}`}
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly(true)}
          >
            Unread
          </button>
        </div>
      </div>

      {loading ? (
        <p className="admin-hint">Loading notifications…</p>
      ) : notifications.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "Nothing unread" : "No notifications"}
          description="Subscription requests and customer messages will appear here as they arrive."
        />
      ) : (
        <ul className="admin-notifications">
          {notifications.map((notification) => (
            <li key={notification.id}>
              <Link
                className={`admin-notification ${notification.readAt === null ? "is-unread" : ""}`.trim()}
                to={destination(notification)}
                onClick={() => {
                  void notificationRepository.markRead(notification.id).then(() => badges.reload());
                }}
              >
                <span className="admin-notification-icon">
                  <Icon name={ICONS[notification.type]} className="size-5" />
                </span>
                <span className="admin-notification-body">
                  <strong>{notification.title}</strong>
                  <small>{notification.body}</small>
                  <time dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time>
                </span>
                {notification.readAt === null && <span className="admin-notification-dot" aria-label="Unread" />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default NotificationsPage;
