import { STORE_SETTINGS, runTransaction } from "@/services/admin/indexeddb";

import type { SettingsRepository } from "./repository";
import { DEFAULT_APP_SETTINGS, type AppSettings, type AppSettingsPatch } from "./types";

/**
 * Settings against the local development engine.
 *
 * A missing row is not an error: it means nobody has saved anything yet, so the
 * defaults are returned without being written. The row appears the first time
 * an operator actually changes something.
 */

function nowIso(): string {
  return new Date().toISOString();
}

export const localSettingsRepository: SettingsRepository = {
  mode: "local",

  async getAppSettings() {
    const stored = await runTransaction([STORE_SETTINGS], "readonly", (scope) =>
      scope.get<AppSettings>(STORE_SETTINGS, "global"),
    );

    // Spread over the defaults so a row written by an older build is missing
    // keys rather than breaking a caller that expects them.
    return { ...DEFAULT_APP_SETTINGS, updatedAt: nowIso(), ...stored, key: "global" };
  },

  async updateAppSettings(patch: AppSettingsPatch) {
    return runTransaction([STORE_SETTINGS], "readwrite", async (scope) => {
      const existing = await scope.get<AppSettings>(STORE_SETTINGS, "global");
      const next: AppSettings = {
        ...DEFAULT_APP_SETTINGS,
        ...existing,
        ...patch,
        key: "global",
        updatedAt: nowIso(),
      };
      await scope.put(STORE_SETTINGS, next);
      return next;
    });
  },
};
