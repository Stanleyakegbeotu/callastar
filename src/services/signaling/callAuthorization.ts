import { SIGNALING } from "@/lib/config";
import { normalizeCallId } from "@/lib/callId";
import { callError } from "@/lib/callDiagnostics";

/**
 * Asking permission to ring somebody.
 *
 * The guest has no account, so this is where they get the only credential they
 * will hold: an ephemeral token authorising one call attempt against one Call
 * ID. The check and the mint happen together on the service, so a token only
 * ever exists for a call that could actually connect.
 *
 * The three unavailable cases — no host registered, the operator offline, a code
 * that was never real — all answer `unavailable`. That is deliberate: anything
 * finer would make this endpoint a way to discover which Call IDs exist.
 */

export type CallAuthorization =
  | {
      state: "available";
      /** The service's id for this attempt. */
      callAttemptId: string;
      /** Scoped to that one attempt, and short-lived. Never logged, never stored. */
      token: string;
      expiresAt: number;
    }
  | { state: "busy" }
  | { state: "unavailable" }
  /** Could not reach the service at all — distinct from a host being away. */
  | { state: "unreachable" }
  | { state: "rate_limited" };

/**
 * The HTTP origin of the signalling service, derived from its socket URL.
 *
 * One configured address for both surfaces, so a deployment cannot end up with a
 * socket pointing at one host and an authorize endpoint at another.
 */
export function signalingHttpOrigin(wsUrl: string = SIGNALING.url): string {
  if (!wsUrl) return "";
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    // Keep any path prefix a reverse proxy adds, minus a trailing slash.
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    return base;
  } catch {
    return "";
  }
}

/**
 * Resolves a Call ID into permission to ring it.
 *
 * Never throws. Every failure is one of the states above, because the caller is
 * a UI that has to say something useful either way — and "we could not reach
 * CallaStar" is a different sentence from "they are not available".
 */
export async function authorizeCall(callId: string, signal?: AbortSignal): Promise<CallAuthorization> {
  const origin = signalingHttpOrigin();
  if (!origin) return { state: "unreachable" };

  try {
    const response = await fetch(`${origin}/calls/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Normalised here so the service and the browser agree on the key, and a
      // code typed with or without its dashes resolves identically.
      body: JSON.stringify({ callId: normalizeCallId(callId) }),
      signal,
    });

    if (response.status === 429) return { state: "rate_limited" };
    if (!response.ok) return { state: "unreachable" };

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return { state: "unreachable" };

    const payload = body as {
      state?: unknown;
      callAttemptId?: unknown;
      token?: unknown;
      expiresAt?: unknown;
    };

    if (payload.state === "busy") return { state: "busy" };
    if (payload.state === "unavailable") return { state: "unavailable" };

    if (
      payload.state === "available" &&
      typeof payload.callAttemptId === "string" &&
      typeof payload.token === "string"
    ) {
      return {
        state: "available",
        callAttemptId: payload.callAttemptId,
        token: payload.token,
        expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : Date.now() + 60_000,
      };
    }

    // A shape we do not recognise is treated as unreachable rather than guessed
    // at: proceeding on a malformed answer would ring nobody.
    return { state: "unreachable" };
  } catch (error) {
    // An abort is the caller's own doing and is not worth a diagnostic.
    if (signal?.aborted) return { state: "unreachable" };
    callError("authorize", error);
    return { state: "unreachable" };
  }
}
