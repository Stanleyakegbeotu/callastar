import { requireSupabase } from "@/lib/supabase/client";
import type { SettingsRepository } from "./repository";
import type { AppSettings, AppSettingsPatch } from "./types";

type SettingsResponse = { whatsappSupportNumber: string | null; whatsappSupportNumberDisplay: string | null; formspreeConfigured: boolean; updatedAt: string };
async function request(action: "get" | "update", patch?: AppSettingsPatch): Promise<SettingsResponse> {
  const { data, error } = await requireSupabase().functions.invoke("admin-settings", { body: { action, patch } });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Settings service unavailable.");
  return data as SettingsResponse;
}
function asSettings(value: SettingsResponse): AppSettings {
  return { key: "global", ...value };
}

export const supabaseSettingsRepository: SettingsRepository = {
  mode: "supabase",
  async getAppSettings() { return asSettings(await request("get")); },
  async updateAppSettings(patch) { return asSettings(await request("update", patch)); },
};
