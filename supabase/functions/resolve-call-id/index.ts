import { corsHeaders, hash, json, normalizeCode, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { code } = await request.json().catch(() => ({}));
  if (typeof code !== "string") return json({ found: false });
  const client = serviceClient();
  const { data } = await client.from("call_ids").select("id, expires_at, host:hosts!inner(id, display_name, short_bio, avatar_path, cover_path, remote_video_asset_id, remote_audio_asset_id, base_follower_count, base_like_count, tracked_follower_count, tracked_like_count, status)").eq("code_hash", await hash(normalizeCode(code))).eq("status", "active").maybeSingle();
  const host = data?.host as { id: string; display_name: string; short_bio: string | null; avatar_path: string | null; cover_path: string | null; remote_video_asset_id: string | null; remote_audio_asset_id: string | null; base_follower_count: number; base_like_count: number; tracked_follower_count: number; tracked_like_count: number; status: string } | null;
  if (!data || !host || host.status !== "active") return json({ found: false });
  const now = new Date().toISOString();
  if (data.expires_at && data.expires_at <= now) return json({ found: false });
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  const coverUrl = host.cover_path ? (await client.storage.from("host-avatars").createSignedUrl(host.cover_path, 3600)).data?.signedUrl ?? null : null;
  await client.from("call_ids").update({ last_used_at: now }).eq("id", data.id);
  return json({ found: true, host: { id: host.id, displayName: host.display_name, shortBio: host.short_bio, avatarUrl, coverUrl, remoteVideoAssetId: host.remote_video_asset_id, remoteAudioAssetId: host.remote_audio_asset_id, followerCount: Number(host.base_follower_count ?? 0) + Number(host.tracked_follower_count ?? 0), likeCount: Number(host.base_like_count ?? 0) + Number(host.tracked_like_count ?? 0), status: host.status } });
});
