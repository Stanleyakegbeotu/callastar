import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { normalizeCallId } from "@/lib/callId";
import { mediaAssetProvider } from "@/services/media/mediaAssetProvider";
import type { HostProfile } from "@/services/admin/types";

import { useHostCall } from "../HostCallProvider";

interface LiveCallingCardProps {
  profile: HostProfile;
  /** Whether this profile has a usable video call source uploaded. */
  hasCallSource: boolean;
}

/**
 * Live calling, for one profile, on the Profile Detail page.
 *
 * The distinction this card exists to make: a profile being **Active** is an
 * operator's setting that survives the browser closing, while **presence** is a
 * live socket that does not. Showing one green dot for both is how a caller ends
 * up ringing a profile nobody is sitting behind — so the two are separate rows
 * with separate words, always both visible.
 */
export function LiveCallingCard({ profile, hasCallSource }: LiveCallingCardProps) {
  const { t } = useTranslation();
  const host = useHostCall();
  const [busy, setBusy] = useState(false);

  /** This card only speaks for the profile this tab is actually operating. */
  const operatingThis = host.profile?.id === profile.id;
  const presence = operatingThis ? host.state.presence : "offline";
  const receiving = operatingThis && host.state.receiveCallsRequested;

  const presenceLabel =
    presence === "available"
      ? t("hostCall.statusAvailable")
      : presence === "busy" || presence === "ringing"
        ? t("hostCall.statusBusy")
        : t("hostCall.statusOffline");

  const presenceTone = presence === "available" ? "live" : presence === "offline" ? "muted" : "busy";

  const toggle = async () => {
    setBusy(true);
    try {
      if (receiving) {
        await host.stopReceiving();
        return;
      }
      await host.startReceiving({
        id: profile.id,
        displayName: profile.displayName,
        callIdKey: normalizeCallId(profile.callId),
        callSourceAssetId: profile.remoteVideoAssetId,
      });
    } finally {
      setBusy(false);
    }
  };

  const inactive = profile.status !== "active";
  // Whether an uploaded source could reach the caller's device at all.
  const sourceReachable = mediaAssetProvider.reachableAcrossDevices;

  return (
    <section className="admin-card live-calling-card" aria-labelledby="live-calling-title">
      <header className="live-calling-head">
        <h2 id="live-calling-title">{t("hostCall.liveCalling")}</h2>
        {/* Two badges, never one. See the note above. */}
        <span className={`live-badge is-${presenceTone}`}>
          <span className="live-badge-dot" aria-hidden="true" />
          {presenceLabel}
        </span>
      </header>

      <dl className="live-calling-rows">
        <div className="live-calling-row">
          <dt>{t("hostCall.profileStatus")}</dt>
          <dd>
            <span className={`admin-chip ${inactive ? "is-warning" : "is-success"}`}>
              {inactive ? t("hostState.inactiveChip") : t("hostState.availableChip")}
            </span>
          </dd>
        </div>

        <div className="live-calling-row">
          <dt>{t("hostCall.realtimeStatus")}</dt>
          <dd>{presenceLabel}</dd>
        </div>

        {/* Where each call type works, in the operator's own words. No WebRTC
            vocabulary: an admin needs to know where to hold their phone, not how
            ICE negotiates. */}
        <div className="live-calling-row">
          <dt>{t("hostCall.videoCalling")}</dt>
          <dd>{t("callType.videoBadge")}</dd>
        </div>

        <div className="live-calling-row">
          <dt>{t("hostCall.audioCalling")}</dt>
          <dd>{t("callType.audioBadge")}</dd>
        </div>

        <div className="live-calling-row">
          <dt>{t("hostCall.videoSource")}</dt>
          {/*
            Three answers, not two. A source that exists but cannot be reached by
            another device is not the same as no source at all, and an operator
            told "Available" for one would be misled about what a call will do.
          */}
          <dd>
            {!hasCallSource
              ? t("hostCall.sourceMissing")
              : sourceReachable
                ? t("hostCall.sourceAvailable")
                : t("hostCall.sourceLocalOnly")}
          </dd>
        </div>
      </dl>

      {!host.supported ? (
        <p className="live-calling-note is-warning" role="status">
          <Icon name="info" className="size-4" />
          {host.unsupportedReason ?? t("hostCall.unsupported")}
        </p>
      ) : (
        <>
          <button
            type="button"
            className={`live-toggle ${receiving ? "is-on" : ""}`.trim()}
            onClick={() => void toggle()}
            disabled={busy || inactive}
            aria-pressed={receiving}
          >
            <span className="live-toggle-track" aria-hidden="true">
              <span className="live-toggle-knob" />
            </span>
            <span className="live-toggle-label">{t("hostCall.receiveCalls")}</span>
          </button>

          <p className="live-calling-note" role="status">
            {receiving && presence === "available" ? (
              <>
                <strong>{t("hostCall.availableTitle")}</strong>
                {/* The honest caveat: this is a web page, not a background service. */}
                {t("hostCall.availableCopy")}
              </>
            ) : receiving ? (
              // Asked for, but the socket is not up — so presence is not claimed.
              <>
                <strong>{t("hostCall.statusOffline")}</strong>
                {t("hostCall.availableCopy")}
              </>
            ) : (
              <>
                <strong>{t("hostCall.offlineTitle")}</strong>
                {t("hostCall.offlineCopy")}
              </>
            )}
          </p>
        </>
      )}

      {inactive && (
        <p className="live-calling-note is-warning">
          <Icon name="info" className="size-4" />
          {t("hostState.inactiveNoteTitle")}
        </p>
      )}
    </section>
  );
}

export default LiveCallingCard;
