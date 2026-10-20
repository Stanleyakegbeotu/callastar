import { corsHeaders, isAllowedCorsOrigin, json, requireAdmin, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!isAllowedCorsOrigin(request)) return json({ error: "origin_not_allowed" }, 403);
  if (!await requireAdmin(request)) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  if (typeof body.callAttemptId !== "string" || !/^att_[a-zA-Z0-9_-]{8,80}$/.test(body.callAttemptId) ||
      typeof body.profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.profileId)) return json({ error: "invalid_request" }, 400);

  const { data, error } = await serviceClient().from("call_sessions")
    .select("host_id,visitor_name,visitor_phone,visitor_email,call_id_snapshot,profile_name_snapshot,mode_at_start,status,call_type")
    .eq("signaling_attempt_id", body.callAttemptId).eq("host_id", body.profileId).in("status", ["connecting", "ringing"]).maybeSingle();
  if (error) return json({ error: "call_context_unavailable" }, 503);
  if (!data) return json({ error: "call_not_found" }, 404);
  return json({
    callerName: data.visitor_name,
    callerPhone: data.visitor_phone,
    callerEmail: data.visitor_email,
    callId: data.call_id_snapshot,
    profileName: data.profile_name_snapshot,
    profileId: data.host_id,
    mode: data.mode_at_start,
    callType: data.call_type,
  });
});
