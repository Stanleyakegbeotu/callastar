import { corsHeaders, json, requireAdmin, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const admin = await requireAdmin(request);
  if (!admin) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => ({}));
  const client = serviceClient();
  if (body.action === "list") {
    let query = client.from("call_evidence").select("id,call_session_id,caller_name,caller_email,host_id,host_name,package_id,package_name,plan_type,call_type,captured_at,session_started_at,answered_at,ended_at,duration_seconds,call_status,termination_reason,evidence_status,image_path,width,height,created_at,failure_reason")
      .order("created_at", { ascending: false }).limit(200);
    if (typeof body.hostId === "string" && body.hostId) query = query.eq("host_id", body.hostId);
    const { data, error } = await query;
    if (error) return json({ error: "list_failed" }, 500);
    const evidence = await Promise.all((data ?? []).map(async (row) => {
      let thumbnailUrl: string | null = null;
      if (row.evidence_status === "ready" && row.image_path) {
        const { data: signed } = await client.storage.from("call-evidence").createSignedUrl(row.image_path, 300);
        thumbnailUrl = signed?.signedUrl ?? null;
      }
      return ({
      id: row.id, callSessionId: row.call_session_id, callerName: row.caller_name, callerEmail: row.caller_email,
      hostId: row.host_id, hostName: row.host_name, callType: row.call_type, capturedAt: row.captured_at,
      packageId: row.package_id, packageName: row.package_name, planType: row.plan_type,
      sessionStartedAt: row.session_started_at, answeredAt: row.answered_at, endedAt: row.ended_at,
      durationSeconds: row.duration_seconds, callStatus: row.call_status, terminationReason: row.termination_reason,
      status: row.evidence_status === "failed" ? "capture_failed" : row.evidence_status,
      syncStatus: row.evidence_status === "ready" ? "synced" : row.evidence_status === "pending" ? "sync_pending" : "sync_failed",
      imagePath: row.image_path,
      cloudEvidenceId: row.id, cloudStoragePath: row.image_path, width: row.width, height: row.height,
      mimeType: "image/jpeg", createdAt: row.created_at, failureReason: row.failure_reason, thumbnailUrl,
    });
    }));
    return json({ evidence });
  }
  if (body.action !== "view" || typeof body.id !== "string") return json({ error: "invalid_request" }, 400);
  const { data: row } = await client.from("call_evidence").select("id,image_path,evidence_status").eq("id", body.id).maybeSingle();
  if (!row || row.evidence_status !== "ready" || !row.image_path) return json({ error: "evidence_unavailable" }, 404);
  const { data, error } = await client.storage.from("call-evidence").createSignedUrl(row.image_path, 300);
  if (error || !data) return json({ error: "image_unavailable" }, 500);
  return json({ url: data.signedUrl });
});
