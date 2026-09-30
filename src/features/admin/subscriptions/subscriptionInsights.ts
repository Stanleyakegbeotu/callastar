import type { SubscriptionRequestStatus, SupportChannel } from "@/services/subscriptions/types";

/**
 * How subscription requests are described, defined once.
 *
 * The same words and the same colour meaning on the list, the detail page and
 * the overview — so no two screens can tell an operator different things about
 * the same request.
 */

export const REQUEST_STATUS_LABELS: Record<SubscriptionRequestStatus, string> = {
  awaiting_payment: "Awaiting payment",
  proof_submitted: "Proof submitted",
  reviewing: "Reviewing",
  confirmed: "Confirmed",
  needs_attention: "Needs attention",
  cancelled: "Cancelled",
};

export const REQUEST_STATUS_TONE: Record<SubscriptionRequestStatus, string> = {
  awaiting_payment: "progress",
  proof_submitted: "live",
  reviewing: "progress",
  confirmed: "ready",
  needs_attention: "warning",
  cancelled: "neutral",
};

export const CHANNEL_LABELS: Record<SupportChannel, string> = {
  whatsapp: "WhatsApp",
  in_app: "In-app chat",
};

/** Money is stored in cents; it is only ever formatted for display. */
export function formatUsdCents(cents: number): string {
  const whole = cents / 100;
  return whole.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** A request nobody has finished dealing with yet. */
export function isOpenRequest(status: SubscriptionRequestStatus): boolean {
  return status === "awaiting_payment" || status === "proof_submitted" || status === "reviewing";
}
