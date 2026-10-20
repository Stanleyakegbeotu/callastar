import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SIGNALING_PROTOCOL_VERSION } from "@/services/signaling/protocol";

const serviceDir = path.resolve(import.meta.dirname, "../server/signaling");
const port = 8794;
const tokenSecret = "production-host-token-secret-for-test-only".padEnd(64, "0");
const allowedOrigin = "https://callastarpro.netlify.app";
const profileId = "4b3b0b7c-38f4-4ce8-a4df-f03232ce7389";
const callIdKey = "CS7K4PQ9MX2J8R";
let service: ChildProcess;

function token(forProfile = profileId, forCallId = callIdKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: "callastar-admin", aud: "callastar-signaling", sub: "admin-user", role: "admin", profileId: forProfile, callIdKey: forCallId, iat: now, exp: now + 300 })).toString("base64url");
  const input = `${header}.${claims}`;
  return `${input}.${createHmac("sha256", tokenSecret).update(input).digest("base64url")}`;
}

async function socketHello(hostToken: string, origin = allowedOrigin) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const message = await new Promise<{ type: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for hello response")), 3000);
    socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(String(raw))); });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: SIGNALING_PROTOCOL_VERSION, role: "host", token: hostToken, profileId, callIdKey: "CS7K4PQ9MX2J8R" }));
  });
  return { socket, message };
}

describe("production signaling host credentials", () => {
  beforeAll(async () => {
    service = spawn(process.execPath, ["src/index.ts"], {
      cwd: serviceDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        SIGNALING_HOST: "127.0.0.1",
        SIGNALING_ALLOWED_ORIGINS: allowedOrigin,
        SIGNALING_TOKEN_SECRET: "guest-token-secret-for-test-only".padEnd(64, "0"),
        SIGNALING_HOST_TOKEN_SECRET: tokenSecret,
        SIGNALING_CALL_ACCESS_URL: "https://project.invalid/functions/v1/update-call-session",
        SIGNALING_SUPABASE_ANON_KEY: "test-anon-key",
      },
      stdio: "ignore",
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* waiting for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("production signaling service did not start");
  });

  afterAll(async () => {
    service?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    service?.kill("SIGKILL");
  });

  it("accepts a correctly signed Admin token only for its profile and allowed origin", async () => {
    const { socket, message } = await socketHello(token());
    expect(message.type).toBe("hello.ok");
    socket.close();
  });

  it("rejects a token scoped to another profile", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: allowedOrigin } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: SIGNALING_PROTOCOL_VERSION, role: "host", token: token("95550cb8-107b-4d79-887a-8d0a2856a9ec"), profileId, callIdKey: "CS7K4PQ9MX2J8R" }));
    const code = await new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4401);
  });

  it("rejects using the profile token with a different Call ID", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: allowedOrigin } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: SIGNALING_PROTOCOL_VERSION, role: "host", token: token(profileId, "CSOTHERPROFILE1"), profileId, callIdKey }));
    const code = await new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4401);
  });

  it("does not accept the development shared secret in production", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: allowedOrigin } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: SIGNALING_PROTOCOL_VERSION, role: "host", token: "test-host-secret-".padEnd(64, "0"), profileId, callIdKey: "CS7K4PQ9MX2J8R" }));
    const code = await new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)));
    expect(code).toBe(4401);
  });
});
