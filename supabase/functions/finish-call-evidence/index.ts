import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

const MAX_BYTES = 2 * 1024 * 1024;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (typeof body.id !== "string" || typeof body.token !== "string" || !["upload", "complete", "failed", "finalize"].includes(body.action)) return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: row } = await client.from("call_evidence").select("id,host_id,call_session_id,evidence_status,image_path")
    .eq("id", body.id).eq("capture_token_hash", await hash(body.token)).maybeSingle();
  if (!row) return json({ error: "not_found" }, 404);
  if (body.action === "failed") {
    if (row.evidence_status === "ready") return json({ status: "ready" });
    const uploadFailed = body.failureKind === "upload";
    const { error } = await client.from("call_evidence").update({ evidence_status: uploadFailed ? "upload_failed" : "failed", failure_reason: String(body.reason ?? (uploadFailed ? "upload_failed" : "capture_failed")).slice(0, 120) }).eq("id", row.id);
    if (error) return json({ error: "evidence_unavailable" }, 500);
    return json({ status: "failed" });
  }
  if (body.action === "upload") {
    if (row.evidence_status !== "pending" || body.mimeType !== "image/jpeg" || !Number.isInteger(body.fileSize) || body.fileSize <= 0 || body.fileSize > MAX_BYTES || typeof body.capturedAt !== "string" || Number.isNaN(Date.parse(body.capturedAt))) return json({ error: "invalid_evidence_image" }, 400);
    const path = `${row.host_id}/${row.call_session_id}/evidence.jpg`;
    const { data: existingFiles } = await client.storage.from("call-evidence").list(`${row.host_id}/${row.call_session_id}`, { search: "evidence.jpg" });
    if (existingFiles?.some((file) => file.name === "evidence.jpg")) {
      const { error } = await client.from("call_evidence").update({ image_path: path, captured_at: body.capturedAt, evidence_status: "uploading" }).eq("id", row.id).eq("evidence_status", "pending");
      if (error) return json({ error: "evidence_unavailable" }, 500);
      return json({ path, uploadToken: "", alreadyUploaded: true });
    }
    const { data: ticket, error } = await client.storage.from("call-evidence").createSignedUploadUrl(path, { upsert: false });
    if (error || !ticket) return json({ error: "upload_unavailable" }, 500);
    const { error: updateError } = await client.from("call_evidence").update({ image_path: path, captured_at: body.capturedAt, evidence_status: "uploading" }).eq("id", row.id).eq("evidence_status", "pending");
    if (updateError) return json({ error: "evidence_unavailable" }, 500);
    return json({ path, uploadToken: ticket.token });
  }
  if (body.action === "complete") {
    if (row.evidence_status !== "uploading" || !row.image_path) return json({ error: "invalid_state" }, 409);
    const { data: files } = await client.storage.from("call-evidence").list(`${row.host_id}/${row.call_session_id}`, { search: "evidence.jpg" });
    if (!files?.some((file) => file.name === "evidence.jpg")) return json({ error: "upload_missing" }, 409);
    const { error } = await client.from("call_evidence").update({ evidence_status: "ready", failure_reason: null }).eq("id", row.id).eq("evidence_status", "uploading");
    if (error) return json({ error: "evidence_unavailable" }, 500);
    return json({ status: "ready" });
  }
  if (typeof body.endedAt !== "string" || Number.isNaN(Date.parse(body.endedAt)) ||
      !(body.durationSeconds === null || (Number.isInteger(body.durationSeconds) && body.durationSeconds >= 0 && body.durationSeconds <= 86400)) ||
      typeof body.callStatus !== "string" || body.callStatus.length > 40) return json({ error: "invalid_metadata" }, 400);
  const { error: finalizeError } = await client.from("call_evidence").update({
    ended_at: body.endedAt, duration_seconds: body.durationSeconds, call_status: body.callStatus,
    termination_reason: typeof body.terminationReason === "string" ? body.terminationReason.slice(0, 160) : null,
  }).eq("id", row.id);
  if (finalizeError) return json({ error: "evidence_unavailable" }, 500);
  return json({ status: "updated" });
});
