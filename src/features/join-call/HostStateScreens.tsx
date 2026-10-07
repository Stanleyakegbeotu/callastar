import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatCallId } from "@/lib/callId";
import { maskAccessId } from "@/services/access/accessCode";
import type { SubscriptionAccessId } from "@/services/access/types";
import type { SubscriptionPlan } from "@/services/subscriptions/types";
import type { HostPreview } from "@/types/host";

/**
 * The three places the join flow can stop before a call.
 *
 * All drawn from the same parts as the rest of the public app — host card,
 * display title, note panel, pill actions — because they are not error pages.
 * Two of them are ordinary outcomes: a host who is not online, and a caller who
 * has already had their preview.
 */

interface HostCardProps {
  host: HostPreview;
  callId?: string;
  tone: "available" | "inactive" | "access";
  label: string;
}

function HostCard({ host, callId, tone, label }: HostCardProps) {
  return (
    <div className={`host-card host-card-${tone}`}>
      <span className="host-card-avatar">
        <img src={host.avatarUrl} alt="" />
        <span className={`host-card-dot host-card-dot-${tone}`} aria-hidden="true" />
      </span>
      <span className="host-card-text">
        <strong className="host-card-name">{host.displayName}</strong>
        {callId && (
          <span className="host-card-callid">
            Call ID: <code>{formatCallId(callId)}</code>
          </span>
        )}
        <span className={`host-card-chip host-card-chip-${tone}`}>
          <span className="host-card-chip-dot" aria-hidden="true" />
          {label}
        </span>
      </span>
    </div>
  );
}

/**
 * The host is not taking calls.
 *
 * Deliberately not phrased as an error: nothing has gone wrong, the person on
 * the other end is simply not online. This is reached before any device is
 * requested, and a valid Subscription Access ID does not get past it either.
 */
export function ProfileInactiveScreen({
  host,
  onReturnHome,
  onEnterAnotherId,
}: {
  host: HostPreview;
  onReturnHome: () => void;
  onEnterAnotherId: () => void;
}) {
  const { t } = useTranslation();

  return (
    <main className="host-state">
      <div className="host-state-brand">
        <CallaStarLogo />
      </div>

      <HostCard host={host} tone="inactive" label={t("hostState.inactiveChip")} />

      <h1 className="cs-display">{t("hostState.inactiveTitle")}</h1>
      <p className="cs-lede">{t("hostState.inactiveCopy")}</p>

      <div className="cs-note">
        <span className="cs-note-icon">
          <Icon name="info" className="size-6" />
        </span>
        <span>
          <strong className="cs-note-title">{t("hostState.inactiveNoteTitle")}</strong>
          {t("hostState.inactiveNoteCopy")}
        </span>
      </div>

      <div className="host-state-actions">
        <Button onClick={onReturnHome}>{t("common.returnHome")}</Button>
        <Button variant="secondary" withArrow={false} onClick={onEnterAnotherId}>
          {t("hostState.enterAnotherId")}
        </Button>
      </div>
    </main>
  );
}

/**
 * This browser has already had its free preview for this host.
 *
 * Reached before permissions, so no camera is opened for a call that cannot
 * happen. The note says plainly what is remembered and where — a browser, not a
 * device, and certainly not a person.
 */
export function ReturningSubscriptionScreen({
  host,
  callId,
  callType,
  onContinueToPlans,
  onReturnHome,
}: {
  host: HostPreview;
  callId: string;
  callType: "video" | "audio";
  onContinueToPlans: () => void;
  onReturnHome: () => void;
}) {
  const { t } = useTranslation();

  return (
    <main className="host-state host-state-returning">
      <div className="host-state-brand">
        <CallaStarLogo />
      </div>

      <section className="returning-copy" aria-labelledby="returning-title">
        <div className="returning-host">
          <span className="returning-host-avatar">
            <img src={host.avatarUrl} alt="" />
            <span className="host-card-dot host-card-dot-available" aria-hidden="true" />
          </span>
          <span className="returning-host-details">
            <strong>{host.displayName}</strong>
            <span className="returning-host-status">
              <span className="host-card-chip-dot" aria-hidden="true" />
              {t("hostState.availableChip")}
            </span>
            <span className="host-card-callid">
              Call ID: <code>{formatCallId(callId)}</code>
            </span>
          </span>
        </div>

        <h1 className="cs-display" id="returning-title">
          {t("hostState.returningTitle", { host: host.displayName })}
        </h1>
        <p className="cs-lede">
          {callType === "audio"
            ? t("hostState.returningCopyAudio", { host: host.displayName })
            : t("hostState.returningCopyVideo", { host: host.displayName })}
        </p>

        <div className="returning-plan-note">
          <span className="returning-plan-note-icon" aria-hidden="true">
            <Icon name="video" className="size-6" />
          </span>
          <p>
            <strong>{t("hostState.returningNoteTitle")}</strong>
            {t("hostState.returningNoteCopy")}
          </p>
        </div>
      </section>

      <div className="returning-decision">
        <div className="host-state-actions">
          <Button onClick={onContinueToPlans}>{t("access.continueToPlans")}</Button>
          <Button variant="secondary" withArrow={false} onClick={onReturnHome}>
            {t("common.returnHome")}
          </Button>
        </div>

        {/* This remembers a browser preview, not a device or a person. */}
        <div className="host-state-footnote returning-footnote">
          <span className="host-state-footnote-icon">
            <Icon name="info" className="size-5" />
          </span>
          <span>
            <strong>{t("hostState.previewUsedTitle")}</strong>
            {t("hostState.previewUsedCopy", { host: host.displayName })}
            <small>{t("hostState.noAccountRequired")}</small>
          </span>
        </div>
      </div>
    </main>
  );
}

/**
 * A valid Subscription Access ID.
 *
 * Everything shown comes from the stored plan, so an admin editing the global
 * plan changes what this promises. The credential is shown masked — the app
 * never held the plaintext beyond resolving it.
 */
export function WelcomeBackScreen({
  host,
  access,
  plan,
  onStartNewCall,
  onReturnHome,
}: {
  host: HostPreview;
  access: SubscriptionAccessId;
  plan: SubscriptionPlan;
  onStartNewCall: () => void;
  onReturnHome: () => void;
}) {
  const { t } = useTranslation();

  return (
    <main className="host-state host-state-welcome">
      <div className="host-state-brand host-state-brand-left">
        <CallaStarLogo />
      </div>

      <span className="welcome-chip">
        <span className="welcome-chip-icon" aria-hidden="true">
          <Icon name="check" className="size-4" />
        </span>
        {t("welcome.chip")}
      </span>

      <h1 className="welcome-title">{t("welcome.title")}</h1>
      <p className="cs-lede welcome-lede">
        {t("welcome.subtitle", { plan: plan.displayName, host: host.displayName })}
      </p>

      <div className="host-card host-card-access">
        <span className="host-card-avatar host-card-avatar-square">
          <img src={host.avatarUrl} alt="" />
        </span>
        <span className="host-card-text">
          <strong className="host-card-name">{host.displayName}</strong>
          <span className="host-card-role">{t("welcome.hostRole")}</span>
          <span className="host-card-chip host-card-chip-available">
            <span className="host-card-chip-dot" aria-hidden="true" />
            {t("welcome.accessActive")}
          </span>
        </span>
      </div>

      <section className="welcome-plan">
        <div className="welcome-plan-head">
          <h2>{plan.displayName}</h2>
          <span className="welcome-plan-id">
            <small>{t("welcome.subscriptionId")}</small>
            {/* Masked: only the last four were ever stored. */}
            <code>{maskAccessId(access.codeLast4)}</code>
          </span>
        </div>
        <ul className="welcome-plan-features">
          {plan.features.map((feature) => (
            <li key={feature}>
              <span className="welcome-plan-check" aria-hidden="true">
                <Icon name="check" className="size-4" />
              </span>
              {feature}
            </li>
          ))}
        </ul>
      </section>

      <p className="welcome-ready">{t("welcome.ready")}</p>

      <div className="host-state-actions">
        <Button onClick={onStartNewCall}>{t("access.startNewCall")}</Button>
        <Button variant="secondary" withArrow={false} onClick={onReturnHome}>
          {t("common.returnHome")}
        </Button>
      </div>
    </main>
  );
}
