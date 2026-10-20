import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";
import { STORAGE_BUCKETS, CALL_MEDIA_TTL_SECONDS } from "../_shared/storageContract.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { sessionId, sessionToken } = await request.json().catch(() => ({}));
  if (typeof sessionId !== "string" || typeof sessionToken !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: session, error: sessionError } = await client.from("call_sessions").select("host_id, status, call_type, mode_at_start, ticket_reserved_until, ticket_consumed_at, delivery_kind, source_asset_id").eq("id", sessionId).eq("session_token_hash", await hash(sessionToken)).maybeSingle();
  if (sessionError) return json({ error: "session_query_failed" }, 503);
  if (!session || !["connecting", "ringing", "active", "reconnecting"].includes(session.status)) return json({ error: "not_found" }, 404);
  if (session.mode_at_start && !session.ticket_consumed_at &&
      (!session.ticket_reserved_until || Date.parse(session.ticket_reserved_until) <= Date.now())) {
    return json({ code: "CALL_ID_RESERVATION_CONFLICT" }, 409);
  }
  const kind = session.call_type === "audio" ? "remote_audio" : "remote_video";
  const queryStarted = performance.now();
  const mediaQuery = session.delivery_kind === "source_video"
    ? client.from("host_assets").select("storage_path, has_audio, interruptions").eq("id", session.source_asset_id).eq("host_id", session.host_id).eq("kind", "remote_video")
    : client.from("host_media").select("storage_path, has_audio").eq("host_id", session.host_id).eq("kind", kind).eq("is_active", true);
  let { data: media, error: mediaError } = await mediaQuery.maybeSingle();
  if (!media && !mediaError && kind === "remote_audio") {
    const fallback = await client.from("host_media").select("storage_path, has_audio").eq("host_id", session.host_id).eq("kind", "remote_video").eq("is_active", true).maybeSingle();
    media = fallback.data; mediaError = fallback.error;
  }
  if (mediaError) return json({ error: "media_query_failed" }, 503);
  // Live calls can use the profile's uploaded video after the host chooses it.
  // In that path the call session points at host_media, while the editable
  // interruption timeline is stored on the matching host_assets row.
  if (kind === "remote_video" && media && !Array.isArray(media.interruptions)) {
    const { data: asset, error: assetError } = await client.from("host_assets")
      .select("interruptions")
      .eq("host_id", session.host_id)
      .eq("kind", "remote_video")
      .eq("storage_path", media.storage_path)
      .maybeSingle();
    if (assetError) return json({ error: "media_query_failed" }, 503);
    media.interruptions = asset?.interruptions ?? [];
  }
  console.info("[callastar:media_pipeline]", { stage: "call_media_query", durationMs: Math.round(performance.now() - queryStarted), success: Boolean(media) });
  if (!media) return json({ available: false });
  const signStarted = performance.now();
  const { data: signed, error: signError } = await client.storage.from(STORAGE_BUCKETS.remote_video).createSignedUrl(media.storage_path, CALL_MEDIA_TTL_SECONDS);
  if (signError || !signed?.signedUrl) return json({ error: "signed_url_failed" }, 503);
  console.info("[callastar:media_pipeline]", { stage: "call_media_signed_url", durationMs: Math.round(performance.now() - signStarted), success: true });
  return json({ available: true, media: { type: session.call_type, url: signed.signedUrl, posterUrl: null, hasAudio: media.has_audio, interruptions: media.interruptions ?? [], expiresAt: new Date(Date.now() + CALL_MEDIA_TTL_SECONDS * 1000).toISOString() } });
});
