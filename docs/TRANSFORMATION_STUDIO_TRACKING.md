# Transformation Studio — live tracking (Milestone 4)

What the Studio does today, what it deliberately does not do, and the numbers
behind both. Milestone 4 proves the **live input pipeline**: a camera, two
models, one loop, and an overlay that sits on the person being tracked. Nobody
is transformed here, no source image is warped, and nothing reaches a call.

Route: **Admin → Transformation** (`/admin/studio`).

## What exists

| Step | State | Where |
| --- | --- | --- |
| Source | Not built | Milestone 6 |
| Analyze | Not built | Milestone 6 |
| **Camera** | **Built** | This milestone |
| Calibrate | Not built | Milestone 5 |
| Preview | Not built | Later |
| Save | Not built | Later |

The step rail shows all six from the first visit and labels the five that do not
exist. Hiding them would make a tracking preview look like a finished
transformation tool.

## Ownership

One hook, `useStudioRuntime`, owns five things with one lifetime: the two
MediaPipe tasks, the camera, the frame loop, the downscale canvas and the
overlay. Splitting them across hooks would mean five teardowns to get right, and
the failure mode of getting one wrong is a camera light that stays on.

- `StudioCamera` — video only, never the microphone, with a flip that acquires
  the replacement before releasing the original.
- `TrackingScheduler` — the single owner of the frame loop. Prefers
  `requestVideoFrameCallback`, falls back to `requestAnimationFrame`, and
  **drops** frames that arrive mid-inference rather than queueing them.
- `coordinateMapping` — the only place a normalised landmark becomes a screen
  pixel. Cover-crop, front-camera mirroring and device pixel ratio all live
  here, and nothing else does its own arithmetic on a landmark.
- `overlayDrawing` — one Canvas 2D surface for both layers. Not Three.js: a
  second renderer to manage for some dots and lines would be cost without
  benefit, and the face mesh and skeleton share a coordinate space.

The overlay is drawn imperatively from the scheduler's callback, not from React
state. Sixty renders a second carrying 478 landmarks would spend more time in
reconciliation than in inference; React sees a summary four times a second.

## Measurements

Two sets, and they are not interchangeable.

### Hardware (Intel HD Graphics 4600, ANGLE/D3D11, WebGL2)

`pnpm test:transformation:benchmark -- --headed`, 1280×720 camera, mean of 40
frames after 5 warm-up frames.

| Tracking size | Face | Pose | Face + pose | p95 |
| --- | --- | --- | --- | --- |
| 320 | 13.6 ms | 41.4 ms | 56.4 ms | 82.2 ms |
| 480 | 13.0 ms | 41.1 ms | 55.4 ms | 76.1 ms |
| 640 | 13.7 ms | 41.7 ms | 54.4 ms | 74.6 ms |

Model init: face **994 ms**, pose **409 ms**.

Three findings worth carrying forward:

1. **Pose costs about three times what face costs.** The cadence presets exist
   for exactly this reason: `balanced` runs pose every third frame, which brings
   a frame from ~55 ms to roughly 27 ms — about 37 fps on a 2013 integrated GPU.
   Running both every frame would be ~18 fps.
2. **Tracking resolution barely moves the numbers.** 320 and 640 are within a
   millisecond of each other, because MediaPipe resizes to its own input
   resolution internally. The downscale saves texture upload and memory, not
   inference. The quality presets are therefore mostly about *cadence*, and the
   `trackingSize` differences should not be advertised as a performance lever
   until a phone says otherwise.
3. **Model init is a second, not thirteen.** The Milestone 2 and 3 figures
   (~13 s init, 1.5–2.4 s inference) were measured under a forced SwiftShader
   rasteriser and are not device baselines. They were labelled as such at the
   time; this table supersedes them for planning.

### Software rasteriser (SwiftShader)

`playwright.transformation.config.ts` forces `--use-angle=swiftshader` so the
engine proofs run reproducibly on a machine with no usable GPU. Nothing measured
under it is a baseline, and no test in that config asserts a frame rate. The
benchmark config forces no GL flags and prints `UNMASKED_RENDERER_WEBGL` beside
every timing, so a number is never quoted without the renderer that produced it.

**Still required:** a real phone. No iPhone or Android measurement exists, and a
2013 desktop iGPU is not a proxy for either.

## Segmentation

`pose_landmarker_lite` does return a mask — 640×480, held as a WebGL texture.
The Studio's segmentation toggle is **off by default** and, when switched on,
rebuilds the pose task with `outputSegmentationMasks: true`; the diagnostics then
report the mask's presence, size and representation, and the pose inference time
can be compared before and after.

The mask is **measured, not drawn**. `PoseTracker` closes every mask inside the
inference call, so no provider-owned WASM memory escapes into the engine.
Drawing it means copying pixels off the GPU, which is a synchronous readback
stall — deliberately left to a later milestone that has a reason to pay for it.

## Privacy

Unchanged from the foundation, and enforced rather than asserted:

- Tracking runs entirely on this device. No frame, landmark or blendshape leaves
  the browser, and there is no cloud inference.
- Nothing is persisted. Results live for the frame that produced them and are
  overwritten by the next — nothing reaches IndexedDB, `localStorage`, session
  history or analytics.
- No identity, embedding or recognition of any kind is computed. This is
  geometry tracking, and calibration in the next milestone is **measurement, not
  model training**.
- The camera is requested only from an explicit click, never on route load, and
  only after the models are ready — asking earlier would hold the light through a
  download somebody might cancel. A browser test asserts `getUserMedia` is not
  called when the route opens.
- Audio is never requested. `cameraConstraints` pins `audio: false` and a test
  asserts it on every call.

## Verification

Run on 2026-09-29.

| Suite | Result |
| --- | --- |
| `pnpm test` | 302 passed (20 files) |
| `pnpm typecheck` | clean |
| `pnpm build` | clean |
| `pnpm test:transformation:browser` | 21 passed |
| `pnpm test:e2e` | 18 passed |
| `pnpm test:transformation:benchmark --headed` | 1 passed, table above |

The Studio's own browser proofs cover permission gating, a real `getUserMedia`
stream reaching both models, overlay canvas sizing against the live preview,
pause/resume, camera flip, stop, route teardown and a hidden tab. Track teardown
is asserted by reading `readyState` on every stream `getUserMedia` handed out —
instrumented before any app code runs, so it cannot be fooled by a stream the
Studio forgot about.

Mobile layout is checked at 360, 375, 390, 393 and 430 px: no element past the
right edge, and the step rail scrolls without panning the page.

Two notes on the runs themselves. The `Comlink` foundation check failed once
inside the full 8-minute transformation suite and passed in isolation — that is
machine contention from the Studio tests holding a camera, two models and GPU
contexts, not a defect. And the foundation spec's `faceModelConfigured` /
`poseModelConfigured` assertions were stale: they encoded "no model binaries
exist yet", which stopped being true when Milestone 3 wired the generated model
paths. They now assert the models **are** configured, because a checkout where
they are not is one where the Studio loads and then fails at the first inference.

## Not in this milestone

- No Three.js, no OpenCV, no source deformation, no renderer.
- No calibration.
- No source image selection or analysis.
- No connection to WebRTC, and no Transformation option in host source
  selection. The Studio output reaches nothing.
- No recording, and no `MediaRecorder`.
- No Supabase, and no additional ML runtime.
