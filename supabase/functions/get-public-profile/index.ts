import { corsHeaders, json, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { profileId } = await request.json().catch(() => ({}));
  if (typeof profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(profileId)) return json({ profile: null }, 400);
  const client = serviceClient();
  const { data: host, error } = await client.from("hosts").select("id,display_name,short_bio,status,avatar_path,cover_path,remote_video_asset_id,remote_audio_asset_id,base_follower_count,base_like_count,tracked_follower_count,tracked_like_count").eq("id", profileId).maybeSingle();
  if (error || !host) return json({ profile: null });
  const mediaStarted = performance.now();
  const [avatar, cover] = await Promise.all([
    host.avatar_path ? client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 1800) : Promise.resolve({ data: null, error: null }),
    host.cover_path ? client.storage.from("host-avatars").createSignedUrl(host.cover_path, 1800) : Promise.resolve({ data: null, error: null }),
  ]);
  const avatarUrl = avatar.data?.signedUrl ?? null;
  const coverUrl = cover.data?.signedUrl ?? null;
  const toDataUrl = async (url: string | null | undefined, fallback: string) => {
    if (!url) return fallback;
    try { const response = await fetch(url); if (!response.ok) return fallback; const bytes = new Uint8Array(await response.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return `data:${response.headers.get("content-type") ?? "image/jpeg"};base64,${btoa(binary)}`; }
    catch { return fallback; }
  };
  const initials = `https://ui-avatars.com/api/?name=${encodeURIComponent(host.display_name)}&background=101f37&color=fff&size=256`;
  const [avatarDataUrl, coverDataUrl] = await Promise.all([
    toDataUrl(avatarUrl, initials), toDataUrl(coverUrl, ""),
  ]);
  console.info("[callastar:media_pipeline]", { stage: "profile_media_response", durationMs: Math.round(performance.now() - mediaStarted), success: !(avatar.error || cover.error) });
  const profile = {
    id: host.id, displayName: host.display_name, shortBio: host.short_bio ?? "", status: host.status,
    avatarDataUrl, coverDataUrl: coverUrl ? coverDataUrl : null,
    remoteVideoAssetId: host.remote_video_asset_id, remoteAudioAssetId: host.remote_audio_asset_id,
    followerCount: Number(host.base_follower_count ?? 0) + Number(host.tracked_follower_count ?? 0),
    likeCount: Number(host.base_like_count ?? 0) + Number(host.tracked_like_count ?? 0),
  };
  return json({ profile });
});
