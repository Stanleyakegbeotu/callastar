import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Call ID authorisation client.
 *
 * What matters here is that every outcome is distinguishable, because each one
 * is a different screen: a host who is away, a host already on a call, and a
 * service we could not reach are three different things to tell somebody. A
 * client that collapsed them would make the UI lie.
 *
 * `SIGNALING.url` is read at module load, so the config is mocked before the
 * module under test is imported.
 */
vi.mock("@/lib/config", () => ({
  SIGNALING: { url: "wss://signal.example.com", transport: "websocket" },
  isLiveCallingConfigured: true,
}));

const { authorizeCall, signalingHttpOrigin } = await import("./callAuthorization");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signalling HTTP origin", () => {
  it("derives https from a secure socket URL", () => {
    // One configured address for both surfaces, so a deployment cannot end up
    // with the socket on one host and the authorize endpoint on another.
    expect(signalingHttpOrigin("wss://signal.example.com")).toBe("https://signal.example.com");
    expect(signalingHttpOrigin("ws://localhost:8787")).toBe("http://localhost:8787");
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(signalingHttpOrigin("wss://example.com/rtc/")).toBe("https://example.com/rtc");
  });

  it("returns nothing for an unconfigured or malformed URL", () => {
    expect(signalingHttpOrigin("")).toBe("");
    expect(signalingHttpOrigin("not a url")).toBe("");
  });
});

describe("authorizeCall", () => {
  it("returns the token for an available host", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        state: "available",
        callAttemptId: "att_1",
        token: "att_1.CS7K4P.999.sig",
        expiresAt: 1_800_000_000_000,
      }),
    );

    const result = await authorizeCall("cs-7k4p-q9mx-2j8r");
    expect(result).toEqual({
      state: "available",
      callAttemptId: "att_1",
      token: "att_1.CS7K4P.999.sig",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("normalises the Call ID before sending it", async () => {
    // A code typed with or without its dashes has to reach the same profile.
    fetchMock.mockResolvedValue(jsonResponse(200, { state: "unavailable" }));
    await authorizeCall("cs-7k4p-q9mx-2j8r");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ callId: "CS7K4PQ9MX2J8R" });
  });

  it("posts to the derived origin", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { state: "unavailable" }));
    await authorizeCall("CS-7K4P-Q9MX-2J8R");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://signal.example.com/calls/authorize");
  });

  it("distinguishes busy from unavailable", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { state: "busy" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "busy" });

    fetchMock.mockResolvedValue(jsonResponse(200, { state: "unavailable" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unavailable" });
  });

  it("reports rate limiting as its own state", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: "rate_limited" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "rate_limited" });
  });

  it("reports an unreachable service rather than an absent host", async () => {
    // These are different sentences to a caller, so they must be different
    // states here: one says try later, the other says check your connection.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unreachable" });

    fetchMock.mockResolvedValue(jsonResponse(500, { error: "internal" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unreachable" });
  });

  it("refuses to proceed on a malformed answer", async () => {
    // Half an answer is not an answer. Proceeding on one would ring nobody.
    fetchMock.mockResolvedValue(jsonResponse(200, { state: "available" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unreachable" });

    fetchMock.mockResolvedValue(jsonResponse(200, { state: "available", callAttemptId: "att_1" }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unreachable" });

    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(authorizeCall("CS-1")).resolves.toEqual({ state: "unreachable" });
  });

  it("never throws, whatever the service does", async () => {
    // The caller is a UI that has to say something either way.
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(authorizeCall("CS-1")).resolves.toBeTruthy();
  });
});
