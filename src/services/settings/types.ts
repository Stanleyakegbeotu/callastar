/**
 * Application settings an operator can change from the dashboard, rather than
 * by editing source or an environment file.
 *
 * One row, one key. Settings that matter to the running product belong here;
 * build-time switches (which data engine, which auth mode) stay in
 * `lib/config.ts`, because changing those at runtime would mean changing what
 * the app fundamentally is.
 */
export interface AppSettings {
  key: "global";
  /**
   * Digits only, as `wa.me` needs them. Null when no number has been saved, and
   * the WhatsApp payment option is offered as unavailable rather than broken.
   */
  whatsappSupportNumber: string | null;
  /** What the admin typed, kept so the field shows it back to them readably. */
  whatsappSupportNumberDisplay: string | null;
  updatedAt: string;
}

export type AppSettingsPatch = Partial<Omit<AppSettings, "key" | "updatedAt">>;

export const DEFAULT_APP_SETTINGS: Omit<AppSettings, "updatedAt"> = {
  key: "global",
  whatsappSupportNumber: null,
  whatsappSupportNumberDisplay: null,
};
