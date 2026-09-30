/**
 * Call session helpers for the public app.
 *
 * Call ID parsing now lives in `lib/callId.ts`, and resolving a code to a host
 * is the call backend's job, so what remains here is the local identifier the
 * `/call/:sessionId` route uses.
 */

/** Route-level id for one call attempt. */
export function createSessionId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `cs_${random}`;
}
