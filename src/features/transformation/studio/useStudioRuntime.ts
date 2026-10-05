import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { detectTransformationCapabilities } from "../capabilities";
import { CalibrationCollector, type CalibrationCollectorState } from "../engine/calibrationCollector";
import type { CalibrationInvalidation, CalibrationMode } from "../engine/calibrationTypes";
import {
  computeOverlayCanvasSize,
  computeTrackingSize,
  mapFacePlacementToDisplay,
  type DisplayGeometry,
} from "../engine/coordinateMapping";
import { FaceTracker } from "../engine/faceTracker";
import { fitStableHeadAnchors, HeadMotionStabilizer, stableHeadAnchors } from "../engine/headLock";
import { responseGain, type TransformationControlsRef } from "../engine/transformationControls";
import type { FaceFrameSnapshot } from "../engine/faceFrame";
import { faceBounds } from "../engine/faceGeometry";
import { LandmarkStabilizer } from "../engine/landmarkStabilizer";
import { BOUNDARY_SKIN_REGIONS, sampleImageRegion, type BoundaryRgb } from "../engine/rendering/boundaryHarmonization";
import { computeExpressionMotion, type ExpressionMotion } from "../engine/expressionMotion";
import type { FaceTrackingResult } from "../engine/faceTypes";
import { MonotonicClock } from "../engine/monotonicClock";
import { NO_POSE_RESULT, type PoseTrackingResult } from "../engine/poseTypes";
import { NO_MOTION, computeRelativeMotion, type CalibrationMotion } from "../engine/relativeMotion";
import { StudioCamera, describeCameraError, type CameraFacing } from "../engine/studioCamera";
import {
  QUALITY_PRESETS,
  TrackingScheduler,
  type QualityMode,
  type SchedulableTracker,
  type SchedulerStats,
} from "../engine/trackingScheduler";
import {
  initialTransformationState,
  transformationReducer,
  type TransformationState,
} from "../engine/transformationPhase";
import { hasRequiredTransformationModels } from "../modelAssets";

import { DEFAULT_OVERLAY_STYLE, drawTrackingOverlay } from "./overlayDrawing";
import { describeTracking, type TrackingGuidance } from "./trackingGuidance";
import { BlinkStateMachine } from "../engine/blinkState";
import { GazeSmoother } from "../engine/eyeGaze";
import { EyeControlFilter, EYE_RENDER_CHANNELS } from "../engine/eyeControls";
import { HybridCoordinator } from "../tracking/hybridCoordinator";

/**
 * Everything the live Studio owns.
 *
 * One hook, because these five things have one lifetime: the MediaPipe tasks,
 * the camera, the frame loop, the downscale canvas and the overlay. Splitting
 * them across hooks would mean five separate teardowns to get right, and the
 * failure mode of getting one wrong is a camera light that stays on.
 *
 * The overlay is drawn imperatively from the scheduler's callback, NOT from
 * React state. Sixty renders a second carrying 478 landmarks would spend more
 * time in reconciliation than in inference; React state here is a summary,
 * refreshed a few times a second for the status chip and the diagnostics.
 *
 * Nothing in this hook persists a landmark. Results live for the frame that
 * produced them and are overwritten by the next.
 */

/** How often the React-visible summary refreshes. Four times a second reads as live. */
const SUMMARY_INTERVAL_MS = 250;

export interface StudioSummary {
  face: FaceTrackingResult | null;
  pose: PoseTrackingResult | null;
  stats: SchedulerStats | null;
  guidance: TrackingGuidance;
  /** The camera's real frame size, once the track reports one. */
  cameraWidth: number | null;
  cameraHeight: number | null;
  faceInitMs: number | null;
  /**
   * Live motion against the calibrated neutral.
   *
   * `NO_MOTION` until a baseline exists — absent rather than zero, because zero
   * would claim the operator is sitting in a neutral nobody has captured.
   */
  motion: CalibrationMotion;
  expression: ExpressionMotion | null;
}

const EMPTY_SUMMARY: StudioSummary = {
  face: null,
  pose: null,
  stats: null,
      guidance: describeTracking(null, null, { running: false }),
  cameraWidth: null,
  cameraHeight: null,
  faceInitMs: null,
  motion: NO_MOTION,
  expression: null,
};

/** Satisfies the generic scheduler contract without constructing a Pose Landmarker. */
const DISABLED_POSE_TRACKER: SchedulableTracker<PoseTrackingResult> = {
  ready: false,
  detect: (_frame, timestampMs, frameId) => ({ ...NO_POSE_RESULT, timestampMs, frameId }),
};

interface Runtime {
  clock: MonotonicClock;
  face: FaceTracker;
  camera: StudioCamera;
  scheduler: TrackingScheduler;
  /**
   * Pure JS data over results the scheduler already produced.
   *
   * No second inference pass, no extra model, no worker — which is why
   * calibration costs effectively nothing and needs no teardown of its own.
   */
  calibration: CalibrationCollector;
  /** Where each camera frame is downscaled before inference. */
  trackingCanvas: HTMLCanvasElement;
  trackingContext: CanvasRenderingContext2D;
  oralFrame: HTMLCanvasElement;
  gazeSmoother: GazeSmoother;
  blinkState: BlinkStateMachine;
}

export interface StudioRuntime {
  state: TransformationState;
  summary: StudioSummary;
  quality: QualityMode;
  facing: CameraFacing;
  showFace: boolean;
  calibration: CalibrationCollectorState;
  /** Why the last baseline was dropped, when one was. */
  calibrationInvalidation: CalibrationInvalidation | null;
  /** Latest motion from the existing scheduler. The renderer reads it without a React render. */
  motionRef: React.MutableRefObject<CalibrationMotion>;
  expressionRef: React.MutableRefObject<ExpressionMotion | null>;
  /** Face transform and expressions captured atomically from one camera frame. */
  faceFrameRef: React.MutableRefObject<FaceFrameSnapshot | null>;
  faceLockDebugRef: React.MutableRefObject<boolean>;
  oralFrameEnabledRef: React.MutableRefObject<boolean>;
  /** Camera flips deliberately freeze the rendered source until a new baseline exists. */
  renderPausedRef: React.MutableRefObject<boolean>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  start: () => void;
  stop: () => void;
  togglePause: () => void;
  flipCamera: () => void;
  setQuality: (mode: QualityMode) => void;
  setShowFace: (show: boolean) => void;
  startCalibration: (mode?: CalibrationMode) => void;
  cancelCalibration: () => void;
  clearCalibration: () => void;
  /** Developer lab borrows the face task with all normal face/pose inference suspended. */
  suspendForTrackerLab: () => () => void;
  getFaceTracker: () => FaceTracker | null;
}

const IDLE_CALIBRATION: CalibrationCollectorState = new CalibrationCollector().getState();

export function useStudioRuntime(controlsRef: TransformationControlsRef): StudioRuntime {
  const [state, dispatch] = useReducer(transformationReducer, initialTransformationState);
  const [summary, setSummary] = useState<StudioSummary>(EMPTY_SUMMARY);
  const [quality, setQualityState] = useState<QualityMode>("balanced");
  const [facing, setFacing] = useState<CameraFacing>("user");
  const [showFace, setShowFace] = useState(true);
  const [calibration, setCalibration] = useState<CalibrationCollectorState>(IDLE_CALIBRATION);
  const [calibrationInvalidation, setCalibrationInvalidation] = useState<CalibrationInvalidation | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const trackerLabLeases = useRef(0);
  const resumeAfterLab = useRef(false);

  const getFaceTracker = useCallback(() => runtimeRef.current?.face ?? null, []);
  const suspendForTrackerLab = useCallback(() => {
    const owned = runtimeRef.current;
    if (!owned) return () => {};
    if (trackerLabLeases.current === 0) resumeAfterLab.current = owned.scheduler.isRunning;
    trackerLabLeases.current++;
    owned.scheduler.pause();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      trackerLabLeases.current = Math.max(0, trackerLabLeases.current - 1);
      if (trackerLabLeases.current === 0 && resumeAfterLab.current && runtimeRef.current === owned && !document.hidden) {
        owned.scheduler.resume();
        resumeAfterLab.current = false;
      }
    };
  }, []);

  /** The video element's laid-out size, cached so the draw does not force layout. */
  const displaySizeRef = useRef({ width: 0, height: 0 });
  const cameraSizeRef = useRef<{ width: number | null; height: number | null }>({ width: null, height: null });
  const mirroredRef = useRef(true);
  const trackingSizeRef = useRef(QUALITY_PRESETS.balanced.trackingSize);
  const showFaceRef = useRef(showFace);
  const lastSummaryAtRef = useRef(0);
  const lastCalibrationAtRef = useRef(0);
  const lastCalibrationPhaseRef = useRef<CalibrationCollectorState["phase"]>("idle");
  const motionRef = useRef<CalibrationMotion>(NO_MOTION);
  const expressionRef = useRef<ExpressionMotion | null>(null);
  const faceFrameRef = useRef<FaceFrameSnapshot | null>(null);
  const faceLockDebugRef = useRef(false);
  const oralFrameEnabledRef = useRef(false);
  const renderPausedRef = useRef(false);
  const startCalibrationRef = useRef<((mode?: CalibrationMode) => void) | null>(null);

  showFaceRef.current = showFace;
  mirroredRef.current = facing === "user";

  /**
   * Teardown.
   *
   * Runs on unmount, and in development runs once for StrictMode's discarded
   * first mount. Everything here is idempotent for that reason, and the runtime
   * is rebuilt from scratch rather than revived.
   */
  const teardown = useCallback(() => {
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    if (!runtime) return;

    runtime.scheduler.dispose();
    runtime.camera.dispose();
    runtime.face.dispose();
    runtime.oralFrame.width=0;runtime.oralFrame.height=0;

    const video = videoRef.current;
    if (video) video.srcObject = null;

    const overlay = overlayRef.current;
    const context = overlay?.getContext("2d");
    if (overlay && context) context.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** The geometry every landmark is mapped through. Read fresh on each draw. */
  const geometry = useCallback((): DisplayGeometry => {
    return {
      sourceWidth: cameraSizeRef.current.width ?? 0,
      sourceHeight: cameraSizeRef.current.height ?? 0,
      displayWidth: displaySizeRef.current.width,
      displayHeight: displaySizeRef.current.height,
      objectFit: "cover",
      mirrored: mirroredRef.current,
    };
  }, []);

  const start = useCallback(() => {
    if (runtimeRef.current) return;

    const capabilities = detectTransformationCapabilities();
    if (!capabilities.getUserMedia) {
      dispatch({
        type: "FAIL",
        code: "unsupported_browser",
        error: "This browser cannot use a camera. Transformation Studio needs a modern browser on a secure origin.",
      });
      return;
    }

    if (!hasRequiredTransformationModels()) {
      dispatch({
        type: "FAIL",
        code: "model_load_failed",
        error: "The face model is not installed in this build. Run `pnpm assets:transformation`.",
      });
      return;
    }

    const trackingCanvas = document.createElement("canvas");
    // `willReadFrequently` is deliberately off: the models read this canvas
    // through the GPU path, and forcing a software surface would slow every
    // frame down for nobody's benefit.
    const trackingContext = trackingCanvas.getContext("2d");
    const oralFrame = document.createElement('canvas');
    const oralContext = oralFrame.getContext('2d');
    const boundarySampleCanvas = document.createElement("canvas");
    boundarySampleCanvas.width = 96;
    boundarySampleCanvas.height = 96;
    const boundarySampleContext = boundarySampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!trackingContext) {
      dispatch({ type: "FAIL", code: "webgl_unavailable", error: "This browser could not create a drawing surface." });
      return;
    }

    // One clock for the face model and scheduler frame IDs.
    const clock = new MonotonicClock();
    const face = new FaceTracker({ delegate: capabilities.webGl2 ? "GPU" : "CPU" }, clock);
    const camera = new StudioCamera();
    const calibrationCollector = new CalibrationCollector();
    // One per runtime: it advances once per TRACKER update, never per render.
    const blinkState = new BlinkStateMachine();
    const gazeSmoother = new GazeSmoother();
    const eyeFilter = new EyeControlFilter();
    const hybridCoordinator = new HybridCoordinator();
    const landmarkStabilizer = new LandmarkStabilizer();
    const headMotionStabilizer = new HeadMotionStabilizer();
    let lastExpressionTimestamp = Number.NaN;
    let lastEyeProfile: unknown = null;
    let lastStabilityProfile: unknown = null;
    let lastPublishedFaceTimestamp = Number.NaN;
    let lastPublishedProfile: unknown = null;
    let nextFaceFrameId = 0;
    let lastBoundarySampleAt = -Infinity;
    let boundarySkinSamples: (BoundaryRgb | null)[] = BOUNDARY_SKIN_REGIONS.map(() => null);
    let boundarySkinSampleTimestampMs: number | null = null;
    let boundarySkinSampleCostMs = 0;

    let lastObservedFaceTimestamp = Number.NaN;
    let trackingLostAt: number | null = null;
    const scheduler = new TrackingScheduler({
      face,
      pose: DISABLED_POSE_TRACKER,
      cadence: QUALITY_PRESETS[quality],
      prepareFrame: (video) => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return null;

        cameraSizeRef.current = { width, height };

        const size = computeTrackingSize(width, height, trackingSizeRef.current);
        if (trackingCanvas.width !== size.width || trackingCanvas.height !== size.height) {
          trackingCanvas.width = size.width;
          trackingCanvas.height = size.height;
        }

        // Unmirrored, always. The model works on the true frame; the flip is a
        // display concern and lives in the coordinate mapping.
        trackingContext.drawImage(video, 0, 0, size.width, size.height);
        return trackingCanvas;
      },
      onUpdate: ({ face: faceResult, stats }) => {
        const now = performance.now();
        if (faceResult && faceResult.timestampMs !== boundarySkinSampleTimestampMs) {
          if (faceResult.detected && boundarySampleContext && now - lastBoundarySampleAt >= 125) {
            const sampleStartedAt = performance.now();
            try {
              boundarySampleContext.drawImage(trackingCanvas, 0, 0, boundarySampleCanvas.width, boundarySampleCanvas.height);
              const pixels = boundarySampleContext.getImageData(0, 0, boundarySampleCanvas.width, boundarySampleCanvas.height).data;
              const center = faceResult.landmarks[1];
              boundarySkinSamples = BOUNDARY_SKIN_REGIONS.map(({ landmark }) => {
                const point = faceResult.landmarks[landmark];
                if (!point || !center) return null;
                return sampleImageRegion(pixels, boundarySampleCanvas.width, boundarySampleCanvas.height, {
                  x: point.x + (center.x - point.x) * 0.18,
                  y: point.y + (center.y - point.y) * 0.18,
                });
              });
              boundarySkinSampleTimestampMs = faceResult.timestampMs;
              boundarySkinSampleCostMs = performance.now() - sampleStartedAt;
              lastBoundarySampleAt = now;
            } catch {
              boundarySkinSamples = BOUNDARY_SKIN_REGIONS.map(() => null);
              boundarySkinSampleTimestampMs = faceResult.timestampMs;
              boundarySkinSampleCostMs = performance.now() - sampleStartedAt;
              lastBoundarySampleAt = now;
            }
          } else if (!faceResult.detected) {
            boundarySkinSamples = BOUNDARY_SKIN_REGIONS.map(() => null);
            boundarySkinSampleTimestampMs = faceResult.timestampMs;
            boundarySkinSampleCostMs = 0;
          }
        }

        // The Face Landmarker is configured for one active controller. If it
        // loses that face and a clear face returns after a brief stable window,
        // capture a fresh face-only neutral automatically. The source asset is
        // separate and is never re-analysed or replaced.
        if (faceResult && faceResult.timestampMs !== lastObservedFaceTimestamp) {
          lastObservedFaceTimestamp = faceResult.timestampMs;
          if (faceResult.detected) {
            if (trackingLostAt !== null && now - trackingLostAt >= 250) {
              blinkState.reset();
              gazeSmoother.reset();
              expressionRef.current = null;
              motionRef.current = NO_MOTION;
              startCalibrationRef.current?.("face-only");
            }
            trackingLostAt = null;
          } else if (trackingLostAt === null && calibrationCollector.getState().phase === "ready") {
            trackingLostAt = now;
          }
        }

        /*
         * Calibration is fed every frame, because a window of a dozen frames
         * cannot afford to miss any. Publishing it to React is throttled — but
         * a PHASE change always goes straight through, so "Hold still" becomes
         * "Almost ready…" the moment it is true rather than up to 100ms later.
         */
        if (calibrationCollector.isRunning) {
          calibrationCollector.accept(faceResult, null, now);
          const next = calibrationCollector.getState();
          if (next.phase !== lastCalibrationPhaseRef.current || now - lastCalibrationAtRef.current >= 100) {
            lastCalibrationPhaseRef.current = next.phase;
            lastCalibrationAtRef.current = now;
            setCalibration(next);
          }
        }

        // This is pure arithmetic over results the scheduler already made. It
        // is intentionally outside React so a renderer can consume every
        // tracker update without a second inference loop or 60 renders/sec.
        const profile = calibrationCollector.getState().profile;
        if (profile !== lastStabilityProfile) {
          landmarkStabilizer.reset();
          headMotionStabilizer.reset();
          lastStabilityProfile = profile;
        }
        const rawMotion = computeRelativeMotion(profile, faceResult, null);
        const control = controlsRef.current.tracking;
        landmarkStabilizer.setStability(control.stability);
        const stabilizedHead = headMotionStabilizer.update(rawMotion.head, faceResult?.timestampMs ?? now, control.stability);
        const selectedHead = control.faceLock ? stabilizedHead : rawMotion.head;
        const currentMotion = {
          ...rawMotion,
          head: selectedHead ? {
            ...selectedHead,
            yawDelta: selectedHead.yawDelta * responseGain(control.yawResponse, 70),
            pitchDelta: selectedHead.pitchDelta * responseGain(control.pitchResponse, 70),
            scaleDelta: 1 + (selectedHead.scaleDelta - 1) * responseGain(control.scaleFollow, 72),
          } : null,
        };
        const filteredLandmarks = landmarkStabilizer.update(
          faceResult?.detected ? faceResult.landmarks : null,
          faceResult?.timestampMs ?? now,
        );
        const stabilizedLandmarks = control.rawDirect
          ? faceResult?.detected ? faceResult.landmarks : null
          : control.faceLock ? filteredLandmarks : faceResult?.detected ? faceResult.landmarks : null;
        motionRef.current = currentMotion;
        const eyeProfile = profile;
        if (lastEyeProfile !== eyeProfile) { eyeFilter.reset(); blinkState.reset(); gazeSmoother.reset(); lastEyeProfile = eyeProfile; lastExpressionTimestamp = Number.NaN; }
        // Pose-only updates may contain the same face result. They must not
        // advance blink velocity or adaptive eye filters a second time.
        if (faceResult?.timestampMs !== lastExpressionTimestamp) {
        lastExpressionTimestamp = faceResult?.timestampMs ?? Number.NaN;
        const expression = blinkState.apply(computeExpressionMotion(faceResult, eyeProfile), now);
        if (expression?.eyeGaze) {
          expression.eyeGaze.applied = gazeSmoother.update(
            expression.eyeGaze.normalized,
            expression.eyeGaze.quality ? { left: expression.eyeGaze.quality.left * (faceResult?.confidence ?? 0), right: expression.eyeGaze.quality.right * (faceResult?.confidence ?? 0) } : null,
            now,
            { left: expression.blinkLeft >= 0.5, right: expression.blinkRight >= 0.5 },
            { left: (expression.eyes?.[EYE_RENDER_CHANNELS.left].confidence ?? 0) >= 0.35, right: (expression.eyes?.[EYE_RENDER_CHANNELS.right].confidence ?? 0) >= 0.35 },
          );
        }
        if (expression?.eyes) {
          for (const side of ['left', 'right'] as const) {
            const channel = EYE_RENDER_CHANNELS[side];
            expression.eyes[side].blink = channel === 'left' ? expression.blinkLeft : expression.blinkRight;
            expression.eyes[side].openness = (1 - expression.eyes[side].blink) * (1 + 0.4 * expression.eyes[side].wideOpen);
            expression.eyes[side].gazeX = expression.eyeGaze?.applied?.[channel].x ?? 0;
            expression.eyes[side].gazeY = expression.eyeGaze?.applied?.[channel].y ?? 0;
          }
          // Gaze has already been filtered by its iris-quality-aware path.
          const filtered = eyeFilter.update(expression.eyes, now);
          for (const side of ['left', 'right'] as const) {
            filtered[side].gazeX = expression.eyes[side].gazeX;
            filtered[side].gazeY = expression.eyes[side].gazeY;
          }
          expression.eyes = filtered;
          expression.eyes = hybridCoordinator.resolve({ eyes: filtered, pose: null, detected: faceResult?.detected ?? false, confidence: faceResult?.confidence ?? 0 }, now).eyes ?? filtered;
          expression.blinkLeft = filtered[EYE_RENDER_CHANNELS.left].blink;
          expression.blinkRight = filtered[EYE_RENDER_CHANNELS.right].blink;
        } else eyeFilter.update(null, now);
        // Snapshot only for a visible live oral preview, once per NEW face
        // result. The inference pixels and lip polygon now describe the same
        // frame, even when video decoding advances during model inference.
        // One reusable buffer, no queue, camera/tracker/eye inputs unchanged.
        if(expression?.liveMouth && oralFrameEnabledRef.current && oralContext){
          if(oralFrame.width!==trackingCanvas.width || oralFrame.height!==trackingCanvas.height){oralFrame.width=trackingCanvas.width;oralFrame.height=trackingCanvas.height;}
          oralContext.drawImage(trackingCanvas,0,0);
          expression.liveMouth.sourceFrame=oralFrame;
        } else if(oralFrame.width>0){oralContext?.clearRect(0,0,oralFrame.width,oralFrame.height);}
        expressionRef.current = expression;
        }
        if (calibrationCollector.getState().phase === "ready") renderPausedRef.current = false;

        if (faceResult && (faceResult.timestampMs !== lastPublishedFaceTimestamp || profile !== lastPublishedProfile)) {
          lastPublishedFaceTimestamp = faceResult.timestampMs;
          lastPublishedProfile = profile;
          const trackedHead = faceResult.detected ? currentMotion.head : null;
          const currentAnchors = faceResult.detected ? stableHeadAnchors(faceResult.landmarks) ?? [] : [];
          const rawFit = profile?.face.stableAnchors && currentAnchors.length
            ? fitStableHeadAnchors(profile.face.stableAnchors, currentAnchors, profile.face.center,
              trackingCanvas.width / Math.max(1, trackingCanvas.height))
            : null;
          const rawScaleRatio = rawFit?.scale ?? rawMotion.head?.scaleDelta ?? null;
          const renderAnchors = stabilizedLandmarks ? stableHeadAnchors(stabilizedLandmarks) ?? [] : [];
          const renderFit = profile?.face.stableAnchors && renderAnchors.length
            ? fitStableHeadAnchors(profile.face.stableAnchors, renderAnchors, profile.face.center,
              trackingCanvas.width / Math.max(1, trackingCanvas.height))
            : null;
          const renderBounds = stabilizedLandmarks ? faceBounds(stabilizedLandmarks) : null;
          const renderCenter = renderFit?.center ?? (renderBounds ? {
            x: (renderBounds.minX + renderBounds.maxX) / 2,
            y: (renderBounds.minY + renderBounds.maxY) / 2,
            z: faceResult.derived?.center.z ?? 0,
          } : null);
          const frameId = faceResult.frameId ?? ++nextFaceFrameId;
          const viewportTransform = geometry();
          const viewportPlacement = faceResult.detected && renderBounds && renderCenter
            ? mapFacePlacementToDisplay({ center: renderCenter, bounds: renderBounds }, viewportTransform)
            : null;
          faceFrameRef.current = {
            frameId,
            timestampMs: faceResult.timestampMs,
            trackingTimestampMs: stats.faceEndMs ?? now,
            landmarks: faceResult.landmarks,
            stabilizedLandmarks: stabilizedLandmarks ?? faceResult.landmarks,
            stabilizationMs: landmarkStabilizer.lastUpdateMs + headMotionStabilizer.lastUpdateMs,
            stabilizationLatencyEstimateMs: Math.max(
              landmarkStabilizer.lastLatencyEstimateMs ?? 0,
              headMotionStabilizer.lastLatencyEstimateMs ?? 0,
            ),
            boundarySkinSamples,
            boundarySkinSampleTimestampMs,
            boundarySkinSampleCostMs,
            rawGlobalTransform: rawMotion.head,
            // Screen placement and scale come from this raw camera frame. The
            // calibration fit remains available as a size reference only.
            globalTransform: trackedHead,
            globalCenter: faceResult.detected ? faceResult.derived?.center ?? null : null,
            viewportPlacement,
            referenceCenter: profile?.face.center ?? null,
            referenceScale: profile?.face.scale ?? null,
            rawFaceScale: profile?.face.scale !== undefined && rawScaleRatio !== null
              ? profile.face.scale * rawScaleRatio
              : null,
            trackingAspect: profile && profile.trackingSpace.height > 0
              ? profile.trackingSpace.width / profile.trackingSpace.height
              : trackingCanvas.width / Math.max(1, trackingCanvas.height),
            rawScaleRatio,
            expressionState: expressionRef.current,
            stableAnchors: currentAnchors,
            referenceAnchors: profile?.face.stableAnchors ?? [],
            projectedReferenceAnchors: rawFit?.projectedReference ?? [],
            livePlacement: {
              frameId,
              timestampMs: faceResult.timestampMs,
              center: faceResult.detected ? renderCenter : null,
              width: faceResult.detected && renderBounds ? renderBounds.maxX - renderBounds.minX : null,
              height: faceResult.detected && renderBounds ? renderBounds.maxY - renderBounds.minY : null,
              scale: faceResult.detected ? renderFit?.scale ?? currentMotion.head?.scaleDelta ?? null : null,
              roll: trackedHead?.rollDelta ?? null,
              yaw: trackedHead?.yawDelta ?? null,
              pitch: trackedHead?.pitchDelta ?? null,
              mirrored: viewportTransform.mirrored,
              devicePixelRatio: window.devicePixelRatio || 1,
              viewportTransform,
              viewport: viewportPlacement,
            },
          };
        }
        drawFrame(faceResult);

        // React sees the rest a few times a second, not every frame.
        if (now - lastSummaryAtRef.current < SUMMARY_INTERVAL_MS) return;
        lastSummaryAtRef.current = now;

        setSummary({
          face: faceResult,
          pose: null,
          stats,
          guidance: describeTracking(faceResult, null, { running: true }),
          cameraWidth: cameraSizeRef.current.width,
          cameraHeight: cameraSizeRef.current.height,
          faceInitMs: face.getTimings().initMs,
          // Against whatever baseline exists right now. Null profile gives
          // `NO_MOTION`, which is absent rather than zero.
          motion: currentMotion,
          expression: expressionRef.current,
        });
      },
    });

    const runtime: Runtime = {
      clock,
      face,
      camera,
      scheduler,
      calibration: calibrationCollector,
      trackingCanvas,
      trackingContext,
      oralFrame,
      gazeSmoother,
      blinkState,
    };
    runtimeRef.current = runtime;

    function drawFrame(faceResult: FaceTrackingResult | null) {
      const overlay = overlayRef.current;
      const context = overlay?.getContext("2d");
      if (!overlay || !context) return;

      const { width, height } = displaySizeRef.current;
      const backing = computeOverlayCanvasSize(width, height, window.devicePixelRatio);
      if (overlay.width !== backing.width || overlay.height !== backing.height) {
        overlay.width = backing.width;
        overlay.height = backing.height;
      }

      drawTrackingOverlay(context, faceResult, null, {
        geometry: geometry(),
        style: { ...DEFAULT_OVERLAY_STYLE, ratio: backing.ratio },
        showFace: showFaceRef.current,
        showPose: false,
        faceLockDebug: faceLockDebugRef.current ? faceFrameRef.current : null,
        livePlacement: faceFrameRef.current?.livePlacement ?? null,
      });
    }

    void (async () => {
      try {
        dispatch({ type: "LOAD_DEPENDENCIES" });
        dispatch({ type: "LOAD_MODELS" });
        dispatch({ type: "LOADING_STAGE", stage: "Loading the face model" });
        await face.initialize();
        if (runtimeRef.current !== runtime) return;

        dispatch({ type: "RUNTIME_READY" });
      } catch (error) {
        if (runtimeRef.current !== runtime) return;
        dispatch({
          type: "FAIL",
          code: "model_load_failed",
          error: error instanceof Error ? error.message : "The vision models could not be loaded.",
        });
        return;
      }

      // Only now is a camera requested. Asking before the models were ready
      // would leave the light on through a download somebody might cancel.
      dispatch({ type: "REQUEST_CAMERA" });

      let stream: MediaStream;
      try {
        stream = await camera.start("user");
      } catch (error) {
        if (runtimeRef.current !== runtime) return;
        const described = describeCameraError(error);
        dispatch(
          described.code === "permission_denied"
            ? { type: "CAMERA_DENIED", error: described.message }
            : { type: "CAMERA_FAILED", error: described.message },
        );
        return;
      }

      if (runtimeRef.current !== runtime) return;

      const video = videoRef.current;
      if (!video) return;

      video.srcObject = stream;
      cameraSizeRef.current = { width: camera.state.width, height: camera.state.height };
      setFacing(camera.state.facing);

      try {
        await video.play();
      } catch {
        // Autoplay of a muted, inline local preview is permitted everywhere this
        // runs; if it is refused the loop simply sees no frames, which the
        // guidance already reports honestly.
      }

      if (runtimeRef.current !== runtime) return;

      dispatch({ type: "CAMERA_LIVE" });
      dispatch({ type: "START_RUNNING" });
      scheduler.start(video);
      if (trackerLabLeases.current > 0) scheduler.pause();
    })();
  }, [geometry, quality]);

  const stop = useCallback(() => {
    teardown();
    dispatch({ type: "DISPOSE" });
    setSummary(EMPTY_SUMMARY);
    motionRef.current = NO_MOTION;
    expressionRef.current = null;
    renderPausedRef.current = false;
    // A baseline belongs to a Studio session, and this ends one.
    setCalibration(IDLE_CALIBRATION);
    setCalibrationInvalidation("disposed");
    lastCalibrationPhaseRef.current = "idle";
    cameraSizeRef.current = { width: null, height: null };
  }, [teardown]);

  /**
   * Begins a face-neutral capture after an explicit operator request or when a
   * camera flip / sustained tracking loss changes the active controller.
   */
  const startCalibration = useCallback((mode: CalibrationMode = "face-only") => {
    if (trackerLabLeases.current > 0) return;
    const runtime = runtimeRef.current;
    if (!runtime || runtime.camera.state.stream === null) return;

    const size = computeTrackingSize(
      cameraSizeRef.current.width ?? 0,
      cameraSizeRef.current.height ?? 0,
      trackingSizeRef.current,
    );

    runtime.calibration.start(
      mode,
      {
        cameraFacing: runtime.camera.state.facing,
        trackingWidth: size.width,
        trackingHeight: size.height,
        mirrored: runtime.camera.state.mirrored,
      },
      performance.now(),
    );

    setCalibrationInvalidation(null);
    runtime.blinkState.reset();
    runtime.gazeSmoother.reset();
    motionRef.current = NO_MOTION;
    expressionRef.current = null;
    renderPausedRef.current = true;
    lastCalibrationPhaseRef.current = runtime.calibration.getState().phase;
    setCalibration(runtime.calibration.getState());
  }, []);
  startCalibrationRef.current = startCalibration;

  const cancelCalibration = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.calibration.cancel();
    setCalibration(runtime.calibration.getState());
  }, []);

  /** Drops the baseline without touching the models, the camera or the loop. */
  const clearCalibration = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.calibration.clear();
    lastCalibrationPhaseRef.current = "idle";
    setCalibration(runtime.calibration.getState());
    setCalibrationInvalidation("recalibration-requested");
    setSummary((previous) => ({ ...previous, motion: NO_MOTION }));
    motionRef.current = NO_MOTION;
    expressionRef.current = null;
    renderPausedRef.current = true;
  }, []);

  const togglePause = useCallback(() => {
    if (trackerLabLeases.current > 0) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (runtime.scheduler.isRunning) {
      // The preview stays live; only inference stops. That is what makes this
      // useful for looking closely at a frozen overlay.
      runtime.scheduler.pause();
      dispatch({ type: "PAUSE" });
      setSummary((previous) => ({
        ...previous,
        guidance: describeTracking(previous.face, null, { running: false }),
      }));
    } else {
      runtime.scheduler.resume();
      dispatch({ type: "RESUME" });
    }
  }, []);

  const flipCamera = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.camera.isSwitching) return;
    runtime.gazeSmoother.reset();

    dispatch({ type: "CAMERA_SWITCHING" });
    // A baseline belongs to its camera. Freeze the experimental output until
    // the operator explicitly captures a fresh neutral on the new camera.
    renderPausedRef.current = true;
    expressionRef.current = null;

    /*
     * A flip invalidates the baseline, immediately and unconditionally.
     *
     * Front and rear cameras differ in mirror, optics, field of view and where
     * the operator sits in frame. Silently reusing a front-camera neutral on a
     * rear camera produces motion that is subtly and unfixably wrong — every
     * delta measured from a pose the operator was never in. The models, the
     * camera and the loop are untouched; only the baseline goes.
     */
    runtime.calibration.clear();
    lastCalibrationPhaseRef.current = "idle";
    setCalibration(runtime.calibration.getState());
    setCalibrationInvalidation("camera-facing-changed");
    setSummary((previous) => ({ ...previous, motion: NO_MOTION }));

    void (async () => {
      try {
        const result = await runtime.camera.flip();
        if (runtimeRef.current !== runtime) return;

        const video = videoRef.current;
        if (video) {
          video.srcObject = result.stream;
          await video.play().catch(() => {});
          // The same element, so the scheduler keeps its loop and the models
          // are untouched.
          runtime.scheduler.setVideo(video);
        }

        cameraSizeRef.current = { width: runtime.camera.state.width, height: runtime.camera.state.height };
        setFacing(result.facing);
        dispatch({ type: "CAMERA_LIVE" });
        startCalibration("face-only");
      } catch (error) {
        if (runtimeRef.current !== runtime) return;

        // The camera controller restores the previous facing where it can, so
        // this reports the flip failing rather than the camera being lost.
        setFacing(runtime.camera.state.facing);
        const described = describeCameraError(error);
        dispatch(
          runtime.camera.state.stream
            ? { type: "CAMERA_LIVE" }
            : { type: "CAMERA_FAILED", error: described.message },
        );
      }
    })();
  }, [startCalibration]);

  /**
   * Changing quality does NOT invalidate a calibration.
   *
   * A preset changes how often each model runs and how large the frame handed
   * to them is. It does not change the coordinate convention: landmarks stay
   * normalised 0..1, the tracking frame keeps the camera's aspect ratio, and
   * mirroring and cropping are untouched. A baseline captured at 480px means
   * exactly the same thing at 320px, so invalidating here would cost the
   * operator a recalibration for nothing.
   *
   * The profile records the tracking size it was captured at, for the record.
   * If a future preset ever changed the crop or the mirror, THAT would have to
   * invalidate — which is why the rule is written down rather than implied.
   */
  const setQuality = useCallback((mode: QualityMode) => {
    setQualityState(mode);
    trackingSizeRef.current = QUALITY_PRESETS[mode].trackingSize;
    runtimeRef.current?.scheduler.setCadence(QUALITY_PRESETS[mode]);
  }, []);

  /** Keeps the cached display size current without measuring inside the loop. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      displaySizeRef.current = { width: video.clientWidth, height: video.clientHeight };
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  /**
   * A hidden tab gets no camera frames and should not hold a GPU context.
   *
   * Only pauses what was running, and only resumes what this effect paused —
   * returning to a tab must not restart a session the operator paused by hand.
   */
  useEffect(() => {
    let pausedByVisibility = false;

    const onVisibilityChange = () => {
      const scheduler = runtimeRef.current?.scheduler;
      if (!scheduler) return;
      if (trackerLabLeases.current > 0) return;

      if (document.hidden) {
        if (!scheduler.isRunning) return;
        scheduler.pause();
        pausedByVisibility = true;
        dispatch({ type: "PAUSE" });
      } else if (pausedByVisibility || resumeAfterLab.current) {
        pausedByVisibility = false;
        resumeAfterLab.current = false;
        scheduler.resume();
        dispatch({ type: "RESUME" });
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return useMemo(
    () => ({
      state,
      summary,
      quality,
      facing,
      showFace,
      calibration,
      calibrationInvalidation,
      motionRef,
      expressionRef,
      faceFrameRef,
      faceLockDebugRef,
      oralFrameEnabledRef,
      renderPausedRef,
      videoRef,
      overlayRef,
      start,
      stop,
      togglePause,
      flipCamera,
      setQuality,
      setShowFace,
      startCalibration,
      cancelCalibration,
      clearCalibration,
      suspendForTrackerLab,
      getFaceTracker,
    }),
    [
      state,
      summary,
      quality,
      facing,
      showFace,
      calibration,
      calibrationInvalidation,
      motionRef,
      expressionRef,
      faceFrameRef,
      faceLockDebugRef,
      renderPausedRef,
      start,
      stop,
      togglePause,
      flipCamera,
      setQuality,
      startCalibration,
      cancelCalibration,
      clearCalibration,
    ],
  );
}
