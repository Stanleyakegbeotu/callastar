import type { NotificationRepository } from "./repository";

/**
 * Supabase is not connected in this phase.
 *
 * When it lands, notifications stop being written by the client at all: a
 * trigger on `subscription_requests` and `support_messages` creates them, which
 * is the only way an operator can trust that nothing was missed.
 */
function notConnected(): never {
  throw new Error("Supabase notification repository is not connected.");
}

export const supabaseNotificationRepository: NotificationRepository = {
  mode: "supabase",
  create: notConnected,
  list: notConnected,
  markRead: notConnected,
  markAllRead: notConnected,
  countUnread: notConnected,
};
