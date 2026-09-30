import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatDuration } from "@/lib/utils";
import type { HostPreview } from "@/types/host";

interface SessionCompletePageProps {
  host: HostPreview;
  planName: string;
  durationSeconds: number | null;
  onStartAnother: () => void;
  onGoHome: () => void;
}

/**
 * A paid session that ran its full length.
 *
 * Distinct from "Call ended" on purpose: nothing went wrong and nobody hung up
 * — the plan's time was used. Saying so plainly is the difference between a
 * product that finished and one that seems to have dropped the call.
 */
export function SessionCompletePage({
  host,
  planName,
  durationSeconds,
  onStartAnother,
  onGoHome,
}: SessionCompletePageProps) {
  const { t } = useTranslation();

  return (
    <main className="status-screen">
      <div className="status-brand">
        <CallaStarLogo />
      </div>
      <div className="status-content">
        <Avatar src={host.avatarUrl} alt="" />
        <h1 className="status-title" role="status">
          {t("sessionLimit.completeTitle")}
        </h1>
        <p className="status-copy">{t("sessionLimit.completeCopy", { plan: planName })}</p>

        {durationSeconds !== null && (
          <p className="call-ended-duration">
            <span className="admin-visually-hidden">Call duration </span>
            {formatDuration(durationSeconds)}
          </p>
        )}

        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          {t("call.devicesReleased")}
        </div>

        <div className="status-actions">
          <Button onClick={onStartAnother} withArrow={false}>
            {t("sessionLimit.startAnother")}
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onGoHome}>
            {t("common.returnHome")}
          </Button>
        </div>
      </div>
    </main>
  );
}

export default SessionCompletePage;
