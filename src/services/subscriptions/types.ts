/**
 * Subscription plans are GLOBAL: every CallaStar profile uses the same three
 * plans at the same prices. Plan ids are stable and never change, so renaming
 * "Premium" in the dashboard cannot break a historical request.
 */
export type SubscriptionPlanId = "regular" | "premium" | "gold";

export type SupportPriority = "standard" | "priority" | "highest";

export interface SubscriptionPlan {
  id: SubscriptionPlanId;
  displayName: string;
  /** Cents, so money is never held in a float. */
  priceUsdCents: number;
  sessionDurationMinutes: number;
  supportPriority: SupportPriority;
  description: string;
  features: string[];
  isActive: boolean;
  isMostPopular: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionPlanPatch = Partial<
  Pick<
    SubscriptionPlan,
    | "displayName"
    | "priceUsdCents"
    | "sessionDurationMinutes"
    | "supportPriority"
    | "description"
    | "features"
    | "isActive"
    | "isMostPopular"
  >
>;

export type SubscriptionRequestStatus =
  | "awaiting_payment"
  | "proof_submitted"
  | "reviewing"
  | "confirmed"
  | "needs_attention"
  | "cancelled";

export type SupportChannel = "whatsapp" | "in_app";

export interface SubscriptionRequest {
  id: string;
  /** Short human reference shared with support, e.g. CS-REQ-4K7P. */
  reference: string;
  sessionId: string;
  profileId: string;
  profileName: string;
  customerEmail: string;
  customerEmailNormalized: string;
  planId: SubscriptionPlanId;
  planNameSnapshot: string;
  /** Snapshotted at creation: later price edits never rewrite history. */
  amountUsdCents: number;
  channel: SupportChannel;
  status: SubscriptionRequestStatus;
  conversationId: string | null;
  proofMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface CreateSubscriptionRequestInput {
  sessionId: string;
  profileId: string;
  profileName: string;
  customerEmail: string;
  planId: SubscriptionPlanId;
  planNameSnapshot: string;
  amountUsdCents: number;
  channel: SupportChannel;
}

/**
 * Access granted to a customer after support confirms a payment, and spent on
 * ONE call session.
 *
 * The call a subscription was requested from is already over by the time an
 * admin confirms it — that call ended the moment access was found to be
 * missing, and it is never resumed. So a grant belongs to the customer, and the
 * next call they start claims it. `sessionId` records where the request came
 * from, for history; `consumedBySessionId` records which call actually used it,
 * and until that is set the grant is waiting to be claimed.
 *
 * Deliberately not modelled as recurring billing: nothing here renews, because
 * nothing in this phase actually charges anyone on a schedule.
 */
export interface CallAccessGrant {
  id: string;
  /** The session whose checkpoint asked for this subscription. */
  sessionId: string;
  requestId: string;
  planId: SubscriptionPlanId;
  customerEmailNormalized: string;
  /** The call that spent this grant, or null while it is still unclaimed. */
  consumedBySessionId: string | null;
  consumedAt: string | null;
  status: "active" | "revoked";
  grantedAt: string;
}

export interface ClaimAccessInput {
  sessionId: string;
  customerEmail: string;
}

export interface SubscriptionRequestFilters {
  status?: SubscriptionRequestStatus | "all";
  channel?: SupportChannel | "all";
  limit?: number;
}
