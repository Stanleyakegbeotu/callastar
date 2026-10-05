import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { SubscriptionPlan, SupportChannel } from "@/services/subscriptions/types";
import type { HostPreview } from "@/types/host";

import type { CallAccessGate } from "../hooks/useCallAccessGate";

interface AccessScreenProps {
  gate: CallAccessGate;
  host: HostPreview;
  onOpenSupportChat: () => void;
  onStartNewCall: () => void;
  onGoHome: () => void;
  onChooseChannel: (channel: SupportChannel) => void;
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
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
}: {
  children: React.ReactNode;
  labelledBy: string;
  /** The plans need room for three cards abreast once there is a desktop. */
  wide?: boolean;
  /**
   * Payment is a short decision between two options. On a desktop it lays them
   * side by side and stays shallow, so the Continue button is on screen without
   * anyone having to scroll for it.
   */
  compact?: boolean;
}) {
  return (
    <main className={`access-screen ${wide ? "access-screen-plans" : ""}`.trim()}>
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
  );
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
}: AccessScreenProps) {
  const { t } = useTranslation();
  // No channel state: each channel is its own action now, so the choice and the
  // commitment are the same tap and there is nothing to hold in between.
  const remainingReturnHome = t("common.returnHome");
  const whatsappReady = gate.whatsappNumber !== null && gate.whatsappNumber.length > 0;

  if (gate.status === "required") {
    return (
      <Panel labelledBy="access-required-title">
        <span className="access-panel-icon" aria-hidden="true">
          <Icon name="crown" className="size-8" />
        </span>
        <h1 className="sheet-title sheet-title-centered" id="access-required-title">
          {t("access.requiredTitle")}
        </h1>
        <p className="sheet-copy sheet-copy-centered">
          {t("access.requiredCopy", { host: host.displayName })}
        </p>
        <p className="sheet-note sheet-copy-centered">
          {t("access.requiredNote")}
        </p>
        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          {t("call.devicesReleased")}
        </div>
        <div className="sheet-actions">
          <Button onClick={gate.openPlans}>{t("access.continueToPlans")}</Button>
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {t("common.returnHome")}
          </Button>
        </div>
      </Panel>
    );
  }

  if (gate.status === "selecting_plan") {
    return (
      <Panel labelledBy="access-plans-title" wide>
        <div className="plan-screen-heading">
          <span className="plan-screen-eyebrow">CallaStar Access</span>
          <h1 className="sheet-title" id="access-plans-title">
            {t("access.plansTitle")}
          </h1>
          <p className="sheet-copy">{t("access.plansCopy")}</p>
        </div>

        {gate.plansLoading ? (
          <p className="sheet-note">{t("common.loading")}</p>
        ) : (
          <ul className="plan-list">
            {gate.plans.map((plan, index) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                index={index}
                total={gate.plans.length}
                onChoose={() => gate.choosePlan(plan)}
                t={t}
              />
            ))}
          </ul>
        )}

        <div className="cs-note plan-quality-note">
          <span className="cs-note-icon">
            <Icon name="info" className="size-6" />
          </span>
          <span>{t("access.qualityNote")}</span>
        </div>

        <button type="button" className="join-text-action" onClick={onGoHome}>
          {t("common.returnHome")}
        </button>
      </Panel>
    );
  }

  if (gate.status === "payment_method" && gate.selectedPlan) {
    const plan = gate.selectedPlan;
    return (
      <Panel labelledBy="access-payment-title" compact>
        <h1 className="sheet-title" id="access-payment-title">
          {t("access.paymentTitle")}
        </h1>

        <div className="plan-summary">
          <span className="plan-summary-icon">
            <Icon name="crown" className="size-7" />
          </span>
          <span className="plan-summary-text">
            <strong>{plan.displayName}</strong>
            <span>Continue your video and audio calls with your favourite creators.</span>
          </span>
          <span className="plan-summary-price">{formatUsd(plan.priceUsdCents)}</span>
        </div>

        <p className="sheet-copy">
          {t("access.paymentCopy")}
        </p>

        {/*
          Two direct actions, not a choice followed by a confirmation.

          This was a radiogroup plus a Continue button: pick a channel, then
          press Continue — two taps for one decision, and the button was the part
          that drifted below the fold on a short phone. Each channel is now its
          own action, so the decision and the commitment are the same tap and
          there is nothing left that has to stay reachable underneath.
        */}
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
              <span>{whatsappReady ? t("access.whatsappCopy") : t("access.whatsappUnavailable")}</span>
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
          <button type="button" className="join-text-action" onClick={gate.backToPlans}>
            {t("access.backToPlans")}
          </button>
        </div>
      </Panel>
    );
  }

  if (gate.status === "payment_pending") {
    return (
      <Panel labelledBy="access-pending-title">
        <span className="access-panel-icon access-panel-icon-wait" aria-hidden="true">
          <Icon name="clock" className="size-8" />
        </span>
        <h1 className="sheet-title sheet-title-centered" id="access-pending-title">
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
    );
  }

  if (gate.status === "confirmed") {
    return (
      <Panel labelledBy="access-confirmed-title">
        <span className="access-panel-icon access-panel-icon-done" aria-hidden="true">
          <Icon name="check" className="size-8" />
        </span>
        <h1 className="sheet-title sheet-title-centered" id="access-confirmed-title">
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
    );
  }

  return null;
}

function PlanCard({
  plan,
  index,
  total,
  onChoose,
  t,
}: {
  plan: SubscriptionPlan;
  index: number;
  total: number;
  onChoose: () => void;
  t: (key: string, options?: Record<string, string>) => string;
}) {
  return (
    <li
      className={`plan-card plan-card-${plan.id} ${plan.isMostPopular ? "plan-card-popular" : ""}`.trim()}
    >
      <div className="plan-card-head">
        <div className="plan-card-heading">
          <span className="plan-card-index" aria-hidden="true">
            {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
          <h2 className="plan-card-name">{plan.displayName}</h2>
          <p className="plan-card-description">{plan.description}</p>
        </div>
        <span className="plan-card-price">
          {formatUsd(plan.priceUsdCents)} <small>USD</small>
        </span>
      </div>

      {plan.isMostPopular && (
        <span className="plan-badge">
          <Icon name="star" className="size-4" />
          {t("access.mostPopular")}
        </span>
      )}

      <p className="plan-card-duration">
        <Icon name="clock" className="size-4" />
        {t("access.sessionLength", { minutes: String(plan.sessionDurationMinutes) })}
      </p>

      <div className="plan-card-body">
        <ul className="plan-features">
          {plan.features.map((feature) => (
            <li key={feature}>
              <span className="plan-check" aria-hidden="true">
                <Icon name="check" className="size-4" />
              </span>
              {feature}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`plan-choose ${plan.isMostPopular ? "plan-choose-primary" : ""}`.trim()}
          onClick={onChoose}
        >
          {t("access.choose", { plan: plan.displayName.split(" ")[0] })}
          <Icon name="arrow" className="size-4" />
        </button>
      </div>
    </li>
  );
}

export default SubscriptionAccessScreen;
