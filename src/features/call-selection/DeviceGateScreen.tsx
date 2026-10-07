import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatCallId } from "@/lib/callId";
import { copyText } from "@/lib/utils";
import type { CallSupportReason } from "@/services/device/deviceCapability";

interface DeviceGateScreenProps {
  reason: CallSupportReason;
  /** Preserved into the shareable link when the caller already has one. */
  callId?: string;
  onContinueWithAudio?: () => void;
  onGoHome: () => void;
}

/**
 * Where a desktop visitor is told that video is a phone product.
 *
 * Reached BEFORE anything is asked of the browser: no camera prompt, no peer
 * connection, no invitation. That ordering is the point — discovering the
 * restriction after filling in a form and granting a camera would be the same
 * information delivered at the worst possible moment.
 *
 * The three reasons read differently on purpose. Telling somebody to use their
 * phone when the real problem is that the page is not on HTTPS would send them
 * off to do the wrong thing.
 */
export function DeviceGateScreen({ reason, callId, onContinueWithAudio, onGoHome }: DeviceGateScreenProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  /**
   * A link the caller can open on their phone.
   *
   * The Call ID is carried because it identifies a profile and is meant to be
   * shared. Nothing else is: no Subscription Access ID, no ephemeral call token.
   * Those are credentials, and a URL ends up in history, in a paste buffer and
   * quite often in somebody else's chat window.
   */
  const mobileLink = (() => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.origin + window.location.pathname);
    url.hash = "";
    url.search = "";
    if (callId) url.searchParams.set("call", formatCallId(callId));
    return url.toString();
  })();

  const copyLink = () => {
    void copyText(mobileLink).then((ok) => setCopied(ok ? "done" : "failed"));
  };

  const isDeviceClass = reason === "device-class";
  const title = isDeviceClass
    ? t("deviceGate.title")
    : reason === "insecure-context"
      ? t("deviceGate.insecureTitle")
      : t("deviceGate.unsupportedTitle");
  const copy = isDeviceClass
    ? t("deviceGate.copy")
    : reason === "insecure-context"
      ? t("deviceGate.insecureCopy")
      : t("deviceGate.unsupportedCopy");

  return (
    <div className="page-shell device-gate-page">
      <main className="device-gate" aria-labelledby="device-gate-title">
        <div className="device-gate-brand">
          <CallaStarLogo />
        </div>

        <span className="device-gate-art" aria-hidden="true">
          <Icon name="video" className="size-10" />
        </span>

        <h1 id="device-gate-title" className="cs-display device-gate-title">
          {title}
        </h1>
        <p className="cs-lede">{copy}</p>

        {/* Only offered where audio genuinely still works. An insecure context or
            a browser without WebRTC blocks both call types equally. */}
        {isDeviceClass && onContinueWithAudio && <p className="device-gate-secondary">{t("deviceGate.secondary")}</p>}

        <div className="device-gate-actions">
          {isDeviceClass ? (
            <>
              {onContinueWithAudio && (
                <Button onClick={onContinueWithAudio} withArrow={false}>
                  {t("deviceGate.continueAudio")}
                </Button>
              )}
              <Button variant="secondary" withArrow={false} onClick={copyLink}>
                <Icon name="copy" className="size-4" />
                {t("deviceGate.copyLink")}
              </Button>
            </>
          ) : (
            <Button variant="secondary" withArrow={false} onClick={onGoHome}>
              {t("common.returnHome")}
            </Button>
          )}
        </div>

        {isDeviceClass && (
          <>
            {/* aria-live so the outcome of a copy is announced, since the only
                other feedback is a line of text appearing. */}
            <p className="device-gate-helper" role="status" aria-live="polite">
              {copied === "done"
                ? t("deviceGate.copied")
                : copied === "failed"
                  ? t("deviceGate.copyFailed")
                  : t("deviceGate.helper")}
            </p>
            <button type="button" className="device-gate-home" onClick={onGoHome}>
              {t("common.returnHome")}
            </button>
          </>
        )}
      </main>
    </div>
  );
}

export default DeviceGateScreen;
