/**
 * Call ID generation and normalisation.
 *
 * The format is fixed by the server: `supabase/functions/_shared/utils.ts`
 * builds codes from the same alphabet and groups them the same way, so a code
 * minted locally today is shaped exactly like one minted by Supabase later.
 *
 * Display form:   CS-7K4P-Q9MX-2J8R
 * Normalised key: CS7K4PQ9MX2J8R
 *
 * Ambiguous characters (I, O, 0, 1) are left out so a code can be read aloud
 * or copied off a screen without confusion.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BODY_LENGTH = 12;
const PREFIX = "CS";

/** Normalised shape: the prefix plus twelve body characters. */
const CALL_ID_KEY_PATTERN = /^CS[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

/**
 * Cryptographically random, never `Math.random` and never sequential.
 * 256 byte values over a 32-character alphabet divides evenly, so there is no
 * modulo bias to correct for.
 */
export function generateCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(BODY_LENGTH));
  const body = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return formatCallId(`${PREFIX}${body}`);
}

/**
 * Lookup key for a code a person typed: case, spaces and separators are all
 * noise, so `cs-7k4p-q9mx-2j8r` and `CS 7K4P Q9MX 2J8R` reach the same profile.
 */
export function normalizeCallId(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Group a normalised code for display. Anything unexpected is returned as-is. */
export function formatCallId(code: string): string {
  const key = normalizeCallId(code);
  return key.replace(/^(CS)(.{4})(.{4})(.{4})$/, "$1-$2-$3-$4");
}

/** Whether a code could be a CallaStar Call ID. Existence is a separate question. */
export function isCallIdShape(code: string): boolean {
  return CALL_ID_KEY_PATTERN.test(normalizeCallId(code));
}

/**
 * A lenient check for the Join Call form: enough to catch a stray word, while
 * still accepting the legacy demo code used by the explicit mock backend.
 * Whether a code exists is always answered by the lookup itself.
 */
export function looksLikeCallId(code: string): boolean {
  const key = normalizeCallId(code);
  return key.length >= 6 && key.length <= 24;
}
