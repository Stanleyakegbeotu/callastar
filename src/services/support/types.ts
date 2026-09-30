/**
 * Customer care: a conversation between one customer and CallaStar support.
 *
 * A customer is identified by the email they type, and nothing more. There is no
 * account, no password, no verification code and no confirmation email — the
 * email is a lookup key for finding a previous conversation, which is why
 * `customerEmailNormalized` exists and why nothing in this model pretends the
 * address has been proven to belong to anybody.
 */

export type ConversationStatus = "open" | "pending" | "resolved";

export type MessageSender = "customer" | "admin";

export interface SupportConversation {
  id: string;
  /** As typed, for display. */
  customerEmail: string;
  /** Trimmed and lowercased; this is what the index holds and lookups use. */
  customerEmailNormalized: string;
  customerName: string;
  subject: string;
  status: ConversationStatus;
  /** Set when the thread was opened to pay for a plan. */
  subscriptionRequestId: string | null;
  /** Denormalised for the inbox, so a list never reads every message. */
  lastMessagePreview: string;
  lastMessageAt: string;
  lastMessageSender: MessageSender;
  unreadForAdmin: number;
  unreadForCustomer: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessage {
  id: string;
  conversationId: string;
  sender: MessageSender;
  /** Exactly as typed. Never translated, never rewritten. */
  body: string;
  /** An image the message carries, or null. */
  attachmentId: string | null;
  /** The message this one answers, so a reply keeps its context. */
  replyToMessageId: string | null;
  createdAt: string;
}

/** Attachment metadata. The bytes live in the blob store, fetched by id. */
export interface SupportAssetMeta {
  id: string;
  conversationId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface StartConversationInput {
  customerEmail: string;
  customerName: string;
  subject: string;
  subscriptionRequestId?: string | null;
}

export interface SendMessageInput {
  conversationId: string;
  sender: MessageSender;
  body: string;
  replyToMessageId?: string | null;
  attachment?: File | null;
}

export interface SentMessage {
  message: SupportMessage;
  asset: SupportAssetMeta | null;
  conversation: SupportConversation;
}

export interface ConversationFilters {
  status?: ConversationStatus | "all";
  /** Only threads with something the admin has not read. */
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
}

/** A message together with whatever it needs to render. */
export interface SupportMessageView {
  message: SupportMessage;
  asset: SupportAssetMeta | null;
  /** The quoted message, resolved once so a bubble does not look it up. */
  replyTo: { id: string; sender: MessageSender; body: string; hasAttachment: boolean } | null;
}
