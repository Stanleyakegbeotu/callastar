import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { sessionId, sessionToken } = await request.json().catch(() => ({}));
  if (typeof sessionId !== "string" || typeof sessionToken !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: session } = await client.from("call_sessions").select("host_id, status").eq("id", sessionId).eq("session_token_hash", await hash(sessionToken)).maybeSingle();
  if (!session || ["ended", "cancelled", "failed"].includes(session.status)) return json({ error: "not_found" }, 404);
  const { data: media } = await client.from("host_media").select("storage_path, has_audio").eq("host_id", session.host_id).eq("kind", "remote_video").eq("is_active", true).maybeSingle();
  if (!media) return json({ available: false });
  const { data: signed } = await client.storage.from("host-call-media").createSignedUrl(media.storage_path, 3600);
  if (!signed?.signedUrl) return json({ available: false });
  return json({ available: true, media: { type: "video", url: signed.signedUrl, posterUrl: null, hasAudio: media.has_audio, expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
});
