import { logDiagnostic } from "@/lib/utils";
import { supportRepository } from "@/services/support/repository";
import type { SupportConversation } from "@/services/support/types";

/**
 * Getting into a support conversation.
 *
 * The email is a lookup key and nothing else. There is no code to enter, no
 * link to click and no message sent to the address — "Checking email…" means
 * only that the format is being checked and a previous conversation is being
 * looked for. Nothing in this flow may ever tell somebody their email was
 * verified, because it was not.
 */

/** Deliberately permissive: one @, a dot in the domain, no whitespace. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Whether this is shaped like an email address.
 *
 * Returns a translation key rather than a sentence, so the wording lives with
 * the other copy and this stays a pure check with no opinion about language.
 */
export function validateSupportEmail(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "errors.emailRequired";
  if (!EMAIL_PATTERN.test(trimmed)) return "errors.invalidEmail";
  return null;
}

export interface ResolveConversationInput {
  email: string;
  name: string;
  subject: string;
  subscriptionRequestId?: string | null;
}

/**
 * Resolutions already running, by normalised email.
 *
 * "Look for a conversation, create one if there is none" is read-then-write, so
 * two overlapping calls both read nothing and both create — and the customer
 * ends up with their history split across two threads. StrictMode's double
 * effect produces exactly that overlap on every mount in development, and a
 * double tap would do it in production.
 *
 * Sharing the in-flight promise makes the second caller wait for the first and
 * receive the same conversation. Keyed by email rather than globally, so two
 * different people are never serialised behind each other.
 */
const inFlight = new Map<string, Promise<SupportConversation>>();

/**
 * The customer's conversation: the one they already had, or a new one.
 *
 * Recovery is the point. Somebody who came back on a new call, or after closing
 * the tab, types the same email and finds the thread they were already in
 * rather than starting again with support knowing nothing.
 */
export function resolveConversation(input: ResolveConversationInput): Promise<SupportConversation> {
  const key = input.email.trim().toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;

  const pending = resolveOnce(input).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function resolveOnce(input: ResolveConversationInput): Promise<SupportConversation> {
  const existing = await supportRepository.findConversationByEmail(input.email);

  if (existing) {
    // A returning customer paying for a new plan: point the thread at the
    // request they are asking about now, without losing its history.
    if (input.subscriptionRequestId && existing.subscriptionRequestId !== input.subscriptionRequestId) {
      const updated = await supportRepository
        .updateConversation(existing.id, { subscriptionRequestId: input.subscriptionRequestId })
        .catch((error: unknown) => {
          logDiagnostic("support-link-request", error);
          return null;
        });
      return updated ?? existing;
    }
    return existing;
  }

  return supportRepository.startConversation({
    customerEmail: input.email,
    customerName: input.name,
    subject: input.subject,
    subscriptionRequestId: input.subscriptionRequestId ?? null,
  });
}
