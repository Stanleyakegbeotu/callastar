import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";
import { STORAGE_BUCKETS, CALL_MEDIA_TTL_SECONDS } from "../_shared/storageContract.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { sessionId, sessionToken } = await request.json().catch(() => ({}));
  if (typeof sessionId !== "string" || typeof sessionToken !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: session, error: sessionError } = await client.from("call_sessions").select("host_id, status, call_type").eq("id", sessionId).eq("session_token_hash", await hash(sessionToken)).maybeSingle();
  if (sessionError) return json({ error: "session_query_failed" }, 503);
  if (!session || !["connecting", "ringing", "active", "reconnecting"].includes(session.status)) return json({ error: "not_found" }, 404);
  const kind = session.call_type === "audio" ? "remote_audio" : "remote_video";
  const queryStarted = performance.now();
  let { data: media, error: mediaError } = await client.from("host_media").select("storage_path, has_audio").eq("host_id", session.host_id).eq("kind", kind).eq("is_active", true).maybeSingle();
  if (!media && !mediaError && kind === "remote_audio") {
    const fallback = await client.from("host_media").select("storage_path, has_audio").eq("host_id", session.host_id).eq("kind", "remote_video").eq("is_active", true).maybeSingle();
    media = fallback.data; mediaError = fallback.error;
  }
  if (mediaError) return json({ error: "media_query_failed" }, 503);
  console.info("[callastar:media_pipeline]", { stage: "call_media_query", durationMs: Math.round(performance.now() - queryStarted), success: Boolean(media) });
  if (!media) return json({ available: false });
  const signStarted = performance.now();
  const { data: signed, error: signError } = await client.storage.from(STORAGE_BUCKETS.remote_video).createSignedUrl(media.storage_path, CALL_MEDIA_TTL_SECONDS);
  if (signError || !signed?.signedUrl) return json({ error: "signed_url_failed" }, 503);
  console.info("[callastar:media_pipeline]", { stage: "call_media_signed_url", durationMs: Math.round(performance.now() - signStarted), success: true });
  return json({ available: true, media: { type: session.call_type, url: signed.signedUrl, posterUrl: null, hasAudio: media.has_audio, expiresAt: new Date(Date.now() + CALL_MEDIA_TTL_SECONDS * 1000).toISOString() } });
});
