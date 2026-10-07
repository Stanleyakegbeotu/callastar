import { corsHeaders, encryptCallId, hash, json, normalizeCode, randomCode, requireAdmin, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const admin = await requireAdmin(request);
  if (!admin) return json({ error: "unauthorized" }, 401);
  const { hostId, expiresAt = null } = await request.json().catch(() => ({}));
  if (typeof hostId !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: host } = await client.from("hosts").select("id").eq("id", hostId).maybeSingle();
  if (!host) return json({ error: "not_found" }, 404);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = randomCode();
    let codeCiphertext: string;
    try { codeCiphertext = await encryptCallId(code); }
    catch (error) { console.error("call_id_encryption_unavailable", String(error)); return json({ error: "call_id_encryption_unavailable" }, 503); }
    const { data, error } = await client.from("call_ids").insert({ host_id: hostId, code_hash: await hash(normalizeCode(code)), code_last4: code.slice(-4), code_ciphertext: codeCiphertext, expires_at: expiresAt, created_by: admin.id }).select("id, code_last4, expires_at, created_at").single();
    if (!error && data) return json({ id: data.id, code, codeLast4: data.code_last4, expiresAt: data.expires_at, createdAt: data.created_at });
    if (error?.code !== "23505") return json({ error: "creation_failed" }, 500);
  }
  return json({ error: "creation_failed" }, 500);
});
