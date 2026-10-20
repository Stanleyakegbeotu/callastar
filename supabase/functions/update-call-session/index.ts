import { ticketCandidate } from "../_shared/callTickets.ts";
import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

const allowedTransitions: Record<string, string[]> = {
  connecting: ["ringing", "active", "ended", "cancelled", "failed", "declined", "no_answer"],
  ringing: ["active", "ended", "cancelled", "failed", "declined", "no_answer"],
  active: ["ended", "failed"],
};
const eventTypes = new Set([
  "SOURCE_VIDEO_ENDED", "CALL_ENDED", "session_created", "permissions_requested", "permissions_granted", "permissions_denied", "connecting", "ringing", "connected",
  "call_invited", "call_accepted", "source_selection_started", "source_selected", "rtc_connecting", "rtc_connected",
  "rtc_reconnecting", "rtc_recovered", "rtc_failed", "call_declined", "call_no_answer", "camera_disabled", "camera_enabled",
  "microphone_muted", "microphone_unmuted", "subscription_check_started", "subscription_access_granted", "subscription_required",
  "subscription_requested", "subscription_confirmed", "session_limit_reached", "remote_media_ended", "ended", "cancelled", "failed",
]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (typeof body.sessionId !== "string" || typeof body.sessionToken !== "string" || body.sessionToken.length < 40) return json({ error: "invalid_request" }, 400);

  const client = serviceClient();
  const { data: session } = await client.from("call_sessions").select("id,status")
    .eq("id", body.sessionId).eq("session_token_hash", await hash(body.sessionToken)).maybeSingle();
  if (!session) return json({ error: "not_found" }, 404);

  if (body.action === "renew_reservation") {
    const { data, error } = await client.rpc("renew_ticket_session", { p_session_id: session.id });
    return error || data !== true ? json({ error: "reservation_expired" }, 409) : json({ renewed: true });
  }

  if (body.action === "bind_signaling") {
    if (typeof body.code !== "string" || body.code.length > 64 || typeof body.callAttemptId !== "string") return json({ authorized: false },400);
    const { data, error } = await client.rpc("bind_ticket_signaling", {
      p_session_id: session.id, p_code_hash: await hash(body.code.toUpperCase().replace(/[^A-Z0-9]/g,"")), p_attempt_id: body.callAttemptId,
    });
    return error || !data ? json({ authorized: false },409) : json(data);
  }
  if (body.eventType !== undefined) {
    if (typeof body.eventType !== "string" || !eventTypes.has(body.eventType)) return json({ error: "invalid_event" }, 400);
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
    if (JSON.stringify(metadata).length > 2048) return json({ error: "invalid_event" }, 400);
    const { error } = await client.from("call_events").insert({ session_id: session.id, event_type: body.eventType, metadata });
    if (error) return json({ error: "event_unavailable" }, 500);
  }

  if (body.status === undefined) return json({ status: session.status });
  if (typeof body.status !== "string" || (session.status !== body.status && !allowedTransitions[session.status]?.includes(body.status))) return json({ error: "invalid_transition" }, 409);
  const endedAt = typeof body.endedAt === "string" && !Number.isNaN(Date.parse(body.endedAt)) ? body.endedAt : null;
  const durationSeconds = body.durationSeconds === null || (Number.isInteger(body.durationSeconds) && body.durationSeconds >= 0 && body.durationSeconds <= 86400)
    ? body.durationSeconds : null;
  const failureCode = typeof body.failureCode === "string" ? body.failureCode.slice(0, 80) : null;
  let candidate = null;
  if (body.status === "active" || (body.status === "ended" && failureCode === "SOURCE_VIDEO_ENDED")) {
    try { candidate = (await ticketCandidate()).record; }
    catch { return json({ error: "call_id_encryption_unavailable" }, 503); }
  }
  const { data: transitioned, error } = await client.rpc("transition_call_session", {
    p_session_id: session.id,
    p_status: body.status,
    p_ended_at: endedAt,
    p_duration_seconds: durationSeconds,
    p_failure_code: failureCode,
    p_candidate: candidate,
  });
  if (error) return json({ error: "session_update_failed" }, 500);
  if (transitioned !== true) return json({ error: "invalid_transition" }, 409);
  return json({ status: body.status });
});
