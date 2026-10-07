import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  requireSupabase: () => ({ functions: { invoke } }),
}));

import { supabaseNotificationRepository } from "./supabaseNotificationRepository";

describe("Supabase notification repository", () => {
  beforeEach(() => invoke.mockReset());

  it("maps a notification to a stable idempotency key for notify-admin", async () => {
    invoke.mockResolvedValue({ data: { accepted: true }, error: null });

    const notification = await supabaseNotificationRepository.create({
      type: "support_conversation_started",
      title: "New support conversation",
      body: "Jordan is waiting for help.",
      entityKind: "support_conversation",
      entityId: "conversation-123",
    });

    expect(invoke).toHaveBeenCalledWith("notify-admin", {
      body: {
        type: "support_started",
        idempotencyKey: "support_started:support_conversation:conversation-123",
        entityId: "conversation-123",
        summary: "Jordan is waiting for help.",
      },
    });
    expect(notification.id).toBe("support_started:support_conversation:conversation-123");
  });

  it("surfaces a rejected notification request", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "rate limited" } });

    await expect(supabaseNotificationRepository.create({
      type: "subscription_requested",
      title: "Subscription requested",
      body: "",
      entityKind: "subscription_request",
      entityId: "request-123",
    })).rejects.toThrow("rate limited");
  });
});
