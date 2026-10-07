import { config, type AdminDataMode } from "@/lib/config";

import { localSupportRepository } from "./localSupportRepository";
import { supabaseSupportRepository } from "./supabaseSupportRepository";
import type {
  ConversationFilters,
  SendMessageInput,
  SentMessage,
  StartConversationInput,
  SupportConversation,
  SupportMessageView,
} from "./types";
import type { PaymentMethod } from "./paymentMethods";
import type { SupportCustomerIdentity } from "./customerIdentity";

/**
 * The seam for customer care. Both sides of a conversation — the customer's
 * chat and the admin inbox — talk only to this, so neither knows whether the
 * other is in the same browser or across a network.
 */
export interface SupportRepository {
  readonly mode: AdminDataMode;
  setCustomerIdentity?(identity: SupportCustomerIdentity | null): void;
  linkGuestConversation?(): Promise<void>;

  /**
   * Find a customer's most recent thread by email. Format-checked lookup only:
   * this proves nothing about who owns the address, and nothing here behaves as
   * if it did.
   */
  findConversationByEmail(email: string): Promise<SupportConversation | null>;
  listConversationsByEmail(email: string): Promise<SupportConversation[]>;
  startConversation(input: StartConversationInput): Promise<SupportConversation>;
  getConversation(id: string): Promise<SupportConversation | null>;
  listConversations(filters?: ConversationFilters): Promise<SupportConversation[]>;
  updateConversation(id: string, patch: Partial<SupportConversation>): Promise<SupportConversation | null>;

  listMessages(conversationId: string): Promise<SupportMessageView[]>;
  sendMessage(input: SendMessageInput): Promise<SentMessage>;
  /** Atomically validates, records, and selects one payment method for an active checkout. */
  selectPaymentMethod(input: {
    conversationId: string;
    planId: string;
    checkoutIntentId: string;
    method: PaymentMethod;
  }): Promise<boolean>;
  /** The bytes of one attachment, fetched deliberately and never while listing. */
  getAttachment(assetId: string): Promise<Blob | null>;

  /** Advance a read cursor only through the last incoming message actually shown. */
  markRead(conversationId: string, reader: "customer" | "admin", lastReadMessageId?: string | null): Promise<void>;
  countUnreadForAdmin(): Promise<number>;
}

export function getSupportRepository(): SupportRepository {
  return config.adminDataMode === "local" ? localSupportRepository : supabaseSupportRepository;
}

export const supportRepository = getSupportRepository();
