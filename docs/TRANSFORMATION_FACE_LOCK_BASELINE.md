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
