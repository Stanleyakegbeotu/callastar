import { corsHeaders, decryptCallId, isAllowedCorsOrigin, json, normalizeCode, requireAdmin, serviceClient } from "../_shared/utils.ts";

const encode = (value: Uint8Array) => btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isAllowedCorsOrigin(request)) return json({ error: "origin_not_allowed" }, 403);
  const admin = await requireAdmin(request);
  if (!admin) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  if (typeof body.profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.profileId)) return json({ error: "invalid_request" }, 400);

  const secret = Deno.env.get("SIGNALING_HOST_TOKEN_SECRET");
  if (!secret || secret.length < 32) return json({ error: "credential_service_unavailable" }, 503);
  const client = serviceClient();
  const { data: host, error } = await client.from("hosts").select("id,status").eq("id", body.profileId).eq("status", "active").maybeSingle();
  if (error) return json({ error: "profile_unavailable" }, 503);
  if (!host) return json({ error: "profile_unavailable" }, 403);
  const { data: ticket, error: ticketError } = await client.from("call_ids").select("code_ciphertext")
    .eq("host_id", host.id).eq("status", "active").or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (ticketError || !ticket?.code_ciphertext) return json({ error: "profile_unavailable" }, 403);
  let callIdKey: string;
  try { callIdKey = normalizeCode(await decryptCallId(ticket.code_ciphertext)); }
  catch { return json({ error: "credential_service_unavailable" }, 503); }
  if (!callIdKey) return json({ error: "profile_unavailable" }, 403);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = encode(new TextEncoder().encode(JSON.stringify({ iss: "callastar-admin", aud: "callastar-signaling", sub: admin.id, role: "admin", profileId: host.id, callIdKey, iat: now, exp: expiresAt })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`))));
  return json({ token: `${header}.${payload}.${signature}`, expiresAt: expiresAt * 1000 });
});
