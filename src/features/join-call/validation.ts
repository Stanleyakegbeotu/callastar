import { formatCallId, looksLikeCallId } from "@/lib/callId";

export interface JoinCallValues {
  fullName: string;
  phone: string;
  email: string;
  callId: string;
}

export type JoinCallField = keyof JoinCallValues;

export type JoinCallErrors = Partial<Record<JoinCallField, string>>;

/**
 * Digits only, so any grouping style the caller prefers is accepted. The range
 * covers national numbers at the short end and E.164 (15 digits) at the long
 * end — no country-specific assumptions beyond that.
 */
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

/** Deliberately permissive: one @, a dot in the domain, no whitespace. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function validateField(field: JoinCallField, values: JoinCallValues): string | undefined {
  const value = values[field].trim();

  switch (field) {
    case "fullName":
      if (!value) return "Enter your full name.";
      if (value.length < 2) return "Your name looks too short.";
      return undefined;

    case "phone": {
      if (!value) return "Enter your phone number.";
      const digits = digitsOf(value);
      if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
        return "Enter a valid phone number.";
      }
      return undefined;
    }

    case "email":
      if (!value) return "Enter your email address.";
      if (!EMAIL_PATTERN.test(value)) return "Enter a valid email address.";
      return undefined;

    case "callId": {
      if (!value) return "Enter the Call ID your host shared.";
      // Only the shape is checked here. Whether the code belongs to a profile
      // is answered by the lookup, which has its own not-found step.
      if (!looksLikeCallId(value)) return "That does not look like a Call ID.";
      return undefined;
    }
  }
}

export function validateJoinCall(values: JoinCallValues): JoinCallErrors {
  const fields: JoinCallField[] = ["fullName", "phone", "email", "callId"];
  const errors: JoinCallErrors = {};

  for (const field of fields) {
    const message = validateField(field, values);
    if (message) errors[field] = message;
  }

  return errors;
}

export function hasErrors(errors: JoinCallErrors): boolean {
  return Object.values(errors).some((message) => Boolean(message));
}

/** Trim the caller details and normalise the Call ID before they enter state. */
export function normaliseJoinCall(values: JoinCallValues): JoinCallValues {
  return {
    fullName: values.fullName.trim(),
    phone: values.phone.trim(),
    email: values.email.trim(),
    // Kept in display form; every lookup normalises it again anyway.
    callId: formatCallId(values.callId),
  };
}
