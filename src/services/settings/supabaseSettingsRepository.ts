import type { SettingsRepository } from "./repository";

/**
 * Supabase is not connected in this phase. Failing loudly is deliberate: a
 * silent fallback to local settings would mean one operator changing the
 * support number and every other browser still sending customers elsewhere.
 *
 * When it lands: a single-row `app_settings` table, readable by anyone (the
 * public payment screen needs the number) and writable only by an admin.
 */
function notConnected(): never {
  throw new Error("Supabase settings repository is not connected.");
}

export const supabaseSettingsRepository: SettingsRepository = {
  mode: "supabase",
  getAppSettings: notConnected,
  updateAppSettings: notConnected,
};
