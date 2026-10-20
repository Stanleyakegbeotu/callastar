import { corsHeaders, hash, json, normalizeCode, randomToken, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { code, callType, caller, clientAttemptId } = await request.json().catch(() => ({}));
  if (typeof code !== "string" || code.length > 64 || !["video", "audio"].includes(callType) || !caller ||
      typeof caller.fullName !== "string" || caller.fullName.trim().length < 2 || caller.fullName.length > 120 ||
      typeof caller.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(caller.email.trim()) || caller.email.length > 254 ||
      typeof caller.phone !== "string" || caller.phone.trim().length < 7 || caller.phone.length > 32 ||
      typeof clientAttemptId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientAttemptId)) return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const sessionToken = randomToken();
  const { data: result, error } = await client.rpc("begin_ticket_session", {
    p_code_hash: await hash(normalizeCode(code)), p_call_type: callType, p_caller: caller,
    p_attempt_id: clientAttemptId, p_token_hash: await hash(sessionToken),
  });
  if (error || !result) return json({ error: "session_failed" }, 500);
  if (result.code) return json(result);
  const { data: session } = await client.from("call_sessions").select("host:hosts(id,display_name,avatar_path)").eq("id", result.sessionId).single();
  const host = Array.isArray(session?.host) ? session.host[0] : session?.host;
  if (!host) return json({ error: "session_failed" }, 500);
  let access = null;
  if (result.kind === "paid") {
    const { data: grant } = await client.from("call_access_grants").select("id,plan_id,plan:subscription_plans(display_name,session_duration_minutes)").eq("id", result.grantId).single();
    const plan = Array.isArray(grant?.plan) ? grant.plan[0] : grant?.plan;
    if (!grant || !plan) return json({ error: "access_check_failed" }, 500);
    access = { grantId: grant.id, planId: grant.plan_id, planName: plan.display_name, sessionDurationMinutes: plan.session_duration_minutes };
  }
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  return json({ sessionId: result.sessionId, sessionToken, status: "connecting", callDelivery: result.deliveryKind, mode: result.mode, accessKind: result.kind, access,
    host: { id: host.id, displayName: host.display_name, avatarUrl } });
});
