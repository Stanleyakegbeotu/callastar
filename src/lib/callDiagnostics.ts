import { logDiagnostic } from "./utils";

/**
 * The one place call diagnostics are allowed out.
 *
 * Real-time calling produces exactly the kind of debugging information that must
 * never reach a production log: an SDP names local IP addresses and codecs, ICE
 * candidates name network paths, and TURN credentials and guest call tokens are
 * live credentials. So this module is a boundary rather than a convenience —
 * `console.log` scattered through call code is how that material escapes.
 *
 * Two rules:
 *
 *  1. Nothing is emitted outside a development build. `import.meta.env.DEV` is
 *     checked in `logDiagnostic`, so a production bundle drops all of it.
 *  2. Only the named fields below are ever emitted. Everything passes through
 *     `redact`, which keeps a short allowlist and drops the rest — so a future
 *     caller cannot accidentally widen what gets logged by passing a bigger
 *     object.
 */

/**
 * Fields safe to print: connection state machines and counters.
 *
 * Deliberately excluded, and the reason each one is dangerous:
 *   sdp, description   local IP addresses, codecs, session identifiers
 *   candidate          network topology
 *   token, credential  live credentials
 *   playbackUrl        an authorised media URL
 *   email, phone, name a caller's contact details
 *   accessId           a subscription credential
 */
const SAFE_FIELDS = new Set([
  "phase",
  "previousPhase",
  "role",
  "connectionState",
  "iceConnectionState",
  "signalingState",
  "iceGatheringState",
  "candidatePairType",
  "usingRelay",
  "iceRestarts",
  "attempt",
  "attempts",
  "turnConfigured",
  "relayReadiness",
  "sourceKind",
  "sourceMode",
  "deviceClass",
  "callType",
  "supported",
  "reason",
  "code",
  "status",
  "presence",
  "durationSeconds",
  "count",
  "elapsedMs",
  "messageType",
  "queued",
  "dropped",
]);

export type DiagnosticFields = Record<string, unknown>;

/**
 * Keeps the allowlisted fields and summarises the rest.
 *
 * A dropped key is reported by name but never by value, which is enough to
 * notice that something was passed without printing what it was.
 */
function redact(fields: DiagnosticFields): DiagnosticFields {
  const kept: DiagnosticFields = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) {
      dropped.push(key);
      continue;
    }
    // Only primitives. An object under a safe key could still carry anything.
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }

  if (dropped.length > 0) kept.omitted = dropped.join(",");
  return kept;
}

/** A development-only call diagnostic. Silent in production. */
export function callDiagnostic(scope: string, fields: DiagnosticFields): void {
  logDiagnostic(`call:${scope}`, redact(fields));
}

/**
 * An error from the call stack.
 *
 * Only the message and the error's own name, never a payload the throw site
 * happened to be holding. A stack trace stays in development, where
 * `logDiagnostic` confines it.
 */
export function callError(scope: string, error: unknown, fields: DiagnosticFields = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  logDiagnostic(`call:${scope}`, { ...redact(fields), error: message });
}

/** Exposed for the test that proves the allowlist actually holds. */
export const __testing = { redact, SAFE_FIELDS };
