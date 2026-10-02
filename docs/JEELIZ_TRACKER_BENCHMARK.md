# Jeeliz tracker benchmark foundation

Implemented 1 October 2026. This is a developer-only tracker experiment in
Admin → Transformation Studio → Open Tracker Lab, available with Vite dev
(`import.meta.env.DEV`). MediaPipe remains the sole production renderer input.
Jeeliz is never converted to `FacialControlFrame`, sent to FaceRenderer, or used
to modify source meshes, calibration conventions, M8/M9 geometry, or call output.

## Package and provenance

- Official npm package: `facefilter`, exactly **3.4.3**, the registry's latest
  stable version at installation; license **Apache-2.0**.
- Repository: <https://github.com/jeeliz/jeelizFaceFilter>.
- Source archive: <https://registry.npmjs.org/facefilter/-/facefilter-3.4.3.tgz>.
- Archive size: **6,443,787 bytes**; unpacked npm package: **11,412,704 bytes**,
  11 files. Installed module: **111,478 bytes**.
- `main` is `index.js`, which exports `JEELIZFACEFILTER` as a named export and
  imports four JSON models. The actual dist file,
  `dist/jeelizFaceFilter.moduleES6.js`, exports the API as **default**. The lazy
  loader imports that inspected subpath, then calls the official `create_new()`.
  The real browser test proves this import works with this Vite project.
- No TypeScript declarations or helper scripts are shipped in this npm package.
  The adapter declares only the API subset it actually consumes.
- Packaged neural nets: `NN_DEFAULT.json`, `NN_STANDARD_2.json`,
  `NN_STANDARD_3.json`, `NN_LIGHT_1.json`, `NN_4EXPR_1.json`, `NN_4EXPR_3.json`.
  Only the following two are prepared and used.

| Package path | Bytes | SHA-256 | Same-origin runtime URL |
| --- | ---: | --- | --- |
| `neuralNets/NN_DEFAULT.json` | 3,756,740 | `f348ce0fb3b30b8cf27e1666bc56de0c6b1f1b8f02cadc4cd5ca53169534b182` | `/models/jeeliz/NN_DEFAULT.json` |
| `neuralNets/NN_4EXPR_3.json` | 1,657,334 | `1e628f1fbd838f9cf57a3c62add85bf67280ee5581ccc24799a4ea4bfa24ec61` | `/models/jeeliz/NN_4EXPR_3.json` |

`scripts/prepare-jeeliz-assets.mjs` verifies the locked package version/license,
source file sizes, SHA-256 and JSON structure; copies only changed files; and
writes a deterministic provenance manifest plus the Apache license. Missing or
corrupt source assets fail with a named error. Generated local copies are ignored
by Git and recreated by `pnpm assets:jeeliz`, `predev`, and `prebuild`. No model
download or third-party CDN is used at runtime. Runtime URLs honor Vite BASE_URL.

## Architecture and ownership

`tracking/trackerProvider.ts` defines initialize/start/stop/dispose, capabilities
and a numeric sample contract independent of React and Jeeliz callbacks.

Opening Tracker Lab chooses Raw preview and acquires a suspension lease on the
Studio's normal scheduler. Both normal face and pose inference stop. The
MediaPipe lab adapter borrows the existing FaceTracker and runs face-only
inference against the same video at a 480px longest edge. Jeeliz alone runs when
selected, on the very same `runtime.videoRef.current`. No lab provider requests a
MediaStream; StudioCamera retains permission, acquisition, flip and teardown.
Both normal MediaPipe tasks remain allocated but idle in either lab mode.
Closing the lab resumes the prior scheduler only after provider disposal, and
preserves a manually paused Studio.

Jeeliz waits for video dimensions, loaded frame data and a presented frame (or
timeupdate fallback), creates its own API instance, checks the local model URL,
and initializes with a dedicated offscreen canvas, `videoSettings.videoElement`,
`maxFacesDetected: 1` and `followZRot: true`. It never uses Three's canvas/context.
Canvas intrinsic dimensions preserve video aspect ratio; ResizeObserver, video
resize and orientation changes call the supported resize API. A separate 2D
overlay uses the existing cover-crop/mirroring coordinate module. It shows box,
center, confidence, scale, and a labelled raw Euler orientation triad.

**Borrowed-camera cleanup safeguard:** inspected 3.4.3 `destroy()` invokes its
public `toggle_pause(true, true)`, which otherwise stops even an external stream.
The adapter wraps this method on its PRIVATE `create_new()` instance, always
passing `shutOffVideo=false` to the original implementation. Destroy still frees
library memory and stops its loop. The adapter then releases its dedicated WebGL
context via `WEBGL_lose_context`. No global API or installed library is patched.
This safeguard is covered by a unit test and an official-library browser test.

Provider switches, camera stops/flips, model switches, route exits and hidden
tabs abort initialization, silence callbacks, disconnect observers/listeners,
cancel frame callbacks, and serialize disposal before starting the next provider.
API instances that never began initialization have no GPU state to destroy.
Camera flips retain the same video element and reinitialize the selected Jeeliz
provider after the replacement stream presents a frame. The adapter does not
call Jeeliz's camera acquisition/update-video-settings methods.

Initialization covers module load, camera readiness, local-model availability,
library callback errors, WebGL loss and timeouts. Failure stays in Tracker Lab;
the main Studio and its camera remain available. Ordinary no-face is a diagnostic
state, not a crash. Provider-owned tracking objects and expression arrays are
copied immediately and never retained.

## Actual capabilities and outputs

| Signal | Default Jeeliz | Four-expression Jeeliz | MediaPipe lab |
| --- | --- | --- | --- |
| Position / detection square scale / raw Euler pose | Available | Available | Position / eye-span scale / measured physical pose |
| Mouth opening | Channel 0 | Channel 0 | jawOpen, geometry fallback |
| Smile | Unsupported | Channel 1 | Mean mouthSmileLeft/Right when present |
| Brow frown | Unsupported | Channel 2 | Mean browDownLeft/Right when present |
| Brow raise | Unsupported | Channel 3 | browInnerUp when present |
| Dense mesh / irises | Unsupported | Unsupported | 478 / 10 points when detected |
| Independent left/right blink | Unsupported | Unsupported | eyeBlinkLeft/Right when present |
| Gaze | Unsupported | Unsupported | Iris-derived face-local estimate, not gaze ground truth |
| Multiple faces in this adapter | Unsupported (configured one) | Unsupported (configured one) | Configured one |
| Exact inference time | Unavailable | Unavailable | Measured around detect |

The library itself supports up to eight faces; this lab intentionally supports
one controller. Four-expression indexes are grounded in the official
[cubeExpr example](https://github.com/jeeliz/jeelizFaceFilter/blob/master/demos/threejs/cubeExpr/main.js).
The [official API documentation](https://github.com/jeeliz/jeelizFaceFilter#specifications)
documents reused callback objects, existing video input, position, scale and
Euler outputs. Unsupported measurements render as `unsupported`; absent supported
measurements render as `unavailable`. A real zero is displayed numerically.

## Pose conventions: measurement required

The lab does NOT assume rx=pitch, ry=yaw, rz=roll or any signs. Canonical Jeeliz
pose remains null and diagnostics say unverified until all seven captures pass:
neutral, physical right/left, up/down, tilt right/left. Each capture uses a steady
0.8–1s window with at least eight fresh detected samples. Median raw angles are
stored as numeric evidence. Opposing movements must exceed thresholds, straddle
neutral, have a dominant axis, and identify three distinct axes. Otherwise the
mapping is rejected and recapture is requested.

All angle subtraction, wrapping, axis permutation and signs live in
`jeelizMapping.ts`. CallaStar physical conventions are yaw positive toward the
subject's LEFT, pitch positive UP, and roll positive toward the subject's RIGHT.
Mappings reset on camera/model/provider changes; mirror is a display operation.
The unit and browser tests verify deliberately permuted synthetic axes. **No
actual iPhone/Android Jeeliz axis conventions have been measured yet.** The
tester must capture them on the physical device; this experiment makes that
measurement inspectable without sending guessed pose to the renderer.
Position normalization (including the Y-axis conversion) also lives in that
module. Jeeliz physical angles are deltas from the captured neutral; MediaPipe
lab angles are absolute physical angles. Jitter and cue response subtract their
own baselines, so neither comparison depends on the angle origin.

## Benchmark interpretation

Start/Stop/Reset retain numeric diagnostic samples only, in memory, capped at
30,000 samples per run. No video, images, landmark arrays or recognition data are
accepted by the recorder. It retains up to eight numeric summaries during the
lab visit; closing/resetting discards them. Switching provider/model, flipping
camera, or hiding the tab ends a run rather than mixing conditions.

Recorded measurements: initialization, mean confidence, callback rate and
interval, fresh-video callback rate, presentation-age estimate, stale callbacks,
camera presentation gaps, first-five-seconds neutral angular standard deviation,
lost-face transitions, reacquisition time, unresolved loss, supported expression
ranges and optional cue-to-motion/expression response estimates.

Important interpretation limits:

- Jeeliz callback FPS is not an exposed inference FPS. Fresh-video callback FPS
  is an estimate based on changing video currentTime, not a claimed neural rate.
- Frame age is time since a recent camera presentation, not camera sensor latency
  or an exact association with Jeeliz's internally consumed frame. Missing
  presentation timing is unavailable. Internal Jeeliz dropped inferences are not
  exposed; camera presentation gaps and repeated callbacks are measured instead.
- Exact Jeeliz inference duration is unavailable and is never derived from
  callback interval. MediaPipe inference duration is measured directly.
- Neutral jitter before pose capture is labelled raw rx/ry/rz. After capture it
  uses physical yaw/pitch/roll. Hold still for the first five seconds of each run.
- Response cues include HUMAN REACTION TIME, and stop when a pose/expression
  channel changes by 0.12. They are labelled estimates, not exact tracker latency.
- Jeeliz scale measures a detection square; MediaPipe scale measures eye span.
  Confidence also has different definitions (Jeeliz detector probability versus
  MediaPipe geometry-derived confidence). Neither is directly interchangeable.
- MediaPipe initialization is the existing face task's startup time. Jeeliz
  initialization includes module/readiness/model checks and initialization.
  Both are reported, but their timing scopes differ.
- Jeeliz's detected state uses probability >= 0.8. MediaPipe retains its
  existing model thresholds and geometry-derived confidence. These confidence
  scales are not calibrated against each other. MediaPipe gaze diagnostics are
  raw eye-local iris-displacement estimates, not calibrated screen gaze.
- The ordinary Studio tasks remain resident but suspended in both lab modes;
  there is no concurrent inference or optional dual-observation mode.
- SwiftShader/fake-camera tests prove integration and cleanup; they do not rank
  tracker quality, speed, lighting robustness, or real physical expressions.

The UI includes the full required physical sequence: neutral five seconds;
right/center/left/center; up/center/down/center; both tilts; closer/farther;
mouth closed/25/50/75/100%; supported smile/brows; fast movement; low/strong light;
glasses; front camera; and a separate rear-camera/reacquisition run. All requested
320/360/375/390/393/414/430px widths have automated overflow assertions.

## Verification and physical handoff

All automated gates pass:

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm test` | 756 tests across 49 files PASS |
| Focused tracker unit tests | 38 tests across 4 files PASS |
| Full Transformation Playwright suite | 77 tests PASS |
| Focused Jeeliz browser suite | 15 tests PASS; includes real official module, both models and camera flip |
| `pnpm test:e2e` | 18 tests PASS |
| `pnpm build` | PASS; both assets SHA-256 verified during prebuild |
| `git diff --check` | PASS |
| Existing HTTPS workflow | PASS: Studio, both models, license and manifest return HTTP 200 |
| HTTPS browser smoke | PASS: secureContext true, one getUserMedia, zero overflow at 393px, no CORS/model errors, upstream camera remains live after disposal |

Browser suites ran serially. The HTTPS smoke used a synthetic camera and stubbed
MediaPipe startup, with the REAL installed Jeeliz module and default local model.
The full Transformation suite separately exercised real MediaPipe and the
existing renderer. The official-module lab test exercised BOTH Jeeliz models and
camera flipping with real WebGL, with external network requests blocked.

The first regression run found a stale camera-flip calibration assertion and a
five-second no-face guidance timing flake. An isolated worktree at original
commit `11ac465` reproduced the camera-flip assertion failure: existing M8.3
already starts face-only reacquisition after flipping. The test now verifies
that behavior, absent old profile/shoulder capture, and unchanged model init
time. The guidance timeout now allows software-rendered inference to finish;
all detection assertions remain. These corrections change tests, not normal
calibration/renderer behavior. Tests that wrote M8 screenshots into tracked
artifacts now write into Playwright output directories. The three pre-existing
modified screenshots remain byte-for-byte unchanged.

Physical iPhone and Android comparison remains pending.
Use `pnpm dev` and the existing `scripts/start-mobile-tunnel.ps1`. The launcher
retains its original executable location and falls back to an existing PATH
installation; no new tunnel service or deployment is required.

Known existing limitation: the Studio's state machine treats Stop/disposed as
terminal, even though the UI offers Start camera again. Reload the Studio after
Stop to begin a new session. This task preserves that state machine; provider
switches and closing/reopening Tracker Lab work during a live camera session.

MEDIAPIPE CURRENTLY DRIVES PRODUCTION RENDERER: YES

JEELIZ CURRENTLY DRIVES PRODUCTION RENDERER: NO

JEELIZ BENCHMARK READY: YES

IPHONE JEELIZ TEST: NOT TESTED

ANDROID JEELIZ TEST: NOT TESTED
