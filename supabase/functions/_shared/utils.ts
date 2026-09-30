import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": Deno.env.get("CALLASTAR_PUBLIC_ORIGIN") ?? "http://localhost:8443",
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
export const displayCode = (code: string) => code.replace(/^(CS)(.{4})(.{4})(.{4})$/, "$1-$2-$3-$4");
export async function hash(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join(""); }
export function randomCode() { const bytes = crypto.getRandomValues(new Uint8Array(12)); return displayCode(`CS${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`); }
export function randomToken() { return crypto.randomUUID() + crypto.randomUUID().replaceAll("-", ""); }
export function serviceClient() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
export async function requireAdmin(request: Request) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const client = serviceClient();
  const { data: { user } } = await client.auth.getUser(token);
  if (!user) return null;
  const { data } = await client.from("admin_profiles").select("user_id").eq("user_id", user.id).maybeSingle();
  return data ? user : null;
}
