import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import type { VideoSourceAvailability } from "@/services/videoSource/videoSourceProvider";
import type { VideoSourceKind } from "@/services/signaling";

interface SourceSelectionScreenProps {
  callerName: string;
  /** Null while availability is still being determined. */
  options: { liveCamera: VideoSourceAvailability; uploadedSource: VideoSourceAvailability } | null;
  /** Epoch ms the window closes, so the operator can see time passing. */
  deadline: number | null;
  onChoose: (kind: VideoSourceKind) => void;
}

/**
 * How the operator will appear, chosen per call.
 *
 * Deliberately after Answer and before any camera. Answering should not commit
 * somebody's face to a call, and asking beforehand would mean choosing for a call
 * that might not be answered.
 *
 * This choice is never written to the profile. A host who picks Live Camera once
 * has not changed what their profile is; the next call asks again.
 *
 * FilterCore is absent — not disabled, not "coming soon". An option that does
 * nothing is worse than no option.
 */
export function SourceSelectionScreen({
  callerName,
  options,
  deadline,
  onChoose,
}: SourceSelectionScreenProps) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState<number | null>(null);

  /**
   * A visible countdown, because the caller is waiting on this and an operator
   * who cannot see that is an operator who takes their time.
   */
  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return undefined;
    }

    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const uploaded = options?.uploadedSource;
  const uploadedUsable = uploaded?.available === true;
  const uploadedNote =
    uploaded && !uploaded.available
      ? uploaded.reason === "not_uploaded"
        ? t("hostCall.noSource")
        : t("hostCall.sourceUnreachable")
      : null;

  return (
    <div className="source-sheet" role="dialog" aria-modal="true" aria-labelledby="source-title">
      <div className="source-sheet-inner">
        <header className="source-sheet-head">
          <h1 id="source-title" className="source-sheet-title">
            {t("hostCall.sourceTitle")}
          </h1>
          <p className="source-sheet-copy">{t("hostCall.sourceCopy")}</p>
          <p className="source-sheet-caller">
            {t("hostCall.callingProfile", { name: callerName })}
            {remaining !== null && <span className="source-sheet-countdown">{remaining}s</span>}
          </p>
        </header>

        <div className="source-sheet-options">
          <button
            type="button"
            className="source-card"
            onClick={() => onChoose("live-camera")}
            disabled={options !== null && !options.liveCamera.available}
          >
            <span className="source-card-icon">
              <Icon name="camera" className="size-7" />
            </span>
            <span className="source-card-text">
              <strong>{t("hostCall.liveCamera")}</strong>
              <span>{t("hostCall.liveCameraCopy")}</span>
            </span>
            <Icon name="arrow" className="size-5 source-card-arrow" />
          </button>

          <button
            type="button"
            className={`source-card ${uploadedUsable ? "" : "is-unavailable"}`.trim()}
            onClick={() => onChoose("uploaded-source")}
            disabled={!uploadedUsable}
            // The reason is on the card, so the disabled state is never a mystery.
            aria-describedby={uploadedNote ? "source-uploaded-note" : undefined}
          >
            <span className="source-card-icon">
              <Icon name="video" className="size-7" />
            </span>
            <span className="source-card-text">
              <strong>{t("hostCall.uploadedSource")}</strong>
              <span>{t("hostCall.uploadedSourceCopy")}</span>
              {uploadedNote && (
                <span id="source-uploaded-note" className="source-card-note">
                  {uploadedNote}
                </span>
              )}
            </span>
            {uploadedUsable && <Icon name="arrow" className="size-5 source-card-arrow" />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SourceSelectionScreen;
