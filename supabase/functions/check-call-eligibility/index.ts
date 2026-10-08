import {
  corsHeadersFor,
  isAllowedCorsOrigin,
  jsonForRequest,
  serviceClient,
} from "../_shared/utils.ts"

const normalizeEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : ""

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeadersFor(request) })
  if (!isAllowedCorsOrigin(request))
    return jsonForRequest({ error: "origin_not_allowed" }, 403, request)
  if (request.method !== "POST")
    return jsonForRequest({ error: "method_not_allowed" }, 405, request)
  const email = normalizeEmail((await request.json().catch(() => ({}))).email)
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return jsonForRequest({ error: "invalid_customer_identity" }, 400, request)
  }

  try {
    const client = serviceClient()
    const [
      { data: trial, error: trialError },
      { data: grants, error: grantsError },
      { data: conversations, error: conversationsError },
      { data: legacyCalls, error: callsError },
    ] = await Promise.all([
      client
        .from("call_trial_eligibility")
        .select("state,consumed_at,reserved_until")
        .eq("customer_email_normalized", email)
        .maybeSingle(),
      client
        .from("call_access_grants")
        .select("id")
        .eq("customer_email_normalized", email)
        .eq("status", "active")
        .is("consumed_by_session_id", null)
        .limit(1),
      client
        .from("support_conversations")
        .select("id,checkout_draft,subscription_request_id,last_message_at")
        .eq("customer_email_normalized", email)
        .order("last_message_at", { ascending: false })
        .limit(1),
      client
        .from("call_sessions")
        .select("id,connected_at,created_at")
        .ilike("visitor_email", email)
        .not("connected_at", "is", null)
        .is("access_grant_id", null)
        .order("connected_at", { ascending: true })
        .limit(1),
    ])
    if (trialError || grantsError || conversationsError || callsError)
      throw new Error("eligibility_lookup_failed")

    const legacyConsumed = (legacyCalls ?? []).length > 0
    const trialState =
      trial?.state === "consumed" || legacyConsumed
        ? "consumed"
        : trial?.state === "reserved" &&
            trial.reserved_until &&
            trial.reserved_until > new Date().toISOString()
          ? "reserved"
          : "available"
    const latest = conversations?.[0] ?? null
    const hasSupportFlow = Boolean(latest)
    return jsonForRequest(
      {
        trialState,
        consumedAt:
          trial?.consumed_at ?? legacyCalls?.[0]?.connected_at ?? null,
        paidAccessAvailable: (grants ?? []).length > 0,
        supportConversationId: hasSupportFlow ? latest.id : null,
      },
      200,
      request,
    )
  } catch {
    return jsonForRequest({ error: "eligibility_lookup_failed" }, 500, request)
  }
})
