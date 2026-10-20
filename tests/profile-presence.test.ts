import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const current = vi.hoisted(() => ({
  profile: null as { id: string } | null,
  state: { presence: "offline" },
}));
vi.mock("../src/features/host-calls/HostCallProvider", () => ({ useHostCall: () => current }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PresenceBadge } from "../src/features/host-calls/components/PresenceBadge";
const render = () => renderToStaticMarkup(createElement(PresenceBadge, { profileId: "one" }));
beforeEach(() => { current.profile = null; current.state.presence = "offline"; });
it("does not label an unobserved profile offline", () => {
  expect(render()).toBe("");
  current.profile = { id: "other" };
  expect(render()).toBe("");
});
it("labels an observed disconnected live session explicitly", () => {
  current.profile = { id: "one" };
  expect(render()).toContain("hostCall.statusDisconnected");
});
it.each(["available", "busy", "ringing"])("preserves confirmed live presence: %s", presence => {
  current.profile = { id: "one" }; current.state.presence = presence;
  expect(render()).toContain(presence === "available" ? "hostCall.statusAvailable" : "hostCall.statusBusy");
});
