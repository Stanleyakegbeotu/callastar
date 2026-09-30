import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { config } from "./config.ts";

/**
 * Ephemeral call tokens.
 *
 * A guest has no account, but still must not be able to subscribe to arbitrary
 * signalling traffic. So resolving a Call ID mints a token that authorises
 * exactly one call attempt, to one profile, for a couple of minutes — and
 * nothing else. A Call ID is not a credential: knowing one buys the right to
 * ring a profile once, not to act as it or to listen to anybody else's calls.
 *
 * Signed rather than stored, so the service holds no session table and a restart
 * does not strand a call that is mid-dial. HMAC-SHA256 over the claims, with the
 * signature compared in constant time.
 */

export interface GuestClaims {
  callAttemptId: string;
  callIdKey: string;
  /** Epoch ms. */
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", config.tokenSecret).update(payload).digest("base64url");
}

function encodeClaims(claims: GuestClaims): string {
  // Fixed field order: the signature is over this exact string, so the layout is
  // part of the contract rather than whatever JSON.stringify happens to produce.
  return [claims.callAttemptId, claims.callIdKey, String(claims.expiresAt)].join(".");
}

export function mintGuestToken(callIdKey: string): { token: string; claims: GuestClaims } {
  const claims: GuestClaims = {
    callAttemptId: `att_${randomUUID()}`,
    callIdKey,
    expiresAt: Date.now() + config.guestTokenTtlMs,
  };

  const payload = encodeClaims(claims);
  return { token: `${payload}.${sign(payload)}`, claims };
}

export type TokenVerification =
  | { ok: true; claims: GuestClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyGuestToken(token: string): TokenVerification {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };

  const [callAttemptId, callIdKey, expiresAtRaw, signature] = parts as [string, string, string, string];
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };

  const payload = [callAttemptId, callIdKey, expiresAtRaw].join(".");
  const expected = sign(payload);

  // Length is checked first because timingSafeEqual throws on a mismatch.
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Signature before expiry: an expired token whose signature is forged should
  // report the forgery, not hand back a hint that the format was otherwise fine.
  if (Date.now() > expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, claims: { callAttemptId, callIdKey, expiresAt } };
}

/**
 * The host credential.
 *
 * A shared secret, compared in constant time. This is the development
 * stand-in — see the README: production needs a per-operator credential tied to
 * the admin session, so that revoking one operator does not mean rotating a
 * secret every host shares.
 */
export function verifyHostToken(token: string): boolean {
  const provided = Buffer.from(token);
  const expected = Buffer.from(config.hostSecret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
