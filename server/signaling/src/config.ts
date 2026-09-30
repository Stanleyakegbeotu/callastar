/**
 * Service configuration, entirely from the environment.
 *
 * Nothing here has a default that would be unsafe in production. The host
 * secret in particular has no fallback: a signalling service that accepts any
 * host with a guessable credential lets a stranger answer somebody else's calls.
 */

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  port: readInt(process.env.SIGNALING_PORT, 8787),
  host: process.env.SIGNALING_HOST ?? "0.0.0.0",

  /**
   * Signs the ephemeral guest call tokens. Must be set, and must be a real
   * random secret — the service refuses to start otherwise.
   */
  tokenSecret: process.env.SIGNALING_TOKEN_SECRET ?? "",

  /**
   * What a host presents to operate a profile.
   *
   * A shared secret is a DEVELOPMENT stand-in, and the README says so. Real
   * operator authorisation belongs with the admin session: see the
   * `ProfileOperator` note in the README for what replacing this involves.
   */
  hostSecret: process.env.SIGNALING_HOST_SECRET ?? "",

  /**
   * Browser origins allowed to call the HTTP endpoints. Empty means same-origin
   * only, which is the safe default rather than `*`.
   */
  allowedOrigins: readList(process.env.SIGNALING_ALLOWED_ORIGINS),

  /** How long a guest call token stays valid. One call attempt, briefly. */
  guestTokenTtlMs: readInt(process.env.SIGNALING_GUEST_TOKEN_TTL_MS, 120_000),

  /** A ring nobody answers becomes `no_answer` on the server's own clock. */
  ringTimeoutMs: readInt(process.env.SIGNALING_RING_TIMEOUT_MS, 35_000),

  /**
   * Presence expires this long after the last frame from a socket.
   *
   * Server-authoritative on purpose. A host whose phone loses signal, or whose
   * tab is closed, stops being available without having to tell us — nobody
   * should ever ring a host who is not there.
   */
  presenceTimeoutMs: readInt(process.env.SIGNALING_PRESENCE_TIMEOUT_MS, 45_000),
  heartbeatMs: readInt(process.env.SIGNALING_HEARTBEAT_MS, 15_000),

  /** Rate limits, per client address. See `rateLimit.ts`. */
  limits: {
    authorizePerMinute: readInt(process.env.SIGNALING_AUTHORIZE_PER_MINUTE, 10),
    invitesPerMinute: readInt(process.env.SIGNALING_INVITES_PER_MINUTE, 12),
    messagesPerSecond: readInt(process.env.SIGNALING_MESSAGES_PER_SECOND, 60),
    connectionsPerMinute: readInt(process.env.SIGNALING_CONNECTIONS_PER_MINUTE, 30),
  },
} as const;

/** Refuses to run in a configuration that would be unsafe. */
export function assertConfigured(): void {
  const problems: string[] = [];

  if (config.tokenSecret.length < 32) {
    problems.push("SIGNALING_TOKEN_SECRET must be set to at least 32 random characters.");
  }
  if (config.hostSecret.length < 32) {
    problems.push("SIGNALING_HOST_SECRET must be set to at least 32 random characters.");
  }

  if (problems.length > 0) {
    throw new Error(
      `CallaStar signalling cannot start:\n  - ${problems.join("\n  - ")}\n` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
}
