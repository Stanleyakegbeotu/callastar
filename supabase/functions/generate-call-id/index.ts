import { corsHeaders, json, requireAdmin, serviceClient } from "../_shared/utils.ts";
import { ticketCandidate } from "../_shared/callTickets.ts";
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!await requireAdmin(request)) return json({ error: "unauthorized" }, 401);
  const { hostId, mode = null, maxUses = null, regenerate = true } = await request.json().catch(() => ({}));
  if (typeof hostId !== "string" || (mode !== null && !["free", "premium"].includes(mode)) ||
      (maxUses !== null && ![1,2,3,5].includes(maxUses)) || typeof regenerate !== "boolean") return json({ error: "invalid_request" }, 400);
  try {
    const candidate = await ticketCandidate();
    const { data: id, error } = await serviceClient().rpc("configure_call_ticket", {
      p_host_id: hostId, p_candidate: candidate.record, p_mode: mode, p_max_uses: maxUses, p_regenerate: regenerate,
    });
    if (error) return json({ error: "ticket_configuration_failed" }, 500);
    const { data: issued } = await serviceClient().from("call_ids").select("code_hash").eq("id",id).single();
    return json({ id, code: issued?.code_hash === candidate.record.code_hash ? candidate.code : null });
  } catch { return json({ error: "call_id_encryption_unavailable" }, 503); }
});
