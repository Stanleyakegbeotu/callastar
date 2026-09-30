import { corsHeaders, hash, json, normalizeCode, randomToken, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { code, callType, caller } = await request.json().catch(() => ({}));
  if (typeof code !== "string" || !["video", "audio"].includes(callType) || !caller || typeof caller.fullName !== "string" || typeof caller.email !== "string" || typeof caller.phone !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: callId } = await client.from("call_ids").select("id, host:hosts!inner(id, display_name, avatar_path, status), expires_at").eq("code_hash", await hash(normalizeCode(code))).eq("status", "active").maybeSingle();
  const host = callId?.host as { id: string; display_name: string; avatar_path: string | null; status: string } | null;
  if (!callId || !host || host.status !== "active" || (callId.expires_at && callId.expires_at <= new Date().toISOString())) return json({ error: "not_found" }, 404);
  const sessionToken = randomToken();
  const { data: session, error } = await client.from("call_sessions").insert({ host_id: host.id, call_id_id: callId.id, call_type: callType, visitor_name: caller.fullName.trim(), visitor_email: caller.email.trim().toLowerCase(), visitor_phone: caller.phone.trim(), session_token_hash: await hash(sessionToken) }).select("id, status").single();
  if (error || !session) return json({ error: "session_failed" }, 500);
  await client.from("call_events").insert({ session_id: session.id, event_type: "session_created" });
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  return json({ sessionId: session.id, sessionToken, status: session.status, host: { id: host.id, displayName: host.display_name, avatarUrl } });
});
