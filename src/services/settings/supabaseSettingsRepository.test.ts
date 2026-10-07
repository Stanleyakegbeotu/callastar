import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  requireSupabase: () => ({ functions: { invoke } }),
}));

import { supabaseSettingsRepository } from "./supabaseSettingsRepository";

describe("Supabase settings repository", () => {
  beforeEach(() => invoke.mockReset());

  it("loads only the settings payload returned by the protected function", async () => {
    invoke.mockResolvedValue({ data: {
      whatsappSupportNumber: "14062813342",
      whatsappSupportNumberDisplay: "+1 (406) 281-3342",
      formspreeConfigured: true,
      updatedAt: "2026-10-07T00:00:00.000Z",
    }, error: null });

    await expect(supabaseSettingsRepository.getAppSettings()).resolves.toMatchObject({
      key: "global",
      whatsappSupportNumber: "14062813342",
      formspreeConfigured: true,
    });
    expect(invoke).toHaveBeenCalledWith("admin-settings", { body: { action: "get", patch: undefined } });
  });

  it("sends updates through the protected function and propagates failures", async () => {
    invoke.mockResolvedValueOnce({ data: {
      whatsappSupportNumber: "14062813342",
      whatsappSupportNumberDisplay: "+1 (406) 281-3342",
      formspreeConfigured: false,
      updatedAt: "2026-10-07T00:00:00.000Z",
    }, error: null });
    await supabaseSettingsRepository.updateAppSettings({ whatsappSupportNumber: "14062813342" });
    expect(invoke).toHaveBeenCalledWith("admin-settings", {
      body: { action: "update", patch: { whatsappSupportNumber: "14062813342" } },
    });

    invoke.mockResolvedValueOnce({ data: null, error: { message: "denied" } });
    await expect(supabaseSettingsRepository.getAppSettings()).rejects.toThrow("denied");
  });
});
