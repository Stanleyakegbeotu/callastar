import { corsHeaders, hash, json, normalizeCode, randomToken, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { code, callType, caller } = await request.json().catch(() => ({}));
  if (typeof code !== "string" || code.length > 64 || !["video", "audio"].includes(callType) || !caller ||
      typeof caller.fullName !== "string" || caller.fullName.trim().length < 2 || caller.fullName.length > 120 ||
      typeof caller.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(caller.email) || caller.email.length > 254 ||
      typeof caller.phone !== "string" || caller.phone.trim().length < 7 || caller.phone.length > 32) return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: callId } = await client.from("call_ids").select("id,code_last4, host:hosts!inner(id, display_name, avatar_path, status), expires_at").eq("code_hash", await hash(normalizeCode(code))).eq("status", "active").maybeSingle();
  const host = callId?.host as { id: string; display_name: string; avatar_path: string | null; status: string } | null;
  if (!callId || !host || host.status !== "active" || (callId.expires_at && callId.expires_at <= new Date().toISOString())) return json({ error: "not_found" }, 404);
  const sessionToken = randomToken();
  const { data: session, error } = await client.from("call_sessions").insert({ host_id: host.id, call_id_id: callId.id, call_id_snapshot: `••••-${callId.code_last4}`, profile_name_snapshot: host.display_name, call_type: callType, visitor_name: caller.fullName.trim(), visitor_email: caller.email.trim().toLowerCase(), visitor_phone: caller.phone.trim(), session_token_hash: await hash(sessionToken) }).select("id, status").single();
  if (error || !session) return json({ error: "session_failed" }, 500);
  await client.from("call_events").insert({ session_id: session.id, event_type: "session_created" });
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  return json({ sessionId: session.id, sessionToken, status: session.status, host: { id: host.id, displayName: host.display_name, avatarUrl } });
});
