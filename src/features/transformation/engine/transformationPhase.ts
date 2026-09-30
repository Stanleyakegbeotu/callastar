/**
 * The Transformation Studio lifecycle.
 *
 * One machine, driven by things that actually happen: a dependency chunk
 * arriving, a model finishing its download, a source being analysed, a camera
 * being granted. Deliberately not a collection of booleans — `loading &&
 * !ready && !failed` is how a studio ends up rendering a preview over a
 * disposed renderer.
 *
 * Three concerns stay separate, because they genuinely move independently:
 * the ENGINE phase below, the CAMERA state, and the SOURCE state. A camera can
 * be running while a source is still being analysed, and a source can be ready
 * long before anyone grants a camera.
 */

export type TransformationPhase =
  /** Nothing started. */
  | "idle"
  /** Pulling the MediaPipe/OpenCV/Three chunks in. */
  | "loading-dependencies"
  /** Fetching and instantiating the face and pose models. */
  | "loading-models"
  /** Runtime is up and waiting for a source. */
  | "source-selected"
  /** Reading landmarks and geometry out of the chosen source. */
  | "analyzing-source"
  /** The source has a usable prepared profile. */
  | "source-ready"
  /** Waiting on the camera permission prompt. */
  | "camera-request"
  /** Measuring the operator's neutral pose. */
  | "calibrating"
  /** Everything is prepared; the loop is not running. */
  | "ready"
  /** The tracking/render loop is running. */
  | "running"
  /** Deliberately suspended — by the operator, or by the page being hidden. */
  | "paused"
  | "failed"
  /** Torn down. Terminal: nothing restarts from here. */
  | "disposed";

/**
 * Why the Studio stopped.
 *
 * A closed set, because each one has its own copy and its own recovery. A
 * missing model and a refused camera are not the same problem and must not read
 * as the same message.
 */
export type TransformationErrorCode =
  | "unsupported_browser"
  | "webgl_unavailable"
  | "wasm_failed"
  | "model_load_failed"
  | "camera_permission_denied"
  | "camera_unavailable"
  | "source_decode_failed"
  | "source_face_not_found"
  | "pose_not_found"
  | "renderer_failed"
  | "out_of_memory"
  | "tracking_lost";

/** Camera state, independent of the engine phase. */
export type CameraState = "off" | "requesting" | "live" | "switching" | "denied" | "error";

/** Source state, independent of both. */
export type SourceState = "none" | "selected" | "analyzing" | "ready" | "failed";

export interface TransformationState {
  phase: TransformationPhase;
  camera: CameraState;
  source: SourceState;
  /** Operator-facing sentence, never a raw exception. */
  error: string | null;
  errorCode: TransformationErrorCode | null;
  /** What the loading screen is currently waiting on. */
  loadingStage: string | null;
  /** True once the runtime is up, so a source change need not reload 35MB. */
  runtimeReady: boolean;
}

export const initialTransformationState: TransformationState = {
  phase: "idle",
  camera: "off",
  source: "none",
  error: null,
  errorCode: null,
  loadingStage: null,
  runtimeReady: false,
};

export type TransformationAction =
  | { type: "LOAD_DEPENDENCIES" }
  | { type: "LOAD_MODELS" }
  | { type: "LOADING_STAGE"; stage: string }
  /** Runtime and models are up. Survives source changes. */
  | { type: "RUNTIME_READY" }
  | { type: "SELECT_SOURCE" }
  | { type: "ANALYZE_SOURCE" }
  | { type: "SOURCE_READY" }
  | { type: "SOURCE_FAILED"; code: TransformationErrorCode; error: string }
  | { type: "REQUEST_CAMERA" }
  | { type: "CAMERA_LIVE" }
  | { type: "CAMERA_DENIED"; error: string }
  | { type: "CAMERA_FAILED"; error: string }
  /** A flip: the camera is briefly between tracks but the engine survives. */
  | { type: "CAMERA_SWITCHING" }
  | { type: "STOP_CAMERA" }
  | { type: "START_CALIBRATION" }
  | { type: "CALIBRATED" }
  | { type: "START_RUNNING" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "FAIL"; code: TransformationErrorCode; error: string }
  | { type: "DISPOSE" };

/**
 * Phases an action may arrive in.
 *
 * The Studio is asynchronous in several directions at once — a model download,
 * a source analysis and a camera prompt can all be outstanding together — so a
 * late callback landing after teardown is normal, not exceptional. Guarding here
 * is what stops one resurrecting a disposed engine.
 */
const ALLOWED_FROM: Partial<Record<TransformationAction["type"], readonly TransformationPhase[]>> = {
  LOAD_DEPENDENCIES: ["idle", "failed"],
  LOAD_MODELS: ["loading-dependencies"],
  RUNTIME_READY: ["loading-dependencies", "loading-models"],
  // A source may be chosen at any point once the runtime is up, including while
  // another is already loaded — that is Change Source.
  SELECT_SOURCE: ["source-selected", "source-ready", "analyzing-source", "ready", "running", "paused"],
  ANALYZE_SOURCE: ["source-selected", "source-ready"],
  SOURCE_READY: ["analyzing-source"],
  SOURCE_FAILED: ["analyzing-source"],
  REQUEST_CAMERA: ["source-ready", "ready", "source-selected"],
  CAMERA_LIVE: ["camera-request", "ready", "running", "paused"],
  CAMERA_DENIED: ["camera-request"],
  CAMERA_FAILED: ["camera-request", "ready", "running", "paused"],
  CAMERA_SWITCHING: ["ready", "running", "paused"],
  START_CALIBRATION: ["ready", "running", "paused"],
  CALIBRATED: ["calibrating"],
  START_RUNNING: ["ready", "paused", "calibrating"],
  PAUSE: ["running"],
  RESUME: ["paused"],
};

function isAllowed(action: TransformationAction, phase: TransformationPhase): boolean {
  // Nothing may move a disposed engine. It is torn down; there is no restart.
  if (phase === "disposed" && action.type !== "DISPOSE") return false;
  const allowed = ALLOWED_FROM[action.type];
  return allowed === undefined || allowed.includes(phase);
}

export function transformationReducer(
  state: TransformationState,
  action: TransformationAction,
): TransformationState {
  if (!isAllowed(action, state.phase)) return state;

  switch (action.type) {
    case "LOAD_DEPENDENCIES":
      return { ...state, phase: "loading-dependencies", error: null, errorCode: null, loadingStage: "Loading vision engine" };

    case "LOAD_MODELS":
      return { ...state, phase: "loading-models", loadingStage: "Loading face and pose models" };

    case "LOADING_STAGE":
      return { ...state, loadingStage: action.stage };

    /**
     * The runtime survives source changes.
     *
     * `runtimeReady` is what lets Change Source skip reloading 35MB of WASM and
     * 9MB of models for every new image.
     */
    case "RUNTIME_READY":
      return { ...state, phase: "source-selected", runtimeReady: true, loadingStage: null };

    case "SELECT_SOURCE":
      return { ...state, phase: "source-selected", source: "selected", error: null, errorCode: null };

    case "ANALYZE_SOURCE":
      return { ...state, phase: "analyzing-source", source: "analyzing" };

    case "SOURCE_READY":
      return { ...state, phase: "source-ready", source: "ready" };

    case "SOURCE_FAILED":
      // The engine itself is fine; only this source failed. Staying in
      // `source-selected` lets the operator pick another without a reload.
      return {
        ...state,
        phase: "source-selected",
        source: "failed",
        errorCode: action.code,
        error: action.error,
      };

    case "REQUEST_CAMERA":
      return { ...state, phase: "camera-request", camera: "requesting", error: null, errorCode: null };

    case "CAMERA_LIVE":
      // From a flip this returns to whatever it was doing, because the engine
      // never stopped — only the track changed.
      return {
        ...state,
        camera: "live",
        phase: state.phase === "camera-request" ? "ready" : state.phase,
      };

    case "CAMERA_DENIED":
      return {
        ...state,
        phase: "failed",
        camera: "denied",
        errorCode: "camera_permission_denied",
        error: action.error,
      };

    case "CAMERA_FAILED":
      return { ...state, phase: "failed", camera: "error", errorCode: "camera_unavailable", error: action.error };

    case "CAMERA_SWITCHING":
      // Deliberately does not touch the phase: a flip must not tear down
      // calibration or the prepared source.
      return { ...state, camera: "switching" };

    case "STOP_CAMERA":
      return { ...state, camera: "off", phase: state.source === "ready" ? "source-ready" : "source-selected" };

    case "START_CALIBRATION":
      return { ...state, phase: "calibrating" };

    case "CALIBRATED":
      return { ...state, phase: "ready" };

    case "START_RUNNING":
      return { ...state, phase: "running" };

    case "PAUSE":
      return { ...state, phase: "paused" };

    case "RESUME":
      return { ...state, phase: "running" };

    case "FAIL":
      return { ...state, phase: "failed", errorCode: action.code, error: action.error };

    case "DISPOSE":
      // Terminal, and deliberately keeps nothing: every resource is released.
      return { ...initialTransformationState, phase: "disposed" };
  }
}

/** Whether the tracking loop should be running right now. */
export function shouldRunLoop(state: TransformationState): boolean {
  return (state.phase === "running" || state.phase === "calibrating") && state.camera === "live";
}

/** Whether a source change is safe without reloading the runtime. */
export function canChangeSource(state: TransformationState): boolean {
  return state.runtimeReady && state.phase !== "disposed";
}
