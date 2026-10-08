import { describe, expect, it } from "vitest"
import { decideCustomerCallAccess } from "./callBackendEligibility"
import type { CallEligibility } from "./callBackend"

const cloud = (overrides: Partial<CallEligibility> = {}): CallEligibility => ({
  trialState: "available",
  consumedAt: null,
  paidAccessAvailable: false,
  supportConversationId: null,
  ...overrides,
})

describe("customer call eligibility", () => {
  it("requires the cloud to allow a free call when the local state is empty", () => {
    expect(decideCustomerCallAccess(false, cloud())).toBe("allow_free_trial")
  })

  it("routes consumed local state even when cloud says available", () => {
    expect(decideCustomerCallAccess(true, cloud())).toBe("route_returning")
  })

  it("reconciles empty or false local state when cloud says consumed", () => {
    expect(
      decideCustomerCallAccess(false, cloud({ trialState: "consumed" })),
    ).toBe("route_returning")
  })

  it("allows a paid grant even when free trial state is consumed", () => {
    expect(
      decideCustomerCallAccess(
        true,
        cloud({ trialState: "consumed", paidAccessAvailable: true }),
      ),
    ).toBe("allow_paid_call")
  })

  it("does not start a second call while a trial reservation is active", () => {
    expect(
      decideCustomerCallAccess(false, cloud({ trialState: "reserved" })),
    ).toBe("in_progress")
  })
})
