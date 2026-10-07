import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { CallaStarLogo } from "@/components/branding/CallaStarLogo"

import { Button } from "@/components/ui/Button"

import { Icon } from "@/components/ui/Icon"

import type {
  SubscriptionPlan,
  SupportChannel,
} from "@/services/subscriptions/types"

import type { HostPreview } from "@/types/host"

import type { CallAccessGate } from "../hooks/useCallAccessGate"
import { formatMinorUnits } from "@/services/subscriptions/money"

interface AccessScreenProps {
  gate: CallAccessGate

  host: HostPreview

  onOpenSupportChat: () => void

  onStartNewCall: () => void

  onGoHome: () => void
  onChooseChannel: (channel: SupportChannel) => void
  welcomeBackName?: string
}

/**
 * A card on the post-call canvas.
 *
 * The backdrop is a still gradient, not a paused video and not a MediaStream:
 * by the time anything here is on screen the call has ended and every track has
 * been stopped, so there is no camera behind this — only visual continuity with
 * the call that just finished.
 */

function Panel({
  children,

  labelledBy,

  wide = false,

  compact = false,

  /** The plans need room for three cards abreast once there is a desktop. */

  /**
   * Payment is a short decision between two options. On a desktop it lays them
   * side by side and stays shallow, so the Continue button is on screen without
   * anyone having to scroll for it.
   */
}: {
  children: React.ReactNode

  labelledBy: string

  wide?: boolean

  compact?: boolean
}) {
  return (
    <main
      className={`access-screen ${wide ? "access-screen-plans" : ""} ${
        compact ? "access-screen-payment" : ""
      }`.trim()}
    >
      <div className="access-screen-brand">
        <CallaStarLogo inverse />
      </div>
      <section
        className={`cs-sheet access-panel ${wide ? "access-panel-wide" : ""} ${
          compact ? "access-panel-compact" : ""
        }`.trim()}
        aria-labelledby={labelledBy}
      >
        {children}
      </section>
    </main>
  )
}

/**
 * Access after a call has ended for want of a subscription.
 *
 * The call this follows is final. Nothing here can bring it back: the actions
 * lead to a plan, to support, and then to a NEW call with its own id, media and
 * history record.
 */

export function SubscriptionAccessScreen({
  gate,

  host,

  onOpenSupportChat,

  onStartNewCall,

  onGoHome,

  onChooseChannel,
  welcomeBackName,
}: AccessScreenProps) {
  const { t } = useTranslation()

  // No channel state: each channel is its own action now, so the choice and the

  // commitment are the same tap and there is nothing to hold in between.

  const remainingReturnHome = t("common.returnHome")

  const whatsappReady =
    gate.whatsappNumber !== null && gate.whatsappNumber.length > 0

  if (gate.status === "required") {
    return (
      <Panel labelledBy="access-required-title">
        <span className="access-panel-icon" aria-hidden="true">
          <Icon name="crown" className="size-8" />
        </span>
        <h1
          className="sheet-title sheet-title-centered"
          id="access-required-title"
        >
          {t("access.requiredTitle")}
        </h1>
        <p className="sheet-copy sheet-copy-centered">
          {t("access.requiredCopy", { host: host.displayName })}
        </p>
        <p className="sheet-note sheet-copy-centered">
          {t("access.requiredNote", { host: host.displayName })}
        </p>
        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          {t("call.devicesReleased")}
        </div>
        <div className="sheet-actions">
          <Button onClick={gate.openPlans}>
            {t("access.continueToPlans")}
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {t("common.returnHome")}
          </Button>
        </div>
      </Panel>
    )
  }

  if (gate.status === "selecting_plan") {
    return (
      <PlanSelector
        gate={gate}
        host={host}
        welcomeBackName={welcomeBackName}
        onGoHome={onGoHome}
        t={t}
      />
    )
  }

  if (gate.status === "payment_method" && gate.selectedPlan) {
    const plan = gate.selectedPlan

    return (
      <Panel labelledBy="access-payment-title" compact>
        <div className="payment-overview">
          <h1 className="sheet-title" id="access-payment-title">
            {t("access.paymentTitle")}
          </h1>

          <div className="plan-summary">
            <span className="plan-summary-icon">
              <Icon name="crown" className="size-7" />
            </span>
            <span className="plan-summary-text">
              <strong>{plan.displayName}</strong>
              <span>
                Continue your video and audio calls with your favourite
                creators.
              </span>
            </span>
            <span className="plan-summary-price">
              {formatMinorUnits(plan.priceMinorUnits, plan.currencyCode)}
            </span>
          </div>

          <p className="sheet-copy">{t("access.paymentCopy")}</p>
        </div>

        {/*
          Two direct actions, not a choice followed by a confirmation.

          This was a radiogroup plus a Continue button: pick a channel, then
          press Continue — two taps for one decision, and the button was the part
          that drifted below the fold on a short phone. Each channel is now its
          own action, so the decision and the commitment are the same tap and
          there is nothing left that has to stay reachable underneath.
        */}
        <div className="payment-methods">
          <div className="pay-actions">
            <button
              type="button"
              // No number configured means no working destination, so the action
              // says so plainly rather than offering a link that goes nowhere.
              disabled={!whatsappReady}
              className="pay-action pay-action-whatsapp"
              onClick={() => onChooseChannel("whatsapp")}
            >
              <span className="pay-icon pay-icon-whatsapp">
                <Icon name="whatsapp" className="size-7" />
              </span>
              <span className="pay-action-text">
                <strong>{t("access.whatsapp")}</strong>
                <span>
                  {whatsappReady
                    ? t("access.whatsappCopy")
                    : t("access.whatsappUnavailable")}
                </span>
              </span>
              <Icon name="arrow" className="size-5 pay-action-arrow" />
            </button>

            <button
              type="button"
              className="pay-action pay-action-chat"
              onClick={() => onChooseChannel("in_app")}
            >
              <span className="pay-icon pay-icon-chat">
                <Icon name="chat" className="size-7" />
              </span>
              <span className="pay-action-text">
                <strong>{t("access.inApp")}</strong>
                <span>{t("access.inAppCopy")}</span>
              </span>
              <Icon name="arrow" className="size-5 pay-action-arrow" />
            </button>
          </div>

          <p className="sheet-security">
            <Icon name="shield" className="size-5" />
            {t("access.securityNote")}
          </p>

          <div className="sheet-actions">
            <button
              type="button"
              className="join-text-action"
              onClick={gate.backToPlans}
            >
              {t("access.backToPlans")}
            </button>
          </div>
        </div>
      </Panel>
    )
  }

  if (gate.status === "payment_pending") {
    return (
      <Panel labelledBy="access-pending-title">
        <span
          className="access-panel-icon access-panel-icon-wait"
          aria-hidden="true"
        >
          <Icon name="clock" className="size-8" />
        </span>
        <h1
          className="sheet-title sheet-title-centered"
          id="access-pending-title"
        >
          {t("access.pendingTitle")}
        </h1>
        <p className="sheet-copy sheet-copy-centered">
          {t("access.pendingCopy")}
        </p>
        {gate.request && (
          <p className="sheet-reference">
            {t("access.reference")} <strong>{gate.request.reference}</strong>
          </p>
        )}
        <div className="sheet-actions">
          <Button withArrow={false} onClick={onOpenSupportChat}>
            {t("access.openSupport")}
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {remainingReturnHome}
          </Button>
        </div>
      </Panel>
    )
  }

  if (gate.status === "confirmed") {
    return (
      <Panel labelledBy="access-confirmed-title">
        <span
          className="access-panel-icon access-panel-icon-done"
          aria-hidden="true"
        >
          <Icon name="check" className="size-8" />
        </span>
        <h1
          className="sheet-title sheet-title-centered"
          id="access-confirmed-title"
        >
          {t("access.confirmedTitle")}
        </h1>
        <p className="sheet-copy sheet-copy-centered">
          {t("access.confirmedCopy")}
        </p>
        <div className="sheet-actions">
          <Button withArrow={false} onClick={onStartNewCall}>
            {t("access.startNewCall")}
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {remainingReturnHome}
          </Button>
        </div>
      </Panel>
    )
  }

  return null
}

export function PlanSelector({
  gate,
  host,
  welcomeBackName,
  onGoHome,
  t,
}: {
  gate: CallAccessGate
  host: HostPreview
  welcomeBackName?: string
  onGoHome: () => void
  t: (key: string, options?: Record<string, string>) => string
}) {
  const plans = useMemo(() => {
    const sorted = [...gate.plans]
      .filter((plan) => plan.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const tiers =
      sorted.length > 1 ? [sorted[0], sorted[sorted.length - 1]] : sorted
    return tiers.map((plan, index) => ({
      ...plan,
      displayName:
        tiers.length === 1 ? plan.displayName : index === 0 ? "Plus" : "Pro",
      isMostPopular: tiers.length === 1 ? plan.isMostPopular : index === 0,
    }))
  }, [gate.plans])
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [heroImage, setHeroImage] = useState(
    host.coverUrl || host.avatarUrl || "",
  )
  const [coverFailed, setCoverFailed] = useState(false)
  const { selectedPlan, plusPlan } = useMemo(
    () => ({
      selectedPlan:
        plans.find((plan) => plan.id === selectedPlanId) ?? plans[0] ?? null,
      plusPlan: plans[0] ?? null,
    }),
    [plans, selectedPlanId],
  )

  useEffect(() => {
    setSelectedPlanId(plans[0]?.id ?? null)
  }, [plans])

  useEffect(() => {
    setHeroImage(host.coverUrl || host.avatarUrl || "")
    setCoverFailed(false)
  }, [host.avatarUrl, host.coverUrl, host.id])

  const handleHeroImageError = () => {
    if (
      !coverFailed &&
      host.coverUrl &&
      heroImage === host.coverUrl &&
      host.avatarUrl
    ) {
      setCoverFailed(true)
      setHeroImage(host.avatarUrl)
      return
    }
    setHeroImage("")
  }

  return (
    <main className="access-screen access-screen-plan-selector">
      <section
        className="plan-selector-hero"
        aria-labelledby="access-plans-title"
      >
        {heroImage && (
          <img
            className="plan-selector-cover"
            src={heroImage}
            alt=""
            aria-hidden="true"
            onError={handleHeroImageError}
          />
        )}
        <div className="plan-selector-hero-wash" aria-hidden="true" />
        <button
          type="button"
          className="plan-selector-back"
          onClick={onGoHome}
          aria-label={t("common.returnHome")}
        >
          <Icon name="chevron" className="size-5" />
        </button>
        <div className="plan-selector-intro">
          <span className="plan-selector-eyebrow">
            {t("access.selectorEyebrow")}
          </span>
          <h1 id="access-plans-title">
            {t("access.selectorTitle", { host: host.displayName })}
          </h1>
          <p>{t("access.selectorCopy")}</p>
          {welcomeBackName?.trim() && (
            <p className="plan-selector-welcome">
              {t("access.welcomeBack", { name: welcomeBackName.trim() })}
            </p>
          )}
        </div>
      </section>

      <div className="plan-selector-content">
        {gate.plansLoading ? (
          <div
            className="plan-selector-skeleton"
            aria-label={t("access.plansLoading")}
            aria-busy="true"
          >
            <span />
            <span />
          </div>
        ) : plans.length === 0 ? (
          <p className="plan-selector-unavailable" role="status">
            {t("access.plansUnavailable")}
          </p>
        ) : (
          <>
            <fieldset
              className={`plan-selector-options plan-selector-options-${plans.length}`}
              aria-label={t("access.selectorTitle", { host: host.displayName })}
            >
              {plans.map((plan) => {
                const isSelected = plan.id === selectedPlan?.id
                const isPlus = plan.id === plusPlan?.id
                return (
                  <label
                    key={plan.id}
                    className={`plan-selector-option ${
                      isSelected ? "is-selected" : ""
                    } ${isPlus ? "is-plus" : "is-pro"}`.trim()}
                  >
                    <input
                      type="radio"
                      name="callastar-subscription-plan"
                      value={plan.id}
                      checked={isSelected}
                      onChange={() => setSelectedPlanId(plan.id)}
                      aria-label={`${plan.displayName}, ${formatMinorUnits(plan.priceMinorUnits, plan.currencyCode)}`}
                    />
                    {isPlus && (
                      <span className="plan-selector-popular">
                        {t("access.mostPopular")}
                      </span>
                    )}
                    <span className="plan-selector-option-name">
                      {plan.displayName}
                    </span>
                    <strong className="plan-selector-option-price">
                      {formatMinorUnits(plan.priceMinorUnits, plan.currencyCode)}
                    </strong>
                    <span className="plan-selector-option-duration">
                      {t("access.sessionLength", {
                        minutes: String(plan.sessionDurationMinutes),
                      })}
                    </span>
                    <span className="plan-selector-radio" aria-hidden="true">
                      <i />
                    </span>
                  </label>
                )
              })}
            </fieldset>

            {selectedPlan && (
              <section
                className="plan-selector-benefits"
                aria-live="polite"
                aria-atomic="true"
              >
                <div className="plan-selector-benefits-heading">
                  <div>
                    <span>{t("access.selectorBenefitsEyebrow")}</span>
                    <h2>
                      {t("access.selectorBenefitsTitle", {
                        plan: selectedPlan.displayName,
                      })}
                    </h2>
                  </div>
                  <Icon name="star" className="size-5" />
                </div>
                {selectedPlan.id !== plusPlan?.id && (
                  <p className="plan-selector-includes">
                    {t("access.selectorIncludesPlus")}
                  </p>
                )}
                {selectedPlan.description && (
                  <p className="plan-selector-description">
                    {selectedPlan.description}
                  </p>
                )}
                <ul className="plan-selector-benefit-list">
                  {selectedPlan.features.map((feature) => (
                    <li key={feature}>
                      <span aria-hidden="true">
                        <Icon name="check" className="size-4" />
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="plan-selector-actions">
              <button
                type="button"
                className="plan-selector-continue"
                disabled={!selectedPlan}
                onClick={() => selectedPlan && gate.choosePlan(selectedPlan)}
              >
                <span>
                  {t("access.selectorContinue", {
                    plan: selectedPlan?.displayName ?? "",
                    price: selectedPlan
                      ? formatMinorUnits(selectedPlan.priceMinorUnits, selectedPlan.currencyCode)
                      : "",
                  })}
                </span>
                <Icon name="arrow" className="size-5" />
              </button>
              <p className="plan-selector-quality">{t("access.qualityNote")}</p>
            </div>
          </>
        )}
        {(gate.plansLoading || plans.length === 0) && (
          <p className="plan-selector-quality">{t("access.qualityNote")}</p>
        )}
      </div>
    </main>
  )
}

export default SubscriptionAccessScreen
