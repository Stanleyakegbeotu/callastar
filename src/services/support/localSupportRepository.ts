import { SUPPORT_LIMITS } from "@/lib/config";
import {
  STORE_BLOBS,
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_SUPPORT_ASSETS,
  runTransaction,
} from "@/services/admin/indexeddb";
import { readImageMetadata } from "@/services/admin/mediaFiles";

import type { SupportRepository } from "./repository";
import type {
  ConversationFilters,
  SendMessageInput,
  StartConversationInput,
  SupportAssetMeta,
  SupportConversation,
  SupportMessage,
  SupportMessageView,
} from "./types";
import { paymentMethodLabel } from "./paymentMethods";

/**
 * Customer care against the local development engine.
 *
 * Two things are worth knowing. A message and its attachment are written in one
 * transaction together with the conversation summary, so the inbox can never show
 * a preview for a message that failed to save. And image dimensions are read
 * before that transaction opens: probing a file is not an IndexedDB promise, and
 * awaiting it mid-transaction would let the transaction close underneath us.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Two messages written in the same millisecond would otherwise come back in
 * whatever order the store felt like. A monotonic clock keeps a conversation in
 * the order it was actually said.
 */
let lastStamp = "";
function nextIso(): string {
  const candidate = nowIso();
  if (candidate > lastStamp) {
    lastStamp = candidate;
    return candidate;
  }
  // Same tick: borrow the next millisecond rather than repeat this one.
  const bumped = new Date(new Date(lastStamp).getTime() + 1).toISOString();
  lastStamp = bumped;
  return bumped;
}

/** What the inbox shows for a message, without opening it. */
function preview(body: string, hasAttachment: boolean): string {
  const trimmed = body.trim();
  if (trimmed.length > 0) return trimmed.slice(0, 120);
  return hasAttachment ? "Sent an image" : "";
}

const BLOB_PREFIX = "support:";

function byNewestMessage(a: SupportConversation, b: SupportConversation): number {
  return b.lastMessageAt.localeCompare(a.lastMessageAt);
}

export const localSupportRepository: SupportRepository = {
  mode: "local",

  async findConversationByEmail(email) {
    const all = await this.listConversationsByEmail(email);
    return all[0] ?? null;
  },

  async listConversationsByEmail(email) {
    const normalized = normalizeEmail(email);
    if (normalized.length === 0) return [];

    const conversations = await runTransaction([STORE_CONVERSATIONS], "readonly", (scope) =>
      scope.getAllFromIndex<SupportConversation>(STORE_CONVERSATIONS, "by_email", normalized),
    );
    return conversations.sort(byNewestMessage);
  },

  async startConversation(input: StartConversationInput) {
    const timestamp = nextIso();
    const conversation: SupportConversation = {
      id: newId(),
      customerEmail: input.customerEmail.trim(),
      customerEmailNormalized: normalizeEmail(input.customerEmail),
      customerName: input.customerName.trim(),
      subject: input.subject,
      status: "open",
      subscriptionRequestId: input.subscriptionRequestId ?? null,
      lastMessagePreview: "",
      lastMessageAt: timestamp,
      lastMessageSender: "customer",
      unreadForAdmin: 0,
      unreadForCustomer: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await runTransaction([STORE_CONVERSATIONS], "readwrite", (scope) =>
      scope.put(STORE_CONVERSATIONS, conversation),
    );
    return conversation;
  },

  async getConversation(id) {
    const conversation = await runTransaction([STORE_CONVERSATIONS], "readonly", (scope) =>
      scope.get<SupportConversation>(STORE_CONVERSATIONS, id),
    );
    return conversation ?? null;
  },

  async listConversations(filters?: ConversationFilters) {
    const conversations = await runTransaction([STORE_CONVERSATIONS], "readonly", (scope) =>
      filters?.status && filters.status !== "all"
        ? scope.getAllFromIndex<SupportConversation>(STORE_CONVERSATIONS, "by_status", filters.status)
        : scope.getAll<SupportConversation>(STORE_CONVERSATIONS),
    );

    const search = filters?.search?.trim().toLowerCase() ?? "";
    const matched = conversations.filter((conversation) => {
      if (filters?.unreadOnly && conversation.unreadForAdmin === 0) return false;
      if (search.length === 0) return true;
      return (
        conversation.customerEmailNormalized.includes(search) ||
        conversation.customerName.toLowerCase().includes(search) ||
        conversation.subject.toLowerCase().includes(search)
      );
    });

    matched.sort(byNewestMessage);
    return filters?.limit ? matched.slice(0, filters.limit) : matched;
  },

  async updateConversation(id, patch) {
    return runTransaction([STORE_CONVERSATIONS], "readwrite", async (scope) => {
      const existing = await scope.get<SupportConversation>(STORE_CONVERSATIONS, id);
      if (!existing) return null;
      const next: SupportConversation = { ...existing, ...patch, id: existing.id, updatedAt: nowIso() };
      await scope.put(STORE_CONVERSATIONS, next);
      return next;
    });
  },

  async listMessages(conversationId) {
    return runTransaction([STORE_MESSAGES, STORE_SUPPORT_ASSETS], "readonly", async (scope) => {
      const messages = await scope.getAllFromIndex<SupportMessage>(STORE_MESSAGES, "by_conversation", conversationId);
      const assets = await scope.getAllFromIndex<SupportAssetMeta>(
        STORE_SUPPORT_ASSETS,
        "by_conversation",
        conversationId,
      );

      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      // Same-millisecond ties break on id, so the order is stable between reads.
      const ordered = messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const byId = new Map(ordered.map((message) => [message.id, message]));

      return ordered.map<SupportMessageView>((message) => {
        const quoted = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined;
        return {
          message,
          asset: message.attachmentId ? assetById.get(message.attachmentId) ?? null : null,
          replyTo: quoted
            ? {
                id: quoted.id,
                sender: quoted.sender,
                body: quoted.body,
                hasAttachment: quoted.attachmentId !== null,
              }
            : null,
        };
      });
    });
  },

  async sendMessage(input: SendMessageInput) {
    if (input.action?.type === "select_payment_method") {
      throw new Error("Payment methods must be selected through the validated payment action.");
    }
    const attachment = input.attachment ?? null;

    if (attachment && attachment.size > SUPPORT_LIMITS.MAX_ATTACHMENT_BYTES) {
      throw new Error("That image is too large to attach.");
    }

    // Probed before the transaction opens: this is not an IndexedDB promise, and
    // awaiting it inside one would let the transaction close mid-write.
    const dimensions = attachment ? await readImageMetadata(attachment) : { width: null, height: null };

    const messageId = input.idempotencyKey
      ? `event:${input.conversationId}:${input.idempotencyKey}`
      : newId();
    const assetId = attachment ? newId() : null;
    const timestamp = nextIso();
    const body = input.body.trim().slice(0, SUPPORT_LIMITS.MESSAGE_MAX);

    return runTransaction(
      [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_SUPPORT_ASSETS, STORE_BLOBS],
      "readwrite",
      async (scope) => {
        const conversation = await scope.get<SupportConversation>(STORE_CONVERSATIONS, input.conversationId);
        if (!conversation) throw new Error("That conversation no longer exists.");

        const existing = input.idempotencyKey
          ? await scope.get<SupportMessage>(STORE_MESSAGES, messageId)
          : null;
        if (existing) return { message: existing, asset: null, conversation };

        const message: SupportMessage = {
          id: messageId,
          conversationId: input.conversationId,
          sender: input.sender,
          body,
          action: input.action ?? null,
          attachmentId: assetId,
          replyToMessageId: input.replyToMessageId ?? null,
          createdAt: timestamp,
        };
        await scope.put(STORE_MESSAGES, message);

        let asset: SupportAssetMeta | null = null;
        if (attachment && assetId) {
          asset = {
            id: assetId,
            conversationId: input.conversationId,
            messageId,
            fileName: attachment.name,
            mimeType: attachment.type,
            fileSize: attachment.size,
            width: dimensions.width,
            height: dimensions.height,
            createdAt: timestamp,
          };
          await scope.put(STORE_SUPPORT_ASSETS, asset);
          await scope.put(STORE_BLOBS, attachment, `${BLOB_PREFIX}${assetId}`);
        }

        // The unread counter belongs to the other side of the conversation.
        const fromCustomer = input.sender === "customer";
        const next: SupportConversation = {
          ...conversation,
          lastMessagePreview: preview(body, attachment !== null),
          lastMessageAt: timestamp,
          lastMessageSender: input.sender,
          unreadForAdmin: fromCustomer ? conversation.unreadForAdmin + 1 : conversation.unreadForAdmin,
          unreadForCustomer: fromCustomer ? conversation.unreadForCustomer : conversation.unreadForCustomer + 1,
          // An admin reply moves a thread from "waiting on us" to "answered";
          // a customer message always reopens it.
          status: fromCustomer ? "open" : input.sender === "admin" ? "pending" : conversation.status,
          checkoutDraft: input.sender === "admin" && conversation.checkoutDraft
            ? { ...conversation.checkoutDraft, subscriptionFollowupStatus: "admin_handoff" }
            : conversation.checkoutDraft,
          updatedAt: timestamp,
        };
        await scope.put(STORE_CONVERSATIONS, next);

        return { message, asset, conversation: next };
      },
    );
  },

  async selectPaymentMethod(input) {
    const idempotencyKey = `event:${input.conversationId}:payment-method:${input.checkoutIntentId}`;
    return runTransaction([STORE_CONVERSATIONS, STORE_MESSAGES], "readwrite", async (scope) => {
      const conversation = await scope.get<SupportConversation>(STORE_CONVERSATIONS, input.conversationId);
      const draft = conversation?.checkoutDraft;
      if (!conversation || !draft || draft.planId !== input.planId) return false;
      const checkoutIntentId = draft.checkoutIntentId ?? `${conversation.id}:${draft.planId}`;
      if (checkoutIntentId !== input.checkoutIntentId) return false;

      if (draft.selectedPaymentMethod) return draft.selectedPaymentMethod === input.method;
      if (draft.paymentDecision !== "yes" || draft.subscriptionFollowupStatus !== "awaiting_payment_method") return false;
      const messages = await scope.getAllFromIndex<SupportMessage>(STORE_MESSAGES, "by_conversation", input.conversationId);
      if (messages.some((message) => message.sender === "admin")) return false;

      const message: SupportMessage = {
        id: idempotencyKey,
        conversationId: input.conversationId,
        sender: "customer",
        body: paymentMethodLabel(input.method),
        action: { type: "select_payment_method", value: input.method },
        attachmentId: null,
        replyToMessageId: null,
        createdAt: nextIso(),
      };
      await scope.put(STORE_MESSAGES, message);
      const updated: SupportConversation = {
        ...conversation,
        checkoutDraft: {
          ...draft,
          checkoutIntentId,
          selectedPaymentMethod: input.method,
          subscriptionFollowupStatus: "payment_method_selected",
        },
        lastMessagePreview: message.body,
        lastMessageAt: message.createdAt,
        lastMessageSender: "customer",
        unreadForAdmin: conversation.unreadForAdmin + 1,
        status: "open",
        updatedAt: message.createdAt,
      };
      await scope.put(STORE_CONVERSATIONS, updated);
      return true;
    });
  },

  async getAttachment(assetId) {
    const blob = await runTransaction([STORE_BLOBS], "readonly", (scope) =>
      scope.get<Blob>(STORE_BLOBS, `${BLOB_PREFIX}${assetId}`),
    );
    return blob ?? null;
  },

  async markRead(conversationId, reader, lastReadMessageId) {
    if (!lastReadMessageId) return;
    await runTransaction([STORE_CONVERSATIONS, STORE_MESSAGES], "readwrite", async (scope) => {
      const conversation = await scope.get<SupportConversation>(STORE_CONVERSATIONS, conversationId);
      if (!conversation) return;
      const message = await scope.get<SupportMessage>(STORE_MESSAGES, lastReadMessageId);
      if (!message || message.conversationId !== conversationId) return;
      const incoming = reader === "customer" ? message.sender !== "customer" : message.sender === "customer";
      if (!incoming) return;
      const readAt = reader === "customer" ? conversation.customerLastReadAt : conversation.adminLastReadAt;
      const nextReadAt = readAt && readAt > message.createdAt ? readAt : message.createdAt;

      await scope.put(STORE_CONVERSATIONS, {
        ...conversation,
        unreadForAdmin: reader === "admin" ? 0 : conversation.unreadForAdmin,
        unreadForCustomer: reader === "customer" ? 0 : conversation.unreadForCustomer,
        customerLastReadAt: reader === "customer" ? nextReadAt : conversation.customerLastReadAt,
        adminLastReadAt: reader === "admin" ? nextReadAt : conversation.adminLastReadAt,
      });
    });
  },

  async countUnreadForAdmin() {
    const conversations = await runTransaction([STORE_CONVERSATIONS], "readonly", (scope) =>
      scope.getAll<SupportConversation>(STORE_CONVERSATIONS),
    );
    return conversations.reduce((total, conversation) => total + (conversation.unreadForAdmin > 0 ? 1 : 0), 0);
  },
};
