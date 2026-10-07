import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"

import { SubscriptionAccessScreen } from "@/features/call-session/subscription/SubscriptionAccessScreen"
import { DEFAULT_PLANS } from "@/services/subscriptions/defaultPlans"
import type { SubscriptionPlan } from "@/services/subscriptions/types"
import type {
  CallAccessGate,
  CallAccessStatus,
} from "@/features/call-session/hooks/useCallAccessGate"
import type { HostPreview } from "@/types/host"
import { initI18n } from "@/i18n"
import "@/styles/globals.css"

const timestamp = "2026-01-01T00:00:00.000Z"
const plans: SubscriptionPlan[] = DEFAULT_PLANS.map((plan) => ({
  ...plan,
  createdAt: timestamp,
  updatedAt: timestamp,
}))
const coverUrl = "/media/onboarding/girl-wallpaper.jpg"
const host: HostPreview = {
  id: "selector-fixture-host",
  displayName: "Amara Vale",
  shortName: "Amara",
  avatarUrl:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PC9zdmc+",
  coverUrl,
}

function SelectorFixture() {
  const [status, setStatus] = useState<CallAccessStatus>("selecting_plan")
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(
    null,
  )
  const gate: CallAccessGate = {
    status,
    blocksCall: true,
    selectedPlan,
    request: null,
    plans,
    plansLoading: false,
    whatsappNumber: null,
    openPlans: () => setStatus("selecting_plan"),
    choosePlan: (plan) => {
      setSelectedPlan(plan)
      setStatus("payment_method")
    },
    backToPlans: () => setStatus("selecting_plan"),
    startPayment: async () => null,
    finishPreview: () => undefined,
    whatsappLinkFor: () => null,
  }

  return (
    <SubscriptionAccessScreen
      gate={gate}
      host={host}
      onOpenSupportChat={() => undefined}
      onStartNewCall={() => undefined}
      onGoHome={() => undefined}
      onChooseChannel={() => undefined}
    />
  )
}

initI18n()
createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <SelectorFixture />
  </MemoryRouter>,
)
