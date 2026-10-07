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
function callIdEncryptionKey() {
  const encoded = Deno.env.get("CALL_ID_ENCRYPTION_KEY");
  if (!encoded) throw new Error("CALL_ID_ENCRYPTION_KEY is not configured.");
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("CALL_ID_ENCRYPTION_KEY must be a base64 encoded 32-byte key.");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function encryptCallId(value: string) {
  const key = await callIdEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
export async function decryptCallId(value: string) {
  const key = await callIdEncryptionKey();
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (bytes.length < 29) throw new Error("Invalid encrypted Call ID.");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(clear);
}
export function randomCode() { const bytes = crypto.getRandomValues(new Uint8Array(12)); return displayCode(`CS${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`); }
export function randomToken() { return crypto.randomUUID() + crypto.randomUUID().replaceAll("-", ""); }
export function serviceClient() { return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); }
export async function requireAdmin(request: Request) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const client = serviceClient();
  const { data: { user } } = await client.auth.getUser(token);
  if (!user) return null;
  const { data } = await client.from("admin_profiles").select("user_id")
    .eq("user_id", user.id).eq("role", "admin").eq("is_active", true).maybeSingle();
  return data ? user : null;
}
