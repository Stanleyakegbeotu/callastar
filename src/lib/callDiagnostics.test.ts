import { describe, expect, it } from "vitest";

import { __testing } from "./callDiagnostics";

const { redact } = __testing;

/**
 * The allowlist is a security boundary, so it is tested like one.
 *
 * Real-time calling produces exactly the material that must never reach a log:
 * an SDP names local addresses, a TURN credential and a guest token are live
 * credentials, and a playback URL is authorised access to somebody's media. The
 * test below is what stops a future caller widening that by passing a bigger
 * object.
 */
describe("call diagnostics redaction", () => {
  it("keeps the connection fields worth debugging", () => {
    const kept = redact({
      phase: "connected",
      connectionState: "connected",
      iceConnectionState: "completed",
      candidatePairType: "relay",
      usingRelay: true,
      iceRestarts: 1,
      turnConfigured: false,
    });

    expect(kept).toEqual({
      phase: "connected",
      connectionState: "connected",
      iceConnectionState: "completed",
      candidatePairType: "relay",
      usingRelay: true,
      iceRestarts: 1,
      turnConfigured: false,
    });
  });

  it("drops every sensitive field, by value", () => {
    const secrets = {
      sdp: "v=0\r\no=- 1 1 IN IP4 192.168.1.44\r\n",
      description: { type: "offer", sdp: "v=0" },
      candidate: "candidate:1 1 udp 2130706431 192.168.1.44 54321 typ host",
      token: "att_1.CS7K4P.999.signature",
      credential: "turn-password",
      username: "turn-user",
      playbackUrl: "https://storage.example.com/signed/abc?sig=xyz",
      email: "caller@example.com",
      phone: "+15551234567",
      fullName: "John Williams",
      accessId: "CSA-1111-2222",
      callId: "CS-7K4P-Q9MX-2J8R",
    };

    const kept = redact(secrets);
    const serialised = JSON.stringify(kept);

    // Not one of the values survives, under any key.
    for (const value of Object.values(secrets)) {
      const needle = typeof value === "string" ? value : JSON.stringify(value);
      expect(serialised).not.toContain(needle);
    }

    // Every dropped key is named, so a developer can see something was withheld.
    for (const key of Object.keys(secrets)) {
      expect(kept.omitted).toContain(key);
    }
  });

  it("drops an object even under an allowlisted key", () => {
    // A safe key is not a licence to smuggle a payload through it.
    const kept = redact({ phase: { nested: "sdp-ish" }, reason: "host_offline" });
    expect(kept.phase).toBeUndefined();
    expect(kept.reason).toBe("host_offline");
    expect(kept.omitted).toContain("phase");
  });

  it("keeps null but not undefined-ish structures", () => {
    const kept = redact({ reason: null, count: 0, usingRelay: false });
    expect(kept).toEqual({ reason: null, count: 0, usingRelay: false });
  });

  it("adds no omitted key when nothing was dropped", () => {
    const kept = redact({ phase: "ringing" });
    expect(kept).toEqual({ phase: "ringing" });
    expect("omitted" in kept).toBe(false);
  });
});
