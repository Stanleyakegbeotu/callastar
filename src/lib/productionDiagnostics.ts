const EVENTS = new Set([
  "ADMIN_ROUTE_LOAD_FAILED", "HOST_MEDIA_QUERY_FAILED", "SIGNED_URL_FAILED", "MEDIA_IMAGE_READY",
  "MEDIA_LOAD_FAILED", "PROFILE_CREATE_TIMING", "CALL_MEDIA_READY",
  "CALL_EVIDENCE_CAPTURED", "CALL_EVIDENCE_UPLOAD_FAILED", "CALL_EVIDENCE_STAGE", "CHUNK_LOAD_FAILED",
]);
const FIELDS = new Set(["stage", "durationMs", "success", "attempt", "readyState", "width", "height", "size", "kind"]);

/** No error objects, URLs or identities can enter production diagnostics. */
export function productionDiagnostic(event: string, fields: Record<string, unknown> = {}): void {
  if (!EVENTS.has(event)) return;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") safe[key] = value;
    if ((key === "stage" || key === "kind") && typeof value === "string" && /^[a-z_]{1,40}$/.test(value)) safe[key] = value;
  }
  console.info(`[callastar:${event}]`, safe);
}
