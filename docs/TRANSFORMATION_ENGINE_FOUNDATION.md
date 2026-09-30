# Transformation engine foundation

This is dependency and contract preparation for a future browser-local FilterCore. Nothing here is connected to the call UI, camera, signaling, subscriptions, or `RtcCallEngine`.

## Dependency roles

| Package | Role | Loaded when |
| --- | --- | --- |
| `@mediapipe/tasks-vision` | Face landmarks, pose landmarks, optional segmentation | Future feature entry or explicit development preflight |
| `@techstark/opencv-js` | Classical geometry, masks, color and image processing | Future feature entry or explicit development preflight |
| `three` | WebGL texture, mesh and compositing renderer | Future feature entry or explicit development preflight |
| `comlink` | Typed main-thread/worker messages | A worker is started |

`loaders.ts` uses dynamic imports; no transformation package is imported by the app entry point. TensorFlow.js, ONNX Runtime, and other model runtimes were intentionally omitted: MediaPipe Tasks Vision does not require them, and no selected algorithm needs them yet. Browser camera, canvas, WebGL, MediaStream and WebRTC APIs need no npm wrapper.

Three.js ships no TypeScript declarations in this installed release, so `@types/three` 0.186.0 is the sole added development dependency.

## Intended pipeline and ownership

Camera frames → tracking at a controlled resolution and cadence → image processing and rendering → canvas video track → existing video-source abstraction → `RtcCallEngine.replaceVideoTrack()`. This is a future design, not a connected path. `TransformationOutput` carries a `MediaStreamTrack` and `release()` so the future caller can replace and stop the track deliberately. Audio stays on its current path.

The future engine must accept source images or videos, including accessories, hair, clothing and upper torso. Its calibration stage may prepare landmark maps, masks and color statistics; it is not machine-learning training. There is no automatic accessory removal or skin-tone classification in this foundation.

## Models and MediaPipe WASM

`modelAssets.ts` is the single model path registry. Face and pose models are now selected and self-hosted; the image segmenter stays unset.

| Model | File | Source | Licence | Size |
| --- | --- | --- | --- | --- |
| Face Landmarker | `face_landmarker.task` | [`mediapipe-models/face_landmarker/.../float16/latest`](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task) | Apache-2.0 (Google) | ~3.6 MB |
| Pose Landmarker | `pose_landmarker_lite.task` | [`mediapipe-models/pose_landmarker/.../float16/latest`](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task) | Apache-2.0 (Google) | ~5.5 MB |

Face Landmarker was chosen over a bare mesh model because it bundles blendshapes and the facial transformation matrix, so head pose needs no separate solver. Pose Landmarker `lite` was chosen over `full`/`heavy` because it runs on a phone alongside the face model and the heavier variants buy accuracy this pipeline does not need for shoulder anchors. Its segmentation mask is used rather than adding a dedicated Image Segmenter — a second model would be more to download, hold and run per frame, and is only worth it if the pose mask proves insufficient.

The binaries are **downloaded at build time and gitignored**, exactly as the WASM is copied and gitignored: `scripts/fetch-transformation-models.mjs` fetches them into `public/transformation/models/`, verifies each against an expected size so a truncated or redirected download is never cached, and writes `manifest.json` recording every URL, purpose and licence. `predev` and `prebuild` run it, and a file already present at a plausible size is skipped. This keeps ~9 MB of third-party binaries out of the repository while still serving them same-origin, so the Studio makes no third-party request at runtime and works through an HTTPS tunnel or offline once fetched. Apache-2.0 permits redistribution with attribution, which the manifest provides.

The installed MediaPipe package supplies its own version-matched WASM files. `scripts/copy-transformation-wasm.mjs` copies them into `public/transformation/wasm/<installed-version>` for same-origin hosting, writes a manifest, and generates `wasmAssetPath.generated.ts`. The versioned URL avoids serving stale files across package upgrades. Run `pnpm assets:transformation` after installation; the `predev` and `prebuild` scripts also run it. Generated binary files are ignored by the local `.gitignore` and should be produced by the deployment build. `FilesetResolver.forVisionTasks()` reads the generated path. A successful resolver and HTTP check means the WASM assets are reachable; it does not mean a model runtime has initialized.

The six copied JS/WASM files total about 35.4 MB on disk. They are static assets, requested only when the future feature starts; deployment storage and caching policy still need review. In the current production build the number of transformed modules remained 267. The main JS chunk was 653.91 kB before this work and 654.04 kB afterward (gzip 186.77 → 186.81 kB). The new CV loaders are not referenced by the app entry point, so no CV runtime is loaded at startup.

## Browser and worker constraints

Camera/video elements and the existing call remain on the main thread. The only worker here is an isolated Comlink ping for a smoke test. MediaPipe's [web guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js) says `detectForVideo()` is synchronous and suggests workers to avoid blocking the UI. The future implementation must benchmark whether this exact package build accepts transferable `ImageBitmap` frames in a Vite module worker on iPhone Safari and Android Chrome. OpenCV processing can be evaluated in a worker, but its browser bundle and WASM initialization must be tested on each target before moving it. Three.js can render on `OffscreenCanvas` where supported, but the shipping path needs a main-thread fallback. `HTMLVideoElement`, direct DOM canvases, `getUserMedia`, `captureStream` and the current WebRTC sender remain main-thread concerns. [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) and [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) are feature-detected; neither is assumed on every Safari version.

The future mobile scheduler should reduce tracking resolution independently from output, cap tracking FPS, drop stale frames, reuse buffers/canvases/textures and render at display cadence where possible. It must stop any owned media track and worker on teardown. Every temporary OpenCV `Mat` needs `delete()` in `finally`. Three textures, materials, geometries and renderer need `dispose()` when replaced; WebGL contexts may need explicit release. A source switch must release the old GPU and WASM objects before creating replacements.

## Security and privacy

This foundation does not request camera permission, upload source images, persist landmarks or embeddings, identify people, or emit face analytics. Development preflight reports API presence and dependency readiness only; it does not enumerate hardware. Any later source processing should remain browser-local unless the product requirements explicitly change.

## License audit

| Package | Installed version | Package license | Upstream |
| --- | --- | --- | --- |
| `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 | [MediaPipe](https://github.com/google-ai-edge/mediapipe) |
| `@techstark/opencv-js` | 5.0.0-release.1 | Apache-2.0 | [TechStark/opencv-js](https://github.com/TechStark/opencv-js) |
| `three` | 0.186.1 | MIT | [three.js](https://github.com/mrdoob/three.js) |
| `comlink` | 4.4.2 | Apache-2.0 | [GoogleChromeLabs/comlink](https://github.com/GoogleChromeLabs/comlink) |

These labels come from the installed package metadata and upstream license files. Commercial distribution requires preserving applicable license and notice text, including any notices shipped with package assets. Model licenses are separate and have not been cleared; no model binary is included.

## Verification and remaining work

The development preflight always checks browser API presence. Pass one of `"mediapipe"`, `"opencv"`, `"three"` or `"worker"` to check one heavy dependency; unchecked fields are `null`. This keeps the heavy runtimes out of the same tab on memory-limited devices. The selected checks cover package imports, MediaPipe WASM file reachability, OpenCV `Mat` creation and deletion, Three WebGL2 renderer creation and disposal, and worker/Comlink ping. MediaPipe WASM initialization remains false until a licensed model is configured. `pnpm test` covers pure foundation contracts; `pnpm test:transformation:browser` exercises each runtime in a fresh Chromium page without camera permission. Safari and Android device checks and performance benchmarks are still required before FilterCore implementation.

Verification on 2026-09-29: baseline typecheck/build passed with 91 Vitest tests. After installation, typecheck passed, 94 Vitest tests passed across 8 files, and 4 isolated Chromium smoke tests passed. The production build passed. This verifies browser imports and runtime setup in Chromium only; no model inference, mobile device benchmark or full transformed-track integration has been run.
