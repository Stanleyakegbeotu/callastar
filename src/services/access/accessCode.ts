/**
 * Generating, normalising and hashing Subscription Access IDs.
 *
 * Kept apart from `lib/callId.ts` on purpose. A Call ID and an Access ID look
 * superficially alike and mean completely different things — one identifies a
 * host and is meant to be passed around, the other authorises a call and is
 * not. Sharing the generator between them is how a credential ends up with the
 * entropy of a public identifier.
 */

/**
 * No I, O, 0 or 1: these are read aloud and typed by hand, and a credential
 * that fails because someone heard "oh" for "zero" is a support ticket.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const PREFIX = "CSUB";
const GROUP_LENGTH = 4;
const GROUPS = 2;

/** `CSUB-XXXX-XXXX`, case-insensitive, separators optional. */
const ACCESS_ID_PATTERN = /^CSUB[-\s]?[A-Z2-9]{4}[-\s]?[A-Z2-9]{4}$/i;

/**
 * A new credential.
 *
 * `crypto.getRandomValues` only — never `Math.random()`, never a counter, and
 * never anything derived from the profile. Rejection sampling keeps every
 * character equally likely; taking the remainder of 256 by 32 would be uniform
 * here, but the habit of biasing an alphabet is not one worth keeping.
 */
export function generateAccessCode(): string {
  const length = GROUP_LENGTH * GROUPS;
  const characters: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

  while (characters.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      characters.push(ALPHABET[byte % ALPHABET.length]);
      if (characters.length === length) break;
    }
  }

  const groups: string[] = [];
  for (let index = 0; index < GROUPS; index += 1) {
    groups.push(characters.slice(index * GROUP_LENGTH, (index + 1) * GROUP_LENGTH).join(""));
  }

  return `${PREFIX}-${groups.join("-")}`;
}

/** Does this look like an Access ID at all? Used to route, not to authorise. */
export function looksLikeAccessId(value: string): boolean {
  return ACCESS_ID_PATTERN.test(value.trim());
}

/**
 * One canonical form for hashing and comparison: uppercase, no separators,
 * no whitespace. What somebody typed must not change whether their credential
 * works.
 */
export function normalizeAccessId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `CSUB-9K4P-48Q2` from any accepted form. Display only. */
export function formatAccessId(value: string): string {
  const normalized = normalizeAccessId(value);
  const body = normalized.startsWith(PREFIX) ? normalized.slice(PREFIX.length) : normalized;
  const groups = body.match(/.{1,4}/g) ?? [];
  return [PREFIX, ...groups].join("-");
}

/** The last four characters, which is all that is kept for recognition. */
export function accessIdLast4(value: string): string {
  return normalizeAccessId(value).slice(-4);
}

/** `CSUB-••••-48Q2`: enough to recognise, not enough to use. */
export function maskAccessId(last4: string): string {
  return `${PREFIX}-••••-${last4}`;
}

/**
 * SHA-256 of the normalised code, hex encoded.
 *
 * Web Crypto needs a secure context, which the app already requires for the
 * camera. Where it is genuinely missing this throws rather than falling back to
 * a weaker digest — a credential silently stored under a toy hash would be
 * worse than one that could not be created at all.
 */
export async function hashAccessId(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Secure hashing is unavailable, so access IDs cannot be issued here.");
  }

  const bytes = new TextEncoder().encode(normalizeAccessId(value));
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
