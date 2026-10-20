import { corsHeaders, hash, json, normalizeCode, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { code } = await request.json().catch(() => ({}));
  if (typeof code !== "string") return json({ found: false });
  const client = serviceClient();
  const { data } = await client.from("call_ids").select("id, status, issued_mode, max_uses, use_count, expires_at, host:hosts!inner(id, display_name, short_bio, avatar_path, cover_path, remote_video_asset_id, remote_audio_asset_id, base_follower_count, base_like_count, tracked_follower_count, tracked_like_count, status)").eq("code_hash", await hash(normalizeCode(code))).maybeSingle();
  const host = (Array.isArray(data?.host) ? data.host[0] : data?.host) as { id: string; display_name: string; short_bio: string | null; avatar_path: string | null; cover_path: string | null; remote_video_asset_id: string | null; remote_audio_asset_id: string | null; base_follower_count: number; base_like_count: number; tracked_follower_count: number; tracked_like_count: number; status: string } | null;
  if (!data || !host) return json({ found: false, code: "CALL_ID_NOT_FOUND" });
  if (data.status === "exhausted" || (data.expires_at && data.expires_at <= new Date().toISOString())) return json({ found: false, code: "CALL_ID_EXHAUSTED", mode: data.issued_mode });
  if (data.status !== "active") return json({ found: false, code: "CALL_ID_RETIRED", mode: data.issued_mode });
  if (host.status !== "active") return json({ found: false, code: "PROFILE_UNAVAILABLE" });
  const now = new Date().toISOString();
  if (data.expires_at && data.expires_at <= now) return json({ found: false });
  const mediaStarted = performance.now();
  const [avatar, cover] = await Promise.all([
    host.avatar_path ? client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600) : Promise.resolve({ data: null, error: null }),
    host.cover_path ? client.storage.from("host-avatars").createSignedUrl(host.cover_path, 3600) : Promise.resolve({ data: null, error: null }),
  ]);
  const avatarUrl = avatar.data?.signedUrl ?? null;
  const coverUrl = cover.data?.signedUrl ?? null;
  console.info("[callastar:media_pipeline]", { stage: "signed_url_resolution", durationMs: Math.round(performance.now() - mediaStarted), success: !(avatar.error || cover.error) });
  console.info("CALL_ID_RESOLVED", { mode: data.issued_mode });
  return json({ found: true, state: data.issued_mode === 'free' ? 'VALID_FREE_CALL' : 'VALID_PREMIUM_CALL', host: { callDelivery: host.remote_video_asset_id ? 'source_video' : 'live', mode: data.issued_mode, id: host.id, displayName: host.display_name, shortBio: host.short_bio, avatarUrl, coverUrl, remoteVideoAssetId: host.remote_video_asset_id, remoteAudioAssetId: host.remote_audio_asset_id, followerCount: Number(host.base_follower_count ?? 0) + Number(host.tracked_follower_count ?? 0), likeCount: Number(host.base_like_count ?? 0) + Number(host.tracked_like_count ?? 0), status: host.status } });
});
