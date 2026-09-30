import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import type { CallType } from "@/types/call";

interface CallPermissionScreenProps {
  callType: CallType;
  /** True once the browser prompt is actually open. */
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Asks before the browser asks.
 *
 * The browser's own permission dialog gives no context — it names a domain and a
 * device. This screen is what makes it make sense, and it is why `getUserMedia`
 * is never called on route mount: a prompt nobody expected is a prompt people
 * dismiss.
 *
 * It appears only after the Call ID resolved, the profile was Active and the host
 * was available. Asking for a camera for a call that cannot happen wastes a
 * decision on nothing.
 */
export function CallPermissionScreen({ callType, busy, onContinue, onCancel }: CallPermissionScreenProps) {
  const { t } = useTranslation();
  const isVideo = callType === "video";

  return (
    <div className="page-shell permission-page">
      <main className="permission-pre" aria-labelledby="permission-title">
        <div className="permission-brand">
          <CallaStarLogo />
        </div>

        <span className="permission-art" aria-hidden="true">
          <Icon name={isVideo ? "camera" : "mic"} className="size-9" />
        </span>

        <h1 id="permission-title" className="cs-display permission-title">
          {isVideo ? t("permission.videoTitle") : t("permission.audioTitle")}
        </h1>
        <p className="cs-lede">{isVideo ? t("permission.videoCopy") : t("permission.audioCopy")}</p>

        <div className="permission-actions">
          <Button onClick={onContinue} disabled={busy} withArrow={false}>
            {busy ? t("common.loading") : t("common.continue")}
          </Button>
          <Button variant="secondary" withArrow={false} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </main>
    </div>
  );
}

export default CallPermissionScreen;
