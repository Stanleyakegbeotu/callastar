import { corsHeaders, hash, json, normalizeCode, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { code } = await request.json().catch(() => ({}));
  if (typeof code !== "string") return json({ found: false });
  const client = serviceClient();
  const { data } = await client.from("call_ids").select("id, host:hosts!inner(id, display_name, short_bio, avatar_path, status)").eq("code_hash", await hash(normalizeCode(code))).eq("status", "active").maybeSingle();
  const host = data?.host as { id: string; display_name: string; short_bio: string | null; avatar_path: string | null; status: string } | null;
  if (!data || !host || host.status !== "active") return json({ found: false });
  const now = new Date().toISOString();
  const { data: callId } = await client.from("call_ids").select("expires_at").eq("id", data.id).single();
  if (callId?.expires_at && callId.expires_at <= now) return json({ found: false });
  const avatarUrl = host.avatar_path ? (await client.storage.from("host-avatars").createSignedUrl(host.avatar_path, 3600)).data?.signedUrl ?? null : null;
  await client.from("call_ids").update({ last_used_at: now }).eq("id", data.id);
  return json({ found: true, host: { id: host.id, displayName: host.display_name, shortBio: host.short_bio, avatarUrl } });
});
