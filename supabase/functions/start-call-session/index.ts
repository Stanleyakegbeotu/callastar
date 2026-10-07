import { corsHeaders, hash, json, normalizeCode, randomToken, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { code, callType, caller, clientAttemptId } = await request.json().catch(() => ({}));
  if (typeof code !== "string" || code.length > 64 || !["video", "audio"].includes(callType) || !caller ||
      typeof caller.fullName !== "string" || caller.fullName.trim().length < 2 || caller.fullName.length > 120 ||
      typeof caller.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(caller.email) || caller.email.length > 254 ||
      typeof caller.phone !== "string" || caller.phone.trim().length < 7 || caller.phone.length > 32 ||
      typeof clientAttemptId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientAttemptId)) return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: callId } = await client.from("call_ids").select("id,code_last4, host:hosts!inner(id, display_name, avatar_path, status), expires_at").eq("code_hash", await hash(normalizeCode(code))).eq("status", "active").maybeSingle();
  const host = callId?.host as { id: string; display_name: string; avatar_path: string | null; status: string } | null;
  if (!callId || !host || host.status !== "active" || (callId.expires_at && callId.expires_at <= new Date().toISOString())) return json({ error: "not_found" }, 404);
  // The caller's attempt id makes retries idempotent. Only the token hash is
  // stored; each successful retry rotates the opaque token returned to caller.
  let { data: session } = await client.from("call_sessions").select("id,status,access_grant_id")
    .eq("client_attempt_id", clientAttemptId).maybeSingle();
  if (session && (session.status !== "connecting" || session.access_grant_id)) {
    return json({ error: "attempt_already_started" }, 409);
  }
  const sessionToken = randomToken();
  const tokenHash = await hash(sessionToken);
  if (!session) {
    const { data, error } = await client.from("call_sessions").insert({
      host_id: host.id, call_id_id: callId.id, call_id_snapshot: `••••-${callId.code_last4}`,
      profile_name_snapshot: host.display_name, call_type: callType, visitor_name: caller.fullName.trim(),
      visitor_email: caller.email.trim().toLowerCase(), visitor_phone: caller.phone.trim(),
      session_token_hash: tokenHash, client_attempt_id: clientAttemptId,
    }).select("id,status,access_grant_id").single();
    if (error || !data) {
      // A concurrent retry can win the unique attempt id insert.
      if (error?.code === "23505") {
        const retry = await client.from("call_sessions").select("id,status,access_grant_id")
          .eq("client_attempt_id", clientAttemptId).maybeSingle();
        session = retry.data;
      }
      if (!session) return json({ error: "session_failed" }, 500);
    } else session = data;
  }
  if (session.status !== "connecting") return json({ error: "attempt_already_started" }, 409);
  const { error: rotateError } = await client.from("call_sessions").update({ session_token_hash: tokenHash }).eq("id", session.id);
  if (rotateError) return json({ error: "session_failed" }, 500);

  const { data: access, error: accessError } = await client.rpc("reserve_call_trial", {
    p_customer_email: caller.email.trim(), p_session_id: session.id,
  });
  if (accessError || !access) return json({ error: "access_check_failed" }, 500);
  if (access.allowed !== true) {
    await client.rpc("transition_call_session", { p_session_id: session.id, p_status: "failed", p_failure_code: access.code });
    await client.from("call_events").insert({ session_id: session.id, event_type: "subscription_required", metadata: { reason: access.code } });
    return json({ code: access.code }, 200);
  }
  await client.from("call_events").insert({ session_id: session.id, event_type: "session_created" });
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  return json({ sessionId: session.id, sessionToken, status: session.status,
    access: access.kind === "paid" ? { grantId: access.grantId, planId: access.planId, planName: access.planName, sessionDurationMinutes: access.sessionDurationMinutes } : null,
    host: { id: host.id, displayName: host.display_name, avatarUrl } });
});
