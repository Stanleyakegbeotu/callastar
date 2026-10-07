import { corsHeaders, json, serviceClient } from "../_shared/utils.ts";

function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expectedSecret = Deno.env.get("ADMIN_BOOTSTRAP_SECRET");
  if (!expectedSecret) return json({ error: "bootstrap_unavailable" }, 503);

  let input: { email?: unknown; password?: unknown; displayName?: unknown; bootstrapSecret?: unknown };
  try {
    input = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (typeof input.bootstrapSecret !== "string" || !sameSecret(input.bootstrapSecret, expectedSecret)) {
    return json({ error: "bootstrap_not_authorized" }, 401);
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "invalid_email" }, 400);
  if (password.length < 12 || password.length > 128) return json({ error: "password_too_short" }, 400);
  if (displayName.length < 2 || displayName.length > 80) return json({ error: "invalid_display_name" }, 400);

  const client = serviceClient();
  const { data: existing, error: lookupError } = await client
    .from("admin_profiles")
    .select("user_id")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (lookupError) return json({ error: "bootstrap_unavailable" }, 503);
  if (existing) return json({ error: "bootstrap_already_used" }, 409);

  const { data: created, error: createError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (createError || !created.user) return json({ error: "admin_creation_failed" }, 400);

  const { error: profileError } = await client.from("admin_profiles").insert({
    user_id: created.user.id,
    display_name: displayName,
    role: "admin",
    is_active: true,
  });
  if (profileError) {
    await client.auth.admin.deleteUser(created.user.id);
    return json({ error: profileError.code === "23505" ? "bootstrap_already_used" : "admin_creation_failed" }, profileError.code === "23505" ? 409 : 500);
  }

  return json({ created: true });
});

