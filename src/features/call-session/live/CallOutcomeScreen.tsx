import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { formatDuration, getInitials } from "@/lib/utils";
import type { CallFailureReason } from "@/types/call";
import type { HostPreview } from "@/types/host";

/**
 * Every way a call can finish without having simply been hung up well.
 *
 * One screen rather than eight, because they differ only in three strings and an
 * icon tone — but they are genuinely different outcomes, so the copy is chosen
 * from the classified reason rather than from a generic "something went wrong".
 * A caller told "Connection lost" when the host declined would have been lied to.
 */
export type CallOutcome =
  | { kind: "ended"; endedByHost: boolean; durationSeconds: number | null }
  | { kind: "declined" }
  | { kind: "no_answer" }
  | { kind: "failure"; reason: CallFailureReason; message: string | null };

interface CallOutcomeScreenProps {
  host: HostPreview;
  outcome: CallOutcome;
  /** Starts a brand-new attempt with a new id — never resumes this one. */
  onCallAgain: () => void;
  onGoHome: () => void;
}

interface Presentation {
  icon: IconName;
  tone: "neutral" | "warning" | "danger";
  title: string;
  copy: string;
  /** Some outcomes are not worth offering a retry for. */
  allowRetry: boolean;
}

export function CallOutcomeScreen({ host, outcome, onCallAgain, onGoHome }: CallOutcomeScreenProps) {
  const { t } = useTranslation();
  const name = host.shortName || host.displayName;

  const present = (): Presentation => {
    switch (outcome.kind) {
      case "declined":
        // Not a fault, so not red. The host made a choice.
        return {
          icon: "phoneOff",
          tone: "warning",
          title: t("liveCall.declinedTitle"),
          copy: t("liveCall.declinedCopy", { name }),
          allowRetry: true,
        };

      case "no_answer":
        return {
          icon: "clock",
          tone: "warning",
          title: t("liveCall.noAnswerTitle"),
          copy: t("liveCall.noAnswerCopy", { name }),
          allowRetry: true,
        };

      case "ended":
        return {
          icon: "check",
          tone: "neutral",
          title: t("liveCall.endedTitle"),
          copy: outcome.endedByHost ? t("liveCall.endedByHost", { name }) : t("call.devicesReleased"),
          allowRetry: true,
        };

      case "failure":
        switch (outcome.reason) {
          case "host_offline":
            return {
              icon: "info",
              tone: "warning",
              title: t("liveCall.offlineTitle"),
              copy: t("liveCall.offlineCopy", { name }),
              allowRetry: true,
            };
          case "host_busy":
            return {
              icon: "phone",
              tone: "warning",
              title: t("liveCall.busyTitle"),
              copy: t("liveCall.busyCopy", { name }),
              allowRetry: true,
            };
          case "rtc_connection_lost":
            return {
              icon: "bolt",
              tone: "danger",
              title: t("liveCall.lostTitle"),
              copy: t("liveCall.lostCopy"),
              allowRetry: true,
            };
          case "signaling_unavailable":
            return {
              icon: "globe",
              tone: "danger",
              title: t("liveCall.unreachableTitle"),
              copy: t("liveCall.unreachableCopy"),
              allowRetry: true,
            };
          // A source that cannot be delivered and a negotiation that failed both
          // read as "we could not connect this". Neither is the caller's doing,
          // and neither is a network fault worth naming as one.
          default:
            return {
              icon: "info",
              tone: "danger",
              title: t("liveCall.unableTitle"),
              copy: outcome.message ?? t("liveCall.unableCopy"),
              allowRetry: true,
            };
        }
    }
  };

  const view = present();
  const duration = outcome.kind === "ended" ? outcome.durationSeconds : null;

  return (
    <div className="page-shell outcome-page">
      <main className="call-outcome" aria-labelledby="outcome-title">
        <div className="call-outcome-brand">
          <CallaStarLogo />
        </div>

        <span className={`call-outcome-icon is-${view.tone}`} aria-hidden="true">
          <Icon name={view.icon} className="size-8" />
        </span>

        <h1 id="outcome-title" className="cs-display call-outcome-title">
          {view.title}
        </h1>
        <p className="cs-lede">{view.copy}</p>

        <div className="call-outcome-host">
          <span className="call-outcome-avatar">
            {host.avatarUrl ? <img src={host.avatarUrl} alt="" /> : getInitials(host.displayName)}
          </span>
          <span className="call-outcome-host-text">
            <strong>{host.displayName}</strong>
            {duration !== null && <span>{formatDuration(duration)}</span>}
          </span>
        </div>

        <div className="call-outcome-actions">
          {view.allowRetry && (
            <Button onClick={onCallAgain} withArrow={false}>
              {t("liveCall.callAgain")}
            </Button>
          )}
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {t("common.returnHome")}
          </Button>
        </div>
      </main>
    </div>
  );
}

export default CallOutcomeScreen;
