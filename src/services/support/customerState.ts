import { productionDiagnostic } from "@/lib/productionDiagnostics"
import { normalizeCustomerEmail } from "./customerIdentity"

export const CUSTOMER_STATE_KEY = "callastar_customer_state_v1"
export const CUSTOMER_STATE_VERSION = 1

export type CustomerRouteIntent = "start_call" | "customer_care" | "whatsapp_support"

export interface CustomerState {
  normalizedEmail: string
  displayName: string
  phone: string
  freeTrialUsed: boolean
  freeTrialConsumedAt: string | null
  supportConversationId: string | null
  supportStarted: boolean
  selectedPlanId: string | null
  selectedPlanName: string | null
  paymentStarted: boolean
  selectedPaymentMethod: string | null
  lastAppAccessAt: string | null
  lastRouteIntent: CustomerRouteIntent | null
}

interface CustomerStateStore {
  version: 1
  customers: Record<string, CustomerState>
}

const intents = new Set<CustomerRouteIntent>([
  "start_call",
  "customer_care",
  "whatsapp_support",
])

function emptyState(email: string): CustomerState {
  return {
    normalizedEmail: email,
    displayName: "",
    phone: "",
    freeTrialUsed: false,
    freeTrialConsumedAt: null,
    supportConversationId: null,
    supportStarted: false,
    selectedPlanId: null,
    selectedPlanName: null,
    paymentStarted: false,
    selectedPaymentMethod: null,
    lastAppAccessAt: null,
    lastRouteIntent: null,
  }
}

function validState(value: unknown, email: string): value is CustomerState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<CustomerState>
  return (
    state.normalizedEmail === email &&
    typeof state.freeTrialUsed === "boolean" &&
    typeof state.supportStarted === "boolean" &&
    typeof state.paymentStarted === "boolean" &&
    (state.lastRouteIntent === null ||
      intents.has(state.lastRouteIntent as CustomerRouteIntent))
  )
}

function readStore(): CustomerStateStore {
  if (typeof localStorage === "undefined") return { version: 1, customers: {} }
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(CUSTOMER_STATE_KEY) ?? "null",
    )
    if (!parsed || typeof parsed !== "object")
      return { version: 1, customers: {} }
    const store = parsed as Partial<CustomerStateStore>
    return store.version === 1 &&
      store.customers &&
      typeof store.customers === "object"
      ? { version: 1, customers: store.customers }
      : { version: 1, customers: {} }
  } catch {
    return { version: 1, customers: {} }
  }
}

function writeStore(store: CustomerStateStore): void {
  try {
    localStorage.setItem(CUSTOMER_STATE_KEY, JSON.stringify(store))
  } catch {
    /* Cloud remains authoritative. */
  }
}

export function customerStateDiagnostic(
  event: "LOCAL_CUSTOMER_STATE_FOUND" | "LOCAL_CUSTOMER_STATE_MISSING" | "LOCAL_TRIAL_CONSUMED" | "CLOUD_TRIAL_CHECK" | "LOCAL_STATE_RECONCILED" | "REPEAT_FREE_CALL_BLOCKED" | "RETURNING_PAYMENT_CHAT_FOUND" | "RETURNING_USER_ROUTED_TO_PLANS" | "RETURNING_USER_ROUTED_TO_CHAT",
): void {
  productionDiagnostic(event)
}

export function readCustomerState(email: string): CustomerState | null {
  const normalizedEmail = normalizeCustomerEmail(email)
  if (!normalizedEmail) return null
  const stored = readStore().customers[normalizedEmail]
  if (!validState(stored, normalizedEmail)) {
    customerStateDiagnostic("LOCAL_CUSTOMER_STATE_MISSING")
    return null
  }
  customerStateDiagnostic("LOCAL_CUSTOMER_STATE_FOUND")
  return stored
}

export function updateCustomerState(
  email: string,
  patch: Partial<Omit<CustomerState, "normalizedEmail">>,
): CustomerState | null {
  const normalizedEmail = normalizeCustomerEmail(email)
  if (!normalizedEmail) return null
  const store = readStore()
  const current = validState(store.customers[normalizedEmail], normalizedEmail)
    ? store.customers[normalizedEmail]
    : emptyState(normalizedEmail)
  const next = { ...current, ...patch, normalizedEmail }
  store.customers[normalizedEmail] = next
  writeStore(store)
  return next
}

export function markCustomerTrialConsumed(
  email: string,
  consumedAt: string | null,
): CustomerState | null {
  const state = updateCustomerState(email, {
    freeTrialUsed: true,
    freeTrialConsumedAt: consumedAt ?? new Date().toISOString(),
  })
  if (state) customerStateDiagnostic("LOCAL_TRIAL_CONSUMED")
  return state
}

export function noteRecognizedCustomerAccess(
  email: string,
  intent: CustomerRouteIntent,
): CustomerState | null {
  return updateCustomerState(email, {
    lastAppAccessAt: new Date().toISOString(),
    lastRouteIntent: intent,
  })
}
