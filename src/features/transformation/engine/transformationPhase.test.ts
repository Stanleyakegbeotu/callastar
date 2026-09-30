import { describe, expect, it } from "vitest";

import {
  canChangeSource,
  initialTransformationState,
  shouldRunLoop,
  transformationReducer,
  type TransformationAction,
  type TransformationState,
} from "./transformationPhase";

function run(actions: TransformationAction[], from: TransformationState = initialTransformationState) {
  return actions.reduce(transformationReducer, from);
}

/** The runtime up and a source analysed — the common starting point. */
function sourceReady(): TransformationState {
  return run([
    { type: "LOAD_DEPENDENCIES" },
    { type: "LOAD_MODELS" },
    { type: "RUNTIME_READY" },
    { type: "SELECT_SOURCE" },
    { type: "ANALYZE_SOURCE" },
    { type: "SOURCE_READY" },
  ]);
}

function running(): TransformationState {
  return run(
    [
      { type: "REQUEST_CAMERA" },
      { type: "CAMERA_LIVE" },
      { type: "START_CALIBRATION" },
      { type: "CALIBRATED" },
      { type: "START_RUNNING" },
    ],
    sourceReady(),
  );
}

describe("transformation lifecycle", () => {
  it("reports the loading stage rather than an indefinite spinner", () => {
    // Section 89: 35MB of WASM and 9MB of models is a real wait, and a bare
    // spinner for it reads as a hang.
    const deps = transformationReducer(initialTransformationState, { type: "LOAD_DEPENDENCIES" });
    expect(deps.phase).toBe("loading-dependencies");
    expect(deps.loadingStage).toBeTruthy();

    const models = transformationReducer(deps, { type: "LOAD_MODELS" });
    expect(models.loadingStage).toBeTruthy();
    expect(models.loadingStage).not.toBe(deps.loadingStage);
  });

  it("keeps the runtime across a source change", () => {
    // Section 66: changing the image must not re-download the runtime.
    const ready = sourceReady();
    expect(ready.runtimeReady).toBe(true);
    expect(canChangeSource(ready)).toBe(true);

    const changed = transformationReducer(ready, { type: "SELECT_SOURCE" });
    expect(changed.runtimeReady, "a source change must not drop the runtime").toBe(true);
    expect(changed.source).toBe("selected");
  });

  it("keeps a failed source recoverable without reloading anything", () => {
    // A source with no face in it is not an engine failure; the operator should
    // be able to pick another immediately.
    const failed = run(
      [
        { type: "SELECT_SOURCE" },
        { type: "ANALYZE_SOURCE" },
        { type: "SOURCE_FAILED", code: "source_face_not_found", error: "No face found in that image." },
      ],
      sourceReady(),
    );

    expect(failed.source).toBe("failed");
    expect(failed.errorCode).toBe("source_face_not_found");
    // Not "failed": the engine is fine.
    expect(failed.phase).toBe("source-selected");
    expect(failed.runtimeReady).toBe(true);
    expect(canChangeSource(failed)).toBe(true);
  });

  it("treats the three concerns as independent", () => {
    // Engine phase, camera and source move separately — a camera can be live
    // while a source is still being analysed.
    const state = run([{ type: "REQUEST_CAMERA" }, { type: "CAMERA_LIVE" }], sourceReady());
    expect(state.camera).toBe("live");
    expect(state.source).toBe("ready");
    expect(state.phase).toBe("ready");
  });

  it("survives a camera flip without losing calibration or the source", () => {
    // Section 24: switching cameras must not destroy source calibration.
    const live = running();
    const switching = transformationReducer(live, { type: "CAMERA_SWITCHING" });

    expect(switching.camera).toBe("switching");
    // The phase is deliberately untouched: the engine never stopped.
    expect(switching.phase).toBe("running");
    expect(switching.source).toBe("ready");

    const back = transformationReducer(switching, { type: "CAMERA_LIVE" });
    expect(back.camera).toBe("live");
    expect(back.phase, "a flip must not knock the engine out of running").toBe("running");
  });

  it("classifies a refused camera separately from an unavailable one", () => {
    // Section 86/87: these are different problems with different recoveries.
    const denied = run([{ type: "REQUEST_CAMERA" }, { type: "CAMERA_DENIED", error: "blocked" }], sourceReady());
    expect(denied.errorCode).toBe("camera_permission_denied");
    expect(denied.camera).toBe("denied");

    const broken = run([{ type: "REQUEST_CAMERA" }, { type: "CAMERA_FAILED", error: "in use" }], sourceReady());
    expect(broken.errorCode).toBe("camera_unavailable");
  });

  it("only runs the loop when there is something to track", () => {
    expect(shouldRunLoop(running())).toBe(true);
    expect(shouldRunLoop(sourceReady()), "no camera, no loop").toBe(false);

    const paused = transformationReducer(running(), { type: "PAUSE" });
    expect(shouldRunLoop(paused), "a paused studio must not keep inferring").toBe(false);

    // Section 60: a hidden page must not keep MediaPipe running.
    expect(shouldRunLoop(transformationReducer(paused, { type: "RESUME" }))).toBe(true);
  });

  it("runs the loop during calibration, which needs live tracking", () => {
    const calibrating = run(
      [{ type: "REQUEST_CAMERA" }, { type: "CAMERA_LIVE" }, { type: "START_CALIBRATION" }],
      sourceReady(),
    );
    expect(shouldRunLoop(calibrating)).toBe(true);
  });

  it("cannot be resurrected once disposed", () => {
    // Late callbacks after teardown are normal here: a model download, a source
    // analysis and a camera prompt can all be outstanding at once.
    const disposed = transformationReducer(running(), { type: "DISPOSE" });
    expect(disposed.phase).toBe("disposed");

    for (const action of [
      { type: "START_RUNNING" },
      { type: "CAMERA_LIVE" },
      { type: "SOURCE_READY" },
      { type: "RESUME" },
      { type: "LOAD_MODELS" },
      { type: "RUNTIME_READY" },
    ] satisfies TransformationAction[]) {
      expect(transformationReducer(disposed, action), `${action.type} must not revive a disposed engine`).toBe(
        disposed,
      );
    }

    expect(canChangeSource(disposed)).toBe(false);
    expect(shouldRunLoop(disposed)).toBe(false);
  });

  it("releases everything on dispose", () => {
    const disposed = transformationReducer(running(), { type: "DISPOSE" });
    expect(disposed.camera).toBe("off");
    expect(disposed.source).toBe("none");
    expect(disposed.runtimeReady).toBe(false);
  });

  it("ignores a stale callback that lands after the phase moved on", () => {
    // SOURCE_READY only means anything while an analysis is actually in flight.
    const ready = sourceReady();
    expect(transformationReducer(ready, { type: "SOURCE_READY" })).toBe(ready);

    // And CALIBRATED only while calibrating.
    expect(transformationReducer(ready, { type: "CALIBRATED" })).toBe(ready);
  });

  it("stopping the camera returns to the source, not to nothing", () => {
    const stopped = transformationReducer(running(), { type: "STOP_CAMERA" });
    expect(stopped.camera).toBe("off");
    expect(stopped.phase).toBe("source-ready");
    expect(stopped.source, "stopping a camera must not discard the analysed source").toBe("ready");
  });
});
