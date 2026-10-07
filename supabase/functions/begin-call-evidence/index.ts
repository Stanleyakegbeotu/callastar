import { corsHeaders, hash, json, normalizeCode, randomToken, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (typeof body.callSessionId !== "string" || !(/^(?:cs_[a-z0-9-]{8,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(body.callSessionId)) ||
      typeof body.sessionToken !== "string" || body.sessionToken.length < 40 ||
      typeof body.callId !== "string" || typeof body.hostId !== "string" ||
      (body.consentAt !== null && body.consentAt !== undefined && (typeof body.consentAt !== "string" || Number.isNaN(Date.parse(body.consentAt)))) ||
      typeof body.sessionStartedAt !== "string" || Number.isNaN(Date.parse(body.sessionStartedAt)) ||
      typeof body.answeredAt !== "string" || Number.isNaN(Date.parse(body.answeredAt)) ||
      (body.consentAt && Date.parse(body.consentAt) > Date.parse(body.answeredAt))) return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: session } = await client.from("call_sessions")
    .select("id,host_id,call_id_id,call_type,visitor_name,visitor_email,session_token_hash,status,created_at,connected_at")
    .eq("id", body.callSessionId).eq("session_token_hash", await hash(body.sessionToken)).maybeSingle();
  if (!session || session.call_type !== "video" || !["connecting", "ringing", "active"].includes(session.status) || session.host_id !== body.hostId) {
    return json({ error: "call_session_unavailable" }, 404);
  }
  const { data: callIdRow } = await client.from("call_ids").select("id,host_id,host:hosts!inner(display_name,status)")
    .eq("code_hash", await hash(normalizeCode(body.callId))).eq("status", "active").maybeSingle();
  const host = callIdRow?.host as { display_name: string; status: string } | undefined;
  if (!callIdRow || callIdRow.id !== session.call_id_id || callIdRow.host_id !== session.host_id || host?.status !== "active") return json({ error: "call_not_found" }, 404);
  const { data: existing } = await client.from("call_evidence").select("id,evidence_status,image_path").eq("call_session_id", body.callSessionId).maybeSingle();
  const metadata = {
    caller_name: session.visitor_name, caller_email: session.visitor_email,
    host_id: session.host_id, host_name: host.display_name, call_type: "video", consent_at: null,
    session_started_at: session.created_at, answered_at: session.connected_at ?? body.answeredAt,
    package_id: typeof body.packageId === "string" ? body.packageId : null,
    package_name: typeof body.packageName === "string" ? body.packageName : null,
    plan_type: ["free_trial", "plus", "pro", "subscription"].includes(body.planType) ? body.planType : "subscription",
    width: Number.isInteger(body.width) && body.width > 0 ? body.width : null,
    height: Number.isInteger(body.height) && body.height > 0 ? body.height : null,
    ended_at: typeof body.endedAt === "string" ? body.endedAt : null,
    duration_seconds: Number.isInteger(body.durationSeconds) && body.durationSeconds >= 0 ? body.durationSeconds : null,
    call_status: typeof body.callStatus === "string" ? body.callStatus.slice(0, 40) : "active",
    termination_reason: typeof body.terminationReason === "string" ? body.terminationReason.slice(0, 160) : null,
  };
  if (existing?.evidence_status === "ready") {
    await client.from("call_evidence").update(metadata).eq("id", existing.id);
    return json({ id: existing.id, token: "", status: "ready", imagePath: existing.image_path });
  }
  const token = randomToken();
  if (existing) {
    const { error } = await client.from("call_evidence").update({
      ...metadata, capture_token_hash: await hash(token), evidence_status: "pending", failure_reason: null,
    }).eq("id", existing.id);
    if (error) return json({ error: "evidence_unavailable" }, 500);
    return json({ id: existing.id, token });
  }
  const { data: inserted, error: insertError } = await client.from("call_evidence").insert({
    ...metadata, call_session_id: body.callSessionId, capture_token_hash: await hash(token),
  }).select("id").maybeSingle();
  if (insertError?.code === "23505") {
    const { data: duplicate } = await client.from("call_evidence").select("id,evidence_status,image_path").eq("call_session_id", body.callSessionId).maybeSingle();
    if (!duplicate) return json({ error: "evidence_unavailable" }, 500);
    if (duplicate.evidence_status === "ready") return json({ id: duplicate.id, token: "", status: "ready", imagePath: duplicate.image_path });
    const retryToken = randomToken();
    await client.from("call_evidence").update({ ...metadata, capture_token_hash: await hash(retryToken), evidence_status: "pending", failure_reason: null }).eq("id", duplicate.id);
    return json({ id: duplicate.id, token: retryToken });
  }
  if (insertError || !inserted) return json({ error: "evidence_unavailable" }, 500);
  return json({ id: inserted.id, token });
});
