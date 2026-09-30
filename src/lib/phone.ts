/**
 * International phone numbers for WhatsApp deep links.
 *
 * Deliberately not a full E.164 parser: that needs a country metadata library,
 * and this only has to answer two questions — is what the admin typed a
 * plausible international number, and what digits does `wa.me` need? No country
 * is special-cased, so a number from anywhere is accepted on the same terms.
 */

/** Longest possible E.164 subscriber number is 15 digits; the shortest in use is 8. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export interface PhoneValidation {
  valid: boolean;
  /** Digits only, ready for `https://wa.me/<digits>`. */
  normalized: string;
  /** Present when invalid: wording meant for a person, not a log. */
  error: string | null;
}

/**
 * Strip everything a person might type for readability — spaces, brackets,
 * dots, dashes — down to the digits `wa.me` expects.
 *
 * A leading `+` is dropped because the deep link format does not use it, and a
 * leading `00` international prefix is dropped because it is a dialling
 * convention rather than part of the number.
 */
export function normalizePhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  return digits;
}

/** Pretty-print stored digits in groups, so a saved number stays readable. */
export function formatPhoneForDisplay(digits: string): string {
  if (digits.length === 0) return "";
  const groups = digits.slice(1).replace(/(\d{3})(?=\d)/g, "$1 ");
  return `+${digits.slice(0, 1)}${groups.length > 0 ? ` ${groups}` : ""}`.trim();
}

/**
 * Whether this is plausibly a number somebody could be reached on.
 *
 * A country code is required, which in practice means the number cannot be a
 * local subscriber number: those are shorter than the minimum and get rejected.
 */
export function validateWhatsappNumber(value: string): PhoneValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: false, normalized: "", error: "Enter a WhatsApp number, including the country code." };
  }

  // Letters are always a mistake here, and silently dropping them would save a
  // number nobody can be reached on.
  if (/[A-Za-z]/.test(trimmed)) {
    return { valid: false, normalized: "", error: "A phone number cannot contain letters." };
  }

  const normalized = normalizePhoneDigits(trimmed);

  if (normalized.length < MIN_DIGITS) {
    return {
      valid: false,
      normalized,
      error: "That number looks too short. Include the country code, for example +1 415 555 0123.",
    };
  }

  if (normalized.length > MAX_DIGITS) {
    return { valid: false, normalized, error: "That number is longer than any international phone number." };
  }

  // A country code never starts at zero once the dialling prefix is gone.
  if (normalized.startsWith("0")) {
    return {
      valid: false,
      normalized,
      error: "Start with the country code rather than a national trunk prefix.",
    };
  }

  return { valid: true, normalized, error: null };
}

/**
 * The link that opens WhatsApp with a message ready to send.
 *
 * Returns null rather than a broken `wa.me/` when no number is configured: a
 * link that goes nowhere is worse than an option that says it is unavailable.
 */
export function buildWhatsappLink(digits: string | null, message: string): string | null {
  const normalized = digits ? normalizePhoneDigits(digits) : "";
  if (normalized.length < MIN_DIGITS) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
