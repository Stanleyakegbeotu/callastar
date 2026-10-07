import { describe, expect, it } from "vitest";
import { boundedEvidenceSize, claimEvidenceSession, evidencePlanType, shouldCaptureCallEvidence } from "./capturePolicy";

const active = {
  sessionMatches: true, liveMode: true, callType: "video", callStatus: "active", rtcPhase: "connected",
  hasLocalVideo: true, hasHost: true, hasStartedAt: true,
};

describe("call evidence capture policy", () => {
  it("requires active app state, connected RTC, and local video without an extra consent gate", () => {
    expect(shouldCaptureCallEvidence(active)).toBe(true);
    for (const change of [
      { callStatus: "ringing" }, { callStatus: "reconnecting" }, { rtcPhase: "connecting" },
      { liveMode: false }, { callType: "audio" }, { hasLocalVideo: false },
    ]) expect(shouldCaptureCallEvidence({ ...active, ...change })).toBe(false);
  });

  it("bounds frames without changing their aspect ratio", () => {
    expect(boundedEvidenceSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(boundedEvidenceSize(720, 1280)).toEqual({ width: 405, height: 720 });
    expect(boundedEvidenceSize(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it("claims each session only once, including after a page remount", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const id = `policy-test-${crypto.randomUUID()}`;
    expect(claimEvidenceSession(id, storage)).toBe(true);
    expect(claimEvidenceSession(id, storage)).toBe(false);
    expect(claimEvidenceSession(`${id}-reload`, storage)).toBe(true);
    expect(claimEvidenceSession(`${id}-reload`, storage)).toBe(false);
  });

  it("routes free trial, Plus, and Pro through the same evidence plan metadata", () => {
    expect(evidencePlanType(null)).toBe("free_trial");
    expect(evidencePlanType({ planId: "plus-monthly", planName: "Plus" })).toBe("plus");
    expect(evidencePlanType({ planId: "pro-yearly", planName: "Pro" })).toBe("pro");
  });
});
