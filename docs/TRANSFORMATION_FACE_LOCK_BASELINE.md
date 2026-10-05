# Transformation Face-Lock Baseline

**Baseline name:** FACE LOCK / RAW-DIRECT BASELINE

**Status:** Locked as the known-good reference before stability and coverage work.

This document records the physically reviewed baseline reported for the current
face-only implementation. The physical observations below come from the
operator's review supplied with the milestone brief; automated checks run in
this workspace do not reproduce physical head movement.

## Architecture

```text
Camera frame
    ↓
MediaPipe Face Landmarker
    ↓
One current FaceFrameSnapshot
    ├── shared tracked geometry and global face movement
    ├── Raw Direct placement and transformed skin mesh
    ├── eyes
    ├── nose
    └── mouth and oral system
```

`FaceFrameSnapshot` is the atomic current-frame input. Its frame ID, timestamp,
landmarks, global motion, placement, and expression state travel together to
preview and rendering. `LiveFacePlacement` maps that same frame into the display
viewport. Stable-anchor fitting is a geometry helper feeding the shared frame;
it is not an independent renderer placement or tracker.

Pose Landmarker is disabled in active Studio face mode. The mode supplies no
pose inference, calibration defaults to face-only, and pose/body overlays and
guidance are absent. Raw Direct uses current face geometry and the shared camera
crop mapping to place the source mesh. The source identity texture remains on
the transformed mesh.

## Physically reviewed behavior

The operator reports this as the best result achieved so far:

- Face-only tracking and Raw Direct placement work.
- Live left/right translation and close/far scale response are useful.
- Facial reactions, blinks, sustained eye closure, gaze, mouth movement, and
  improved face pinning work.
- Eye behavior is the strongest facial system and is locked against redesign.
- Left yaw is the strongest pose reference; right yaw and upward/downward pitch
  still need refinement.
- Micro-jitter, contour mismatch, and incomplete forehead, temple, jaw, and chin
  coverage remain.
- Outer-edge dark bands and hard transitions remain; the compositor must be
  audited before changing feather width.
- Mouth tracking is functional but immature and is deferred from redesign.

These are reported physical observations, not claims established by the
synthetic-camera tests.

## Regression lock

Keep the existing checks around the following behavior when changing the
renderer or tracking path:

| Behavior | Existing coverage |
| --- | --- |
| Face-only calibration and expression capture | `engine/calibrationCollector.test.ts`, `studio/trackingGuidance.test.ts` |
| Face inference reaches the live camera; pose inference stays at zero | `tests/transformation-studio.browser.spec.ts` |
| Shared frame identity and display/camera crop mapping | `engine/coordinateMapping.test.ts`, `tests/transformation-renderer.browser.spec.ts`; the Studio exposes camera, tracking, render, and Raw Direct frame IDs in its diagnostics |
| Live X/Y translation, rotation, and close/far scale response | `engine/relativeMotion.test.ts`, `engine/rendering/rendererMotion.test.ts`, `tests/transformation-renderer.browser.spec.ts` |
| Blink, independent and held eye closure, gaze, and eye response during head motion | `engine/eyeControls.test.ts`, `engine/eyeGaze.test.ts`, `engine/blinkState.test.ts`, `engine/expressionMotion.test.ts` |
| Nose and mouth behavior | `engine/mouthControls.test.ts`, `engine/expressionMotion.test.ts`, `engine/rendering/mouthNoseRegression.test.ts`, `engine/rendering/m88OralRegression.test.ts`, `tests/transformation-m88-oral.browser.spec.ts` |
| Source mesh projection and identity texture topology | `engine/rendering/sourceMesh.test.ts`, `engine/rendering/liveMeshProjection.test.ts` |

Physical regression review remains necessary for left/right yaw, up/down pitch,
full facial coverage, visible edge quality, and eye/mouth behavior on a real
camera. Automated geometry tests do not establish those physical results.

## Baseline verification at lock

- `pnpm typecheck` — passed.
- `pnpm test` — 57 files, 858 tests passed.
- `pnpm build` — passed. Vite reported the existing OpenCV browser
  externalization notices and large-chunk warning.
- Focused transformation browser checks — camera/frame diagnostics and the
  live preview/full-screen flow passed (2 tests) using the synthetic camera and
  software renderer. These checks do not provide physical acceptance or a
  device performance baseline.

## Change boundary

Keep this implementation as the reference. Future work improves the current
shared face frame and Raw Direct path. Do not restore pose/body tracking,
calibration-relative screen placement, an independent HeadLock placement
system, fixed face-root placement, or renderer-specific pose tracking. Keep the
eye system locked, preserve current translation and scale behavior, and defer
major mouth redesign, hair, ears, neck, and body transformation.

## Stability, coverage, and boundary refinement

This section records the follow-on code changes made on top of the pushed
baseline. It is not a new physical acceptance record. The implementation keeps
the shared face frame, raw landmarks, Raw Direct placement, and local eye and
mouth systems. Stabilized landmarks are an additional renderer geometry view;
raw landmarks still drive current tracking and expression inputs.

- A lightweight One Euro style landmark filter uses an 8 Hz minimum cutoff for
  stable geometry and 50 Hz for expressive eye, iris, lip, and jaw landmarks.
  Velocity raises the cutoff while moving. Filter CPU time and a motion-derived
  lag estimate are exposed in diagnostics; the estimate is not device latency.
- The single continuous face mesh now has a face-width-scaled regional feather
  and a connected zero-alpha outer ring. Coverage extends toward forehead,
  temple, cheek, jaw, and chin regions while remaining attached to the current
  tracked mesh. The forehead extension is proportion-based; there is no exact
  hairline landmark or hair segmentation, so hairline clearance needs physical
  review.
- Boundary skin samples are taken from the same tracking canvas frame as the
  MediaPipe result, at a 125 ms cadence. Six regional low-frequency RGB
  corrections are bounded to 12%, smoothed with a 650 ms time constant, and
  applied only near the existing outer feather. The source texture and its
  center appearance remain unchanged.
- The renderer alpha path is explicit: straight texture/shader values and
  straight-alpha material blending feed a premultiplied-alpha WebGL canvas.
  Image bitmaps request no premultiplication. This code audit and browser
  assertion found no double premultiplication in the configured path; the
  actual visual cause of previously observed dark edges is not established by
  that audit.
- Developer diagnostics now expose per-region contour error and directional
  left/right yaw and up/down pitch summaries over the latest 120 qualifying
  frames, plus mask, alpha/feather, boundary color, filter cost, and estimated
  lag views. The pose summaries are instrumentation; they do not contain
  operator-recorded physical pose measurements.

### Follow-on verification

- `pnpm.cmd typecheck` — passed.
- `pnpm.cmd test` — 59 files and 864 tests passed.
- `pnpm.cmd build` — passed; Vite reported the existing OpenCV browser
  externalization notices and large-chunk warning.
- Transformation renderer browser regression — passed, including straight
  material/texture settings and the premultiplied-alpha context.
- M8.8 real Studio AUTO lifecycle browser regression — passed with the
  synthetic camera. It is not a physical camera or performance benchmark.

### Physical acceptance status

The current environment did not provide an operator-run physical camera review
after these changes. Therefore right yaw, left-yaw non-regression, upward and
downward pitch, full forehead/temple/cheek/jaw/chin coverage, hairline clearance,
visible boundary quality, and physical eye/mouth non-regression remain
**unverified**. No face-FPS improvement or physical latency value is claimed.
The geometry, blending, and diagnostics are ready for that review, but the
milestone is not physically accepted until those poses and boundaries are
checked on the target camera.
