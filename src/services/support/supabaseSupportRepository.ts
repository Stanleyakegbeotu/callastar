import { SUPPORT_LIMITS } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";
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
import { isPaymentMethod } from "./paymentMethods";
import { sendAdminEvent } from "@/services/notifications/adminEvents";
import type { SupportCustomerIdentity } from "./customerIdentity";

type Row = Record<string, any>;
const BUCKET = "support-attachments";
let customerIdentity: SupportCustomerIdentity | null = null;

async function customerAction<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  if (!customerIdentity) throw new Error("Customer support identity is unavailable.");
  const { data, error } = await requireSupabase().functions.invoke("support-customer", {
    body: { action, email: customerIdentity.normalizedEmail, displayEmail: customerIdentity.email,
      name: customerIdentity.name, phone: customerIdentity.phone, guestSessionId: customerIdentity.guestSessionId, ...values },
  });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Customer support is unavailable.");
  return data as T;
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function fromConversation(row: Row): SupportConversation {
  return {
    id: row.id,
    customerEmail: row.customer_email ?? "",
    customerEmailNormalized: row.customer_email_normalized ?? "",
    customerName: row.customer_name ?? "",
    subject: row.subject,
    status: row.status,
    subscriptionRequestId: row.subscription_request_id,
    packageBriefSeenAt: row.package_brief_seen_at,
    checkoutDraft: row.checkout_draft ?? null,
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    lastMessageSender: row.last_message_sender,
    unreadForAdmin: row.unread_for_admin,
    unreadForCustomer: row.unread_for_customer,
    customerLastReadAt: row.customer_last_read_at ?? null,
    adminLastReadAt: row.admin_last_read_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConversationPatch(patch: Partial<SupportConversation>): Row {
  const columns: Partial<Record<keyof SupportConversation, string>> = {
    customerEmail: "customer_email",
    customerEmailNormalized: "customer_email_normalized",
    customerName: "customer_name",
    subject: "subject",
    status: "status",
    subscriptionRequestId: "subscription_request_id",
    packageBriefSeenAt: "package_brief_seen_at",
    checkoutDraft: "checkout_draft",
    lastMessagePreview: "last_message_preview",
    lastMessageAt: "last_message_at",
    lastMessageSender: "last_message_sender",
    unreadForAdmin: "unread_for_admin",
    unreadForCustomer: "unread_for_customer",
    customerLastReadAt: "customer_last_read_at",
    adminLastReadAt: "admin_last_read_at",
  };
  const result: Row = {};
  for (const [key, value] of Object.entries(patch) as [keyof SupportConversation, unknown][]) {
    const column = columns[key];
    if (column) result[column] = value;
  }
  return result;
}

function fromMessage(row: Row): SupportMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender,
    body: row.body,
    action: row.action_type === "select_payment_method" && isPaymentMethod(row.action_value)
      ? { type: "select_payment_method", value: row.action_value }
      : row.action_type === "continue_payment_method_selection"
        ? { type: "continue_payment_method_selection" }
        : row.action_type === "payment_method_help"
          ? { type: "payment_method_help" }
          : null,
    attachmentId: row.attachment_id,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  };
}

function fromAsset(row: Row): SupportAssetMeta {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

function preview(body: string, hasAttachment: boolean): string {
  const trimmed = body.trim();
  if (trimmed) return trimmed.slice(0, 120);
  return hasAttachment ? "Sent an image" : "";
}

export const supabaseSupportRepository: SupportRepository = {
  mode: "supabase",

  setCustomerIdentity(identity) { customerIdentity = identity; },
  async linkGuestConversation() { await customerAction("link_guest"); },

  async findConversationByEmail(email) {
    if (customerIdentity) {
      const { conversation } = await customerAction<{ conversation: Row | null }>("resolve", { email: email.trim().toLowerCase(), displayEmail: email.trim() });
      return conversation ? fromConversation(conversation) : null;
    }
    const conversations = await this.listConversationsByEmail(email);
    return conversations[0] ?? null;
  },

  async listConversationsByEmail(email) {
    if (customerIdentity) {
      const conversation = await this.findConversationByEmail(email);
      return conversation ? [conversation] : [];
    }
    const normalized = email.trim().toLowerCase();
    if (!normalized) return [];
    const { data, error } = await requireSupabase()
      .from("support_conversations")
      .select("*")
      .eq("customer_email_normalized", normalized)
      .order("last_message_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(fromConversation);
  },

  async startConversation(input: StartConversationInput) {
    if (customerIdentity) {
      const { conversation } = await customerAction<{ conversation: Row }>("resolve", {
        email: input.customerEmail, name: input.customerName, subject: input.subject,
        subscriptionRequestId: input.subscriptionRequestId ?? null,
      });
      return fromConversation(conversation);
    }
    const id = newId();
    const timestamp = new Date().toISOString();
    const email = input.customerEmail.trim();
    const { data, error } = await requireSupabase()
      .from("support_conversations")
      .insert({
        id,
        customer_email: email,
        customer_email_normalized: email.toLowerCase(),
        customer_name: input.customerName.trim(),
        subject: input.subject,
        status: "open",
        subscription_request_id: input.subscriptionRequestId ?? null,
        last_message_preview: "",
        last_message_at: timestamp,
        last_message_sender: "customer",
        unread_for_admin: 0,
        unread_for_customer: 0,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select("*")
      .single();
    if (error) throw error;
    return fromConversation(data);
  },

  async getConversation(id) {
    if (customerIdentity) {
      const { conversation } = await customerAction<{ conversation: Row | null }>("get", { conversationId: id });
      return conversation ? fromConversation(conversation) : null;
    }
    const { data, error } = await requireSupabase()
      .from("support_conversations")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? fromConversation(data) : null;
  },

  async listConversations(filters) {
    let query = requireSupabase().from("support_conversations").select("*");
    if (filters?.status && filters.status !== "all") query = query.eq("status", filters.status);
    if (filters?.unreadOnly) query = query.gt("unread_for_admin", 0);
    const { data, error } = await query.order("last_message_at", { ascending: false });
    if (error) throw error;
    const search = filters?.search?.trim().toLowerCase() ?? "";
    const filtered = (data ?? []).map(fromConversation).filter((conversation) =>
      !search || [conversation.customerEmail, conversation.customerName, conversation.subject].some((value) => value.toLowerCase().includes(search)),
    );
    return filters?.limit ? filtered.slice(0, filters.limit) : filtered;
  },

  async updateConversation(id, patch) {
    if (customerIdentity) {
      const { conversation } = await customerAction<{ conversation: Row | null }>("update", { conversationId: id, patch });
      return conversation ? fromConversation(conversation) : null;
    }
    const values = toConversationPatch(patch);
    if (Object.keys(values).length === 0) return this.getConversation(id);
    const { data, error } = await requireSupabase()
      .from("support_conversations")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? fromConversation(data) : null;
  },

  async listMessages(conversationId) {
    if (customerIdentity) {
      const { messages: messageRows, assets: assetRows } = await customerAction<{ messages: Row[]; assets: Row[] }>("messages", { conversationId });
      const messages = messageRows.map(fromMessage);
      const assets = assetRows.map(fromAsset);
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      const byId = new Map(messages.map((message) => [message.id, message]));
      return messages.map<SupportMessageView>((message) => {
        const quoted = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined;
        return { message, asset: message.attachmentId ? assetById.get(message.attachmentId) ?? null : null,
          replyTo: quoted ? { id: quoted.id, sender: quoted.sender, body: quoted.body, hasAttachment: quoted.attachmentId !== null } : null };
      });
    }
    const client = requireSupabase();
    const [{ data: messageRows, error: messagesError }, { data: assetRows, error: assetsError }] = await Promise.all([
      client.from("support_messages").select("*").eq("conversation_id", conversationId).order("created_at").order("id"),
      client.from("support_assets").select("*").eq("conversation_id", conversationId),
    ]);
    if (messagesError) throw messagesError;
    if (assetsError) throw assetsError;

    const messages = (messageRows ?? []).map(fromMessage);
    const assets = (assetRows ?? []).map(fromAsset);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const byId = new Map(messages.map((message) => [message.id, message]));
    return messages.map<SupportMessageView>((message) => {
      const quoted = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined;
      return {
        message,
        asset: message.attachmentId ? assetById.get(message.attachmentId) ?? null : null,
        replyTo: quoted
          ? { id: quoted.id, sender: quoted.sender, body: quoted.body, hasAttachment: quoted.attachmentId !== null }
          : null,
      };
    });
  },

  async sendMessage(input: SendMessageInput) {
    if (customerIdentity && input.sender !== "admin") {
      if (input.action) throw new Error("Use the structured support action for this selection.");
      if (input.sender === "assistant" && !input.idempotencyKey) throw new Error("Automated support messages require an idempotency key.");
      let attachment: Record<string, unknown> | null = null;
      if (input.attachment) {
        if (input.attachment.size > SUPPORT_LIMITS.MAX_ATTACHMENT_BYTES || !SUPPORT_LIMITS.ATTACHMENT_MIME_TYPES.includes(input.attachment.type as never)) throw new Error("That image cannot be attached.");
        const dimensions = await readImageMetadata(input.attachment);
        const bytes = new Uint8Array(await input.attachment.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        attachment = { base64: btoa(binary), fileName: input.attachment.name, mimeType: input.attachment.type,
          fileSize: input.attachment.size, width: dimensions.width, height: dimensions.height };
      }
      const result = await customerAction<{ message: Row; asset: Row | null; conversation: Row }>("send", {
        conversationId: input.conversationId, body: input.body, sender: input.sender, idempotencyKey: input.idempotencyKey ?? null, attachment,
      });
      return { message: fromMessage(result.message), asset: result.asset ? fromAsset(result.asset) : null, conversation: fromConversation(result.conversation) };
    }
    if (input.action?.type === "select_payment_method") {
      throw new Error("Payment methods must be selected through the validated payment action.");
    }
    const client = requireSupabase();
    const attachment = input.attachment ?? null;
    if (attachment && attachment.size > SUPPORT_LIMITS.MAX_ATTACHMENT_BYTES) throw new Error("That image is too large to attach.");

    const conversation = await this.getConversation(input.conversationId);
    if (!conversation) throw new Error("That conversation is unavailable.");

    const id = input.idempotencyKey
      ? `event:${input.conversationId}:${input.idempotencyKey}`
      : newId();
    const assetId = attachment ? newId() : null;
    const body = input.body.trim().slice(0, SUPPORT_LIMITS.MESSAGE_MAX);
    let storagePath: string | null = null;
    let dimensions = { width: null as number | null, height: null as number | null };

    if (attachment && assetId) {
      dimensions = await readImageMetadata(attachment);
      storagePath = `${input.conversationId}/${assetId}`;
      const { error } = await client.storage.from(BUCKET).upload(storagePath, attachment, {
        contentType: attachment.type,
        upsert: false,
      });
      if (error) throw error;
    }

    const { data: messageRow, error: messageError } = await client
      .from("support_messages")
      .insert({
        id,
        conversation_id: input.conversationId,
        sender: input.sender,
        body,
        action_type: input.action?.type ?? null,
        action_value: null,
        attachment_id: assetId,
        reply_to_message_id: input.replyToMessageId ?? null,
      })
      .select("*")
      .single();
    if (messageError?.code === "23505" && input.idempotencyKey) {
      const { data: existing, error: lookupError } = await client
        .from("support_messages")
        .select("*")
        .eq("id", id)
        .single();
      if (lookupError) throw lookupError;
      return { message: fromMessage(existing), asset: null, conversation };
    }
    if (messageError) {
      if (storagePath) await client.storage.from(BUCKET).remove([storagePath]);
      throw messageError;
    }

    let asset: SupportAssetMeta | null = null;
    if (attachment && assetId && storagePath) {
      const { data: assetRow, error: assetError } = await client
        .from("support_assets")
        .insert({
          id: assetId,
          conversation_id: input.conversationId,
          message_id: id,
          file_name: attachment.name,
          mime_type: attachment.type,
          file_size: attachment.size,
          width: dimensions.width,
          height: dimensions.height,
          storage_path: storagePath,
        })
        .select("*")
        .single();
      if (assetError) throw assetError;
      asset = fromAsset(assetRow);
    }

    const fromCustomer = input.sender === "customer";
    const updated = await this.updateConversation(input.conversationId, {
      lastMessagePreview: preview(body, attachment !== null),
      lastMessageAt: messageRow.created_at,
      lastMessageSender: input.sender,
      unreadForAdmin: fromCustomer ? conversation.unreadForAdmin + 1 : conversation.unreadForAdmin,
      unreadForCustomer: fromCustomer ? conversation.unreadForCustomer : conversation.unreadForCustomer + 1,
      status: fromCustomer ? "open" : input.sender === "admin" ? "pending" : conversation.status,
      checkoutDraft: input.sender === "admin" && conversation.checkoutDraft
        ? { ...conversation.checkoutDraft, subscriptionFollowupStatus: "admin_handoff" }
        : conversation.checkoutDraft,
    });
    if (!updated) throw new Error("The message was saved, but its conversation could not be updated.");

    return { message: fromMessage(messageRow), asset, conversation: updated };
  },

  async selectPaymentMethod(input) {
    if (customerIdentity) {
      const { selected } = await customerAction<{ selected: boolean }>("select_payment_method", input);
      if (selected) sendAdminEvent("payment_method_selected", input.conversationId, `Customer selected ${input.method} as a payment method.`);
      return selected;
    }
    const client = requireSupabase();
    const { data, error } = await client.rpc("select_support_payment_method", {
      p_conversation_id: input.conversationId,
      p_plan_id: input.planId,
      p_checkout_intent_id: input.checkoutIntentId,
      p_method: input.method,
    });
    if (error) throw error;
    if (data === true) sendAdminEvent("payment_method_selected", input.conversationId, `Customer selected ${input.method} as a payment method.`);
    return data === true;
  },

  async getAttachment(assetId) {
    if (customerIdentity) {
      const { base64, mimeType } = await customerAction<{ base64: string; mimeType: string }>("attachment", { assetId });
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    }
    const client = requireSupabase();
    const { data: asset, error: lookupError } = await client.from("support_assets").select("storage_path").eq("id", assetId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!asset) return null;
    const { data, error } = await client.storage.from(BUCKET).download(asset.storage_path);
    if (error) throw error;
    return data;
  },

  async markRead(conversationId, reader, lastReadMessageId) {
    if (!lastReadMessageId) return;
    if (customerIdentity && reader === "customer") {
      await customerAction("mark_read", { conversationId, lastReadMessageId });
      return;
    }
    const { error } = await requireSupabase().rpc("mark_support_conversation_read", {
      p_conversation_id: conversationId,
      p_reader: reader,
      p_last_read_message_id: lastReadMessageId,
    });
    if (error) throw error;
  },

  async countUnreadForAdmin() {
    const { count, error } = await requireSupabase()
      .from("support_conversations")
      .select("id", { count: "exact", head: true })
      .gt("unread_for_admin", 0);
    if (error) throw error;
    return count ?? 0;
  },
};
