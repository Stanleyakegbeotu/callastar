import { useState } from "react"
import type { StudioRuntime } from "../useStudioRuntime"
import type { FaceRendererStats } from "../../engine/rendering/FaceRenderer"
import { physicalOrientation } from "../../engine/rigidFaceMotion"
import { MOUTH_SHAPES } from '../../engine/mouthControls'

export const MOUTH_NOSE_SEQUENCE = [
  "A: Neutral",
  "B: Jaw 0 → 25 → 50 → 75 → 100%",
  "C: Press lips",
  "D: Purse / kiss",
  "E: O / oo",
  "F: EE / wide",
  "G: Left smile",
  "H: Right smile",
  "I: Full smile",
  "J: Frown each side",
  "K: Upper lip raise each side",
  "L: Lower lip down each side",
  "M: Smile + open jaw",
  "N: Jaw open + head turn",
  "O: Mouth shapes + pitch",
  "P: Teeth with live interior",
  "Q: Tongue with live interior",
  "R: Closed-mouth source",
  "S: Already-open source",
  "Nose: Look up / center / down / center / left / right; sneer each side; jaw with neutral nose",
  "Eyes: Blink / wink / hold / wide / gaze; repeat while turning",
] as const
const value = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(3) : "unavailable"
export default function MouthNoseDiagnostics({
  runtime,
  stats,
  liveInterior,
}: {
  runtime: StudioRuntime
  stats: FaceRendererStats | null
  liveInterior: boolean
}) {
  const [step, setStep] = useState<number | null>(null)
  const m = runtime.summary.expression?.mouth,
    n = runtime.summary.expression?.nose
  const head = runtime.summary.face?.derived
  const pose = head ? physicalOrientation(head) : null
  const metrics: Record<string, number | null | undefined> = {
    jawOpen: m?.jaw.open,
    aperture: m?.aperture.measured,
    width: m?.aperture.width,
    ...m?.lips,
    ...m?.corners,
    mouthCenterX: m?.measured?.centerX,
    mouthCenterY: m?.measured?.centerY,
    upperLipLeft: m?.measured?.upperLeftY,
    upperLipRight: m?.measured?.upperRightY,
    lowerLipLeft: m?.measured?.lowerLeftY,
    lowerLipRight: m?.measured?.lowerRightY,
    cornerLeftX: m?.measured?.cornerLeftX,
    cornerLeftY: m?.measured?.cornerLeftY,
    cornerRightX: m?.measured?.cornerRightX,
    cornerRightY: m?.measured?.cornerRightY,
    compressed: m?.shape.compressed,
    mouthConfidence: m?.confidence,
    noseYaw: pose?.yaw,
    nosePitch: pose?.pitch,
    sneerLeft: n?.supported.left ? n.sneerLeft : null,
    sneerRight: n?.supported.right ? n.sneerRight : null,
    nostrilLeft: n?.geometry?.left,
    nostrilRight: n?.geometry?.right,
    noseConfidence: n?.confidence,
    interiorOpacity: stats?.mouthFeedOpacity,
    compositorMs: stats?.mouthCompositorMs,
    expressionMs: stats?.expressionMs,
    rendererFps: stats?.fps,
    liveFrameAgeMs: stats?.oral?.frameAgeMs,
    maskAreaPx: stats?.oral?.maskAreaPx,
    faceWidthPx: stats?.oral?.faceWidthPx,
    mouthWidthPx: stats?.oral?.mouthWidthPx,
    featherSigmaPx: stats?.oral?.featherSigmaPx,
    warpedPixels: stats?.oral?.warpedPixels,
    averageLuminance: stats?.oral?.averageLuminance,
    teethVisibleEstimate: stats?.oral?.teethVisibleEstimate,
    tongueConfidence: stats?.oral?.tongueConfidence,
    oralDroppedFrames: stats?.oral?.droppedFrames,
    cameraTimestampMs: stats?.oral?.cameraTimestampMs,
    faceResultTimestampMs: stats?.oral?.faceResultTimestampMs,
    mouthControlsTimestampMs: stats?.oral?.controlsTimestampMs,
    oralSourceTimestampMs: stats?.oral?.oralSourceTimestampMs,
    renderTimestampMs: stats?.oral?.renderTimestampMs,
    renderedAperturePx: stats?.mouthMeshAperturePx?.applied,
    noseDepth: stats?.nosePerspective?.depth,
    nostrilVisibilityProxy: stats?.nosePerspective?.visibility,
    requestedPitch: stats?.nosePerspective?.requestedPitch,
    appliedPitch: stats?.nosePerspective?.appliedPitch,
  }
  for(const [key,model] of [['rollUpper','mouthRollUpper'],['rollLower','mouthRollLower'],['pressLeft','mouthPressLeft'],['pressRight','mouthPressRight'],['dimpleLeft','mouthDimpleLeft'],['dimpleRight','mouthDimpleRight']] as const)
    if(m?.missing.includes(model))metrics[key]=null
  const age = runtime.summary.expression?.updatedAtMs
  const mask =
    stats?.mouthMaskStatus ??
    (!liveInterior
      ? "disabled"
      : !runtime.summary.expression?.liveMouth
        ? "unavailable"
        : age !== undefined && performance.now() - age >= 250
          ? "stale"
          : "waiting for renderer")
  return (
    <section className="studio-card tracker-lab mouth-nose-diagnostics">
      <details>
        <summary>Mouth / Nose Diagnostics · Developer</summary>
        <p className="studio-note">
          Anatomical left/right. Eyes remain active and locked. Mouth and nose:
          M8.8 awaiting physical acceptance. Teeth visibility is a pixel estimate.
        </p>
        <dl>
          {Object.entries(metrics).map(([key, v]) => (
            <div
              className="tracker-lab-metric"
              data-mouth-metric={key}
              key={key}
            >
              <dt>{key}</dt>
              <dd>{value(v)}</dd>
            </div>
          ))}
        </dl>
        <p>
          Live interior: {liveInterior ? "enabled" : "disabled"} · Mask: {mask}
        </p>
        <p>Mode: {stats?.oral?.mode ?? 'unavailable'} · Compositor: {stats?.oral?.active ? 'active' : 'inactive'} · Camera frame: {stats?.oral?.frameAvailable ? 'available' : 'unavailable'} · Polygon: {stats?.oral?.polygonValid ? 'valid' : 'unavailable / invalid'}</p>
        <p className="studio-note">Tongue mask: inactive · Extended mask: inactive · Protrusion deferred — segmenter required. Camera/result/controls timestamps share the camera media clock when paired pixels are present; render and completion age use the performance clock.</p>
        <details><summary>Oral bounds and model signals</summary>
          <p className="studio-note">Crop: {JSON.stringify(stats?.oral?.cropBounds ?? null)} · Mask: {JSON.stringify(stats?.oral?.maskBounds ?? null)}</p>
          <dl>{MOUTH_SHAPES.map(key=><div className="tracker-lab-metric" key={key}><dt>{key} (model)</dt><dd>{value(runtime.summary.face?.blendshapes[key])}</dd></div>)}</dl>
        </details>
        <p className="studio-note">
          Unavailable model signals:{" "}
          {m?.missing.join(", ") || "none reported / awaiting calibration"}.
          Nose sneer: L {n?.supported.left ? "supported" : "unavailable"}, R{" "}
          {n?.supported.right ? "supported" : "unavailable"}.
        </p>
        <details>
          <summary>Mouth / Nose sequence A–S</summary>
          <div className="tracker-lab-actions">
            <button
              type="button"
              className="studio-control"
              onClick={() => setStep(0)}
            >
              Start mouth sequence
            </button>
            <button
              type="button"
              className="studio-control"
              disabled={step === null}
              onClick={() =>
                setStep((s) =>
                  s === null
                    ? null
                    : Math.min(MOUTH_NOSE_SEQUENCE.length - 1, s + 1),
                )
              }
            >
              Next mouth test
            </button>
            <button
              type="button"
              className="studio-control"
              onClick={() => setStep(null)}
            >
              Reset mouth sequence
            </button>
          </div>
          {step !== null && <p role="status">{MOUTH_NOSE_SEQUENCE[step]}</p>}
          <ol>
            {MOUTH_NOSE_SEQUENCE.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      </details>
    </section>
  )
}
