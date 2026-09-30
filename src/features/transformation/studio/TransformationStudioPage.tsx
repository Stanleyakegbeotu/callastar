import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";
import { AdminPageHeader } from "@/features/admin/layout/AdminPageHeader";
import { useProfiles } from "@/features/admin/hooks/useAdminData";

import type { QualityMode } from "../engine/trackingScheduler";

import { describeCalibration } from "./calibrationGuidance";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { SourcePanel } from "./components/SourcePanel";
import { StudioDiagnostics } from "./components/StudioDiagnostics";
import { StudioStepRail } from "./components/StudioStepRail";
import { deriveStudioSteps } from "./studioSteps";
import { useSourceSelection } from "./useSourceSelection";
import { useStudioRuntime } from "./useStudioRuntime";
import type { FaceRendererStats } from "../engine/rendering/FaceRenderer";
import { EXPRESSION_KEYS, NEUTRAL_EXPRESSION, describeBlendshapeCoverage, type ExpressionKey, type ExpressionMotion, type ExpressionValues } from "../engine/expressionMotion";
import { avatarMotionFromTracking, restrictToCapabilities } from "../avatar/avatarMotion";
import type { AvatarMotion } from "../avatar/avatarTypes";
import type { AvatarRendererStats, ThreeAvatarRenderer } from "../avatar/ThreeAvatarRenderer";
import { AvatarPanel } from "./components/AvatarPanel";

/** `avatar` is the experimental 3D path; `face` is the existing M7/M8 renderer. */
type PreviewMode = "raw" | "face" | "avatar";

/**
 * Transformation Studio — live tracking and experimental face rendering.
 *
 * The live camera and tracker remain the source of operator motion. The Preview
 * step can now warp one analysed source face with a fixed mesh; it does not
 * create a call output or modify the existing call flow.
 *
 * Mobile-first, because that is where this has to work: the preview owns the
 * screen and everything else stacks beneath it. Nothing about the camera starts
 * until the operator asks for it.
 */

const QUALITY_MODES: { id: QualityMode; label: string; hint: string }[] = [
  { id: "performance", label: "Performance", hint: "320px frames, fewer inferences" },
  { id: "balanced", label: "Balanced", hint: "480px frames" },
  { id: "quality", label: "Quality", hint: "640px frames, most inferences" },
];

export function TransformationStudioPage() {
  const runtime = useStudioRuntime();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("raw");
  const [rendererStats, setRendererStats] = useState<FaceRendererStats | null>(null);
  const [avatarStats, setAvatarStats] = useState<AvatarRendererStats | null>(null);
  const [avatarManualEnabled, setAvatarManualEnabled] = useState(false);
  const [avatarManualValues, setAvatarManualValues] = useState<ExpressionValues>({ ...NEUTRAL_EXPRESSION });
  const avatarCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarRendererRef = useRef<ThreeAvatarRenderer | null>(null);
  const [showMesh, setShowMesh] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualValues, setManualValues] = useState<ExpressionValues>({ ...NEUTRAL_EXPRESSION });
  const manualExpressionRef = useRef<ExpressionMotion | null>(null);
  const rendererCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const rendererRef = useRef<import("../engine/rendering/FaceRenderer").FaceRenderer | null>(null);

  const [searchParams] = useSearchParams();
  const profiles = useProfiles();

  /*
   * Which profile this source is for.
   *
   * Preselected from the query when the Studio was opened from a profile. With
   * no request, only a single-profile install resolves automatically — picking
   * the first of several would prepare a face for whoever happened to sort
   * first, which is the one mistake this step must not make quietly.
   */
  const requestedProfileId = searchParams.get("profile");
  const activeProfile = useMemo(() => {
    const list = profiles.data ?? [];
    const requested = list.find((entry) => entry.id === requestedProfileId);
    if (requested) return requested;
    return list.length === 1 ? list[0]! : null;
  }, [profiles.data, requestedProfileId]);

  const source = useSourceSelection(activeProfile?.id ?? null);
  const lastSourceRef = useRef(source.asset);

  useEffect(() => {
    if (lastSourceRef.current === source.asset) return;
    lastSourceRef.current = source.asset;
    setPreviewMode("raw");
    setRendererStats(null);
    setAvatarStats(null);
    setAvatarManualEnabled(false);
    setAvatarManualValues({ ...NEUTRAL_EXPRESSION });
    setManualEnabled(false);
    setManualValues({ ...NEUTRAL_EXPRESSION });
  }, [source.asset]);

  manualExpressionRef.current = manualEnabled
    ? { ...manualValues, status: "manual", calculationMs: 0 }
    : null;

  useEffect(() => {
    if (previewMode !== "face") {
      manualExpressionRef.current = null;
      setManualEnabled(false);
    }
  }, [previewMode]);

  useEffect(() => {
    rendererRef.current?.setDiagnostics({ showMesh, wireframe });
  }, [showMesh, wireframe]);

  const canRenderFace = source.stage === "ready" && !!source.profile && !!source.asset &&
    (runtime.calibration.phase === "ready" || (previewMode === "face" && rendererRef.current !== null));

  // The Three chunk and WebGL context are loaded only after the operator opens
  // the experimental face preview. The renderer never calls a tracker.
  useEffect(() => {
    let cancelled = false;
    const disposeCurrent = () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    if (previewMode !== "face" || !canRenderFace || !rendererCanvasRef.current || !source.asset || !source.profile) {
      disposeCurrent();
      setRendererStats(null);
      return;
    }

    const canvas = rendererCanvasRef.current;
    const rendererSource = source.asset;
    const rendererProfile = source.profile;
    void import("../engine/rendering/FaceRenderer").then(async ({ FaceRenderer }) => {
      if (cancelled) return;
      const renderer = new FaceRenderer({
        canvas,
        asset: rendererSource,
        profile: rendererProfile,
        sourceVideoRef,
        motion: runtime.motionRef,
        expression: runtime.expressionRef,
        manualExpression: manualExpressionRef,
        paused: runtime.renderPausedRef,
        onStats: setRendererStats,
      });
      rendererRef.current = renderer;
      await renderer.initialize();
      if (cancelled) {
        renderer.dispose();
        return;
      }
      const resize = () => renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      cleanupResize = () => observer.disconnect();
    }).catch((error: unknown) => {
      if (!cancelled) setRendererStats({
        status: "failed", fps: null, renderMs: null, frames: 0, droppedFrames: 0,
        requested: null, applied: null, clamped: [],
        expressionRequested: null, expressionApplied: null, expressionLimits: null,
        vertexDisplacementMax: 0, vertexDisplacementPx: 0, faceWidthPx: 0, expressionTrace: null,
        expressionClamped: [], expressionMs: null, deformationMs: null,
        message: error instanceof Error ? error.message : "The experimental face renderer could not start.",
      });
    });
    let cleanupResize = () => {};
    return () => {
      cancelled = true;
      cleanupResize();
      disposeCurrent();
    };
  }, [previewMode, canRenderFace, source.asset, source.profile, runtime.motionRef, runtime.expressionRef, runtime.renderPausedRef]);

  /*
   * Read-through refs, so the avatar renderer needs no loop of its own.
   *
   * `current` is a getter rather than a stored value: the renderer reads it once
   * per frame from inside its existing animation loop, so the motion is always
   * fresh without a second loop anywhere. A stored value would need something to
   * write it, and that something would be the duplicate render loop this feature
   * is not allowed to have.
   */
  const calibratedRef = useRef(false);
  calibratedRef.current = runtime.calibration.phase === "ready";
  const avatarModelRef = useRef(source.avatar);
  avatarModelRef.current = source.avatar;
  const avatarManualRef = useRef<{ enabled: boolean; values: ExpressionValues }>({
    enabled: false,
    values: { ...NEUTRAL_EXPRESSION },
  });
  avatarManualRef.current = { enabled: avatarManualEnabled, values: avatarManualValues };

  const avatarMotionRef = useMemo(
    () => ({
      get current(): AvatarMotion {
        const motion = avatarMotionFromTracking({
          motion: runtime.motionRef.current,
          expression: runtime.expressionRef.current,
          calibrated: calibratedRef.current,
        });
        const capabilities = avatarModelRef.current?.profile.capabilities;
        // Expressions the rig cannot perform are zeroed here, so diagnostics can
        // show a live value arriving with nowhere to send it.
        return capabilities ? restrictToCapabilities(motion, capabilities) : motion;
      },
    }),
    [runtime.motionRef, runtime.expressionRef],
  );

  const avatarManualMotionRef = useMemo(
    () => ({
      get current(): AvatarMotion | null {
        const manual = avatarManualRef.current;
        if (!manual.enabled) return null;
        return {
          // Head stays live while the sliders drive the face, so a rig can be
          // tested without having to hold perfectly still.
          head: avatarMotionFromTracking({
            motion: runtime.motionRef.current,
            expression: null,
            calibrated: calibratedRef.current,
          }).head,
          face: { ...manual.values },
          tracking: { faceTracked: true, calibrated: calibratedRef.current, quality: null },
        };
      },
    }),
    [runtime.motionRef],
  );

  /**
   * The avatar renderer's lifetime.
   *
   * Mirrors the face renderer's effect, including its teardown, so switching
   * between preview modes or sources can never leave two renderers running. The
   * import is dynamic for the same reason Three.js is elsewhere: opening the
   * Studio must not pay for a renderer nobody opened.
   */
  useEffect(() => {
    let cancelled = false;
    let cleanupResize = () => {};
    const disposeCurrent = () => {
      avatarRendererRef.current?.dispose();
      avatarRendererRef.current = null;
    };

    if (previewMode !== "avatar" || !avatarCanvasRef.current || !source.avatar) {
      disposeCurrent();
      setAvatarStats(null);
      return;
    }

    const canvas = avatarCanvasRef.current;
    const model = source.avatar;

    void import("../avatar/ThreeAvatarRenderer")
      .then(async ({ ThreeAvatarRenderer: Renderer }) => {
        if (cancelled) return;
        const renderer = new Renderer({
          canvas,
          model,
          motion: avatarMotionRef,
          manualMotion: avatarManualMotionRef,
          paused: runtime.renderPausedRef,
          mirror: "selfie",
          onStats: setAvatarStats,
        });
        avatarRendererRef.current = renderer;
        await renderer.initialize();
        if (cancelled) {
          renderer.dispose();
          return;
        }
        const resize = () => renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        cleanupResize = () => observer.disconnect();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAvatarStats({
          status: "failed",
          fps: null,
          renderMs: null,
          frames: 0,
          message: error instanceof Error ? error.message : "The avatar renderer could not start.",
          requestedHead: null,
          appliedHead: null,
          requestedExpressions: null,
          appliedExpressions: null,
          unsupported: [],
          faceTracked: false,
          calibrated: false,
          webglAvailable: false,
        });
      });

    return () => {
      cancelled = true;
      cleanupResize();
      disposeCurrent();
    };
  }, [previewMode, source.avatar, avatarMotionRef, avatarManualMotionRef, runtime.renderPausedRef]);

  /** Assets already on this profile that could stand in as a source. */
  const storedOptions = useMemo(() => {
    if (!activeProfile) return [];
    const options: { assetId: string; label: string }[] = [];
    if (activeProfile.avatarAssetId) options.push({ assetId: activeProfile.avatarAssetId, label: "Profile avatar" });
    if (activeProfile.remoteVideoAssetId) {
      options.push({ assetId: activeProfile.remoteVideoAssetId, label: "Call source video" });
    }
    return options;
  }, [activeProfile]);

  const { state, summary, calibration } = runtime;
  /**
   * Which expected blendshape categories this model build actually reports.
   *
   * Checked against the live frame rather than assumed, because a category
   * renamed between builds would otherwise present as an expression that does
   * not work — and would be indistinguishable from a deformer fault.
   */
  const blendshapeCoverage = useMemo(
    () => (summary.face?.blendshapes ? describeBlendshapeCoverage(summary.face.blendshapes) : null),
    [summary.face],
  );

  const steps = useMemo(
    () => deriveStudioSteps(state, calibration.phase, source.stage),
    [state, calibration.phase, source.stage],
  );
  const calibrationGuidance = useMemo(() => describeCalibration(calibration), [calibration]);
  const calibrating =
    calibration.phase === "waiting-for-stable-tracking" ||
    calibration.phase === "collecting" ||
    calibration.phase === "evaluating";

  const isLoading = state.phase === "loading-dependencies" || state.phase === "loading-models";
  const isRequestingCamera = state.phase === "camera-request";
  const isLive = state.camera === "live" || state.camera === "switching";
  const isPaused = state.phase === "paused";
  const hasFailed = state.phase === "failed";
  const isIdle = state.phase === "idle" || state.phase === "disposed";

  return (
    <div className="studio-page">
      <AdminPageHeader
        title="Transformation Studio"
        description="Live tracking with an experimental, face-only source preview."
      />

      <StudioStepRail steps={steps} />

      <div className="studio-layout">
        <section className="studio-stage" aria-label="Camera preview">
          <div className={`studio-viewport ${runtime.facing === "user" ? "is-mirrored" : ""} ${previewMode === "face" ? "is-face-render-preview" : ""}`}>
            <video
              ref={runtime.videoRef}
              className="studio-video"
              playsInline
              muted
              // The Studio previews appearance. It never asks for, records or
              // plays audio.
              autoPlay
            />
            <canvas ref={runtime.overlayRef} className="studio-overlay" aria-hidden="true" />

            {/*
              * The source, shown large.
              *
              * Prominent rather than tucked into a card: the operator is
              * judging whether this is the right face, and a thumbnail in a
              * sidebar does not let them. Sits under the idle placeholder so
              * starting a camera replaces it.
              */}
            {source.previewUrl && (previewMode === "raw" || rendererStats?.status === "failed") && (
              <div className="studio-source-preview">
                {source.asset?.kind === "video" ? (
                  <video ref={sourceVideoRef} src={source.previewUrl} playsInline muted preload="metadata" />
                ) : (
                  <img src={source.previewUrl} alt={`Source: ${source.asset?.fileName ?? "selected file"}`} />
                )}
              </div>
            )}
            {source.previewUrl && source.asset?.kind === "video" && previewMode === "face" && (
              <video ref={sourceVideoRef} src={source.previewUrl} className="studio-source-decoder" playsInline muted preload="metadata" />
            )}
            <canvas ref={rendererCanvasRef} className={`studio-face-renderer ${previewMode === "face" ? "is-visible" : ""}`} aria-label="Experimental face renderer preview" />
            <canvas
              ref={avatarCanvasRef}
              className={`studio-face-renderer ${previewMode === "avatar" ? "is-visible" : ""}`}
              aria-label="Experimental 3D avatar preview"
            />

            {isIdle && !source.previewUrl && (
              <div className="studio-placeholder">
                <Icon name="camera" className="size-8" />
                <h2>Live tracking preview</h2>
                <p>
                  Starts the camera on this device, loads the face and pose models, and draws what they see.
                  Nothing is uploaded, stored or sent anywhere.
                </p>
                <button type="button" className="studio-primary" onClick={runtime.start}>
                  Start camera
                </button>
              </div>
            )}

            {(isLoading || isRequestingCamera) && (
              <div className="studio-placeholder" role="status">
                <span className="studio-spinner" aria-hidden="true" />
                <p>{isRequestingCamera ? "Waiting for camera permission" : (state.loadingStage ?? "Loading")}</p>
              </div>
            )}

            {hasFailed && (
              <div className="studio-placeholder is-error" role="alert">
                <Icon name="info" className="size-8" />
                <h2>{state.camera === "denied" ? "Camera blocked" : "Could not start"}</h2>
                <p>{state.error}</p>
                <button type="button" className="studio-primary" onClick={runtime.stop}>
                  Reset
                </button>
              </div>
            )}

            {/*
              * A restrained framing guide: one soft oval where a head belongs,
              * and a line where shoulders do. No scanning grid, no reticle —
              * this is somebody being asked to sit still for a second, not a
              * biometric enrolment, and it must not look like one.
              */}
            {calibrating && (
              <div className="studio-calibration-guide" aria-hidden="true">
                <span className="studio-guide-face" />
                {calibration.mode === "full" && <span className="studio-guide-shoulders" />}
              </div>
            )}

            {calibrating && (
              <div className="studio-calibration-message" role="status">
                <strong>{calibrationGuidance.message}</strong>
                {calibrationGuidance.detail && <span>{calibrationGuidance.detail}</span>}
              </div>
            )}

            {isLive && !calibrating && (
              <div className={`studio-status is-${summary.guidance.quality}`} role="status">
                <span className="studio-status-dot" aria-hidden="true" />
                <strong>{summary.guidance.label}</strong>
                <span>{summary.guidance.detail}</span>
              </div>
            )}
          </div>

          {/*
            * With a source showing, the camera control moves below the stage.
            *
            * The two halves are independent — a source is prepared without a
            * camera, and tracking runs without a source — so neither may hide
            * the other's way in.
            */}
          {isIdle && source.previewUrl && (
            <div className="studio-controls">
              <button type="button" className="studio-control" onClick={runtime.start}>
                <Icon name="camera" className="size-5" />
                <span>Start camera</span>
              </button>
            </div>
          )}

          {isLive && (
            <div className="studio-controls">
              <button type="button" className="studio-control" onClick={runtime.togglePause}>
                <Icon name={isPaused ? "video" : "cameraOff"} className="size-5" />
                <span>{isPaused ? "Resume tracking" : "Pause tracking"}</span>
              </button>
              <button
                type="button"
                className="studio-control"
                onClick={runtime.flipCamera}
                disabled={state.camera === "switching"}
              >
                <Icon name="flip" className="size-5" />
                <span>Flip camera</span>
              </button>
              <button type="button" className="studio-control is-danger" onClick={runtime.stop}>
                <Icon name="phoneOff" className="size-5" />
                <span>Stop</span>
              </button>
            </div>
          )}
          <section className="studio-card studio-render-preview-controls" aria-label="Face renderer preview">
            <h2>Face Renderer Preview · Experimental</h2>
            {source.previewUrl && source.asset && (
              <div className="studio-render-source-thumb">
                {source.asset.kind === "image" ? (
                  <img src={source.previewUrl} alt="Selected face source thumbnail" />
                ) : (
                  <span className="studio-render-video-thumb" aria-label="Video source"><Icon name="video" className="size-5" /></span>
                )}
                <span><small>Source</small><strong>{source.asset.fileName}</strong></span>
              </div>
            )}
            <div className="studio-preview-modes" role="group" aria-label="Preview mode">
              <button type="button" aria-pressed={previewMode === "raw"} onClick={() => setPreviewMode("raw")}>Raw source</button>
              <button type="button" aria-pressed={previewMode === "face"} onClick={() => setPreviewMode("face")} disabled={!canRenderFace}>Face render</button>
              {/* Offered only for a 3D source, so it cannot be pressed with nothing to show. */}
              <button
                type="button"
                aria-pressed={previewMode === "avatar"}
                onClick={() => setPreviewMode("avatar")}
                disabled={!source.avatar}
              >
                3D Avatar
              </button>
            </div>
            <button type="button" className="studio-control" disabled>Save transformation</button>
            {!canRenderFace && <p className="studio-note">Choose and analyze a source, start the camera, and calibrate to enable the experimental preview.</p>}
            {previewMode === "face" && runtime.calibrationInvalidation === "camera-facing-changed" && (
              <p className="studio-alert" role="status">Move back into view and recalibrate before the preview resumes.</p>
            )}
            {rendererStats?.status === "lost" && <p className="studio-alert" role="status">Move back into view to continue the face preview.</p>}
            {previewMode === "face" && rendererStats?.status === "ready" && <p className="studio-note">Expressions active</p>}
            {rendererStats?.status === "failed" && <p className="studio-alert" role="alert">{rendererStats.message ?? "Face renderer unavailable."} The camera and tracker are still running.</p>}
            {previewMode === "face" && rendererStats?.status !== "failed" && (
              <div className="studio-render-options">
                <label><input type="checkbox" checked={showMesh} onChange={(event) => setShowMesh(event.target.checked)} /> Show mesh</label>
                <label><input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} /> Wireframe</label>
              </div>
            )}
            {/*
              * Avatar diagnostics.
              *
              * Reported values only, and the ones that separate the three possible
              * faults: fps proves the loop runs, applied-versus-requested proves the
              * motion reached the model, and the unsupported list proves whether a
              * live expression had anywhere to go.
              */}
            {previewMode === "avatar" && avatarStats && (
              <div className="studio-render-diagnostics" aria-live="polite" data-avatar-diagnostics>
                <span data-avatar-metric="status">Avatar {avatarStats.status}</span>
                <span data-avatar-metric="fps">{avatarStats.fps?.toFixed(1) ?? "—"} fps</span>
                <span data-avatar-metric="ms">{avatarStats.renderMs?.toFixed(1) ?? "—"} ms</span>
                <span data-avatar-metric="frames">{avatarStats.frames} frames</span>
                <span data-avatar-metric="webgl">{avatarStats.webglAvailable ? "WebGL ok" : "no WebGL"}</span>
                <span data-avatar-metric="tracking">
                  {avatarStats.faceTracked ? "tracking" : "no face"}
                  {avatarStats.calibrated ? " · calibrated" : " · uncalibrated"}
                </span>
                {avatarStats.appliedHead && (
                  <span data-avatar-metric="head">
                    yaw {avatarStats.appliedHead.yaw.toFixed(3)} · pitch {avatarStats.appliedHead.pitch.toFixed(3)} ·
                    roll {avatarStats.appliedHead.roll.toFixed(3)} · scale {avatarStats.appliedHead.scale.toFixed(2)}
                  </span>
                )}
                {avatarStats.unsupported.length > 0 && (
                  <span data-avatar-metric="unsupported">
                    No morph for: {avatarStats.unsupported.join(", ")}
                  </span>
                )}
                {avatarStats.requestedExpressions && avatarStats.appliedExpressions && (
                  <details>
                    <summary>Expression raw / applied</summary>
                    {EXPRESSION_KEYS.map((key) => (
                      <code key={key}>
                        {key} raw {avatarStats.requestedExpressions![key].toFixed(2)} · applied{" "}
                        {avatarStats.appliedExpressions![key].toFixed(2)}
                      </code>
                    ))}
                  </details>
                )}
                {avatarStats.message && <span data-avatar-metric="message">{avatarStats.message}</span>}
              </div>
            )}

            {previewMode === "face" && rendererStats?.status === "ready" && (
              <div className="studio-render-diagnostics" aria-live="polite">
                <span>Renderer {rendererStats.fps?.toFixed(1) ?? "—"} fps</span>
                <span>{rendererStats.renderMs?.toFixed(1) ?? "—"} ms</span>
                <span>{rendererStats.droppedFrames} dropped</span>
                <span>Clamped: {rendererStats.clamped.join(", ") || "none"}</span>
                <details>
                  <summary>Requested / applied motion</summary>
                  <code>requested {JSON.stringify(rendererStats.requested)}</code>
                  <code>applied {JSON.stringify(rendererStats.applied)}</code>
                </details>
              </div>
            )}
          </section>
        </section>

        <aside className="studio-panel" aria-label="Tracking settings">
          {source.avatar && (
            <AvatarPanel
              model={source.avatar}
              manual={
                import.meta.env.DEV
                  ? {
                      enabled: avatarManualEnabled,
                      values: avatarManualValues,
                      onToggle: setAvatarManualEnabled,
                      onChange: (key: ExpressionKey, value: number) =>
                        setAvatarManualValues((previous) => ({ ...previous, [key]: value })),
                    }
                  : null
              }
            />
          )}

          <SourcePanel
            source={source}
            profile={activeProfile}
            storedOptions={storedOptions}
            profileChoices={profiles.data ?? []}
          />

          <CalibrationPanel
            calibration={calibration}
            invalidation={runtime.calibrationInvalidation}
            cameraLive={isLive}
            onStart={runtime.startCalibration}
            onCancel={runtime.cancelCalibration}
            onRecalibrate={runtime.clearCalibration}
          />

          <section className="studio-card">
            <h2>Overlays</h2>
            <label className="studio-switch">
              <input
                type="checkbox"
                checked={runtime.showFace}
                onChange={(event) => runtime.setShowFace(event.target.checked)}
              />
              <span>Face mesh</span>
            </label>
            <label className="studio-switch">
              <input
                type="checkbox"
                checked={runtime.showPose}
                onChange={(event) => runtime.setShowPose(event.target.checked)}
              />
              <span>Shoulders and torso</span>
            </label>
            <label className="studio-switch">
              <input
                type="checkbox"
                checked={runtime.segmentation}
                disabled={runtime.segmentationBusy || !isLive}
                onChange={(event) => runtime.setSegmentation(event.target.checked)}
              />
              <span>
                Segmentation
                {runtime.segmentationBusy && <em> — rebuilding pose task…</em>}
              </span>
            </label>
          </section>

          <section className="studio-card">
            <h2>Quality</h2>
            <div className="studio-modes" role="group" aria-label="Tracking quality">
              {QUALITY_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`studio-mode ${runtime.quality === mode.id ? "is-active" : ""}`}
                  aria-pressed={runtime.quality === mode.id}
                  onClick={() => runtime.setQuality(mode.id)}
                >
                  <strong>{mode.label}</strong>
                  <small>{mode.hint}</small>
                </button>
              ))}
            </div>
            <p className="studio-note">
              Changing quality adjusts frame size and how often each model runs. It never reloads the models.
            </p>
          </section>

          <section className="studio-card">
            <button
              type="button"
              className="studio-disclosure"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((open) => !open)}
            >
              <h2>Diagnostics</h2>
              <Icon name="chevron" className={`size-5 ${diagnosticsOpen ? "is-open" : ""}`} />
            </button>
            {diagnosticsOpen && (<>
              <StudioDiagnostics
                summary={summary}
                quality={runtime.quality}
                segmentation={runtime.segmentation}
                calibration={calibration}
              />
              {previewMode === "face" && rendererStats && (
                <div className="studio-expression-diagnostics">
                  <h3>Expressions {manualEnabled ? "· Manual DEV" : "· Live"}</h3>
                  <p>Calculation {rendererStats.expressionMs?.toFixed(2) ?? "—"} ms · Deformation {rendererStats.deformationMs?.toFixed(2) ?? "—"} ms</p>
                  {/*
                    * Mesh movement, in pixels, beside the face it moves.
                    *
                    * The measurement the real-device failures needed: an applied
                    * value of 0.45 next to two pixels means the deformer is too
                    * weak, and the same value next to zero means the vertices are
                    * wrong. Reported together because neither number means
                    * anything alone.
                    */}
                  <p>
                    Mesh movement {rendererStats.vertexDisplacementPx.toFixed(1)} px
                    {" · "}face {rendererStats.faceWidthPx.toFixed(0)} px wide
                    {" · "}source Δ {rendererStats.vertexDisplacementMax.toFixed(4)}
                  </p>
                  {blendshapeCoverage && blendshapeCoverage.missing.length > 0 && (
                    /* A category this model build does not report would otherwise
                       read as an expression that simply does not work. */
                    <p className="studio-alert" role="status">
                      Not reported by this model build: {blendshapeCoverage.missing.join(", ")}
                    </p>
                  )}
                  <div className="studio-expression-row studio-expression-head">
                    <span>expression</span>
                    <span>raw</span>
                    <span>neutral</span>
                    <span>norm</span>
                    <span>src max</span>
                    <span>applied</span>
                    <span>from</span>
                  </div>
                  {EXPRESSION_KEYS.map((key) => {
                    const trace = rendererStats.expressionTrace?.[key];
                    return (
                      <div className="studio-expression-row" key={key}>
                        <span>{key}</span>
                        <span>{trace?.blendshape === null || trace === undefined ? "—" : trace.blendshape.toFixed(2)}</span>
                        <span>{trace ? trace.neutral.toFixed(2) : "—"}</span>
                        <span>{trace ? trace.normalized.toFixed(2) : (rendererStats.expressionRequested?.[key] ?? 0).toFixed(2)}</span>
                        <span>{(rendererStats.expressionLimits?.[key] ?? 1).toFixed(2)}</span>
                        <span>{(rendererStats.expressionApplied?.[key] ?? 0).toFixed(2)}</span>
                        <span>{trace ? (trace.origin === "geometry" ? "geom" : "shape") : "—"}</span>
                        {rendererStats.expressionClamped.includes(key) && <span>clamped</span>}
                      </div>
                    );
                  })}
                  {import.meta.env.DEV && <div className="studio-expression-manual">
                    <label><input type="checkbox" checked={manualEnabled} onChange={(event) => setManualEnabled(event.target.checked)} /> Manual expression override</label>
                    {manualEnabled && EXPRESSION_KEYS.map((key) => <label key={key}>
                      {key} {manualValues[key].toFixed(2)}
                      <input type="range" min="0" max="1" step="0.01" value={manualValues[key]}
                        onChange={(event) => setManualValues((current) => ({ ...current, [key]: Number(event.target.value) }))} />
                    </label>)}
                  </div>}
                </div>
              )}
            </>)}
          </section>

          <p className="studio-privacy">
            <Icon name="shield" className="size-4" />
            <span>
              Tracking runs entirely on this device. Landmarks exist for the frame that produced them and are
              never stored, logged or sent anywhere.
            </span>
          </p>
        </aside>
      </div>
    </div>
  );
}

export default TransformationStudioPage;
