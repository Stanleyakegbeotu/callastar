import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/lib/config", () => ({ config: { callBackend: "supabase", adminDataMode: "supabase" } }));
vi.mock("@/services/admin/repository", () => ({ adminRepository: {} }));
vi.mock("@/services/notifications/adminEvents", () => ({ sendAdminEvent: state.notify }));
vi.mock("@/lib/supabase/client", () => ({ requireSupabase: () => ({ functions: {
  invoke: async (name: string) => ({
    error: null,
    data: name === "start-call-session"
      ? { sessionId: "cloud-session", sessionToken: "proof", host: { displayName: "Host" } }
      : { status: "active" },
  }),
} }) }));
import { callBackend } from "../src/services/callBackend";
beforeEach(() => state.notify.mockClear());

it("does not notify admin merely for a reservation that can still fail during signaling", async () => {
  await callBackend.prepareCallSession!("CS-AAAA-BBBB-CCCC", "video", { fullName: "Caller", email: "caller@example.test", phone: "+2348000000000" }, "attempt");
  expect(state.notify).not.toHaveBeenCalled();
  await callBackend.sessions!.transition("attempt", { status: "failed" });
  expect(state.notify).not.toHaveBeenCalled();
});
it("notifies admin when source playback reaches a successful active session", async () => {
  await callBackend.prepareCallSession!("CS-AAAA-BBBB-CCCC", "video", { fullName: "Caller", email: "caller@example.test", phone: "+2348000000000" }, "connected-attempt");
  await callBackend.sessions!.transition("connected-attempt", { status: "active" });
  expect(state.notify).toHaveBeenCalledWith("new_call", "cloud-session", expect.any(String));
});
