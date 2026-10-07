import { corsHeaders, json, requireAdmin, serviceClient } from "../_shared/utils.ts";

function publicShape(row: Record<string, unknown> | null) {
  return {
    whatsappSupportNumber: typeof row?.whatsapp_support_number === "string" ? row.whatsapp_support_number : null,
    whatsappSupportNumberDisplay: typeof row?.whatsapp_support_number_display === "string" ? row.whatsapp_support_number_display : null,
    formspreeConfigured: typeof row?.formspree_endpoint === "string" && row.formspree_endpoint.length > 0,
    updatedAt: typeof row?.updated_at === "string" ? row.updated_at : new Date().toISOString(),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (!await requireAdmin(request)) return json({ error: "unauthorized" }, 401);
  const client = serviceClient();
  if (body.action === "get") {
    const { data, error } = await client.from("app_settings").select("*").eq("key", "global").maybeSingle();
    if (error) return json({ error: "settings_unavailable" }, 500);
    return json(publicShape(data));
  }
  if (body.action !== "update" || !body.patch || typeof body.patch !== "object") return json({ error: "invalid_request" }, 400);
  const patch = body.patch as Record<string, unknown>;
  const values: Record<string, unknown> = { key: "global", updated_at: new Date().toISOString() };
  if ("whatsappSupportNumber" in patch) {
    const digits = patch.whatsappSupportNumber;
    if (digits !== null && (typeof digits !== "string" || !/^\d{8,15}$/.test(digits))) return json({ error: "invalid_whatsapp_number" }, 400);
    values.whatsapp_support_number = digits;
  }
  if ("whatsappSupportNumberDisplay" in patch) {
    const display = patch.whatsappSupportNumberDisplay;
    if (display !== null && (typeof display !== "string" || display.length > 40)) return json({ error: "invalid_whatsapp_display" }, 400);
    values.whatsapp_support_number_display = display;
  }
  if ("formspreeEndpoint" in patch) {
    const endpoint = patch.formspreeEndpoint;
    if (endpoint !== null && (typeof endpoint !== "string" || endpoint.length > 300 || !/^https:\/\/formspree\.io\/f\/[A-Za-z0-9]+$/.test(endpoint))) return json({ error: "invalid_formspree_endpoint" }, 400);
    values.formspree_endpoint = endpoint;
  }
  const { data, error } = await client.from("app_settings").upsert(values, { onConflict: "key" }).select("*").single();
  if (error || !data) return json({ error: "settings_save_failed" }, 500);
  return json(publicShape(data));
});
