import { useTranslation } from "react-i18next";

/**
 * Overlays that sit above a live call canvas.
 *
 * Each one is a message over a call that is still running. None of them unmounts
 * the media beneath.
 */

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
