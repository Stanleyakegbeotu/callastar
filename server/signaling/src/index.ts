import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";

import { assertConfigured, config } from "./config.ts";
import { SignalingHub } from "./hub.ts";
import { perMinute } from "./rateLimit.ts";
import { mintGuestToken } from "./tokens.ts";

/**
 * CallaStar signalling service.
 *
 * Two surfaces:
 *
 *   POST /calls/authorize   a guest presents a Call ID and, if a host is
 *                           actually available, receives an ephemeral token good
 *                           for that one call attempt
 *   WS   /                  the signalling socket itself
 *
 * Call control and SDP/ICE only. No media ever passes through this process, and
 * nothing is persisted: there is no database, and a restart loses only calls that
 * were mid-dial.
 *
 * Deliberately a real process rather than Vite middleware. Development
 * middleware cannot be deployed, and two phones on a real network need something
 * that can be.
 */

assertConfigured();

const hub = new SignalingHub();
hub.start();

/* --------------------------------------------------------------- rate limits */

const authorizeLimiter = perMinute(config.limits.authorizePerMinute);
const connectionLimiter = perMinute(config.limits.connectionsPerMinute);

/**
 * Which client this is, for rate limiting only.
 *
 * `x-forwarded-for` is trusted because this service is expected to sit behind a
 * TLS terminator — a WebSocket needs `wss://` in a browser. Behind an untrusted
 * proxy this would need narrowing to known hops.
 */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = header?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "unknown";
}

/* ---------------------------------------------------------------------- CORS */

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;

  // An explicit allowlist, never `*`: this endpoint mints call credentials.
  if (config.allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Max-Age", "600");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

/** Bounded, so a request body cannot be used to exhaust memory. */
async function readBody(request: IncomingMessage, maxBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Normalises a Call ID the same way the browser does.
 *
 * Kept deliberately simple and self-contained: uppercase, and strip everything
 * that is not a letter or a digit. `src/lib/callId.ts` produces the same key, so
 * a code typed with or without its dashes resolves identically.
 */
function normalizeCallIdKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* ------------------------------------------------------------------- routing */

const httpServer = createServer((request, response) => {
  applyCors(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const path = (request.url ?? "/").split("?")[0];

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true, ...hub.stats() });
    return;
  }

  if (request.method === "POST" && path === "/calls/authorize") {
    void handleAuthorize(request, response);
    return;
  }

  sendJson(response, 404, { error: "not_found" });
});

/**
 * Mints a token for one call attempt.
 *
 * The check and the mint are together on purpose: a token is only issued for a
 * call that could actually connect, so an unavailable host never becomes a socket
 * sitting in a room waiting for somebody who is not there.
 *
 * `unavailable` covers a Call ID nobody has registered, a profile whose operator
 * is offline, and a code that was never real. One answer for all three, so this
 * cannot be used to find out which Call IDs exist.
 */
async function handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorizeLimiter.take(clientKey(request))) {
    sendJson(response, 429, { error: "rate_limited" });
    return;
  }

  let callIdKey: string;
  try {
    const raw = await readBody(request);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const candidate = (parsed as { callId?: unknown; callIdKey?: unknown }).callIdKey ??
      (parsed as { callId?: unknown }).callId;
    if (typeof candidate !== "string" || candidate.length > 64) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    callIdKey = normalizeCallIdKey(candidate);
    if (callIdKey === "") {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
  } catch {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }

  const availability = hub.hostAvailability(callIdKey);

  if (availability === "unavailable") {
    sendJson(response, 200, { state: "unavailable" });
    return;
  }
  if (availability === "busy") {
    sendJson(response, 200, { state: "busy" });
    return;
  }

  const { token, claims } = mintGuestToken(callIdKey);
  sendJson(response, 200, {
    state: "available",
    callAttemptId: claims.callAttemptId,
    token,
    expiresAt: claims.expiresAt,
  });
}

/* ---------------------------------------------------------------- websockets */

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

httpServer.on("upgrade", (request, socket, head) => {
  if (!connectionLimiter.take(clientKey(request))) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    hub.accept(ws);
  });
});

httpServer.listen(config.port, config.host, () => {
  const relay = process.env.SIGNALING_TURN_CONFIGURED === "true";
  console.log(`CallaStar signalling listening on ${config.host}:${config.port}`);
  if (!relay) {
    // Stated at startup rather than discovered when a call fails on a mobile
    // network. This service does not relay media, but a deployment without TURN
    // is not production ready and should not be described as one.
    console.warn(
      "[callastar:signaling] TURN not confirmed for this deployment. " +
        "Without a TURN server, calls will fail on carrier NAT, CGNAT and restricted Wi-Fi.",
    );
  }
});

function shutdown(signal: string): void {
  console.log(`CallaStar signalling stopping (${signal})`);
  hub.stop();
  wss.close();
  httpServer.close(() => process.exit(0));
  // Never hang on a socket that refuses to close.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
