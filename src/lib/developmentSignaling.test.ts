import { expect, it } from "vitest";
import { developmentSignalingUrl } from "./developmentSignaling";

it("uses the current app's secure origin for phone/tunnel signaling", () => {
  expect(developmentSignalingUrl("ws://127.0.0.1:8787", "https://current-app.example", true)).toBe("wss://current-app.example/__callastar_signaling");
});
it("uses the current local origin for desktop development", () => {
  expect(developmentSignalingUrl("ws://127.0.0.1:8787", "http://localhost:8443", true)).toBe("ws://localhost:8443/__callastar_signaling");
});
it("keeps explicit remote signaling when the development proxy is off", () => {
  expect(developmentSignalingUrl("wss://signal.example", "https://app.example", false)).toBe("wss://signal.example");
});
it("does not enable live calling when no signaling URL was configured", () => {
  expect(developmentSignalingUrl("", "http://localhost:8443", true)).toBe("");
});
