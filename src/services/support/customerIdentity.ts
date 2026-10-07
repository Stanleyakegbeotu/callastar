import type { CallerDetails } from "@/types/user";

export interface SupportCustomerIdentity {
  email: string;
  normalizedEmail: string;
  name: string;
  phone: string;
  guestSessionId: string;
}

const IDENTITY_KEY = "callastar:customer-identity";
const GUEST_KEY = "callastar:support-guest-session";
export const CUSTOMER_IDENTITY_UPDATED = "callastar:customer-identity-updated";
let current: SupportCustomerIdentity | null = null;

export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

function guestSessionId(): string {
  try {
    let value = sessionStorage.getItem(GUEST_KEY);
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem(GUEST_KEY, value);
    }
    return value;
  } catch {
    return crypto.randomUUID();
  }
}

export function readSupportCustomerIdentity(): SupportCustomerIdentity {
  if (current) return current;
  let saved: Partial<CallerDetails> = {};
  try { saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "{}"); } catch { /* storage can be unavailable */ }
  const email = typeof saved.email === "string" ? saved.email.trim() : "";
  current = {
    email,
    normalizedEmail: normalizeCustomerEmail(email),
    name: typeof saved.fullName === "string" ? saved.fullName.trim() : "",
    phone: typeof saved.phone === "string" ? saved.phone.trim() : "",
    guestSessionId: guestSessionId(),
  };
  return current;
}

export function saveSupportCustomerIdentity(caller: CallerDetails): SupportCustomerIdentity {
  const email = caller.email.trim();
  current = {
    email,
    normalizedEmail: normalizeCustomerEmail(email),
    name: caller.fullName.trim(),
    phone: caller.phone.trim(),
    guestSessionId: guestSessionId(),
  };
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(caller)); } catch { /* backend remains authoritative */ }
  window.dispatchEvent(new CustomEvent(CUSTOMER_IDENTITY_UPDATED, { detail: current }));
  return current;
}

export function setSupportCustomerIdentity(identity: SupportCustomerIdentity): void {
  current = { ...identity, email: identity.email.trim(), normalizedEmail: normalizeCustomerEmail(identity.email) };
}
