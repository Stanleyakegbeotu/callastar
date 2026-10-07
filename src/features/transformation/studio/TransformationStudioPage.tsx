import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";
import { AdminPageHeader } from "@/features/admin/layout/AdminPageHeader";
import { useProfiles } from "@/features/admin/hooks/useAdminData";

import type { QualityMode } from "../engine/trackingScheduler";
import { clampControl, DEFAULT_TRANSFORMATION_CONTROLS, type TransformationControls, type TransformationControlsRef } from "../engine/transformationControls";

import { CalibrationPanel } from "./components/CalibrationPanel";
import { SourcePanel } from "./components/SourcePanel";
import { StudioDiagnostics } from "./components/StudioDiagnostics";
import EyeDiagnostics from "./components/EyeDiagnostics";
import MouthNoseDiagnostics from './components/MouthNoseDiagnostics';
import { StudioStepRail } from "./components/StudioStepRail";
import { deriveStudioSteps } from "./studioSteps";
import { useSourceSelection } from "./useSourceSelection";
import { useStudioRuntime } from "./useStudioRuntime";
import { usePreviewExpansion } from "./usePreviewExpansion";
import type { FaceRendererStats, FaceRootMotionDebug, MouthDebugLayer } from "../engine/rendering/FaceRenderer";
import type { RenderMirrorMode } from "../engine/rendering/rendererMotion";
import type { OralInteriorMode } from '../engine/rendering/liveMouthCompositor';
import type { FaceRenderFraming } from "../engine/rendering/faceFraming";
import { NEUTRAL_FACE_RENDER_POSE, type FaceRenderPose } from '../engine/rendering/faceRendererMath';
import { EXPRESSION_KEYS, NEUTRAL_EXPRESSION, describeBlendshapeCoverage, type ExpressionKey, type ExpressionMotion, type ExpressionValues } from "../engine/expressionMotion";
import { avatarMotionFromTracking, restrictToCapabilities } from "../avatar/avatarMotion";
import type { AvatarMotion } from "../avatar/avatarTypes";
import type { AvatarRendererStats, ThreeAvatarRenderer } from "../avatar/ThreeAvatarRenderer";
import { AvatarPanel } from "./components/AvatarPanel";

/** `avatar` is the experimental 3D path; `face` is the existing M7/M8 renderer. */
type PreviewMode = "raw" | "face" | "avatar";
type StudioSection = "source" | "tracking" | "blend" | "face-fit" | "tools" | "diagnostics";
type FaceFitValues = TransformationControls["faceFit"];
type FaceDebugView = "final" | "overlay" | "compare" | "tracking-alignment" | "mask" | "boundaries" | "weights" | "boundary-match" | "face-lock";
const TrackerLab = lazy(() => import('../tracking/TrackerLab'));

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
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const cameraStartAttempted = useRef(false);
  const pipPointerOffset = useRef({ x: 0, y: 0 });
  const pipPointerStart = useRef({ x: 0, y: 0 });
  const pipPointerMoved = useRef(false);
  const [pipCorner, setPipCorner] = useState<"top-left" | "top-right" | "bottom-left" | "bottom-right">("top-right");
  const [pipPosition, setPipPosition] = useState<{ left: number; top: number } | null>(null);
  const [pipDragging, setPipDragging] = useState(false);
  const [pipMenuOpen, setPipMenuOpen] = useState(false);
  const [pipExpanded, setPipExpanded] = useState(false);
  const [pipVisible, setPipVisible] = useState(true);
  const [calibrationSuccessVisible, setCalibrationSuccessVisible] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [activeSheet, setActiveSheet] = useState<StudioSection>("source");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(window.sessionStorage.getItem("callastar-studio-sidebar-width"));
      return Number.isFinite(saved) && saved >= 360 && saved <= 620 ? saved : 440;
    } catch { return 440; }
  });
  const sidebarResizeStart = useRef({ x: 0, width: 440 });
  const [sheetStage, setSheetStage] = useState<"peek" | "half" | "expanded">("half");
  const sheetDragStart = useRef({ y: 0, height: 0 });
  const sheetDragMoved = useRef(false);
  const [sheetDragHeight, setSheetDragHeight] = useState<number | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const defaultFaceFit = DEFAULT_TRANSFORMATION_CONTROLS.faceFit;
  const [controls, setControls] = useState<TransformationControls>(() => structuredClone(DEFAULT_TRANSFORMATION_CONTROLS));
  const controlsRef = useRef<TransformationControlsRef["current"]>(controls);
  controlsRef.current = controls;
  const runtime = useStudioRuntime(controlsRef);
  const faceFit = controls.faceFit;
  const toolValues: Record<string, number> = {
    "Face Coverage": controls.coverage.overall,
    "Forehead Coverage": controls.coverage.forehead,
    "Temple Coverage": controls.coverage.temple,
    "Jaw / Chin Coverage": controls.coverage.jaw,
    "Boundary Feather": controls.blending.feather,
    "Skin Match": controls.blending.skinMatch,
    "Shadow Correction": controls.blending.shadowCorrection,
    "Motion Stability": controls.tracking.stability,
    "Yaw Response": controls.tracking.yawResponse,
    "Pitch Response": controls.tracking.pitchResponse,
    "Scale Follow": controls.tracking.scaleFollow,
    "Facial Response": controls.tracking.facialResponse,
    "Source Strength": controls.blending.sourceOpacity,
  };
  const updateToolValue = (label: string, value: number) => {
    if (label === "Jaw / Chin Coverage") {
      const bounded = clampControl(value);
      setControls(current => ({ ...current, coverage: { ...current.coverage, jaw: bounded, chin: bounded } }));
      return;
    }
    const bindings: Record<string, ["tracking" | "coverage" | "blending", string]> = {
      "Face Coverage": ["coverage", "overall"],
      "Forehead Coverage": ["coverage", "forehead"],
      "Temple Coverage": ["coverage", "temple"],
      "Boundary Feather": ["blending", "feather"],
      "Skin Match": ["blending", "skinMatch"],
      "Shadow Correction": ["blending", "shadowCorrection"],
      "Motion Stability": ["tracking", "stability"],
      "Yaw Response": ["tracking", "yawResponse"],
      "Pitch Response": ["tracking", "pitchResponse"],
      "Scale Follow": ["tracking", "scaleFollow"],
      "Facial Response": ["tracking", "facialResponse"],
      "Source Strength": ["blending", "sourceOpacity"],
    };
    const binding = bindings[label];
    if (!binding) return;
    const [section, key] = binding;
    setControls(current => {
      const next = { ...current, [section]: { ...current[section] } } as TransformationControls;
      (next[section] as unknown as Record<string, number>)[key] = clampControl(value);
      return next;
    });
  };
  const updateFaceFit = (key: keyof FaceFitValues, value: number) => {
    setControls(current => ({ ...current, faceFit: { ...current.faceFit, [key]: value } }));
  };
  const resetFaceFit = () => setControls(current => ({ ...current, faceFit: { ...defaultFaceFit } }));
  const toggleRawDirect = (enabled: boolean) => {
    setSwitches(current => ({ ...current, "Raw Direct": enabled }));
    setControls(current => ({ ...current, tracking: { ...current.tracking, rawDirect: enabled } }));
  };
  const [switches, setSwitches] = useState<Record<string, boolean>>({ "Live Tracking": true, "Raw Direct": false, "Tracking Alignment": false, "Mask Coverage": false, "Mask Preview": false, "Boundary Preview": false, "Face Lock": true, "Mirror Camera": true, "Maintain Source Identity": true, "Show Source Preview": true, "Show Tracking Points": false, "Show Face Boundary": false, "Show Mask": false, "Show Alignment": false });
  const mirrorModeRef = useRef<RenderMirrorMode>("selfie");
  mirrorModeRef.current = switches["Mirror Camera"] && runtime.facing === "user" ? "selfie" : "faithful";
  const [trackerLabOpen, setTrackerLabOpen] = useState(false);
  const trackerLabOverlayRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (runtime.state.camera !== 'live' && runtime.state.camera !== 'switching') setTrackerLabOpen(false);
  }, [runtime.state.camera]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("raw");
  const [faceDebugView, setFaceDebugView] = useState<FaceDebugView>("final");
  runtime.faceLockDebugRef.current = import.meta.env.DEV && (faceDebugView === "face-lock" || faceDebugView === "compare" || faceDebugView === "tracking-alignment");
  const [faceRootDebug, setFaceRootDebug] = useState<FaceRootMotionDebug>({ mode: "tracking", x: 0, y: 0, scale: 1, rollDeg: 0 });
  const faceRootDebugRef = useRef<FaceRootMotionDebug | null>(null);
  faceRootDebugRef.current = import.meta.env.DEV ? faceRootDebug : null;
  const [rendererStats, setRendererStats] = useState<FaceRendererStats | null>(null);
  const [avatarStats, setAvatarStats] = useState<AvatarRendererStats | null>(null);
  const [avatarManualEnabled, setAvatarManualEnabled] = useState(false);
  const [avatarManualValues, setAvatarManualValues] = useState<ExpressionValues>({ ...NEUTRAL_EXPRESSION });
  const avatarCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarRendererRef = useRef<ThreeAvatarRenderer | null>(null);
  const [showMesh, setShowMesh] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [oralInteriorMode, setOralInteriorMode] = useState<OralInteriorMode>('auto');
  const oralInteriorModeRef = useRef<OralInteriorMode>('auto');
  oralInteriorModeRef.current = oralInteriorMode;
  const [mouthDebugLayers, setMouthDebugLayers] = useState<Record<MouthDebugLayer, boolean>>({
    rawOuter: false, rawInner: false, stableOuter: false, stableInner: false,
    mask: false, feather: false,
  });
  const mouthDebugLayersRef = useRef(mouthDebugLayers);
  mouthDebugLayersRef.current = mouthDebugLayers;
  const liveMouthEnabled = oralInteriorMode !== 'source';
  const liveMouthEnabledRef = useRef(true);
  liveMouthEnabledRef.current = liveMouthEnabled;
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualValues, setManualValues] = useState<ExpressionValues>({ ...NEUTRAL_EXPRESSION });
  const manualExpressionRef = useRef<ExpressionMotion | null>(null);
  runtime.oralFrameEnabledRef.current = previewMode === 'face' && liveMouthEnabled && !manualEnabled;
  const [manualHeadEnabled, setManualHeadEnabled] = useState(false);
  const [manualHead, setManualHead] = useState<FaceRenderPose>({ ...NEUTRAL_FACE_RENDER_POSE });
  const manualHeadRef = useRef<FaceRenderPose | null>(null);
  manualHeadRef.current = import.meta.env.DEV && manualHeadEnabled ? manualHead : null;
  const rendererCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const rendererRef = useRef<import("../engine/rendering/FaceRenderer").FaceRenderer | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const framingRef = useRef<FaceRenderFraming | null>(null);
  const calibrationProfile = runtime.calibration.profile;
  // Read by the renderer every frame; a recalibration moves the face with it.
  framingRef.current = calibrationProfile
    ? {
        neutralCenter: calibrationProfile.face.center,
        neutralEyeSpan: calibrationProfile.face.scale,
        trackingWidth: calibrationProfile.trackingSpace.width,
        trackingHeight: calibrationProfile.trackingSpace.height,
      }
    : null;
  const preview = usePreviewExpansion(stageRef);

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
    if (source.stage !== "selected" || !source.asset) return;
    source.setConsent(true);
    source.analyze(true);
  }, [source.stage, source.asset, source.setConsent, source.analyze]);

  useEffect(() => {
    if (lastSourceRef.current === source.asset) return;
    const cameraActive = runtime.state.camera === "live" || runtime.state.camera === "switching";
    const replacingLiveSource = lastSourceRef.current !== null && source.asset !== null && cameraActive;
    lastSourceRef.current = source.asset;
    if (replacingLiveSource) runtime.clearCalibration();
    setPreviewMode("raw");
    resetFaceFit();
    setRendererStats(null);
    setAvatarStats(null);
    setAvatarManualEnabled(false);
    setAvatarManualValues({ ...NEUTRAL_EXPRESSION });
    setManualEnabled(false);
    setManualValues({ ...NEUTRAL_EXPRESSION });
  }, [source.asset, runtime.state.camera, runtime.clearCalibration]);

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
    rendererRef.current?.setDiagnostics({
      showMesh,
      wireframe,
      showMask: switches["Mask Preview"] || switches["Mask Coverage"] || switches["Show Mask"] || (import.meta.env.DEV && faceDebugView === "mask"),
      showBoundaries: switches["Boundary Preview"] || switches["Show Face Boundary"] || (import.meta.env.DEV && faceDebugView === "boundaries"),
      showWeights: import.meta.env.DEV && faceDebugView === "weights",
      showFaceLockDebug: switches["Tracking Alignment"] || switches["Show Alignment"] || (import.meta.env.DEV && (faceDebugView === "face-lock" || faceDebugView === "compare" || faceDebugView === "tracking-alignment")),
    });
  }, [showMesh, wireframe, faceDebugView, switches]);

  const canRenderFace = !trackerLabOpen && source.stage === "ready" && !!source.profile && !!source.asset &&
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
        liveMouthVideoRef: runtime.videoRef,
        liveMouthEnabled: liveMouthEnabledRef,
        oralInteriorMode: oralInteriorModeRef,
        mouthDebugLayers: mouthDebugLayersRef,
        motion: runtime.motionRef,
        controls: controlsRef,
        expression: runtime.expressionRef,
        faceFrame: runtime.faceFrameRef,
        rootMotionDebug: faceRootDebugRef,
        manualExpression: manualExpressionRef,
        manualPose: manualHeadRef,
        paused: runtime.renderPausedRef,
        framing: framingRef,
        // Matches the camera preview's own mirror, so the two stay comparable.
        mirror: mirrorModeRef,
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
      }, [previewMode, canRenderFace, source.asset, source.profile, runtime.motionRef, runtime.expressionRef, runtime.faceFrameRef, runtime.renderPausedRef, runtime.facing]);

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
  const isCalibrated = calibration.phase === "ready";
  const isCameraDenied = hasFailed && state.camera === "denied";

  useEffect(() => {
    if (source.stage !== "ready" || !isIdle || cameraStartAttempted.current) return;
    cameraStartAttempted.current = true;
    runtime.start();
  }, [source.stage, isIdle, runtime.start]);

  useEffect(() => {
    if (hasFailed) cameraStartAttempted.current = false;
  }, [hasFailed]);

  useEffect(() => {
    if (calibration.phase !== "ready") return;
    setCalibrationSuccessVisible(true);
    const timer = window.setTimeout(() => setCalibrationSuccessVisible(false), 2200);
    return () => window.clearTimeout(timer);
  }, [calibration.phase]);

  const beginPipDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = stageRef.current;
    if (!viewport) return;
    const pip = event.currentTarget;
    const viewportRect = viewport.getBoundingClientRect();
    const pipRect = pip.getBoundingClientRect();
    pipPointerOffset.current = { x: event.clientX - pipRect.left, y: event.clientY - pipRect.top };
    pipPointerStart.current = { x: event.clientX, y: event.clientY };
    pipPointerMoved.current = false;
    setPipMenuOpen(false);
    setPipPosition({ left: pipRect.left - viewportRect.left, top: pipRect.top - viewportRect.top });
    setPipDragging(true);
    pip.setPointerCapture(event.pointerId);
  };

  const movePip = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pipDragging || !stageRef.current) return;
    if (Math.hypot(event.clientX - pipPointerStart.current.x, event.clientY - pipPointerStart.current.y) > 5) pipPointerMoved.current = true;
    const bounds = stageRef.current.getBoundingClientRect();
    const pip = event.currentTarget.getBoundingClientRect();
    const header = stageRef.current.querySelector(".studio-camera-header")?.getBoundingClientRect();
    const controls = stageRef.current.querySelector(".studio-bottom-controls")?.getBoundingClientRect();
    const minTop = (header?.bottom ?? bounds.top + 80) - bounds.top + 12;
    const maxLeft = Math.max(12, bounds.width - pip.width - 12);
    const maxTop = Math.max(minTop, (controls?.top ?? bounds.bottom - 140) - bounds.top - pip.height - 12);
    setPipPosition({
      left: Math.min(maxLeft, Math.max(12, event.clientX - bounds.left - pipPointerOffset.current.x)),
      top: Math.min(maxTop, Math.max(minTop, event.clientY - bounds.top - pipPointerOffset.current.y)),
    });
  };

  const finishPipDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pipDragging || !stageRef.current) return;
    if (!pipPointerMoved.current) {
      setPipPosition(null);
      setPipDragging(false);
      setPipMenuOpen(open => !open);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const bounds = stageRef.current.getBoundingClientRect();
    const pip = event.currentTarget.getBoundingClientRect();
    const header = stageRef.current.querySelector(".studio-camera-header")?.getBoundingClientRect();
    const controls = stageRef.current.querySelector(".studio-bottom-controls")?.getBoundingClientRect();
    const minTop = (header?.bottom ?? bounds.top + 80) - bounds.top + 12;
    const maxLeft = Math.max(12, bounds.width - pip.width - 12);
    const maxTop = Math.max(minTop, (controls?.top ?? bounds.bottom - 140) - bounds.top - pip.height - 12);
    const left = Math.min(maxLeft, Math.max(12, event.clientX - bounds.left - pipPointerOffset.current.x));
    const top = Math.min(maxTop, Math.max(minTop, event.clientY - bounds.top - pipPointerOffset.current.y));
    const corners = [
      { name: "top-left" as const, x: 12, y: minTop },
      { name: "top-right" as const, x: maxLeft, y: minTop },
      { name: "bottom-left" as const, x: 12, y: maxTop },
      { name: "bottom-right" as const, x: maxLeft, y: maxTop },
    ];
    const closest = corners.reduce((best, corner) => Math.hypot(left - corner.x, top - corner.y) < Math.hypot(left - best.x, top - best.y) ? corner : best);
    setPipCorner(closest.name);
    setPipPosition(null);
    setPipDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const openControls = (section: StudioSection = activeSheet) => {
    setActiveSheet(section);
    if (window.matchMedia("(min-width: 850px)").matches) {
      setSidebarExpanded(true);
      return;
    }
    setSheetStage("half");
    setSheetDragHeight(null);
    setPipMenuOpen(false);
    setControlsOpen(true);
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    sidebarResizeStart.current = { x: event.clientX, width: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const maxWidth = Math.min(620, window.innerWidth - 520);
    setSidebarWidth(Math.max(360, Math.min(maxWidth, sidebarResizeStart.current.width + sidebarResizeStart.current.x - event.clientX)));
  };

  const finishSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    try { window.sessionStorage.setItem("callastar-studio-sidebar-width", String(sidebarWidth)); } catch { /* Session persistence is optional. */ }
  };

  const beginSheetDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget.closest(".studio-bottom-sheet");
    if (!sheet) return;
    sheetDragStart.current = { y: event.clientY, height: sheet.getBoundingClientRect().height };
    sheetDragMoved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveSheetDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (Math.abs(event.clientY - sheetDragStart.current.y) > 5) sheetDragMoved.current = true;
    const viewportHeight = window.innerHeight;
    const nextHeight = sheetDragStart.current.height + sheetDragStart.current.y - event.clientY;
    setSheetDragHeight(Math.min(viewportHeight * 0.9, Math.max(viewportHeight * 0.16, nextHeight)));
  };

  const finishSheetDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!sheetDragMoved.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const viewportHeight = window.innerHeight;
    const nextHeight = sheetDragHeight ?? sheetDragStart.current.height;
    const snapPoints = [
      { stage: "peek" as const, height: viewportHeight * 0.18 },
      { stage: "half" as const, height: viewportHeight * 0.55 },
      { stage: "expanded" as const, height: viewportHeight * 0.88 },
    ];
    const nearest = snapPoints.reduce((best, point) => Math.abs(nextHeight - point.height) < Math.abs(nextHeight - best.height) ? point : best);
    setSheetStage(nearest.stage);
    setSheetDragHeight(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const retryAnalysis = () => {
    runtime.clearCalibration();
    setPreviewMode("raw");
    source.analyze(true);
  };
  /*
   * What owns the main surface.
   *
   * Raw is the operator's LIVE CAMERA; the uploaded source is a reference and
   * only fills the stage while no camera is running. Face and avatar output
   * take the main surface with the live camera as a comparison PiP. A renderer
   * that failed falls back to the raw layout rather than a blank canvas.
   */
  const outputLayout = (previewMode === "face" && rendererStats?.status !== "failed") || previewMode === "avatar";
  const rootFrame = rendererStats?.faceFrame ?? null;
  const rootProbe = rendererStats?.attachmentProbe ?? null;
  const rootModeLabel = faceRootDebug.mode === "tracking"
    ? "LIVE TRACKING"
    : faceRootDebug.mode === "raw-direct" ? "RAW DIRECT"
    : faceRootDebug.mode === "manual" ? "MANUAL ROOT" : "FORCED OSCILLATOR";
  const rootOverrideActive = faceRootDebug.mode === "manual" || faceRootDebug.mode === "oscillator";
  const rootNumber = (value: number | null | undefined) => Number.isFinite(value) ? value!.toFixed(3) : "—";
  const rootCanvas = rendererCanvasRef.current;
  const rootWidth = rootCanvas?.clientWidth ?? 0;
  const rootHeight = rootCanvas?.clientHeight ?? 0;
  const rootAspect = rootHeight > 0 ? rootWidth / rootHeight : 0;
  const renderedCenter = rootProbe?.rootPosition && rootHeight > 0
    ? {
        x: runtime.facing === "user"
          ? rootWidth - (rootProbe.rootPosition.x + rootAspect) * rootHeight / 2
          : (rootProbe.rootPosition.x + rootAspect) * rootHeight / 2,
        y: (1 - rootProbe.rootPosition.y) * rootHeight / 2,
      }
    : null;
  const centerErrorX = renderedCenter && rootFrame?.viewportPlacement ? renderedCenter.x - rootFrame.viewportPlacement.center.x : null;
  const centerErrorY = renderedCenter && rootFrame?.viewportPlacement ? renderedCenter.y - rootFrame.viewportPlacement.center.y : null;
  const scaleErrorPx = rootFrame?.viewportPlacement && rendererStats ? rendererStats.faceWidthPx - rootFrame.viewportPlacement.width : null;
  const scaleErrorRatio = rootFrame?.viewportPlacement?.width && rendererStats
    ? rendererStats.faceWidthPx / rootFrame.viewportPlacement.width - 1
    : null;
  const rollErrorDeg = rootFrame?.livePlacement?.roll !== null && rootFrame?.livePlacement?.roll !== undefined && rootProbe?.rootLocal
    ? (rootProbe.rootLocal.roll - rootFrame.livePlacement.roll) * 180 / Math.PI
    : null;
  const anchorBounds = (rootFrame?.stableAnchors ?? []).reduce<{
    minX: number; maxX: number; minY: number; maxY: number;
  } | null>((bounds, point) => bounds ? {
    minX: Math.min(bounds.minX, point.x), maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y), maxY: Math.max(bounds.maxY, point.y),
  } : { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y }, null);

  return (
    <div className={`studio-page studio-mobile-shell ${sidebarExpanded ? "studio-sidebar-expanded" : "studio-sidebar-collapsed"}`} style={{ "--studio-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <header className="studio-desktop-header"><div className="studio-desktop-brand"><span>✦</span><strong>CallaStar</strong><i />Transformation Studio</div><div className={`studio-desktop-ready ${isLive ? "is-live" : ""}`}><i />{isLive ? "Camera Ready" : "Camera Standby"}</div></header>
      <AdminPageHeader
        title="Transformation Studio"
        description="Live tracking with an experimental, face-only source preview."
      />

      <StudioStepRail steps={steps} />

      <div className="studio-layout">
        <section ref={stageRef} className={`studio-stage studio-camera-stage ${preview.expanded ? "is-expanded" : ""} ${controlsOpen ? "has-sheet" : ""}`} aria-label="Camera preview">
          <div
            className={`studio-viewport ${runtime.facing === "user" ? "is-mirrored" : ""} ${previewMode === "face" ? "is-face-render-preview" : ""} ${previewMode === "face" && faceDebugView === "overlay" ? "is-overlay-only" : ""} ${previewMode === "face" && (faceDebugView === "compare" || faceDebugView === "tracking-alignment") ? "is-placement-compare" : ""} ${outputLayout && isLive ? "is-output-preview" : ""}`}
            data-layout={outputLayout ? "output" : "camera"}
          >
            <video
              ref={runtime.videoRef}
              className="studio-video"
              playsInline
              muted
              // The Studio previews appearance. It never asks for, records or
              // plays audio.
              autoPlay
            />
            <canvas ref={runtime.overlayRef} className="studio-overlay" aria-hidden="true" style={trackerLabOpen ? { visibility: 'hidden' } : undefined} />
            {trackerLabOpen && <canvas ref={trackerLabOverlayRef} className="studio-overlay" aria-hidden="true" />}

            {/*
              * The source, as a REFERENCE.
              *
              * Large only while no camera runs, so the operator can judge the
              * face before starting. Once live it becomes a thumbnail, and under
              * face or avatar output it is only the hidden frame decoder. One
              * element throughout: a mode switch restyles it rather than
              * remounting a video the renderer may be reading.
              */}
            {isLive && pipVisible && source.previewUrl && (
              <div
                className={`studio-source-preview studio-pip ${pipPosition ? "studio-pip-free" : `studio-pip-${pipCorner}`} ${pipDragging ? "is-dragging" : ""} ${pipExpanded ? "is-expanded" : ""} ${controlsOpen && (sheetStage === "expanded" || pipCorner.startsWith("bottom")) ? "is-above-sheet" : ""}`}
                data-testid="studio-source-reference"
                style={pipPosition ? { left: `${pipPosition.left}px`, top: `${pipPosition.top}px`, right: "auto", bottom: "auto" } : undefined}
                onPointerDown={beginPipDrag}
                onPointerMove={movePip}
                onPointerUp={finishPipDrag}
                onPointerCancel={finishPipDrag}
                aria-label="Source preview. Tap for options or drag to move."
              >
                {source.asset?.kind === "video" ? (
                  <video ref={sourceVideoRef} src={source.previewUrl} playsInline muted autoPlay loop preload="metadata" />
                ) : (
                  <img src={source.previewUrl} alt={`Source: ${source.asset?.fileName ?? "selected file"}`} />
                )}
                <span className="studio-pip-label">Source · {source.stage === "ready" ? "Ready" : "Analyzing"}</span>
              </div>
            )}
            {pipMenuOpen && isLive && <div className={`studio-pip-menu studio-pip-menu-${pipCorner}`}><button type="button" onClick={() => { setPipExpanded(value => !value); setPipMenuOpen(false); }}>{pipExpanded ? "Close Preview" : "View Source"}</button><button type="button" onClick={() => openControls("source")}>Change Source</button></div>}
            <canvas ref={rendererCanvasRef} className={`studio-face-renderer is-face-overlay ${previewMode === "face" ? "is-visible" : ""}`} aria-label="Experimental face renderer preview" />
            <canvas
              ref={avatarCanvasRef}
              className={`studio-face-renderer ${previewMode === "avatar" ? "is-visible" : ""}`}
              aria-label="Experimental 3D avatar preview"
            />

            {import.meta.env.DEV && previewMode === "face" && rendererStats?.status !== "failed" && (
              <div className="studio-root-hud" data-testid="face-root-hud" aria-label="Live face root diagnostics">
                <div className="studio-root-hud-mode">
                  <span>ROOT MODE</span>
                  <strong>{rootModeLabel}</strong>
                  {rootOverrideActive && <em>Developer override active</em>}
                </div>
                <div className="studio-root-hud-metrics">
                  <span><b>FACE</b>{summary.face?.detected ? "Yes" : "No"}</span>
                  <span><b>RAW X</b>{rootNumber(rootFrame?.globalCenter?.x)}</span>
                  <span><b>RAW Y</b>{rootNumber(rootFrame?.globalCenter?.y)}</span>
                  <span><b>RAW SCALE</b>{rootNumber(rootFrame?.rawScaleRatio)}</span>
                  <span><b>ROOT X</b>{rootNumber(rootProbe?.rootPosition?.x)}</span>
                  <span><b>ROOT Y</b>{rootNumber(rootProbe?.rootPosition?.y)}</span>
                  <span><b>ROOT SCALE</b>{rootNumber(rootProbe?.rootScale)}</span>
                  <span><b>TRACKING FPS</b>{summary.stats?.faceFps?.toFixed(1) ?? "—"}</span>
                </div>
              </div>
            )}

            {(isLoading || isRequestingCamera) && (
              <div className="studio-flow-message" role="status">
                <span className="studio-spinner" aria-hidden="true" />
                <strong>{source.stage === "ready" ? (isRequestingCamera ? "Starting camera…" : "Starting camera…") : (state.loadingStage ?? "Preparing camera…")}</strong>
                {source.stage === "ready" && <span>Source ready ✓</span>}
              </div>
            )}

            {!source.asset && source.stage === "empty" && !hasFailed && (
              <div className="studio-first-source">
                <div className="studio-empty-brand"><span>✦</span><strong>Transformation Studio</strong></div>
                <p>Upload an image or video to begin</p>
                <button type="button" className="studio-add-source-primary" onClick={() => sourceInputRef.current?.click()}><Icon name="plus" /> Add Source</button>
              </div>
            )}

            {source.stage === "analyzing" && (
              <div className="studio-flow-message" role="status">
                <span className="studio-spinner" aria-hidden="true" />
                <strong>Analyzing source…</strong>
                <span>{source.progress.stage === "analyzing-face" || source.progress.stage === "analyzing-pose" ? "Detecting facial features…" : source.progress.stage === "evaluating" ? "Preparing source geometry…" : "Preparing facial profile"}</span>
              </div>
            )}

            {source.stage === "failed" && !hasFailed && (
              <div className="studio-flow-error" role="alert"><strong>Unable to analyze this source</strong><span>{source.message ?? "Choose a clear image or video and try again."}</span><button type="button" onClick={() => source.asset ? source.analyze(true) : sourceInputRef.current?.click()}>Try Again</button><button type="button" onClick={() => sourceInputRef.current?.click()}>Choose Another Source</button></div>
            )}

            {source.stage === "selected" && !activeProfile && (
              <div className="studio-flow-error" role="alert"><strong>Open a profile to prepare this source</strong><span>Transformation Studio needs a profile before it can build a facial source.</span><button type="button" onClick={() => history.back()}>Go Back</button></div>
            )}

            {hasFailed && (
              <div className="studio-flow-error" role="alert">
                <strong>{isCameraDenied ? "Camera access is required" : "Could not start the camera"}</strong>
                <span>{isCameraDenied ? "Allow camera access to continue with live tracking." : state.error}</span>
                <button type="button" onClick={() => { cameraStartAttempted.current = false; runtime.stop(); }}>{isCameraDenied ? "Allow Camera" : "Try Again"}</button>
              </div>
            )}

            {/* A simple face guide during the explicit face-only calibration. */}
            {calibrating && (
              <div className="studio-calibration-guide" aria-hidden="true">
                <span className="studio-guide-face" />
              </div>
            )}

            {calibrating && (
              <div className="studio-calibration-message" role="status">
                <strong>Calibrating face…</strong>
                <span>Hold still and look forward</span>
                <div className="studio-calibration-progress"><span style={{ width: `${Math.round(calibration.progress * 100)}%` }} /></div>
              </div>
            )}
            {calibration.phase === "failed" && isLive && <div className="studio-calibration-toast" role="alert"><strong>Calibration couldn't complete</strong><button type="button" onClick={() => runtime.startCalibration()}>Try Again</button></div>}
            {calibrationSuccessVisible && isLive && !calibrating && <div className="studio-calibration-toast" role="status">Face calibrated ✓</div>}
            <header className="studio-camera-header">
              <button type="button" className="studio-round-button studio-back-control" aria-label="Back" onClick={() => history.back()}><Icon name="chevron" /><span>Back</span></button>
              <div className="studio-camera-title"><h1>Transformation Studio</h1></div>
              {isLive ? <button type="button" className="studio-round-button studio-settings-toggle" aria-label="Studio Controls" aria-expanded={controlsOpen} onClick={() => controlsOpen ? setControlsOpen(false) : openControls()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg></button> : <span aria-hidden="true" />}
            </header>
            <input ref={sourceInputRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" className="admin-visually-hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void source.selectFile(file); event.target.value = ""; }} />
          </div>

          {isLive && <div className="studio-bottom-controls studio-mobile-controls">
            {previewMode === "face" ? <>
              <button type="button" className="studio-camera-action" onClick={() => setStopConfirmOpen(true)} aria-label="Stop transformation session"><span className="studio-action-disc"><Icon name="phoneOff" /></span><small>Stop</small></button>
              <button type="button" className="studio-camera-action is-primary" onClick={() => openControls("source")} aria-label="Change source"><span className="studio-action-disc"><Icon name="image" /></span><small>Source</small></button>
              <button type="button" className="studio-camera-action" onClick={() => openControls("face-fit")} aria-label="Adjust face fit"><span className="studio-action-disc"><Icon name="settings" /></span><small>Adjust</small></button>
            </> : <>
              <button type="button" className="studio-camera-action" onClick={() => { setPreviewMode("raw"); runtime.flipCamera(); }} disabled={calibrating || controlsOpen} aria-label="Flip camera"><span className="studio-action-disc"><Icon name="flip" /></span><small>Flip</small></button>
              <button type="button" className="studio-camera-action is-primary" disabled={!isCalibrated || !canRenderFace || controlsOpen} aria-label="Start transformation" onClick={() => setPreviewMode("face")}><span className="studio-action-disc">✦</span><small>Transform</small></button>
              <button type="button" className="studio-camera-action" onClick={() => { setPreviewMode("raw"); runtime.startCalibration(); }} disabled={controlsOpen} aria-label={calibrating ? "Restart calibration" : isCalibrated ? "Recalibrate face" : "Calibrate face"}><span className="studio-action-disc"><Icon name="eye" /></span><small>{calibrating ? "Restart" : isCalibrated ? "Recalibrate" : "Calibrate"}</small></button>
            </>}
          </div>}
          {isLive && <div className="studio-bottom-controls studio-desktop-controls">
            <button type="button" className="studio-camera-action" onClick={() => { setPreviewMode("raw"); runtime.flipCamera(); }} disabled={calibrating || state.camera === "switching"} aria-label="Flip camera"><span className="studio-action-disc"><Icon name="flip" /></span><small>Flip<span>Camera</span></small></button>
            <button type="button" className={`studio-camera-action is-primary ${previewMode === "face" ? "is-on" : ""}`} disabled={!isCalibrated || !canRenderFace} aria-label={previewMode === "face" ? "Show raw tracking" : "Start face render"} onClick={() => setPreviewMode(mode => mode === "face" ? "raw" : "face")}><span className="studio-action-disc">✦</span><small>{previewMode === "face" ? "Face Render" : "Transform"}<span>Face Render</span></small></button>
            <button type="button" className="studio-camera-action" onClick={() => { setPreviewMode("raw"); runtime.startCalibration(); }} aria-label={calibrating ? "Restart calibration" : isCalibrated ? "Recalibrate face" : "Calibrate face"}><span className="studio-action-disc"><Icon name="eye" /></span><small>{calibrating ? "Restart" : isCalibrated ? "Recalibrate" : "Calibrate"}<span>Face Mapping</span></small></button>
          </div>}

          {isLive && <div className="studio-desktop-hud"><strong><i />{summary.face?.detected ? "Tracking Active" : "Camera Ready"}</strong><span>{summary.face?.detected ? "Face Detected" : "Waiting for face"}</span><span>Stability: {summary.face?.detected ? "Good" : "—"}</span></div>}

          {controlsOpen && <button type="button" className="studio-sheet-backdrop" aria-label="Close Studio Controls" onClick={() => setControlsOpen(false)} />}
          <section className={`studio-bottom-sheet studio-desktop-sidebar ${controlsOpen ? "is-open" : ""} ${sheetDragHeight ? "is-dragging" : ""} ${sidebarExpanded ? "is-expanded" : "is-collapsed"}`} aria-label="Studio Controls" style={sheetDragHeight ? { height: `${sheetDragHeight}px` } : undefined}>
              <div className="studio-sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize Studio Controls" onPointerDown={beginSidebarResize} onPointerMove={moveSidebarResize} onPointerUp={finishSidebarResize} onPointerCancel={finishSidebarResize} />
              <div className="studio-sheet-grab" role="button" tabIndex={0} aria-label="Drag to resize Studio Controls" onClick={() => { if (sheetDragMoved.current) { sheetDragMoved.current = false; return; } setSheetStage(stage => stage === "peek" ? "half" : stage === "half" ? "expanded" : "peek"); }} onPointerDown={beginSheetDrag} onPointerMove={moveSheetDrag} onPointerUp={finishSheetDrag} onPointerCancel={finishSheetDrag} onKeyDown={event => { if (event.key === "ArrowUp") { event.preventDefault(); setSheetStage(stage => stage === "peek" ? "half" : "expanded"); } if (event.key === "ArrowDown") { event.preventDefault(); setSheetStage(stage => stage === "expanded" ? "half" : "peek"); } }}><span /></div>
              <div className="studio-sheet-head"><div><h2>Studio Controls</h2><small><i />{summary.face?.detected ? "Tracking Active" : "Camera ready · waiting for face"}</small></div><div className="studio-sidebar-head-actions"><button type="button" className="studio-sidebar-collapse" aria-label={sidebarExpanded ? "Collapse Studio Controls" : "Expand Studio Controls"} title={sidebarExpanded ? "Collapse controls" : "Expand controls"} onClick={() => setSidebarExpanded(value => !value)}><Icon name="chevron" /></button><button type="button" className="studio-sheet-close" aria-label="Close Studio Controls" onClick={() => window.matchMedia("(min-width: 850px)").matches ? setSidebarExpanded(false) : setControlsOpen(false)}><Icon name="close" /></button></div></div>
              <div className="studio-sheet-tabs" aria-label="Studio control sections">{([ ["source", "Source", "image"], ["tracking", "Tracking", "eye"], ["blend", "Blend", "star"], ["face-fit", "Face Fit", "maximize"], ["tools", "Tools", "settings"], ["diagnostics", "Diagnostics", "info"] ] as const).map(([id, label, icon]) => <button type="button" key={id} className={activeSheet === id ? "is-active" : ""} aria-label={label} title={label} aria-pressed={activeSheet === id} onClick={() => { setActiveSheet(id); if (window.matchMedia("(min-width: 850px)").matches) setSidebarExpanded(true); }}><Icon name={icon} /><span>{label}</span></button>)}</div>
              <div className="studio-sheet-content" data-sheet={activeSheet} key={activeSheet}>
                {activeSheet === "source" && <>
                  <div className="studio-current-source">{source.previewUrl && source.asset?.kind === "image" ? <img src={source.previewUrl} alt="Current source" /> : <span><Icon name={source.asset?.kind === "video" ? "video" : "image"} /></span>}<div><strong>{source.asset?.fileName ?? "No source selected"}</strong><small>{source.asset?.kind ?? "Source"}</small>{source.stage === "ready" ? <><small className="studio-source-ready"><i />Analyzed</small><small>Ready for transformation</small></> : <small>{source.stage}</small>}</div></div>
                  <button type="button" className="studio-sheet-row" onClick={() => sourceInputRef.current?.click()}><Icon name="image" /><span><b>Change Source</b><small>Select a new image or video</small></span><Icon name="chevron" className="studio-row-chevron" /></button>
                  <button type="button" className="studio-sheet-row" onClick={() => sourceInputRef.current?.click()}><Icon name="image" /><span><b>Upload New Image</b><small>Choose from your device</small></span><Icon name="chevron" className="studio-row-chevron" /></button>
                  <button type="button" className="studio-sheet-row" onClick={() => sourceInputRef.current?.click()}><Icon name="video" /><span><b>Upload New Video</b><small>Choose from your device</small></span><Icon name="chevron" className="studio-row-chevron" /></button>
                  {storedOptions.length > 0 && <div className="studio-recent-source"><h3>Recent Source</h3>{storedOptions.map(option => <button type="button" className="studio-sheet-row" key={option.assetId} onClick={() => { runtime.clearCalibration(); void source.selectStoredAsset(option.assetId, option.label); }}><Icon name="clock" /><span>{option.label}</span></button>)}</div>}
                  <button type="button" className="studio-sheet-row" disabled={!source.asset || source.stage === "analyzing"} onClick={retryAnalysis}><Icon name="rotate" /><span><b>Re-run Analysis</b><small>Analyze source again</small></span><Icon name="chevron" className="studio-row-chevron" /></button>
                  {source.stage === "analyzing" && <p className="studio-sheet-note">Analyzing source… · Preparing facial profile</p>}
                  <h3 className="studio-sidebar-subheading">Source Settings</h3>
                  <StudioControlSwitch label="Maintain Source Identity" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Maintain Source Identity": enabled })); setControls(current => ({ ...current, appearance: { ...current.appearance, preserveSourceTexture: enabled } })); }} />
                  <StudioControlSlider label="Source Strength" value={toolValues["Source Strength"]} onChange={value => updateToolValue("Source Strength", value)} />
                  <StudioControlSwitch label="Show Source Preview" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Show Source Preview": enabled })); setPipVisible(enabled); }} />
                </>}
                {activeSheet === "tracking" && <>
                  <StudioControlSwitch label="Live Tracking" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Live Tracking": enabled })); if ((runtime.state.phase === "paused") === enabled) runtime.togglePause(); }} />
                  <StudioControlSwitch label="Raw Direct" values={switches} onChange={setSwitches} onToggle={toggleRawDirect} />
                  <StudioControlSwitch label="Tracking Alignment" values={switches} onChange={setSwitches} onToggle={enabled => setSwitches(current => ({ ...current, "Tracking Alignment": enabled }))} />
                  <StudioControlSwitch label="Mask Coverage" values={switches} onChange={setSwitches} onToggle={enabled => setSwitches(current => ({ ...current, "Mask Coverage": enabled }))} />
                  <div className="studio-metric-list"><p><span>Stability</span><b>{summary.face?.detected ? "Good" : "Waiting"}</b></p><p><span>Pose Response</span><b>{summary.motion?.tracked ? "Active" : "Waiting"}</b></p><p><span>Tracking Quality</span><b>{summary.guidance.label}</b></p></div>
                  <details className="studio-inline-advanced"><summary>Advanced</summary><StudioControlSlider label="Tracking Stability" value={toolValues["Motion Stability"]} onChange={value => updateToolValue("Motion Stability", value)} /><StudioControlSlider label="Yaw Response" value={toolValues["Yaw Response"]} onChange={value => updateToolValue("Yaw Response", value)} /><StudioControlSlider label="Pitch Response" value={toolValues["Pitch Response"]} onChange={value => updateToolValue("Pitch Response", value)} /><StudioControlSlider label="Scale Follow" value={toolValues["Scale Follow"]} onChange={value => updateToolValue("Scale Follow", value)} /></details>
                </>}
                {activeSheet === "blend" && <>{["Face Coverage", "Forehead Coverage", "Temple Coverage", "Jaw / Chin Coverage", "Boundary Feather", "Skin Match", "Shadow Correction"].map(label => <StudioControlSlider key={label} label={label} value={toolValues[label]!} onChange={value => updateToolValue(label, value)} />)}<details className="studio-inline-advanced"><summary>Advanced Blend / Appearance</summary><StudioControlSlider label="Chin Coverage" value={controls.coverage.chin} onChange={value => setControls(current => ({ ...current, coverage: { ...current.coverage, chin: clampControl(value) } }))} /><StudioControlSlider label="Luminance Match" value={controls.blending.luminanceMatch} onChange={value => setControls(current => ({ ...current, blending: { ...current.blending, luminanceMatch: clampControl(value) } }))} /><StudioControlSlider label="Chroma Match" value={controls.blending.chromaMatch} onChange={value => setControls(current => ({ ...current, blending: { ...current.blending, chromaMatch: clampControl(value) } }))} /><StudioControlSlider label="Facial Hair Strength" value={controls.appearance.facialHairStrength} onChange={value => setControls(current => ({ ...current, appearance: { ...current.appearance, facialHairStrength: clampControl(value) } }))} /></details><StudioControlSwitch label="Mask Preview" values={switches} onChange={setSwitches} /><StudioControlSwitch label="Boundary Preview" values={switches} onChange={setSwitches} /></>}
                {activeSheet === "face-fit" && <>
                  {([ ["width", "Face Width", 70, 130, "%"], ["height", "Face Height", 70, 130, "%"], ["scale", "Scale", 70, 130, "%"], ["x", "X Offset", -100, 100, ""], ["y", "Y Offset", -100, 100, ""], ["rotation", "Rotation", -15, 15, "°"] ] as const).map(([key, label, min, max, unit]) => <label className="studio-sheet-slider" key={key}><span><b>{label}</b><output>{faceFit[key]}{unit}</output></span><input type="range" min={min} max={max} step="1" value={faceFit[key]} onChange={event => updateFaceFit(key, Number(event.target.value))} /></label>)}
                  <StudioControlSlider label="Coverage" value={toolValues["Face Coverage"]} onChange={value => updateToolValue("Face Coverage", value)} />
                  <button type="button" className="studio-sheet-row" onClick={resetFaceFit}><Icon name="rotate" /><span>Reset Face Fit</span></button>
                </>}
                {activeSheet === "tools" && <>
                  <StudioControlSwitch label="Face Lock" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Face Lock": enabled })); setControls(current => ({ ...current, tracking: { ...current.tracking, faceLock: enabled } })); }} />
                  <StudioControlSlider label="Motion Stability" value={toolValues["Motion Stability"]} onChange={value => updateToolValue("Motion Stability", value)} />
                  <StudioControlSlider label="Facial Response" value={toolValues["Facial Response"]} onChange={value => updateToolValue("Facial Response", value)} />
                  <StudioControlSwitch label="Mirror Camera" values={switches} onChange={setSwitches} />
                  <StudioControlSwitch label="Show Source Preview" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Show Source Preview": enabled })); setPipVisible(enabled); }} />
                  <button type="button" className="studio-sheet-row" onClick={() => { resetFaceFit(); setPreviewMode("raw"); }}><Icon name="rotate" /><span>Reset Transformation</span></button>
                  <button type="button" className="studio-sheet-row" onClick={runtime.flipCamera}><Icon name="flip" /><span>Flip Camera</span></button>
                </>}
                {activeSheet === "diagnostics" && <>
                  <div className="studio-metric-list"><p><span>Face Detected</span><b>{summary.face?.detected ? "Yes" : "No"}</b></p><p><span>Tracking FPS</span><b>{summary.stats?.faceFps?.toFixed(1) ?? "—"}</b></p><p><span>Render FPS</span><b>{rendererStats?.fps?.toFixed(1) ?? "—"}</b></p><p><span>Yaw</span><b>{summary.face?.derived?.yaw == null ? "—" : `${(summary.face.derived.yaw * 180 / Math.PI).toFixed(1)}°`}</b></p><p><span>Pitch</span><b>{summary.face?.derived?.pitch == null ? "—" : `${(summary.face.derived.pitch * 180 / Math.PI).toFixed(1)}°`}</b></p><p><span>Roll</span><b>{summary.face?.derived?.roll == null ? "—" : `${(summary.face.derived.roll * 180 / Math.PI).toFixed(1)}°`}</b></p><p><span>Face Scale</span><b>{summary.face?.derived?.scale?.toFixed(2) ?? "—"}</b></p><p><span>Blend Coverage</span><b>{toolValues["Face Coverage"] ?? 88}%</b></p><p><span>Latency</span><b>{rendererStats?.renderMs?.toFixed(1) ?? "—"} ms</b></p></div>
                  <StudioControlSwitch label="Show Tracking Points" values={switches} onChange={setSwitches} onToggle={enabled => { setSwitches(current => ({ ...current, "Show Tracking Points": enabled })); runtime.setShowFace(enabled); }} /><StudioControlSwitch label="Show Face Boundary" values={switches} onChange={setSwitches} /><StudioControlSwitch label="Show Mask" values={switches} onChange={setSwitches} /><StudioControlSwitch label="Show Alignment" values={switches} onChange={setSwitches} />
                  {import.meta.env.DEV && <details className="studio-inline-advanced"><summary>Developer Diagnostics</summary><StudioControlSwitch label="Raw Direct" values={switches} onChange={setSwitches} onToggle={toggleRawDirect} /><label className="studio-sheet-slider"><span>Root Mode</span><select value={faceRootDebug.mode} onChange={event => setFaceRootDebug(current => ({ ...current, mode: event.target.value as FaceRootMotionDebug["mode"] }))}><option value="tracking">Tracking</option><option value="raw-direct">Raw Direct</option><option value="manual">Manual Root</option><option value="oscillator">Forced Oscillator</option></select></label><div className="studio-metric-list"><p><span>Frame ID</span><b>{rendererStats?.faceFrame?.frameId ?? "—"}</b></p><p><span>Root X</span><b>{rootNumber(rootProbe?.rootPosition?.x)}</b></p><p><span>Root Y</span><b>{rootNumber(rootProbe?.rootPosition?.y)}</b></p><p><span>Contour error</span><b>{rendererStats?.contourAlignment?.[0]?.errorPx.toFixed(1) ?? "—"} px</b></p><p><span>Alpha pipeline</span><b>{rendererStats?.alphaPipeline ?? "—"}</b></p></div></details>}
                  {import.meta.env.DEV && <details className="studio-inline-advanced"><summary>Live mouth geometry · Developer</summary>
                    <div className="studio-metric-list">{(() => {
                      const m = rendererStats?.canonicalMouth;
                      const values = {
                        'Live width': m?.liveWidth, 'Rendered width': m?.renderedWidth, 'Width ratio': m?.widthRatio,
                        'Live outer height': m?.liveOuterHeight, 'Rendered outer height': m?.renderedOuterHeight,
                        'Live opening height': m?.liveOpeningHeight, 'Rendered opening height': m?.renderedOpeningHeight,
                        'Opening ratio': m?.openingRatio, 'Live opening width': m?.liveOpeningWidth,
                        'Rendered opening width': m?.renderedOpeningWidth, 'Open ratio': m?.openRatio,
                        'Left corner X': m?.leftCorner.x, 'Left corner Y': m?.leftCorner.y,
                        'Right corner X': m?.rightCorner.x, 'Right corner Y': m?.rightCorner.y,
                        'Raw motion': m?.filter.rawMotion, 'Filtered motion': m?.filter.filteredMotion,
                        'Filter alpha': m?.filter.alpha, 'Rejected points': m?.filter.rejectedPoints,
                        'Yaw': m?.yaw, 'Pitch': m?.pitch, 'Roll': m?.roll,
                        'Mouth processing ms': rendererStats?.mouthCompositorMs,
                      };
                      return Object.entries(values).map(([label,value]) => <p key={label}><span>{label}</span><b>{rootNumber(value)}</b></p>);
                    })()}</div>
                  </details>}
                </>}
              </div>
          </section>

          {stopConfirmOpen && <div className="studio-stop-backdrop" role="presentation"><section className="studio-stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="studio-stop-title"><h2 id="studio-stop-title">Stop transformation session?</h2><div><button type="button" onClick={() => setStopConfirmOpen(false)}>Cancel</button><button type="button" onClick={() => { setStopConfirmOpen(false); cameraStartAttempted.current = true; runtime.stop(); history.back(); }}>Stop</button></div></section></div>}

          {import.meta.env.DEV && previewMode === "face" && rendererStats?.status !== "failed" && (
            <details className="studio-root-dev-panel" data-testid="face-root-debug-panel">
              <summary>
                <span>Face Tracking Debug</span>
                <strong data-testid="face-root-mode-indicator">ROOT MODE: {rootModeLabel}</strong>
              </summary>
              <div className="studio-root-dev-content">
                <section className="studio-root-debug-group" aria-label="Face root mode">
                  <h3>Face Root Mode</h3>
                  <label className="studio-root-mode-select">Mode
                    <select aria-label="Face root test mode" value={faceRootDebug.mode}
                      onChange={(event) => setFaceRootDebug(value => ({ ...value, mode: event.target.value as FaceRootMotionDebug["mode"] }))}>
                      <option value="tracking">Live Tracking</option>
                      <option value="raw-direct">Raw Direct</option>
                      <option value="manual">Manual Root</option>
                      <option value="oscillator">Forced Oscillator</option>
                    </select>
                  </label>
                  {rootOverrideActive && <p className="studio-root-override-warning" role="status">Developer override active — natural live tracking is overridden.</p>}
                </section>

                <section className="studio-root-debug-group" aria-label="Manual root controls">
                  <h3>Manual Root</h3>
                  {faceRootDebug.mode === "manual" ? <div className="studio-root-manual-grid">
                    <label>Root X <output>{faceRootDebug.x.toFixed(2)}</output>
                      <input aria-label="Manual face root X" type="range" min="-0.30" max="0.30" step="0.01" value={faceRootDebug.x}
                        onChange={(event) => setFaceRootDebug(value => ({ ...value, x: Number(event.target.value) }))} />
                    </label>
                    <label>Root Y <output>{faceRootDebug.y.toFixed(2)}</output>
                      <input aria-label="Manual face root Y" type="range" min="-0.30" max="0.30" step="0.01" value={faceRootDebug.y}
                        onChange={(event) => setFaceRootDebug(value => ({ ...value, y: Number(event.target.value) }))} />
                    </label>
                    <label>Root scale <output>{faceRootDebug.scale.toFixed(2)}×</output>
                      <input aria-label="Manual face root scale" type="range" min="0.50" max="1.80" step="0.01" value={faceRootDebug.scale}
                        onChange={(event) => setFaceRootDebug(value => ({ ...value, scale: Number(event.target.value) }))} />
                    </label>
                    <label>Root roll <output>{faceRootDebug.rollDeg}°</output>
                      <input aria-label="Manual face root roll" type="range" min="-30" max="30" step="1" value={faceRootDebug.rollDeg}
                        onChange={(event) => setFaceRootDebug(value => ({ ...value, rollDeg: Number(event.target.value) }))} />
                    </label>
                  </div> : <p className="studio-root-debug-note">Select Manual Root to adjust global X, Y, scale, and roll.</p>}
                  {faceRootDebug.mode === "oscillator" && <p className="studio-root-debug-note">Tracking placement is bypassed. Root X/Y, scale, and roll cycle continuously.</p>}
                  <button type="button" className="studio-root-reset" onClick={() => setFaceRootDebug({ mode: "tracking", x: 0, y: 0, scale: 1, rollDeg: 0 })}>RESET ROOT TEST</button>
                </section>

                <section className="studio-root-debug-group" aria-label="Raw tracking values">
                  <h3>Raw Tracking</h3>
                  <dl className="studio-root-value-grid">
                    <div><dt>Center X</dt><dd>{rootNumber(rootFrame?.globalCenter?.x)}</dd></div>
                    <div><dt>Center Y</dt><dd>{rootNumber(rootFrame?.globalCenter?.y)}</dd></div>
                    <div><dt>Face width</dt><dd>{rootNumber(anchorBounds ? anchorBounds.maxX - anchorBounds.minX : null)}</dd></div>
                    <div><dt>Face height</dt><dd>{rootNumber(anchorBounds ? anchorBounds.maxY - anchorBounds.minY : null)}</dd></div>
                    <div><dt>Scale ratio</dt><dd>{rootNumber(rootFrame?.rawScaleRatio)}</dd></div>
                    <div><dt>Raw preview frame</dt><dd>{rootFrame?.frameId ?? "—"}</dd></div>
                  </dl>
                </section>

                <section className="studio-root-debug-group" aria-label="Root output values">
                  <h3>Root Output</h3>
                  <dl className="studio-root-value-grid">
                    <div><dt>Root X</dt><dd>{rootNumber(rootProbe?.rootPosition?.x)}</dd></div>
                    <div><dt>Root Y</dt><dd>{rootNumber(rootProbe?.rootPosition?.y)}</dd></div>
                    <div><dt>Root scale</dt><dd>{rootNumber(rootProbe?.rootScale)}</dd></div>
                    <div><dt>Root roll</dt><dd>{rootNumber(rootProbe?.rootLocal?.roll === undefined ? null : rootProbe.rootLocal.roll * 180 / Math.PI)}°</dd></div>
                    <div><dt>Yaw / pitch</dt><dd>{rootNumber(rootFrame?.globalTransform?.yawDelta === undefined ? null : rootFrame.globalTransform.yawDelta * 180 / Math.PI)}° / {rootNumber(rootFrame?.globalTransform?.pitchDelta === undefined ? null : rootFrame.globalTransform.pitchDelta * 180 / Math.PI)}°</dd></div>
                    <div><dt>Center error X / Y</dt><dd>{rootNumber(centerErrorX)} px / {rootNumber(centerErrorY)} px</dd></div>
                    <div><dt>Scale error</dt><dd>{rootNumber(scaleErrorRatio === null ? null : scaleErrorRatio * 100)}%</dd></div>
                    <div><dt>Width error</dt><dd>{rootNumber(scaleErrorPx)} px</dd></div>
                    <div><dt>Roll error</dt><dd>{rootNumber(rollErrorDeg)}°</dd></div>
                  </dl>
                </section>

                <section className="studio-root-debug-group" aria-label="Frame state values">
                  <h3>Frame State</h3>
                  <dl className="studio-root-value-grid">
                    <div><dt>Camera frame ID</dt><dd>{summary.face?.frameId ?? "—"}</dd></div>
                    <div><dt>Tracking frame ID</dt><dd>{rootFrame?.frameId ?? "—"}</dd></div>
                    <div><dt>Render root frame ID</dt><dd>{rendererStats?.faceFrame?.frameId ?? "—"}</dd></div>
                    <div><dt>Root update count</dt><dd>{rendererStats?.frames ?? 0}</dd></div>
                    <div><dt>Expression update count</dt><dd>{summary.stats?.faceInferences ?? 0}</dd></div>
                    <div><dt>Tracking FPS</dt><dd>{summary.stats?.faceFps?.toFixed(1) ?? "—"}</dd></div>
                  </dl>
                </section>

                <section className="studio-root-debug-group" aria-label="Tracking alignment" data-tracking-alignment>
                  <h3>Tracking Alignment</h3>
                  <p className="studio-root-debug-note">Raw face contour is cyan/white; rendered source contour is magenta. Errors compare seven matching MediaPipe vertices.</p>
                  {rendererStats?.contourAlignment?.length ? rendererStats.contourAlignment.map(sample => (
                    <div className="studio-root-alignment-row" key={sample.region} data-alignment-region={sample.region}>
                      <strong>{sample.region}</strong>
                      <span>LIVE ({sample.live.x.toFixed(1)}, {sample.live.y.toFixed(1)})</span>
                      <span>RENDER ({sample.rendered.x.toFixed(1)}, {sample.rendered.y.toFixed(1)})</span>
                      <b>ERROR {sample.errorPx.toFixed(1)} px</b>
                    </div>
                  )) : <p className="studio-root-debug-note">Waiting for a detected face frame.</p>}
                  {rendererStats?.poseAlignment && <p className="studio-root-debug-note" data-metric="yaw-pitch-error-summary">
                    Mean contour error · left yaw {rendererStats.poseAlignment.leftYaw.errorPx?.toFixed(1) ?? "—"} px @ {rendererStats.poseAlignment.leftYaw.angleDeg?.toFixed(0) ?? "—"}° / {rendererStats.poseAlignment.leftYaw.count} frames · right yaw {rendererStats.poseAlignment.rightYaw.errorPx?.toFixed(1) ?? "—"} px @ {rendererStats.poseAlignment.rightYaw.angleDeg?.toFixed(0) ?? "—"}° / {rendererStats.poseAlignment.rightYaw.count} frames · up pitch {rendererStats.poseAlignment.upPitch.errorPx?.toFixed(1) ?? "—"} px @ {rendererStats.poseAlignment.upPitch.angleDeg?.toFixed(0) ?? "—"}° / {rendererStats.poseAlignment.upPitch.count} frames · down pitch {rendererStats.poseAlignment.downPitch.errorPx?.toFixed(1) ?? "—"} px @ {rendererStats.poseAlignment.downPitch.angleDeg?.toFixed(0) ?? "—"}° / {rendererStats.poseAlignment.downPitch.count} frames. Each direction keeps its latest 120 tracked frames; hold each requested angle to compare.
                  </p>}
                </section>

                <details className="studio-root-advanced-debug">
                  <summary>Advanced Debug</summary>
                  <div className="studio-root-advanced-content">
                    <p>Frame {rootFrame?.frameId ?? "—"} · video {rootFrame ? rootNumber(rootFrame.timestampMs) : "—"} ms · tracking {rootFrame ? rootNumber(rootFrame.trackingTimestampMs) : "—"} ms</p>
                    <p>Stable anchors {rootFrame?.stableAnchors.length ?? 0} · calibrated anchors {rootFrame?.referenceAnchors.length ?? 0} · center ({rootNumber(rootFrame?.globalCenter?.x)}, {rootNumber(rootFrame?.globalCenter?.y)})</p>
                    <p>Root matrix: <code>{rootProbe?.rootMatrix?.map(value => value.toFixed(3)).join(", ") ?? "unavailable"}</code></p>
                    <p>Stable anchors: <code>{rootFrame?.stableAnchors.map(point => `(${point.x.toFixed(3)}, ${point.y.toFixed(3)})`).join(" ") || "unavailable"}</code></p>
                    <p>Reference anchors: <code>{rootFrame?.referenceAnchors.map(point => `(${point.x.toFixed(3)}, ${point.y.toFixed(3)})`).join(" ") || "unavailable"}</code></p>
                    {rootProbe && (() => {
                      const point = (value: { x: number; y: number; z?: number } | null) => value
                        ? `(${value.x.toFixed(3)}, ${value.y.toFixed(3)}${value.z === undefined ? "" : `, ${value.z.toFixed(3)}`})`
                        : "unavailable";
                      return <div className="studio-root-world-diagnostics" data-face-root-world
                        data-root-x={rootProbe.rootLocal?.x ?? ""} data-root-y={rootProbe.rootLocal?.y ?? ""}
                        data-root-scale-x={rootProbe.rootLocal?.scaleX ?? ""} data-root-scale-y={rootProbe.rootLocal?.scaleY ?? ""}
                        data-root-roll={rootProbe.rootLocal?.roll ?? ""} data-root-matrix-world={rootProbe.rootMatrix?.join(",") ?? ""}>
                        <p>ROOT LOCAL: {point(rootProbe.rootLocal)} · scale ({rootProbe.rootLocal?.scaleX.toFixed(3)}, {rootProbe.rootLocal?.scaleY.toFixed(3)}) · roll {rootProbe.rootLocal?.roll.toFixed(3)} · matrixAutoUpdate {String(rootProbe.rootLocal?.matrixAutoUpdate)}</p>
                        <p>SKIN WORLD CENTER: {point(rootProbe.skinWorldCenter)} · EYE WORLD CENTER: {point(rootProbe.eyeWorldCenter)} · CHILD {rootProbe.childWorldPosition?.name ?? "—"} WORLD: {point(rootProbe.childWorldPosition)}</p>
                        <p>Hierarchy: {rootProbe.sceneHierarchy?.name} ({rootProbe.sceneHierarchy?.type}) → {rootProbe.sceneHierarchy?.children.map(child => `${child.name} (${child.type})`).join(" · ")}</p>
                        <p>Root links · skin {String(rootProbe.skinIsRootChild)} · eye pixels {String(rootProbe.eyePixelsShareRoot)} · mask geometry {String(rootProbe.maskSharesFaceGeometry)} · nose {String(rootProbe.noseSharesRoot)} · mouth {String(rootProbe.mouthSharesRoot)}</p>
                      </div>;
                    })()}
                  </div>
                </details>
              </div>
            </details>
          )}

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
              <button type="button" className="studio-control" onClick={runtime.togglePause} disabled={trackerLabOpen}>
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
              <button type="button" aria-pressed={previewMode === "raw"} onClick={() => setPreviewMode("raw")}>Raw camera</button>
              <button type="button" aria-pressed={previewMode === "face"} onClick={() => setPreviewMode("face")} disabled={!canRenderFace}>Face render</button>
              {/* Offered only for a 3D source, so it cannot be pressed with nothing to show. */}
              <button
                type="button"
                aria-pressed={previewMode === "avatar"}
                onClick={() => setPreviewMode("avatar")}
                disabled={!source.avatar || trackerLabOpen}
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
                {import.meta.env.DEV && (
                  <label className="studio-composite-debug">Composite view
                    <select className="studio-composite-debug-select" aria-label="Developer composite view" value={faceDebugView} onChange={(event) => setFaceDebugView(event.target.value as FaceDebugView)}>
                      <option value="final">Camera + transformed face</option>
                      <option value="overlay">Face overlay only</option>
                      <option value="compare">Overlay Compare (raw + rendered)</option>
                      <option value="tracking-alignment">Tracking Alignment</option>
                      <option value="mask">Mask Coverage</option>
                      <option value="boundaries">Topology boundaries</option>
                      <option value="weights">Alpha / Feather</option>
                      <option value="boundary-match">Boundary Color Match</option>
                      <option value="face-lock">Face lock</option>
                    </select>
                    {faceDebugView === "boundaries" && <small aria-label="Topology boundary legend">Outer yellow · left eye cyan · right eye magenta · mouth orange</small>}
                    {faceDebugView === "face-lock" && <small aria-label="Face lock legend">Cyan anchors = live · magenta rings = calibrated fit · white = live contour · cyan/magenta WebGL contours = shared face/mask root</small>}
                  </label>
                )}
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

            {previewMode === 'face' && (
              <div className="studio-render-controls">
                <label className="studio-live-mouth-toggle">Mouth preservation
                  <select aria-label="Mouth preservation" value={oralInteriorMode} onChange={event => setOralInteriorMode(event.target.value as OralInteriorMode)}>
                    <option value="auto">AUTO</option><option value="source">SOURCE</option><option value="live">LIVE</option>
                  </select>
                </label>
                <span>AUTO preserves the current live mouth; SOURCE disables it for A/B comparison.</span>
                {import.meta.env.DEV && <details className="studio-inline-advanced"><summary>Mouth geometry overlay · Developer</summary>
                  {([['rawOuter','Green · raw outer lips'],['rawInner','Cyan · raw inner lips'],
                    ['stableOuter','Blue · stabilized outer lips'],['stableInner','Purple · stabilized inner lips'],
                    ['mask','Red · mouth mask boundary'],['feather','Yellow · feather boundary']] as const).map(([key,label]) =>
                    <label key={key}><input type="checkbox" checked={mouthDebugLayers[key]}
                      onChange={event => setMouthDebugLayers(current => ({...current,[key]:event.target.checked}))} /> {label}</label>) }
                </details>}
              </div>
            )}
            {previewMode === "face" && rendererStats?.status === "ready" && (
              <div className="studio-render-diagnostics" aria-live="polite">
                <span>Renderer {rendererStats.fps?.toFixed(1) ?? "—"} fps</span>
                <span>{rendererStats.renderMs?.toFixed(1) ?? "—"} ms</span>
                <span data-metric="display-input-age">Input → display {rendererStats.displayInputAgeMs?.toFixed(1) ?? "—"} ms</span>
                <span data-metric="display-frame">Display frame {rendererStats.displayFrameAtMs?.toFixed(1) ?? "—"} ms</span>
                <span data-metric="render-interval">Render {rendererStats.renderStartMs?.toFixed(1) ?? "—"} → {rendererStats.renderEndMs?.toFixed(1) ?? "—"} ms</span>
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
          {import.meta.env.DEV && (trackerLabOpen ? (
            <Suspense fallback={<section className="studio-card" role="status">Loading Tracker Lab…</section>}>
              <TrackerLab runtime={runtime} overlayRef={trackerLabOverlayRef} onClose={() => setTrackerLabOpen(false)} />
            </Suspense>
          ) : (
            <section className="studio-card">
              <h2>Tracker Lab · Developer</h2>
              <p className="studio-note">Compare MediaPipe and Jeeliz on the live camera, one face tracker at a time.</p>
              <button type="button" className="studio-control" disabled={!isLive || calibrating || source.stage === 'analyzing'} onClick={() => { setPreviewMode('raw'); setTrackerLabOpen(true); }}>Open Tracker Lab</button>
            </section>
          ))}
          {!trackerLabOpen && <>
          {import.meta.env.DEV && <EyeDiagnostics runtime={runtime} rendererFps={rendererStats?.fps ?? null} />}
          {import.meta.env.DEV && <MouthNoseDiagnostics runtime={runtime} stats={rendererStats} liveInterior={liveMouthEnabled} />}
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
            cameraLive={isLive && !trackerLabOpen}
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
            <p className="studio-note">Face-only mode is active. Pose inference and body overlays are disabled.</p>
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
                calibration={calibration}
              />
              {previewMode === "face" && rendererStats && (
                <div className="studio-expression-diagnostics">
                  <h3>Expressions {manualEnabled ? "· Manual DEV" : "· Live"}</h3>
                  <p>Only pixels inside the live inner-lip mask are sampled. Frames stay in memory for the current preview.</p>
                  <p>AUTO preserves the source interior at rest and reveals live teeth and tongue when the aperture opens beyond it. LIVE always uses the camera interior while open; SOURCE keeps the photograph.</p>
                  <p data-metric="live-mouth">Mouth feed {rendererStats.mouthFeedOpacity && rendererStats.mouthFeedOpacity > 0.01 ? "active" : "off"} · opacity {(rendererStats.mouthFeedOpacity ?? 0).toFixed(2)}</p>
                  <p>Mesh {rendererStats.meshVertices ?? 0} vertices / {rendererStats.meshTriangles ?? 0} triangles · depth {rendererStats.depthRange?.toFixed(3)} · DPR {rendererStats.dpr?.toFixed(1)} · WebGL {rendererStats.status} · context losses {rendererStats.contextLossCount ?? 0}</p>
                  {import.meta.env.DEV && rendererStats.boundaryLoops?.map(loop => (
                    <p key={loop.id} data-metric={`boundary-loop-${loop.id}`}>
                      Boundary {loop.id} · {loop.kind} · {loop.vertices.length} vertices · centroid ({loop.centroid.x.toFixed(3)}, {loop.centroid.y.toFixed(3)}) · bounds [{loop.bounds.minX.toFixed(3)}, {loop.bounds.minY.toFixed(3)}]–[{loop.bounds.maxX.toFixed(3)}, {loop.bounds.maxY.toFixed(3)}] · area {loop.area.toFixed(4)} · perimeter {loop.perimeter.toFixed(3)}
                    </p>
                  ))}
                  {import.meta.env.DEV && rendererStats.faceFrame && <p data-metric="face-lock-transform">
                    Face lock frame {rendererStats.faceFrame.frameId} · video {rendererStats.faceFrame.timestampMs.toFixed(1)} ms · tracking {rendererStats.faceFrame.trackingTimestampMs.toFixed(1)} ms · anchors {rendererStats.faceFrame.stableAnchors.length}/{rendererStats.faceFrame.referenceAnchors.length}
                    {rendererStats.faceFrame.globalCenter && <> · center ({rendererStats.faceFrame.globalCenter.x.toFixed(3)}, {rendererStats.faceFrame.globalCenter.y.toFixed(3)})</>}
                  </p>}
                  {import.meta.env.DEV && rendererStats.faceFrame && (() => {
                    const frame = rendererStats.faceFrame;
                    const raw = frame.rawGlobalTransform;
                    const filtered = frame.globalTransform;
                    const root = rendererStats.attachmentProbe;
                    const number = (value: number | null | undefined) => Number.isFinite(value) ? value!.toFixed(3) : "—";
                    return <p data-metric="live-root-motion">
                      RAW center ({number(frame.globalCenter?.x)}, {number(frame.globalCenter?.y)}) · reference ({number(frame.referenceCenter?.x)}, {number(frame.referenceCenter?.y)}) · raw/reference scale ({number(frame.rawFaceScale)} / {number(frame.referenceScale)}) · ratio {number(frame.rawScaleRatio)} · raw TX/TY ({number(raw?.translationX)}, {number(raw?.translationY)}) · filtered TX/TY/scale ({number(filtered?.translationX)}, {number(filtered?.translationY)}, {number(filtered?.scaleDelta)}) · root X/Y/scale ({number(root?.rootPosition?.x)}, {number(root?.rootPosition?.y)}, {number(root?.rootScale)})
                    </p>;
                  })()}
                  {import.meta.env.DEV && <p>Expression leakage: {rendererStats.expressionLeakage ? 'pitch / brow mismatch detected' : 'not detected'} (diagnostic only)</p>}
                  {source.profile && <p>Source pose: yaw {(source.profile.primaryFace.yaw * 180 / Math.PI).toFixed(1)}°, pitch {(source.profile.primaryFace.pitch * 180 / Math.PI).toFixed(1)}°, roll {(source.profile.primaryFace.roll * 180 / Math.PI).toFixed(1)}° — removed before deformation.
                    {source.profile.baseFrameTime !== undefined && <> Base frame: {source.profile.baseFrameTime.toFixed(2)}s · score {source.profile.baseFrameScore?.toFixed(3)}</>}
                  </p>}
                  <p>Expression {rendererStats.expressionMs?.toFixed(2) ?? "—"} ms · Deformation {rendererStats.deformationMs?.toFixed(2) ?? "—"} ms · Mouth compositor {rendererStats.mouthCompositorMs?.toFixed(2) ?? "—"} ms</p>
                  <p data-metric="alpha-pipeline">Alpha: {rendererStats.alphaPipeline ?? "—"} · Boundary blend {rendererStats.boundaryBlendMs?.toFixed(3) ?? "—"} ms</p>
                  {import.meta.env.DEV && faceDebugView === "boundary-match" && rendererStats.boundaryColorCorrection?.map((correction, index) => (
                    <p key={index} data-metric={`boundary-color-${index}`}>
                      {(["forehead", "left-temple", "right-temple", "left-cheek", "right-cheek", "chin"] as const)[index]} RGB × ({correction.r.toFixed(3)}, {correction.g.toFixed(3)}, {correction.b.toFixed(3)})
                    </p>
                  ))}
                  {rendererStats.faceFrame && <p data-metric="face-stabilization">
                    Stable-geometry filter {rendererStats.faceFrame.stabilizationMs.toFixed(3)} ms · estimated filter lag {rendererStats.faceFrame.stabilizationLatencyEstimateMs?.toFixed(1) ?? "0.0"} ms
                  </p>}
                  <p data-metric="mouth-mesh-aperture">
                    Mesh mouth aperture {rendererStats.mouthMeshAperturePx?.neutral.toFixed(1) ?? "—"} → {rendererStats.mouthMeshAperturePx?.applied.toFixed(1) ?? "—"} px
                    · chin moved {rendererStats.jawChinMovementPx?.toFixed(1) ?? "—"} px
                  </p>
                  {rendererStats.eyes && (
                    <p data-metric="eyes">
                      Eyes · aperture L {rendererStats.eyes.aperture?.left?.toFixed(2) ?? "—"} / R {rendererStats.eyes.aperture?.right?.toFixed(2) ?? "—"}
                      {rendererStats.eyes.state && <> · measured L {rendererStats.eyes.state.measuredLeft.toFixed(2)} / R {rendererStats.eyes.state.measuredRight.toFixed(2)} · state L {rendererStats.eyes.state.left} / R {rendererStats.eyes.state.right}</>}
                    </p>
                  )}
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
                    <span>geom</span>
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
                        <span>{trace?.geometry == null ? '—' : trace.geometry.toFixed(2)}</span>
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
                    <label><input type="checkbox" checked={manualHeadEnabled} onChange={event => setManualHeadEnabled(event.target.checked)} /> Manual head override</label>
                    {manualHeadEnabled && (['yaw', 'pitch', 'roll', 'x', 'y', 'scale'] as const).map(key => <label key={key}>
                      {key} {manualHead[key].toFixed(2)}
                      <input type="range" min={key === 'scale' ? .78 : -.28} max={key === 'scale' ? 1.28 : .28} step="0.01" value={manualHead[key]}
                        onChange={event => setManualHead(current => ({ ...current, [key]: Number(event.target.value) }))} />
                    </label>)}
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
          </>}
        </aside>
      </div>
    </div>
  );
}

function StudioControlSlider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="studio-sheet-slider"><span><b>{label}</b><output>{value}%</output></span><input type="range" min="0" max="100" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}

function StudioControlSwitch({ label, values, onChange, onToggle }: { label: string; values: Record<string, boolean>; onChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; onToggle?: (enabled: boolean) => void }) {
  return <label className="studio-sheet-switch"><span>{label}</span><input type="checkbox" checked={values[label] ?? false} onChange={event => onToggle ? onToggle(event.target.checked) : onChange(current => ({ ...current, [label]: event.target.checked }))} /><i aria-hidden="true" /></label>;
}

export default TransformationStudioPage;
