import { Icon } from "@/components/ui/Icon";

import type { CalibrationCollectorState } from "../../engine/calibrationCollector";
import type { CalibrationInvalidation } from "../../engine/calibrationTypes";
import { describeCalibration, describeQuality, describeWarning } from "../calibrationGuidance";

interface CalibrationPanelProps {
  calibration: CalibrationCollectorState;
  invalidation: CalibrationInvalidation | null;
  cameraLive: boolean;
  onStart: (mode?: "full" | "face-only") => void;
  onCancel: () => void;
  onRecalibrate: () => void;
}

/**
 * The calibration controls and result.
 *
 * Kept out of the preview: during a capture the operator should be looking at
 * themselves, not at a panel. This is where they start it, and where they read
 * what was captured once it is over.
 */
export function CalibrationPanel({
  calibration,
  invalidation,
  cameraLive,
  onStart,
  onCancel,
  onRecalibrate,
}: CalibrationPanelProps) {
  const { phase, profile } = calibration;
  const running = phase === "waiting-for-stable-tracking" || phase === "collecting" || phase === "evaluating";

  return (
    <section className="studio-card">
      <h2>Calibration</h2>

      {invalidation === "camera-facing-changed" && phase === "idle" && (
        <p className="studio-alert" role="status">
          <Icon name="info" className="size-4" />
          <span>
            Recalibration required. The other camera frames you differently, so the previous baseline no longer
            describes where you are.
          </span>
        </p>
      )}

      {phase === "idle" && (
        <>
          <p className="studio-note">
            Captures your resting position, so later movement is measured from it rather than from zero.
          </p>
          <button
            type="button"
            className="studio-primary studio-primary-inline"
            onClick={() => onStart("face-only")}
            disabled={!cameraLive}
          >
            Start calibration
          </button>
        </>
      )}

      {running && (
        <>
          <p className="studio-note">Sit comfortably and look at the camera.</p>
          <div
            className="studio-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(calibration.progress * 100)}
            aria-label="Calibration progress"
          >
            <span style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
          </div>
          <button type="button" className="studio-control" onClick={onCancel}>
            <span>Cancel</span>
          </button>
        </>
      )}

      {phase === "failed" && (
        <div className="studio-calibration-failed">
          {/*
            * The reason belongs here, not only over the preview.
            *
            * The guidance line during a capture is on the video, where the
            * operator is looking. Once it has stopped they are looking at this
            * panel, and two buttons with no explanation is not an answer.
            */}
          <p className="studio-calibration-reason" role="status">
            <strong>{describeCalibration(calibration).message}</strong>
            {describeCalibration(calibration).detail && <span>{describeCalibration(calibration).detail}</span>}
          </p>
          <button type="button" className="studio-primary studio-primary-inline" onClick={() => onStart("face-only")}>
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && profile && (
        <div className="studio-calibration-result">
          <p className={`studio-quality is-${profile.quality.quality}`}>
            <Icon name="check" className="size-4" />
            <strong>{describeQuality(profile.quality.quality).label}</strong>
            <span>{describeQuality(profile.quality.quality).detail}</span>
          </p>

          {profile.quality.warnings.length > 0 && (
            // Informational. None of these stop the baseline being used.
            <ul className="studio-warnings">
              {profile.quality.warnings.map((warning) => (
                <li key={warning}>{describeWarning(warning)}</li>
              ))}
            </ul>
          )}

          <button type="button" className="studio-control" onClick={onRecalibrate}>
            <Icon name="rotate" className="size-5" />
            <span>Recalibrate</span>
          </button>
          <p className="studio-note">
            Recalibrating replaces the baseline. It does not reload the models or restart the camera.
          </p>
        </div>
      )}
    </section>
  );
}

export default CalibrationPanel;
