import { requireSupabase } from "@/lib/supabase/client";

import type { SubscriptionRepository } from "./repository";
import type {
  CallAccessGrant,
  CreateSubscriptionRequestInput,
  SubscriptionPlan,
  SubscriptionPlanId,
  SubscriptionPlanPatch,
  SubscriptionRequest,
  SubscriptionRequestFilters,
  SubscriptionRequestStatus,
} from "./types";
import { readSupportCustomerIdentity } from "@/services/support/customerIdentity";

type Row = Record<string, any>;

async function customerSubscriptionAction<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  const identity = readSupportCustomerIdentity();
  if (!identity.normalizedEmail) throw new Error("Enter caller details before requesting a subscription.");
  const { data, error } = await requireSupabase().functions.invoke("support-customer", {
    body: { action, email: identity.normalizedEmail, displayEmail: identity.email, guestSessionId: identity.guestSessionId, ...values },
  });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Subscription service unavailable.");
  return data as T;
}

function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function reference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `CS-REQ-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function fromPlan(row: Row): SubscriptionPlan {
  const features: string[] = Array.isArray(row.features) ? row.features : [];
  const meetAndGreetBenefit = "Free meet-and-greet pass included with every package";
  return {
    id: row.id,
    displayName: row.display_name,
    priceMinorUnits: row.price_minor_units,
    currencyCode: row.currency_code,
    sortOrder: row.sort_order,
    sessionDurationMinutes: row.session_duration_minutes,
    supportPriority: row.support_priority,
    description: row.description,
    features: features.includes(meetAndGreetBenefit) ? features : [...features, meetAndGreetBenefit],
    isActive: row.is_active,
    isMostPopular: row.is_most_popular,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromRequest(row: Row): SubscriptionRequest {
  return {
    id: row.id,
    reference: row.reference,
    sessionId: row.session_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    customerEmail: row.customer_email,
    customerEmailNormalized: row.customer_email_normalized,
    planId: row.plan_id,
    planNameSnapshot: row.plan_name_snapshot,
    amountMinorUnits: row.amount_minor_units,
    currencyCode: row.currency_code,
    channel: row.channel,
    status: row.status,
    conversationId: row.conversation_id,
    proofMessageId: row.proof_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
  };
}

function fromGrant(row: Row): CallAccessGrant {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    planId: row.plan_id,
    customerEmailNormalized: row.customer_email_normalized,
    consumedBySessionId: row.consumed_by_session_id,
    consumedAt: row.consumed_at,
    status: row.status,
    grantedAt: row.granted_at,
  };
}

function planPatch(patch: SubscriptionPlanPatch): Row {
  const columns: Partial<Record<keyof SubscriptionPlanPatch, string>> = {
    displayName: "display_name",
    priceMinorUnits: "price_minor_units",
    currencyCode: "currency_code",
    sortOrder: "sort_order",
    sessionDurationMinutes: "session_duration_minutes",
    supportPriority: "support_priority",
    description: "description",
    features: "features",
    isActive: "is_active",
    isMostPopular: "is_most_popular",
  };
  const result: Row = {};
  for (const [key, value] of Object.entries(patch) as [keyof SubscriptionPlanPatch, unknown][]) {
    const column = columns[key];
    if (column) result[column] = value;
  }
  return result;
}

function requestPatch(patch: Partial<SubscriptionRequest>): Row {
  const columns: Partial<Record<keyof SubscriptionRequest, string>> = {
    conversationId: "conversation_id",
    proofMessageId: "proof_message_id",
    status: "status",
    confirmedAt: "confirmed_at",
  };
  const result: Row = {};
  for (const [key, value] of Object.entries(patch) as [keyof SubscriptionRequest, unknown][]) {
    const column = columns[key];
    if (column) result[column] = value;
  }
  return result;
}

export const supabaseSubscriptionRepository: SubscriptionRepository = {
  mode: "supabase",

  async listPlans() {
    const { data, error } = await requireSupabase()
      .from("subscription_plans")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(fromPlan);
  },

  async getPlan(id) {
    const { data, error } = await requireSupabase().from("subscription_plans").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? fromPlan(data) : null;
  },

  async updatePlan(id, patch: SubscriptionPlanPatch) {
    const client = requireSupabase();
    if (patch.isMostPopular) {
      const { error: clearError } = await client.from("subscription_plans").update({ is_most_popular: false }).neq("id", id);
      if (clearError) throw clearError;
    }
    const { data, error } = await client
      .from("subscription_plans")
      .update({ ...planPatch(patch), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return fromPlan(data);
  },

  async createRequest(input: CreateSubscriptionRequestInput) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
      const { request } = await customerSubscriptionAction<{ request: Row }>("subscription_create", { ...input, email: input.customerEmail });
      return fromRequest(request);
    }
    const email = input.customerEmail.trim();
    const { data, error } = await requireSupabase()
      .from("subscription_requests")
      .insert({
        id: newId(),
        reference: reference(),
        session_id: input.sessionId,
        profile_id: input.profileId,
        profile_name: input.profileName,
        customer_email: email,
        customer_email_normalized: email.toLowerCase(),
        plan_id: input.planId,
        plan_name_snapshot: input.planNameSnapshot,
        amount_minor_units: input.amountMinorUnits,
        currency_code: input.currencyCode,
        channel: input.channel,
        status: "awaiting_payment",
      })
      .select("*")
      .single();
    if (error) throw error;
    return fromRequest(data);
  },

  async getRequest(id) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
      const { requests } = await customerSubscriptionAction<{ requests: Row[] }>("subscription_list", { id });
      return requests[0] ? fromRequest(requests[0]) : null;
    }
    const { data, error } = await requireSupabase().from("subscription_requests").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? fromRequest(data) : null;
  },

  async listRequests(filters?: SubscriptionRequestFilters) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
      const { requests } = await customerSubscriptionAction<{ requests: Row[] }>("subscription_list");
      let rows = requests.map(fromRequest);
      if (filters?.status && filters.status !== "all") rows = rows.filter((item) => item.status === filters.status);
      if (filters?.channel && filters.channel !== "all") rows = rows.filter((item) => item.channel === filters.channel);
      return filters?.limit ? rows.slice(0, filters.limit) : rows;
    }
    let query = requireSupabase().from("subscription_requests").select("*");
    if (filters?.status && filters.status !== "all") query = query.eq("status", filters.status);
    if (filters?.channel && filters.channel !== "all") query = query.eq("channel", filters.channel);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data ?? []).map(fromRequest);
    return filters?.limit ? rows.slice(0, filters.limit) : rows;
  },

  async listSessionRequests(sessionId) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
      const { requests } = await customerSubscriptionAction<{ requests: Row[] }>("subscription_list", { sessionId });
      return requests.map(fromRequest);
    }
    const { data, error } = await requireSupabase()
      .from("subscription_requests")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(fromRequest);
  },

  async updateRequest(id, patch) {
    const values = requestPatch(patch);
    if (Object.keys(values).length === 0) return this.getRequest(id);
    const { data, error } = await requireSupabase()
      .from("subscription_requests")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? fromRequest(data) : null;
  },

  async cancelRequest(id) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin")) {
      const { request } = await customerSubscriptionAction<{ request: Row | null }>("subscription_cancel", { id });
      return request ? fromRequest(request) : null;
    }
    const { data, error } = await requireSupabase().rpc("cancel_customer_subscription_request", {
      p_request_id: id,
    });
    if (error) throw error;
    return data ? fromRequest(data) : null;
  },

  async confirmRequest(id) {
    const { data, error } = await requireSupabase().rpc("confirm_subscription_request", { p_request_id: id });
    if (error) throw error;
    return { request: fromRequest(data.request), grant: fromGrant(data.grant) };
  },

  async getSessionAccess(sessionId) {
    const { data, error } = await requireSupabase()
      .from("call_access_grants")
      .select("*")
      .eq("consumed_by_session_id", sessionId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return data ? fromGrant(data) : null;
  },

  async claimAccess({ sessionId }) {
    const { data, error } = await requireSupabase().rpc("claim_call_access", { p_session_id: sessionId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? fromGrant(row) : null;
  },

  async listGrants() {
    const { data, error } = await requireSupabase().from("call_access_grants").select("*").order("granted_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(fromGrant);
  },

  async countRequestsByStatus(status: SubscriptionRequestStatus) {
    const { count, error } = await requireSupabase()
      .from("subscription_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw error;
    return count ?? 0;
  },
};
