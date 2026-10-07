import { config } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase/client";

import { localSettingsRepository } from "./localSettingsRepository";

export interface PublicSupportSettings {
  whatsappSupportNumber: string | null;
  whatsappSupportNumberDisplay: string | null;
}

/** Public support contact only; admin-only settings stay behind admin auth. */
export async function getPublicSupportSettings(): Promise<PublicSupportSettings> {
  if (config.adminDataMode === "local") {
    const settings = await localSettingsRepository.getAppSettings();
    return {
      whatsappSupportNumber: settings.whatsappSupportNumber,
      whatsappSupportNumberDisplay: settings.whatsappSupportNumberDisplay,
    };
  }

  const { data, error } = await requireSupabase().functions.invoke("public-settings");
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Support settings unavailable.");
  return data as PublicSupportSettings;
}
