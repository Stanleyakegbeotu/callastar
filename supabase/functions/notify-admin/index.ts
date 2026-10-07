import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

const events = new Set(["new_call", "call_answered", "call_completed", "support_started", "payment_method_selected", "payment_help_requested", "purchase_intent", "call_evidence_captured", "critical_app_event"]);
const labels: Record<string, { title: string; entity: string }> = {
  new_call: { title: "New call request", entity: "call_session" },
  call_answered: { title: "Call answered", entity: "call_session" },
  call_completed: { title: "Call completed", entity: "call_session" },
  support_started: { title: "New support conversation", entity: "support_conversation" },
  payment_method_selected: { title: "Payment method selected", entity: "support_conversation" },
  payment_help_requested: { title: "Payment help requested", entity: "support_conversation" },
  purchase_intent: { title: "Subscription intent received", entity: "subscription_request" },
  call_evidence_captured: { title: "Call evidence captured", entity: "call_evidence" },
  critical_app_event: { title: "Critical application event", entity: "system" },
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (typeof body.type !== "string" || !events.has(body.type) || typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 180 || typeof body.entityId !== "string" || body.entityId.length > 180) return json({ error: "invalid_event" }, 400);
  const client = serviceClient();
  const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("cf-connecting-ip") ?? "unknown";
  const { data: rateAllowed, error: rateError } = await client.rpc("callastar_take_notification_rate_limit", { p_rate_key: await hash(source) });
  if (rateError || rateAllowed !== true) return json({ error: "rate_limited" }, 429);
  const summary = typeof body.summary === "string" ? body.summary.replace(/[<>]/g, "").slice(0, 400) : "";
  const { error: claimError } = await client.from("admin_notification_events").insert({ idempotency_key: body.idempotencyKey, event_type: body.type, entity_id: body.entityId });
  if (claimError?.code === "23505") return json({ accepted: true, duplicate: true });
  if (claimError) return json({ accepted: false }, 503);

  const label = labels[body.type];
  const { error: notificationError } = await client.from("admin_notifications").insert({
    notification_type: body.type, title: label.title, body: summary, entity_kind: label.entity,
    entity_id: body.entityId, idempotency_key: body.idempotencyKey,
  });
  if (notificationError) console.error("admin_notification_insert_failed", notificationError.message);

  const { data: settings } = await client.from("app_settings").select("formspree_endpoint").eq("key", "global").maybeSingle();
  const endpoint = settings?.formspree_endpoint;
  if (typeof endpoint === "string" && /^https:\/\/formspree\.io\/f\/[A-Za-z0-9]+$/.test(endpoint)) {
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": body.idempotencyKey },
        body: JSON.stringify({ subject: label.title, event: body.type, entityId: body.entityId, summary, reference: body.reference ?? "" }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) await client.from("admin_notification_events").update({ delivered_at: new Date().toISOString() }).eq("idempotency_key", body.idempotencyKey);
      else console.error("admin_notification_delivery_failed", response.status);
    } catch (error) { console.error("admin_notification_delivery_failed", String(error)); }
  }
  return json({ accepted: true });
});
