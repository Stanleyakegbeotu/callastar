import type { CallEligibility } from "./callBackend"

export type CustomerCallDecision = "allow_free_trial" | "allow_paid_call" | "route_returning" | "in_progress"

/** A missing/available local mirror never grants access; cloud eligibility does. */
export function decideCustomerCallAccess(
  localTrialUsed: boolean,
  cloud: CallEligibility,
): CustomerCallDecision {
  if (localTrialUsed && !cloud.paidAccessAvailable) return "route_returning"
  if (cloud.trialState === "consumed" && !cloud.paidAccessAvailable)
    return "route_returning"
  if (cloud.trialState === "reserved") return "in_progress"
  if (cloud.paidAccessAvailable) return "allow_paid_call"
  return "allow_free_trial"
}
