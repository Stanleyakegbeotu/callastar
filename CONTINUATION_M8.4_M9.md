# Callastar continuation: M8.4 physical fidelity, then M9

## Start here

This checkout contains the interrupted implementation work committed alongside this prompt. Start by checking the current branch and working tree, then fetch and fast-forward from `origin/main` if needed. Read `AGENTS.md`, this prompt, and the latest transformation handoff or milestone notes before changing code. Preserve the existing work; do not reset or revert it.

Continue from the actual code and test state in the repository. The last working branch was `main`. The push containing this prompt should be the newest continuation point on `origin/main`.

## Current milestone and stop condition

The active task is Milestone 8.4, “Physical-Fidelity Correction,” with Milestone 9, “Outer-Head Continuity,” planned afterward. M8.4 is incomplete. M9 has not started. Do not claim M8.4 is complete or begin M9 until every M8.4 hard gate in the handoff passes, including real-device checks. The real iPhone recording described by the handoff is the evidence that M8.3 still needs correction; simulated tests are not a substitute for a new iPhone recording.

## Work already in this continuation

- Added face-local iris/gaze estimation and smoothing, optional neutral gaze calibration, gaze diagnostics, and a source-texture iris UV warper. This moves the iris texture from the recorded source; it does not paste live camera pixels into the avatar. Physical movement, stability, and appearance have not been verified on a device. Check behavior with glasses and different lighting as part of physical evaluation.
- Added tracking callback, skipped-frame, latency, and accepted-camera-rate diagnostics.
- Added displayed input-age/render timing and mouth aperture/chin-travel diagnostics, plus a fast path for the inactive live-mouth compositor.
- Added face-only recalibration on camera flip and after tracker loss/reacquisition.
- Preserved the broader M8.2/M8.3 source, renderer, blink, expression-isolation, rigid-motion, live-mouth, preview, and browser test work already present in this commit.

Inspect the implementation and test files directly before extending them. These bullets describe intended behavior and do not certify correctness.

## Verification state at interruption

- `pnpm.cmd typecheck`: passed.
- `pnpm.cmd test`: passed, 45 files and 718 tests.
- Focused transformation engine suite: passed, 76 tests.
- `pnpm.cmd run test:transformation:browser`: was in progress when interrupted. Chromium was installed for Playwright. The existing calibration browser case `tests/transformation-calibration.browser.spec.ts` still expects manual recalibration after camera flip, but the new behavior starts face-only recalibration automatically, so that expectation needs review/update. Rerun the full browser suite and record its actual final result; do not assume the in-progress run passed.
- No new iPhone or Android physical recording/check was completed. Device validation remains outstanding.

## Next steps

1. Inspect the current browser test state and update the camera-flip test to assert the intended automatic face-only recalibration, including that the loaded source remains intact.
2. Run typecheck, the unit suite, focused transformation tests, and the complete transformation browser suite. Fix regressions and record exact results.
3. Review M8.4 hard gates in the handoff and prove each from implementation, automated results, and a fresh real-device recording/check. In particular, verify that gaze visibly follows the user while preserving the recorded source identity and that diagnostics show current, bounded-latency tracking without an inference backlog. If device evidence is unavailable, leave M8.4 open and say so.
4. Only after all M8.4 gates pass, read and implement the M9 outer-head-continuity requirements. Keep M9 changes separately understandable and validate them against the handoff.
5. Report what changed, commands and device checks performed, exact outcomes, remaining gates, and the commit/push state.

## Commands

On this Windows checkout, use `pnpm.cmd` for package scripts. The full browser command is:

```powershell
pnpm.cmd run test:transformation:browser
```
