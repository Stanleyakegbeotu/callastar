import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { getInitials } from "@/lib/utils";

import type { HostIncomingCall } from "../state/hostCallReducer";

interface IncomingCallScreenProps {
  call: HostIncomingCall;
  profileName: string;
  onAnswer: () => void;
  onDecline: () => void;
}

/**
 * Somebody is calling.
 *
 * Full-screen and above everything, including the admin shell — an operator with
 * a sidebar and a breadcrumb trail over an incoming call would not read it as a
 * phone ringing. It is `role="alertdialog"` for the same reason: this interrupts.
 *
 * The displayed contact and entitlement details come from the Admin-authenticated
 * session lookup, not from caller-controlled signaling fields.
 */
export function IncomingCallScreen({
  call,
  profileName,
  onAnswer,
  onDecline,
}: IncomingCallScreenProps) {
  const { t } = useTranslation();
  const isVideo = call.callType === "video";

  return (
    <div
      className="incoming-call"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="incoming-name"
      aria-describedby="incoming-kind"
    >
      <div className="incoming-call-glow" aria-hidden="true" />

      <div className="incoming-call-body">
        <span className="incoming-call-avatar is-pulsing" aria-hidden="true">
          {getInitials(call.caller.displayName)}
        </span>

        <p id="incoming-kind" className="incoming-call-kind">
          {isVideo ? t("hostCall.incomingVideo") : t("hostCall.incomingAudio")}
        </p>

        <h1 id="incoming-name" className="incoming-call-name">
          {call.adminContext?.callerName ?? call.caller.displayName}
        </h1>

        <p className="incoming-call-profile">{t("hostCall.callingProfile", { name: profileName })}</p>
        {call.adminContext && <dl className="incoming-call-context">
          <div><dt>Phone</dt><dd>{call.adminContext.callerPhone || "Not provided"}</dd></div>
          <div><dt>Email</dt><dd>{call.adminContext.callerEmail || "Not provided"}</dd></div>
          <div><dt>Call ID</dt><dd>{call.adminContext.callId || "Unavailable"}</dd></div>
          <div><dt>Profile</dt><dd>{call.adminContext.profileName || profileName}</dd></div>
          <div><dt>Mode</dt><dd>{call.adminContext.mode ? call.adminContext.mode === "free" ? "Free" : "Premium" : "Unavailable"}</dd></div>
        </dl>}
      </div>

      <div className="incoming-call-actions">
        <div className="incoming-call-action">
          <button
            type="button"
            className="call-round-button is-danger"
            onClick={onDecline}
            aria-label={t("hostCall.decline")}
          >
            <Icon name="phoneOff" className="size-7" />
          </button>
          <span className="call-round-label">{t("hostCall.decline")}</span>
        </div>

        <div className="incoming-call-action">
          <button
            type="button"
            className="call-round-button is-accept"
            onClick={onAnswer}
            aria-label={t("hostCall.answer")}
          >
            <Icon name={isVideo ? "video" : "phone"} className="size-7" />
          </button>
          <span className="call-round-label">{t("hostCall.answer")}</span>
        </div>
      </div>
    </div>
  );
}

export default IncomingCallScreen;
