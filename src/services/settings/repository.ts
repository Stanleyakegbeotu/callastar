import { config, type AdminDataMode } from "@/lib/config";

import { localSettingsRepository } from "./localSettingsRepository";
import { supabaseSettingsRepository } from "./supabaseSettingsRepository";
import type { AppSettings, AppSettingsPatch } from "./types";

/**
 * The seam for operator-editable settings.
 *
 * Nothing outside this folder touches the settings store directly — least of
 * all a payment component, which asks for the current WhatsApp destination and
 * is indifferent to where it came from. Swapping in the Supabase implementation
 * is the whole migration.
 */
export interface SettingsRepository {
  readonly mode: AdminDataMode;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(patch: AppSettingsPatch): Promise<AppSettings>;
}

export function getSettingsRepository(): SettingsRepository {
  return config.adminDataMode === "local" ? localSettingsRepository : supabaseSettingsRepository;
}

export const settingsRepository = getSettingsRepository();
