import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  SIGNALING_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@/services/signaling/protocol";

/**
 * The signalling service, driven against a real running process over real
 * sockets.
 *
 * Deliberately not mocked. What this suite is for is the behaviour that only
 * exists when two clients, a token and a clock are all involved at once: that a
 * guest token authorises exactly one attempt, that an unknown Call ID is
 * indistinguishable from an offline one, that a ring really does time out, and
 * that `subscription_required` survives the relay as itself.
 *
 * Runs straight from TypeScript under Node's type stripping, the same way the
 * service runs in development and production.
 */

const SERVICE_DIR = path.resolve(import.meta.dirname, "../server/signaling");
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

/** Test-only secrets. Long enough to satisfy the service's own refusal to start. */
const TOKEN_SECRET = "test-token-secret-".padEnd(64, "0");
const HOST_SECRET = "test-host-secret-".padEnd(64, "0");

const CALL_ID = "CS-7K4P-Q9MX-2J8R";
/** The same code with its separators stripped, as `normalizeCallId` produces. */
const CALL_KEY = "CS7K4PQ9MX2J8R";

/** Short, so the ring-timeout test does not sit for the production 35 seconds. */
const RING_TIMEOUT_MS = 2_000;

let service: ChildProcess;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a service instance and waits for it to answer.
 *
 * Polls `/health` rather than sleeping a guessed interval, so the suite is not
 * racing process startup on a slow machine.
 */
async function startService(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVICE_DIR,
    env: {
      ...process.env,
      SIGNALING_PORT: String(port),
      SIGNALING_HOST: "127.0.0.1",
      SIGNALING_TOKEN_SECRET: TOKEN_SECRET,
      SIGNALING_HOST_SECRET: HOST_SECRET,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`signalling service did not start on ${port}`);
    await sleep(150);
  }
}

async function stopService(child: ChildProcess | undefined): Promise<void> {
  child?.kill("SIGTERM");
  await sleep(300);
  child?.kill("SIGKILL");
}

interface AuthorizeResponse {
  state: "available" | "busy" | "unavailable";
  callAttemptId?: string;
  token?: string;
  expiresAt?: number;
}

async function authorize(callId = CALL_ID): Promise<{ status: number; body: AuthorizeResponse }> {
  const response = await fetch(`${BASE}/calls/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId }),
  });
  const body = (await response.json().catch(() => ({}))) as AuthorizeResponse;
  return { status: response.status, body };
}

/**
 * A socket that remembers everything it received.
 *
 * Messages are recorded rather than awaited one at a time, because ordering
 * between two clients is not something a test should assume: `expect` looks at
 * what has already arrived before it waits.
 */
interface TestClient {
  send: (message: ClientMessage) => void;
  expect: <T extends ServerMessage["type"]>(
    type: T,
    timeoutMs?: number,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  received: ServerMessage[];
  close: () => void;
}

async function connect(label: string): Promise<TestClient> {
  const socket = new WebSocket(WS_URL);
  const received: ServerMessage[] = [];
  const waiters: { type: string; resolve: (message: ServerMessage) => void }[] = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    received.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter && waiter.type === message.type) {
        waiter.resolve(message);
        waiters.splice(index, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    expect<T extends ServerMessage["type"]>(type: T, timeoutMs = 5_000) {
      const already = received.find((message) => message.type === type);
      if (already) return Promise.resolve(already as Extract<ServerMessage, { type: T }>);

      return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label}: timed out waiting for ${type}`)),
          timeoutMs,
        );
        waiters.push({
          type,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message as Extract<ServerMessage, { type: T }>);
          },
        });
      });
    },
    close: () => socket.close(),
  };
}

/** A host socket, registered and confirmed available. */
async function connectAvailableHost(): Promise<TestClient> {
  const host = await connect("host");
  host.send({
    type: "hello",
    protocolVersion: SIGNALING_PROTOCOL_VERSION,
    role: "host",
    token: HOST_SECRET,
    profileId: "prof_1",
    callIdKey: CALL_KEY,
  });
  await host.expect("hello.ok");
  host.send({ type: "presence.update", profileId: "prof_1", presence: "available" });
  await host.expect("presence.update");
  return host;
}

/** A guest socket holding a freshly minted token for one attempt. */
async function connectGuest(): Promise<{ guest: TestClient; token: string; callAttemptId: string }> {
  const { body } = await authorize();
  if (body.state !== "available" || !body.token || !body.callAttemptId) {
    throw new Error(`expected an available host, got ${body.state}`);
  }
  const guest = await connect("guest");
  guest.send({
    type: "hello",
    protocolVersion: SIGNALING_PROTOCOL_VERSION,
    role: "guest",
    token: body.token,
  });
  await guest.expect("hello.ok");
  return { guest, token: body.token, callAttemptId: body.callAttemptId };
}

beforeAll(async () => {
  service = await startService(PORT, {
    SIGNALING_RING_TIMEOUT_MS: String(RING_TIMEOUT_MS),
    // Generous, so the suite's own pauses never trip presence expiry.
    SIGNALING_PRESENCE_TIMEOUT_MS: "60000",
    // The suite authorises a call in almost every test, which would otherwise
    // exhaust the production allowance of 10/minute partway through. The limiter
    // itself is proved against a dedicated instance below.
    SIGNALING_AUTHORIZE_PER_MINUTE: "2000",
    SIGNALING_CONNECTIONS_PER_MINUTE: "2000",
  });
});

afterAll(async () => {
  await stopService(service);
});

describe("signalling service", () => {
  it("answers a health check", async () => {
    const response = await fetch(`${BASE}/health`);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("refuses to reveal whether an unregistered Call ID exists", async () => {
    // Section 57. A code no host has registered and a code that was never real
    // must answer identically, or this endpoint becomes a way to enumerate which
    // Call IDs are real.
    const unregistered = await authorize(CALL_ID);
    const nonsense = await authorize("CS-0000-0000-0000");
    expect(unregistered.body.state).toBe("unavailable");
    expect(nonsense.body.state).toBe("unavailable");
    expect(unregistered.body).toEqual(nonsense.body);
  });

  it("does not make a registered host callable until it is available", async () => {
    // Section 21: registering is not the same as being available. The operator
    // still has to turn Receive Calls on.
    const host = await connect("host-offline");
    host.send({
      type: "hello",
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
      role: "host",
      token: HOST_SECRET,
      profileId: "prof_1",
      callIdKey: CALL_KEY,
    });
    await host.expect("hello.ok");

    const beforeToggle = await authorize();
    expect(beforeToggle.body.state).toBe("unavailable");

    host.send({ type: "presence.update", profileId: "prof_1", presence: "available" });
    await host.expect("presence.update");
    const afterToggle = await authorize();
    expect(afterToggle.body.state).toBe("available");
    expect(afterToggle.body.token).toBeTruthy();

    host.close();
    await sleep(150);
  });

  it("refuses a forged guest token", async () => {
    const host = await connectAvailableHost();
    const guest = await connect("forger");
    guest.send({
      type: "hello",
      protocolVersion: SIGNALING_PROTOCOL_VERSION,
      role: "guest",
      token: "att_x.CS7K4PQ9MX2J8R.9999999999999.not-a-real-signature",
    });
    const error = await guest.expect("error");
    expect(error.code).toBe("unauthorized");

    guest.close();
    host.close();
    await sleep(150);
  });

  it("refuses a mismatched protocol version rather than guessing", async () => {
    const client = await connect("old-client");
    client.send({
      type: "hello",
      protocolVersion: SIGNALING_PROTOCOL_VERSION + 99,
      role: "host",
      token: HOST_SECRET,
      profileId: "prof_1",
      callIdKey: CALL_KEY,
    });
    const error = await client.expect("error");
    expect(error.code).toBe("protocol_version");

    client.close();
    await sleep(150);
  });

  it("scopes a guest token to the one attempt it names", async () => {
    // Section 56: a guest must not be able to redirect its token at another
    // attempt, or subscribe to anybody else's call.
    const host = await connectAvailableHost();
    const { guest } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId: "att_somebody_elses",
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "Intruder" },
    });
    const error = await guest.expect("error");
    expect(error.code).toBe("unauthorized");

    // And the host was never rung.
    expect(host.received.some((message) => message.type === "call.incoming")).toBe(false);

    guest.close();
    host.close();
    await sleep(150);
  });

  it("delivers an invitation to the host with the caller and a shared deadline", async () => {
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });

    const incoming = await host.expect("call.incoming");
    expect(incoming.callAttemptId).toBe(callAttemptId);
    expect(incoming.caller.displayName).toBe("John Williams");
    expect(incoming.profileId).toBe("prof_1");
    // Both ends time out on the same deadline rather than each guessing.
    expect(incoming.ringExpiresAt).toBeGreaterThan(incoming.ringingSince);

    guest.close();
    host.close();
    await sleep(150);
  });

  it("answers a second caller busy and leaves the first call alone", async () => {
    // Sections 95 and 111: one call at a time, no queue, first call unaffected.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "First Caller" },
    });
    await host.expect("call.incoming");

    const second = await authorize();
    expect(second.body.state).toBe("busy");
    expect(second.body.token).toBeUndefined();

    // The first call is still the only one on the host's screen.
    const incomingCount = host.received.filter((message) => message.type === "call.incoming").length;
    expect(incomingCount).toBe(1);

    guest.close();
    host.close();
    await sleep(150);
  });

  it("relays accept, SDP and ICE between the two participants", async () => {
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");

    host.send({ type: "call.accept", callAttemptId });
    await expect(guest.expect("call.accept")).resolves.toMatchObject({ callAttemptId });

    const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";
    host.send({ type: "webrtc.description", callAttemptId, description: { type: "offer", sdp } });
    const description = await guest.expect("webrtc.description");
    // Relayed verbatim: the service has no business rewriting an SDP.
    expect(description.description).toEqual({ type: "offer", sdp });

    host.send({
      type: "webrtc.ice_candidate",
      callAttemptId,
      candidate: {
        candidate: "candidate:1 1 udp 2130706431 10.0.0.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    });
    const candidate = await guest.expect("webrtc.ice_candidate");
    expect(candidate.candidate.candidate).toContain("typ host");

    guest.close();
    host.close();
    await sleep(150);
  });

  it("reports an uploaded source as unreachable instead of inventing a URL", async () => {
    // Sections 43 and 113. A call source in the operator's IndexedDB cannot be
    // fetched by another device, and the honest answer is the one that keeps a
    // guest from staring at a frame that will never load.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");
    host.send({ type: "call.accept", callAttemptId });
    await guest.expect("call.accept");

    host.send({
      type: "call.source_selected",
      callAttemptId,
      sourceKind: "uploaded-source",
      mediaAssetId: "asset_1",
    });

    const ready = await guest.expect("call.source_ready");
    expect(ready.sourceKind).toBe("uploaded-source");
    expect(ready.unavailableReason).toBe("storage_unreachable");
    expect(ready.playbackUrl).toBeUndefined();

    guest.close();
    host.close();
    await sleep(150);
  });

  it("passes a live-camera choice straight through", async () => {
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");
    host.send({ type: "call.accept", callAttemptId });
    await guest.expect("call.accept");

    host.send({ type: "call.source_selected", callAttemptId, sourceKind: "live-camera" });
    const ready = await guest.expect("call.source_ready");
    expect(ready.sourceKind).toBe("live-camera");
    expect(ready.unavailableReason).toBeUndefined();

    guest.close();
    host.close();
    await sleep(150);
  });

  it("relays a decline and frees the host", async () => {
    // Section 108.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");

    host.send({ type: "call.decline", callAttemptId });
    await expect(guest.expect("call.decline")).resolves.toMatchObject({ callAttemptId });

    // Host presence returns to available, so the next caller gets through.
    await sleep(200);
    const next = await authorize();
    expect(next.body.state).toBe("available");

    guest.close();
    host.close();
    await sleep(150);
  });

  it("tells the host at once when the caller cancels", async () => {
    // Section 109: the incoming screen must clear immediately.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");

    guest.send({ type: "call.cancel", callAttemptId });
    await expect(host.expect("call.cancel")).resolves.toMatchObject({ callAttemptId });

    guest.close();
    host.close();
    await sleep(150);
  });

  it("times out an unanswered ring on its own clock", async () => {
    // Section 110: nothing rings forever, and the host's screen clears too.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "Nobody Home" },
    });
    await host.expect("call.incoming");

    const guestTimeout = await guest.expect("call.no_answer", RING_TIMEOUT_MS + 4_000);
    expect(guestTimeout.callAttemptId).toBe(callAttemptId);
    const hostTimeout = await host.expect("call.no_answer", 2_000);
    expect(hostTimeout.callAttemptId).toBe(callAttemptId);

    host.close();
    await sleep(150);
  });

  it("preserves an end reason rather than flattening it to a failure", async () => {
    // Section 50: `subscription_required` has to reach the operator as itself.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");
    host.send({ type: "call.accept", callAttemptId });
    await guest.expect("call.accept");

    guest.send({ type: "call.end", callAttemptId, reason: "subscription_required" });
    const ended = await host.expect("call.end");
    expect(ended.reason).toBe("subscription_required");

    host.close();
    await sleep(150);
  });

  it("carries the call type through to the host", async () => {
    // Section 3: the host's screen has to know whether it is an audio or a video
    // call before it draws anything, and it must learn that from the protocol
    // rather than inferring it from a route the other device navigated.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "audio",
      caller: { displayName: "John Williams" },
    });

    const incoming = await host.expect("call.incoming");
    expect(incoming.callType).toBe("audio");

    guest.close();
    host.close();
    await sleep(150);
  });

  it("runs an audio call through the same lifecycle as a video call", async () => {
    // Section 2: one signalling architecture. Accept, negotiate and end all
    // behave identically; only the media tracks differ.
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "audio",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");

    host.send({ type: "call.accept", callAttemptId });
    await expect(guest.expect("call.accept")).resolves.toMatchObject({ callAttemptId });

    // An audio call negotiates with no source selection in between.
    const sdp = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    guest.send({ type: "webrtc.description", callAttemptId, description: { type: "offer", sdp } });
    const offer = await host.expect("webrtc.description");
    expect(offer.description.sdp).toContain("m=audio");

    guest.send({ type: "call.end", callAttemptId, reason: "hangup" });
    await expect(host.expect("call.end")).resolves.toMatchObject({ reason: "hangup" });

    // The operator is available again, exactly as after a video call.
    await sleep(200);
    const next = await authorize();
    expect(next.body.state).toBe("available");

    host.close();
    await sleep(150);
  });

  it("rejects a malformed frame without dropping the socket", async () => {
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    // A description whose `sdp` is a number: the validator must refuse it rather
    // than letting it reach a peer connection.
    guest.send({
      type: "webrtc.description",
      callAttemptId,
      description: { type: "nonsense", sdp: 5 },
    } as unknown as ClientMessage);

    const error = await guest.expect("error");
    expect(error.code).toBe("invalid_message");

    // The socket is still usable afterwards.
    guest.send({ type: "ping", nonce: "still-alive" });
    await expect(guest.expect("pong")).resolves.toMatchObject({ nonce: "still-alive" });

    guest.close();
    host.close();
    await sleep(150);
  });

  it("tells the remaining participant when the other socket disappears", async () => {
    const host = await connectAvailableHost();
    const { guest, callAttemptId } = await connectGuest();

    guest.send({
      type: "call.invite",
      callAttemptId,
      callIdKey: CALL_KEY,
      callType: "video",
      caller: { displayName: "John Williams" },
    });
    await host.expect("call.incoming");
    host.send({ type: "call.accept", callAttemptId });
    await guest.expect("call.accept");

    // The guest's phone goes away without a clean hangup.
    guest.close();

    const ended = await host.expect("call.end");
    expect(ended.reason).toBe("transport_closed");

    host.close();
    await sleep(150);
  });

});

/**
 * Rate limiting gets its own instance.
 *
 * The limiter is per client address and in-memory, so proving it on the shared
 * service would spend the allowance every other test depends on. A separate
 * process with a deliberately tiny budget keeps the two concerns apart.
 */
describe("signalling rate limits", () => {
  const LIMIT_PORT = 8792;
  const LIMIT_BASE = `http://127.0.0.1:${LIMIT_PORT}`;
  let limited: ChildProcess;

  beforeAll(async () => {
    limited = await startService(LIMIT_PORT, { SIGNALING_AUTHORIZE_PER_MINUTE: "3" });
  });

  afterAll(async () => {
    await stopService(limited);
  });

  it("refuses repeated Call ID lookups", async () => {
    // Section 57: this endpoint must not be usable as a call-spam engine or as a
    // way to enumerate which Call IDs are real.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${LIMIT_BASE}/calls/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: CALL_ID }),
      });
      statuses.push(response.status);
      await response.json().catch(() => ({}));
    }

    expect(statuses).toContain(429);
    // The budget is spent, not merely dented: once refused it stays refused for
    // the rest of the burst.
    expect(statuses.at(-1)).toBe(429);
  });
});
