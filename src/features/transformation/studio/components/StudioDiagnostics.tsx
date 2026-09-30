import type { ReactNode } from "react";

import type { CalibrationCollectorState } from "../../engine/calibrationCollector";
import { motionOutsideEnvelope } from "../../engine/relativeMotion";
import type { QualityMode } from "../../engine/trackingScheduler";
import type { StudioSummary } from "../useStudioRuntime";

interface StudioDiagnosticsProps {
  summary: StudioSummary;
  quality: QualityMode;
  segmentation: boolean;
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

export function StudioDiagnostics({ summary, quality, segmentation, calibration }: StudioDiagnosticsProps) {
  const { stats, face, pose, motion } = summary;
  const derivedFace = face?.derived ?? null;
  const derivedPose = pose?.derived ?? null;
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
              <Row
                metric="motion-shoulder-angle"
                label="Shoulder angle"
                value={signedDegrees(motion.upperBody?.shoulderAngleDelta)}
              />
              <Row
                metric="motion-shoulder-scale"
                label="Shoulder scale"
                value={
                  typeof motion.upperBody?.shoulderScaleDelta === "number"
                    ? `${motion.upperBody.shoulderScaleDelta.toFixed(2)}×`
                    : MISSING
                }
              />
              <Row metric="motion-shoulder-x" label="Shoulder X" value={signed(motion.upperBody?.translationX)} />
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
            metric="neutral-shoulder-width"
            label="Neutral shoulder width"
            value={ratio(profile?.pose.shoulderWidth)}
          />
          <Row
            metric="neutral-shoulder-angle"
            label="Neutral shoulder angle"
            value={degrees(profile?.pose.shoulderAngle)}
          />
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
          <Row metric="pose-inferences" label="Pose inferences" value={count(stats?.poseInferences)} />
          <Row metric="dropped-frames" label="Dropped frames" value={count(stats?.droppedFrames)} />
          <Row metric="camera-fps" label="Camera rate" value={fps(stats?.cameraFps)} />
          <Row metric="face-ms" label="Face inference" value={ms(stats?.faceAverageMs)} />
          <Row metric="pose-ms" label="Pose inference" value={ms(stats?.poseAverageMs)} />
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
          <Row metric="pose-init" label="Pose model init" value={ms(summary.poseInitMs)} />
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
        </dl>
      </section>

      <section>
        <h3>Pose</h3>
        <dl>
          <Row metric="pose-landmarks" label="Landmarks" value={count(pose?.landmarks.length)} />
          <Row
            metric="pose-trackability"
            label="Trackability"
            value={derivedPose?.trackability ?? MISSING}
            plain
          />
          <Row metric="pose-shoulder-width" label="Shoulder width" value={ratio(derivedPose?.shoulderWidth)} />
          <Row metric="pose-shoulder-angle" label="Shoulder angle" value={degrees(derivedPose?.shoulderAngle)} />
          <Row metric="pose-visibility" label="Visibility" value={ratio(derivedPose?.visibility, 2)} />
        </dl>
      </section>

      <section>
        <h3>Segmentation</h3>
        {segmentation ? (
          <dl>
            <Row
              metric="segmentation-mask"
              label="Mask"
              value={pose?.segmentation.available ? "present" : "absent"}
              plain
            />
            <Row
              metric="segmentation-size"
              label="Size"
              value={
                pose?.segmentation.width && pose.segmentation.height
                  ? `${pose.segmentation.width} × ${pose.segmentation.height}`
                  : MISSING
              }
            />
            <Row
              metric="segmentation-representation"
              label="Held as"
              value={pose?.segmentation.representation ?? MISSING}
              plain
            />
          </dl>
        ) : (
          <p className="studio-note">
            Off. Turning it on rebuilds the pose task and adds a mask to every inference — compare the pose
            inference time above before and after.
          </p>
        )}
        <p className="studio-note">
          The mask is measured, not drawn. Copying its pixels out of the GPU is a later milestone.
        </p>
      </section>
    </div>
  );
}

export default StudioDiagnostics;
