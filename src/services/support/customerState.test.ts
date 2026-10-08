import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CUSTOMER_STATE_KEY,
  markCustomerTrialConsumed,
  readCustomerState,
  updateCustomerState,
} from "./customerState"

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
})

describe("versioned customer state mirror", () => {
  it("keeps trial status isolated by normalized email in one versioned record", () => {
    markCustomerTrialConsumed(" User1@Example.com ", "2026-10-08T00:00:00.000Z")
    updateCustomerState("USER2@example.com", { displayName: "User Two" })

    expect(readCustomerState("user1@example.com")?.freeTrialUsed).toBe(true)
    expect(readCustomerState(" user2@example.com ")?.freeTrialUsed).toBe(false)
    expect(readCustomerState("user2@example.com")?.displayName).toBe("User Two")
    const stored = JSON.parse(localStorage.getItem(CUSTOMER_STATE_KEY) ?? "{}")
    expect(stored.version).toBe(1)
    expect(Object.keys(stored.customers)).toEqual([
      "user1@example.com",
      "user2@example.com",
    ])
  })

  it("ignores malformed storage without throwing", () => {
    localStorage.setItem(CUSTOMER_STATE_KEY, "{")
    expect(() => readCustomerState("user@example.com")).not.toThrow()
    expect(readCustomerState("user@example.com")).toBeNull()
  })

  it("records consumption only when the caller marks the backend transition complete", () => {
    const state = markCustomerTrialConsumed(
      "user@example.com",
      "2026-10-08T01:00:00.000Z",
    )
    expect(state?.freeTrialUsed).toBe(true)
    expect(state?.freeTrialConsumedAt).toBe("2026-10-08T01:00:00.000Z")
  })
})
