/**
 * Operational notifications for the admin workspace.
 *
 * Only things somebody has to act on: a payment to confirm, a customer waiting
 * for a reply. Nothing here is marketing, nothing is a digest, and nothing is
 * written on a timer — a notification exists because a person did something.
 */
export type NotificationType =
  | "subscription_requested"
  | "payment_proof_submitted"
  | "support_message_received"
  | "support_conversation_started";

export type NotificationEntityKind = "subscription_request" | "support_conversation";

export interface AdminNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  entityKind: NotificationEntityKind;
  entityId: string;
  createdAt: string;
  /** ISO timestamp, or null while unread. Indexed, so unread is a lookup. */
  readAt: string | null;
}

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  entityKind: NotificationEntityKind;
  entityId: string;
}

export interface NotificationFilters {
  unreadOnly?: boolean;
  limit?: number;
}
