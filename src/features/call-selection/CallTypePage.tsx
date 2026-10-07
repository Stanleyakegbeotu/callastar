import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { config } from "@/lib/config";
import { callSupport, type CallSupportReason } from "@/services/device/deviceCapability";
import { useCallSession } from "@/state/CallSessionContext";
import { useClearStaleSession } from "@/state/useClearStaleSession";
import type { CallType } from "@/types/call";

import { DeviceGateScreen } from "./DeviceGateScreen";

const OPTIONS: { type: CallType; titleKey: string; copyKey: string; badgeKey: string; icon: IconName }[] = [
  {
    type: "video",
    titleKey: "callType.video",
    copyKey: "callType.videoCopy",
    badgeKey: "callType.videoBadge",
    icon: "video",
  },
  {
    type: "audio",
    titleKey: "callType.audio",
    copyKey: "callType.audioCopy",
    badgeKey: "callType.audioBadge",
    icon: "audio",
  },
];

/**
 * Step one: how to connect.
 *
 * Each option states where it works, at the moment of choosing. The device gate
 * below is the enforcement, but a restriction discovered only at enforcement time
 * is a restriction that felt like a trap — so it is on the card as well.
 */
export function CallTypePage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  useClearStaleSession();
  const { session, dispatch } = useCallSession();
  const callType = config.audioCallsEnabled ? session.type : "video";

  /** Set when a chosen type cannot run here, which shows the gate instead. */
  const [blocked, setBlocked] = useState<CallSupportReason | null>(null);

  const start = () => {
    const verdict = callSupport(callType);
    if (!verdict.supported) {
      // Stops here. Nothing is asked of the browser and no session is created.
      setBlocked(verdict.reason);
      return;
    }
    navigate(`/join/${callType}`);
  };

  if (blocked) {
    return (
      <DeviceGateScreen
        reason={blocked}
        callId={session.callId || undefined}
        onContinueWithAudio={config.audioCallsEnabled ? () => {
          dispatch({ type: "SET_CALL_TYPE", callType: "audio" });
          setBlocked(null);
          navigate("/join/audio");
        } : undefined}
        onGoHome={() => navigate("/")}
      />
    );
  }

  return (
    <div className="page-shell connect-page">
      <header className="connect-header">
        <button type="button" className="icon-back" onClick={() => navigate("/")} aria-label={t("common.back")}>
          <Icon name="chevron" className="size-7" />
        </button>
        <CallaStarLogo />
      </header>

      <main className="connect-content">
        <h1 className="cs-display">{t("callType.title")}</h1>
        <p className="cs-lede">{t("callType.subtitle")}</p>

        <div className="connect-options" role="radiogroup" aria-label={t("callType.title")}>
          {OPTIONS.map((option) => (
            <button
              type="button"
              role="radio"
              aria-checked={callType === option.type}
              disabled={option.type === "audio" && !config.audioCallsEnabled}
              className={`cs-option ${callType === option.type ? "cs-option-selected" : ""}`.trim()}
              key={option.type}
              onClick={() => dispatch({ type: "SET_CALL_TYPE", callType: option.type })}
            >
              <span className="cs-option-icon">
                <Icon name={option.icon} className="size-9" />
              </span>
              <span className="cs-option-text">
                <span className="cs-option-head">
                  <span className="cs-option-title">{t(option.titleKey)}</span>
                  <span className="cs-option-badge">{t(option.badgeKey)}</span>
                </span>
                <span className="cs-option-copy">{t(option.copyKey)}</span>
              </span>
              <span className="cs-radio" aria-hidden="true" />
            </button>
          ))}
        </div>

        <div className="connect-action">
          <Button onClick={start}>{t("common.continue")}</Button>
        </div>
      </main>
    </div>
  );
}

export default CallTypePage;
