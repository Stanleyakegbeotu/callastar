import type { SupportRepository } from "./repository";

/**
 * Supabase is not connected in this phase. Every call fails loudly rather than
 * quietly serving another browser's local conversations — support messages are
 * the last thing that should silently come from the wrong place.
 *
 * When it lands: conversations and messages become tables, attachments move to
 * a private Storage bucket read through signed URLs, and the unread counters
 * become a view rather than columns kept in step by hand.
 */
function notConnected(): never {
  throw new Error("Supabase support repository is not connected.");
}

export const supabaseSupportRepository: SupportRepository = {
  mode: "supabase",
  findConversationByEmail: notConnected,
  listConversationsByEmail: notConnected,
  startConversation: notConnected,
  getConversation: notConnected,
  listConversations: notConnected,
  updateConversation: notConnected,
  listMessages: notConnected,
  sendMessage: notConnected,
  getAttachment: notConnected,
  markRead: notConnected,
  countUnreadForAdmin: notConnected,
};
