import { corsHeaders, decryptCallId, json, requireAdmin, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!await requireAdmin(request)) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  const hostIds = Array.isArray(body.hostIds) ? body.hostIds.filter((id: unknown) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200) : [];
  const client = serviceClient();
  let query = client.from("call_ids").select("id,host_id,code_last4,code_ciphertext,expires_at,created_at").eq("status", "active").order("created_at", { ascending: false });
  if (hostIds.length) query = query.in("host_id", hostIds);
  const { data, error } = await query;
  if (error) return json({ error: "call_ids_unavailable" }, 500);
  const rows = await Promise.all((data ?? []).map(async (row) => ({
    id: row.id, hostId: row.host_id, codeLast4: row.code_last4,
    code: row.code_ciphertext ? await decryptCallId(row.code_ciphertext).catch(() => null) : null,
    expiresAt: row.expires_at, createdAt: row.created_at,
  })));
  return json({ callIds: rows });
});
