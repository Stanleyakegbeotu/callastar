import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { getInitials } from "@/lib/utils";

import type { HostIncomingCall } from "../state/hostCallReducer";

interface IncomingCallScreenProps {
  call: HostIncomingCall;
  profileName: string;
  /**
   * True when this device cannot run a video call. The call is still shown — the
   * operator should know somebody is calling — but Answer is replaced with an
   * instruction rather than a button that would break the product rule.
   */
  mustAnswerOnMobile: boolean;
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
 * The caller's name is all that is shown of them. Their email and phone are in
 * the session record where they belong; putting contact details on a screen that
 * appears unprompted is not something this moment needs.
 */
export function IncomingCallScreen({
  call,
  profileName,
  mustAnswerOnMobile,
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
          {call.caller.displayName}
        </h1>

        <p className="incoming-call-profile">{t("hostCall.callingProfile", { name: profileName })}</p>

        {mustAnswerOnMobile && (
          <div className="incoming-call-notice" role="status">
            <Icon name="info" className="size-4" />
            <span>
              <strong>{t("hostCall.answerOnMobileTitle")}</strong>
              {t("hostCall.answerOnMobileCopy")}
              <em>{t("hostCall.openOnMobile")}</em>
            </span>
          </div>
        )}
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

        {/* Answer is simply absent where it cannot be honoured. A disabled green
            button invites tapping at it; its absence explains itself alongside the
            notice above. */}
        {!mustAnswerOnMobile && (
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
        )}
      </div>
    </div>
  );
}

export default IncomingCallScreen;
