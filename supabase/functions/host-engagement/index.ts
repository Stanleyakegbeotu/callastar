import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

const validEmail = (value: unknown): value is string => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (typeof body.hostId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.hostId) || !validEmail(body.email) || !["get", "set"].includes(body.action)) return json({ error: "invalid_request" }, 400);
  const email = body.email.trim().toLowerCase();
  const client = serviceClient();
  const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("cf-connecting-ip") ?? "unknown";
  const { data: allowed, error: limitError } = await client.rpc("callastar_take_notification_rate_limit", { p_rate_key: await hash(`engagement:${source}`) });
  if (limitError || allowed !== true) return json({ error: "rate_limited" }, 429);
  if (body.action === "set") {
    if (!body.change || typeof body.change !== "object" || (body.change.following !== undefined && typeof body.change.following !== "boolean") || (body.change.liked !== undefined && typeof body.change.liked !== "boolean")) return json({ error: "invalid_request" }, 400);
    const { data: old } = await client.from("profile_engagement").select("following,liked").eq("host_id", body.hostId).eq("customer_email_normalized", email).maybeSingle();
    const { error } = await client.from("profile_engagement").upsert({ host_id: body.hostId, customer_email_normalized: email, following: body.change.following ?? old?.following ?? false, liked: body.change.liked ?? old?.liked ?? false, updated_at: new Date().toISOString() });
    if (error) return json({ error: "engagement_unavailable" }, 500);
  }
  const [{ data: host, error: hostError }, { data: engagement, error: engagementError }] = await Promise.all([
    client.from("hosts").select("base_follower_count,base_like_count,tracked_follower_count,tracked_like_count").eq("id", body.hostId).single(),
    client.from("profile_engagement").select("following,liked").eq("host_id", body.hostId).eq("customer_email_normalized", email).maybeSingle(),
  ]);
  if (hostError || engagementError || !host) return json({ error: "engagement_unavailable" }, 404);
  return json({ followerCount: Number(host.base_follower_count ?? 0) + Number(host.tracked_follower_count ?? 0), likeCount: Number(host.base_like_count ?? 0) + Number(host.tracked_like_count ?? 0), following: engagement?.following ?? false, liked: engagement?.liked ?? false });
});
