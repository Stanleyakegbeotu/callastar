import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** The browser client uses only the public anon key; service credentials stay in Edge Functions. */
export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("CallaStar is not configured with Supabase.");
  return supabase;
}
