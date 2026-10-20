import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

let vite: ViteDevServer | undefined;
const upstream = createHttpServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    response.setHeader("access-control-allow-origin", "https://callastar.netlify.app");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, authorization: request.headers.authorization, origin: request.headers.origin ?? null, body }));
  });
});
const sockets = new WebSocketServer({ server: upstream });
sockets.on("connection", socket => socket.on("message", message => socket.send(message.toString())));
afterAll(async () => {
  await vite?.close();
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  vi.unstubAllEnvs();
});

it("uses the actual Vite proxy despite production-only upstream CORS, retaining user authorization", async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("VITE_SUPABASE_URL", `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  vi.stubEnv("VITE_DEV_SIGNALING_PROXY", "true");
  vi.stubEnv("VITE_SIGNALING_URL", `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  vite = await createServer({
    configFile: "vite.config.ts", mode: "test", logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: ".tmp-supabase-proxy-cache",
  });
  await vite.listen();
  const port = (vite.httpServer!.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/__supabase/functions/v1/admin-call-ids`, {
    method: "POST", headers: { origin: `http://127.0.0.1:${port}`, authorization: "Bearer test-admin-session", "content-type": "application/json" },
    body: '{"hostIds":[]}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "/functions/v1/admin-call-ids", authorization: "Bearer test-admin-session", origin: null, body: '{"hostIds":[]}',
  });
  expect(response.headers.get("access-control-allow-origin")).toBe("https://callastar.netlify.app");
  const authorization = await fetch(`http://127.0.0.1:${port}/__callastar_signaling/calls/authorize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"sessionToken":"scoped-proof"}',
  });
  expect((await authorization.json()).path).toBe("/calls/authorize");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/__callastar_signaling`);
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => socket.send("scoped-call-control"));
      socket.once("message", data => resolve(data.toString()));
    });
    expect(echoed).toBe("scoped-call-control");
  } finally {
    await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.close(); });
  }
}, 30000);
