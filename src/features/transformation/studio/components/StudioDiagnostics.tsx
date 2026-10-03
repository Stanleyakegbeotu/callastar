import type { ReactNode } from "react";

import type { CalibrationCollectorState } from "../../engine/calibrationCollector";
import { motionOutsideEnvelope } from "../../engine/relativeMotion";
import type { QualityMode } from "../../engine/trackingScheduler";
import type { StudioSummary } from "../useStudioRuntime";

interface StudioDiagnosticsProps {
  summary: StudioSummary;
  quality: QualityMode;
  calibration: CalibrationCollectorState;
}

/**
 * Measured values only.
 *
 * Every row here is something the runtime actually reported. Where nothing has
 * been measured the row shows a dash rather than a zero — a fabricated "0.0 ms"
 * in a diagnostics panel is worse than a blank, because it reads as a
 * measurement that happens to be fast.
 *
 * Each row carries a `data-metric`, which is how the browser tests read a value
 * without depending on the wording around it.
 */

const MISSING = "—";

function ms(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} ms` : MISSING;
}

function fps(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value} fps` : MISSING;
}

function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : MISSING;
}

function degrees(radians: number | null | undefined): string {
  return typeof radians === "number" && Number.isFinite(radians)
    ? `${((radians * 180) / Math.PI).toFixed(1)}°`
    : MISSING;
}

function ratio(value: number | null | undefined, digits = 3): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : MISSING;
}

function Row({ metric, label, value, plain }: { metric: string; label: string; value: ReactNode; plain?: boolean }) {
  return (
    <div data-metric={metric}>
      <dt>{label}</dt>
      <dd className={plain ? "studio-diag-plain" : undefined}>{value}</dd>
    </div>
  );
}

/** A signed value, always with its sign, so a sign error is visible at a glance. */
function signed(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING;
  const text = value.toFixed(digits);
  return `${value > 0 ? "+" : ""}${text}${suffix}`;
}

function signedDegrees(radians: number | null | undefined): string {
  if (typeof radians !== "number" || !Number.isFinite(radians)) return MISSING;
  return signed((radians * 180) / Math.PI, 1, "°");
}

export function StudioDiagnostics({ summary, quality, calibration }: StudioDiagnosticsProps) {
  const { stats, face, motion } = summary;
  const derivedFace = face?.derived ?? null;
  const profile = calibration.profile;
  const outside = motionOutsideEnvelope(motion);

  return (
    <div className="studio-diagnostics">
      {/*
        * Relative motion, and the reason this panel matters before anything is
        * transformed: it is the only way to see that the calibration maths
        * behaves. Turn left, and yaw should go one way and the other two should
        * stay near zero. A sign error here would look entirely plausible on a
        * source face and be almost impossible to find later.
        */}
      <section>
        <h3>Motion, relative to neutral</h3>
        {profile ? (
          <>
            <dl>
              <Row metric="motion-yaw" label="Yaw" value={signedDegrees(motion.head?.yawDelta)} />
              <Row metric="motion-pitch" label="Pitch" value={signedDegrees(motion.head?.pitchDelta)} />
              <Row metric="motion-roll" label="Roll" value={signedDegrees(motion.head?.rollDelta)} />
              <Row
                metric="motion-scale"
                label="Scale"
                value={
                  typeof motion.head?.scaleDelta === "number" ? `${motion.head.scaleDelta.toFixed(2)}×` : MISSING
                }
              />
              <Row metric="motion-x" label="Move X" value={signed(motion.head?.translationX)} />
              <Row metric="motion-y" label="Move Y" value={signed(motion.head?.translationY)} />
            </dl>
            <p className="studio-note">
              {motion.tracked
                ? "Positive X is towards the right of the camera frame — on a mirrored preview that looks like moving left."
                : "Tracking lost. The baseline is kept; motion resumes when you are back in frame."}
            </p>
            {outside.length > 0 && (
              // Provisional envelopes, diagnostics only. They become deformation
              // clamps later, and are documented rather than hardcoded silently.
              <p className="studio-note">Outside the recommended range: {outside.join(", ")}.</p>
            )}
          </>
        ) : (
          <p className="studio-note">Calibrate to see movement measured against your resting position.</p>
        )}
      </section>

      <section>
        <h3>Calibration</h3>
        <dl>
          <Row metric="calibration-phase" label="State" value={calibration.phase} plain />
          <Row metric="calibration-accepted" label="Accepted frames" value={count(calibration.acceptedFrames)} />
          <Row metric="calibration-rejected" label="Rejected frames" value={count(calibration.rejectedFrames)} />
          <Row
            metric="calibration-stability"
            label="Stability"
            value={ratio(calibration.stability?.score, 2)}
          />
          <Row
            metric="calibration-worst"
            label="Least steady"
            value={calibration.stability?.worstQuantity ?? MISSING}
            plain
          />
          <Row metric="calibration-quality" label="Quality" value={profile?.quality.quality ?? MISSING} plain />
          <Row
            metric="calibration-frames"
            label="Baseline frames"
            value={count(profile?.quality.frameCount)}
          />
          <Row metric="neutral-yaw" label="Neutral yaw" value={degrees(profile?.face.yaw)} />
          <Row metric="neutral-pitch" label="Neutral pitch" value={degrees(profile?.face.pitch)} />
          <Row metric="neutral-roll" label="Neutral roll" value={degrees(profile?.face.roll)} />
          <Row metric="neutral-scale" label="Neutral face scale" value={ratio(profile?.face.scale)} />
          <Row
            metric="calibration-warnings"
            label="Warnings"
            value={profile ? (profile.quality.warnings.join(", ") || "none") : MISSING}
            plain
          />
        </dl>
      </section>

      <section>
        <h3>Loop</h3>
        <dl>
          {/* Counters, not rates: a count is stable enough to compare across two
              reads, which is what pausing has to be proved with. */}
          <Row metric="camera-frames" label="Camera frames" value={count(stats?.cameraFrames)} />
          <Row metric="tracking-frames" label="Tracking frames" value={count(stats?.trackingFrames)} />
          <Row metric="face-inferences" label="Face inferences" value={count(stats?.faceInferences)} />
          <Row metric="pose-inferences" label="Pose inferences (disabled)" value={count(stats?.poseInferences)} />
          <Row metric="dropped-frames" label="Dropped frames" value={count(stats?.droppedFrames)} />
          <Row metric="camera-fps" label="Camera rate" value={fps(stats?.cameraFps)} />
          <Row metric="accepted-camera-fps" label="Accepted frame rate" value={fps(stats?.acceptedCameraFps)} />
          <Row metric="face-fps" label="Face tracking rate" value={fps(stats?.faceFps)} />
          <Row metric="dropped-input-frames" label="Input frames skipped" value={count(stats?.droppedInputFrames)} />
          <Row metric="dropped-tracking-frames" label="Tracking frames dropped" value={count(stats?.droppedTrackingFrames)} />
          <Row metric="camera-face-latency" label="Camera callback → face result" value={ms(stats?.cameraToFaceMs)} />
          <Row metric="camera-frame-timestamp" label="Camera media timestamp" value={ms(stats?.cameraTimestampMs)} />
          <Row metric="face-stage-start" label="Face tracking start" value={ms(stats?.faceStartMs)} />
          <Row metric="face-stage-end" label="Face tracking end" value={ms(stats?.faceEndMs)} />
          <Row metric="face-ms" label="Face inference" value={ms(stats?.faceAverageMs)} />
          <Row metric="loop-ms" label="Loop" value={ms(stats?.loopAverageMs)} />
        </dl>
      </section>

      <section>
        <h3>Input</h3>
        <dl>
          <Row
            metric="camera-frame-size"
            label="Camera frame"
            value={
              summary.cameraWidth && summary.cameraHeight
                ? `${summary.cameraWidth} × ${summary.cameraHeight}`
                : MISSING
            }
          />
          <Row metric="quality-mode" label="Quality mode" value={quality} plain />
          <Row metric="face-init" label="Face model init" value={ms(summary.faceInitMs)} />
        </dl>
      </section>

      <section>
        <h3>Face</h3>
        <dl>
          <Row metric="face-landmarks" label="Landmarks" value={count(face?.landmarks.length)} />
          <Row metric="face-confidence" label="Confidence" value={ratio(face?.confidence, 2)} />
          <Row metric="face-yaw" label="Yaw" value={degrees(derivedFace?.yaw)} />
          <Row metric="face-pitch" label="Pitch" value={degrees(derivedFace?.pitch)} />
          <Row metric="face-roll" label="Roll" value={degrees(derivedFace?.roll)} />
          <Row metric="face-eyes" label="Eye openness" value={ratio(derivedFace?.eyeOpenness, 2)} />
          <Row metric="face-mouth" label="Mouth openness" value={ratio(derivedFace?.mouthOpenness, 2)} />
          <Row metric="face-scale" label="Face scale" value={ratio(derivedFace?.scale)} />
          <Row metric="expression-complete" label="Expression complete" value={ms(summary.expression?.updatedAtMs)} />
          <Row metric="expression-calc-ms" label="Expression processing" value={ms(summary.expression?.calculationMs)} />
        </dl>
      </section>

      <section>
        <h3>Eye gaze</h3>
        <dl>
          <Row metric="gaze-iris-left" label="Iris L x / y" value={summary.expression?.eyeGaze?.raw
            ? `${signed(summary.expression.eyeGaze.raw.left.x, 3)} / ${signed(summary.expression.eyeGaze.raw.left.y, 3)}` : MISSING} />
          <Row metric="gaze-iris-right" label="Iris R x / y" value={summary.expression?.eyeGaze?.raw
            ? `${signed(summary.expression.eyeGaze.raw.right.x, 3)} / ${signed(summary.expression.eyeGaze.raw.right.y, 3)}` : MISSING} />
          <Row metric="gaze-neutral-left" label="Neutral L x / y" value={summary.expression?.eyeGaze?.neutral
            ? `${ratio(summary.expression.eyeGaze.neutral.left.x)} / ${ratio(summary.expression.eyeGaze.neutral.left.y)}` : "calibrate with iris tracking"} />
          <Row metric="gaze-neutral-right" label="Neutral R x / y" value={summary.expression?.eyeGaze?.neutral
            ? `${ratio(summary.expression.eyeGaze.neutral.right.x)} / ${ratio(summary.expression.eyeGaze.neutral.right.y)}` : "calibrate with iris tracking"} />
          <Row metric="gaze-normalized-left" label="Normalized L x / y" value={summary.expression?.eyeGaze?.normalized
            ? `${signed(summary.expression.eyeGaze.normalized.left.x)} / ${signed(summary.expression.eyeGaze.normalized.left.y)}` : MISSING} />
          <Row metric="gaze-normalized-right" label="Normalized R x / y" value={summary.expression?.eyeGaze?.normalized
            ? `${signed(summary.expression.eyeGaze.normalized.right.x)} / ${signed(summary.expression.eyeGaze.normalized.right.y)}` : MISSING} />
          <Row metric="gaze-applied-left" label="Applied L x / y" value={summary.expression?.eyeGaze?.applied
            ? `${signed(summary.expression.eyeGaze.applied.left.x)} / ${signed(summary.expression.eyeGaze.applied.left.y)}` : MISSING} />
          <Row metric="gaze-applied-right" label="Applied R x / y" value={summary.expression?.eyeGaze?.applied
            ? `${signed(summary.expression.eyeGaze.applied.right.x)} / ${signed(summary.expression.eyeGaze.applied.right.y)}` : MISSING} />
          <Row metric="gaze-clamped" label="Clamped" value={summary.expression?.eyeGaze?.normalized
            ? String(summary.expression.eyeGaze.normalized.clamped) : MISSING} plain />
          <Row metric="gaze-quality" label="Tracking quality L / R" value={summary.expression?.eyeGaze?.quality
            ? `${ratio(summary.expression.eyeGaze.quality.left, 2)} / ${ratio(summary.expression.eyeGaze.quality.right, 2)}` : MISSING} />
        </dl>
      </section>

    </div>
  );
}

export default StudioDiagnostics;
