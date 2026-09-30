import { useTranslation } from "react-i18next";

import type { CallAccessGate } from "../hooks/useCallAccessGate";

/**
 * The subscription check, drawn over a call that is still running.
 *
 * This is the only part of the checkpoint that ever appears during a call, and
 * it changes nothing about it: the remote media keeps playing, the camera and
 * microphone stay live, and the timer keeps counting. It is a status message,
 * not a gate — if access turns out to be missing the call ends and the access
 * screen takes over, so nothing here has an action.
 */
export function SubscriptionCheckpoint({ gate }: { gate: CallAccessGate }) {
  const { t } = useTranslation();
  if (gate.status !== "checking") return null;

  return (
    <div className="access-checking" role="status" aria-live="polite">
      <span className="access-spinner" aria-hidden="true" />
      <h2 className="access-title">{t("access.checkingTitle")}</h2>
      <p className="access-copy">{t("access.checkingCopy")}</p>
    </div>
  );
}

export default SubscriptionCheckpoint;
