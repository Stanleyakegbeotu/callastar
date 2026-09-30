import type { SubscriptionRepository } from "./repository";

/**
 * Supabase is not connected in this phase. Every call fails loudly rather than
 * quietly serving another browser's local data.
 *
 * When it lands: plans -> a `subscription_plans` table, requests ->
 * `subscription_requests`, grants -> `call_access_grants`, and confirmation
 * becomes an Edge Function so a customer cannot grant themselves access.
 */
function notConnected(): never {
  throw new Error("Supabase subscription repository is not connected.");
}

export const supabaseSubscriptionRepository: SubscriptionRepository = {
  mode: "supabase",
  listPlans: notConnected,
  getPlan: notConnected,
  updatePlan: notConnected,
  createRequest: notConnected,
  getRequest: notConnected,
  listRequests: notConnected,
  listSessionRequests: notConnected,
  updateRequest: notConnected,
  confirmRequest: notConnected,
  getSessionAccess: notConnected,
  claimAccess: notConnected,
  listGrants: notConnected,
  countRequestsByStatus: notConnected,
};
