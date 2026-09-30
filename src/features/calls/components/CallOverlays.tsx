import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";

/**
 * Overlays that sit above a live call canvas.
 *
 * Each one is a message over a call that is still running. None of them unmounts
 * the media beneath, which is the whole point: a phone turned sideways and a
 * network hiccup are both things to say something about, not reasons to hang up.
 */

/**
 * Portrait guard.
 *
 * Covers the call rather than relayouting it. Behind this overlay the peer
 * connection, both cameras, the microphone and the call timer all continue
 * untouched — rotating a phone is not an instruction to end a conversation.
 */
export function RotateToPortraitOverlay() {
  const { t } = useTranslation();

  return (
    <div
      className="call-overlay call-overlay-rotate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="rotate-title"
      aria-describedby="rotate-copy"
    >
      <div className="call-overlay-inner">
        <span className="rotate-icon" aria-hidden="true">
          <Icon name="rotate" className="size-10" />
        </span>
        <h2 id="rotate-title" className="call-overlay-title">
          {t("liveCall.rotateTitle")}
        </h2>
        <p id="rotate-copy" className="call-overlay-copy">
          {t("liveCall.rotateCopy")}
        </p>
      </div>
    </div>
  );
}

/**
 * Real RTC connectivity trouble.
 *
 * Deliberately distinct from the uploaded-source fallback that shares the same
 * words: this one appears because ICE actually degraded, after a debounce long
 * enough that a momentary flap does not flash it. The last remote frame, the
 * local camera, the controls and the timer all stay.
 */
export function ReconnectingOverlay() {
  const { t } = useTranslation();

  return (
    <div className="call-overlay call-overlay-reconnecting" role="status" aria-live="polite">
      <div className="call-overlay-inner">
        <span className="call-spinner" aria-hidden="true" />
        <h2 className="call-overlay-title">{t("liveCall.reconnectingTitle")}</h2>
        <p className="call-overlay-copy">{t("liveCall.reconnectingCopy")}</p>
      </div>
    </div>
  );
}

/**
 * Waiting on the other side to be ready.
 *
 * Shown to a caller from the moment the host answers until media arrives, so
 * nobody keeps hearing a ring for a call that has already been picked up.
 */
export function ConnectingOverlay({ label }: { label?: string }) {
  const { t } = useTranslation();

  return (
    <div className="call-overlay call-overlay-connecting" role="status" aria-live="polite">
      <div className="call-overlay-inner">
        <span className="call-spinner" aria-hidden="true" />
        <h2 className="call-overlay-title">{label ?? t("liveCall.connecting")}</h2>
      </div>
    </div>
  );
}
