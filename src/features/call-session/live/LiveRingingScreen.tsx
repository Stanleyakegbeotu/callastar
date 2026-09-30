import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { getInitials } from "@/lib/utils";
import type { HostPreview } from "@/types/host";

interface LiveRingingScreenProps {
  host: HostPreview;
  /** True once the host has answered and is choosing how to appear. */
  connecting: boolean;
  onCancel: () => void;
}

/**
 * The line is ringing on somebody's real phone.
 *
 * Portrait, full-height, and deliberately quiet: the caller is waiting, not
 * doing. Their own camera is not shown at all here — it is running, and it will
 * be needed in a moment, but a self-view is not what somebody waiting for an
 * answer needs to look at.
 *
 * `connecting` is the moment the host tapped Answer. The words change even though
 * nothing is connected yet, because continuing to say "Ringing…" after a call has
 * been picked up is simply untrue.
 */
export function LiveRingingScreen({ host, connecting, onCancel }: LiveRingingScreenProps) {
  const { t } = useTranslation();

  return (
    <main className="live-ring" aria-labelledby="ring-status">
      {/* The host's own picture, blurred and darkened, so the screen belongs to
          the person being called rather than being a flat colour. */}
      <div
        className="live-ring-backdrop"
        aria-hidden="true"
        style={host.avatarUrl ? { backgroundImage: `url(${host.avatarUrl})` } : undefined}
      />
      <div className="live-ring-veil" aria-hidden="true" />

      <div className="live-ring-body">
        <span className={`live-ring-avatar ${connecting ? "" : "is-pulsing"}`.trim()}>
          {host.avatarUrl ? (
            <img src={host.avatarUrl} alt="" />
          ) : (
            <span className="live-ring-initials">{getInitials(host.displayName)}</span>
          )}
        </span>

        <h1 className="live-ring-name">{host.displayName}</h1>

        {/* One live region for the whole status, so a screen reader hears the
            change from ringing to connecting once rather than in fragments. */}
        <p id="ring-status" className="live-ring-status" role="status" aria-live="polite">
          {connecting ? (
            t("liveCall.connecting")
          ) : (
            <>
              <span className="live-ring-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {t("liveCall.ringing")}
            </>
          )}
        </p>

        {!connecting && (
          <p className="live-ring-sub">{t("liveCall.waitingFor", { name: host.shortName })}</p>
        )}
      </div>

      <div className="live-ring-controls">
        <button type="button" className="call-round-button is-danger" onClick={onCancel} aria-label={t("common.cancel")}>
          <Icon name="phoneOff" className="size-7" />
        </button>
        <span className="call-round-label">{t("common.cancel")}</span>
      </div>
    </main>
  );
}

export default LiveRingingScreen;
