/**
 * Call session helpers for the public app.
 *
 * Call ID parsing now lives in `lib/callId.ts`, and resolving a code to a host
 * is the call backend's job, so what remains here is the local identifier the
 * `/call/:sessionId` route uses.
 */

/** Route-level id for one call attempt. */
export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "cs_" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
