import { beforeEach, describe, expect, it, vi } from "vitest";
const { sign, query, authCallback } = vi.hoisted(() => ({
  sign: vi.fn(), query: vi.fn(), authCallback: { value: null as null | ((event: string) => void) },
}));
vi.mock("@/lib/supabase/client", () => ({ requireSupabase: () => ({
  auth: { onAuthStateChange: (callback: (event: string) => void) => { authCallback.value = callback; } },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: query }) }) }),
  storage: { from: () => ({ createSignedUrl: sign }) },
}) }));
import { clearPrivateMediaCache, resolveAdminMedia } from "./privateMedia";
beforeEach(() => {
  clearPrivateMediaCache(); vi.clearAllMocks(); vi.useRealTimers();
  query.mockResolvedValue({ data: { kind: "remote_video", storage_path: "host/video/file.mp4", has_audio: true }, error: null });
  sign.mockResolvedValue({ data: { signedUrl: "https://storage.test/signed" }, error: null });
});
describe("private media URLs", () => {
  it("deduplicates concurrent reads and signs with sufficient call lifetime", async () => {
    const [a, b] = await Promise.all([resolveAdminMedia("asset"), resolveAdminMedia("asset")]);
    expect(a?.url).toBe(b?.url); expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith("host/video/file.mp4", 7200);
  });
  it("refreshes expired URLs and clears cached media on sign-out", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    await resolveAdminMedia("asset");
    vi.setSystemTime(1_000_000 + 7200_000);
    await resolveAdminMedia("asset"); expect(sign).toHaveBeenCalledTimes(2);
    authCallback.value?.("SIGNED_OUT");
    await resolveAdminMedia("asset"); expect(sign).toHaveBeenCalledTimes(3);
  });
  it("does not cache sign failures or missing files and supports explicit retry", async () => {
    sign.mockResolvedValueOnce({ error: { message: "secret must not leak" }, data: null });
    await expect(resolveAdminMedia("asset")).rejects.toThrow("Unable to authorize media");
    await resolveAdminMedia("asset"); expect(sign).toHaveBeenCalledTimes(2);
    await resolveAdminMedia("asset", true); expect(sign).toHaveBeenCalledTimes(3);
    query.mockResolvedValueOnce({ data: null, error: null });
    expect(await resolveAdminMedia("missing")).toBeNull();
  });
});
