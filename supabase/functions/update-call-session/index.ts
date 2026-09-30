import { corsHeaders, hash, json, serviceClient } from "../_shared/utils.ts";

const allowed: Record<string, string[]> = { connecting: ["ringing", "cancelled", "failed"], ringing: ["active", "cancelled", "failed"], active: ["ended", "failed"] };
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const { sessionId, sessionToken, status } = await request.json().catch(() => ({}));
  if (typeof sessionId !== "string" || typeof sessionToken !== "string" || typeof status !== "string") return json({ error: "invalid_request" }, 400);
  const client = serviceClient();
  const { data: session } = await client.from("call_sessions").select("id, status").eq("id", sessionId).eq("session_token_hash", await hash(sessionToken)).maybeSingle();
  if (!session) return json({ error: "not_found" }, 404);
  if (!allowed[session.status]?.includes(status)) return json({ error: "invalid_transition" }, 409);
  const now = new Date().toISOString();
  const update = { status, connected_at: status === "active" ? now : undefined, ended_at: ["ended", "cancelled", "failed"].includes(status) ? now : undefined };
  await client.from("call_sessions").update(update).eq("id", sessionId);
  await client.from("call_events").insert({ session_id: sessionId, event_type: status });
  return json({ status });
});
