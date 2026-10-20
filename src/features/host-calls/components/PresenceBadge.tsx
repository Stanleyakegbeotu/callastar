import { useTranslation } from "react-i18next";

import { useHostCall } from "../HostCallProvider";

/**
 * Whether anybody is actually there to answer, for one profile.
 *
 * Deliberately a separate badge from the profile's Active status. Active is an
 * operator's setting and survives the browser closing; presence is a live socket
 * and does not. A caller needs both to be true, so showing one green dot for the
 * pair is exactly how somebody ends up ringing a profile nobody is sitting
 * behind.
 *
 * Only reports for the profile THIS browser tab is operating. Unobserved
 * profiles do not get an Offline badge: this tab cannot know their presence.
 */
export function PresenceBadge({ profileId }: { profileId: string }) {
  const { t } = useTranslation();
  const { profile, state } = useHostCall();

  const operatingThis = profile?.id === profileId;
  if (!operatingThis) return null;
  const presence = state.presence;

  const label =
    presence === "available"
      ? t("hostCall.statusAvailable")
      : presence === "busy" || presence === "ringing"
        ? t("hostCall.statusBusy")
        : t("hostCall.statusDisconnected");

  const tone = presence === "available" ? "live" : presence === "offline" ? "muted" : "busy";

  return (
    <span className={`live-badge is-${tone}`}>
      {/* The dot is decoration; the word carries the meaning, so the state never
          depends on colour alone. */}
      <span className="live-badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export default PresenceBadge;
