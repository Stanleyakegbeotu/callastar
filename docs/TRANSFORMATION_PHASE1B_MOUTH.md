# Phase 1B: canonical live mouth

## What changed

Phase 1A's alternating current-frame camera snapshots, face-root placement, perioral crop, and SOURCE/AUTO/LIVE comparison remain in place. Phase 1B measures both MediaPipe lip rings in the same inference frame as the snapshot. It removes the current head center, face-width scale, aspect, and root rotation before filtering the lip points. The resulting geometry is a child of the existing `faceRoot`.

The live mesh now has three rings: a narrow perioral feather boundary, the measured outer lip ring, and the measured inner lip ring. Its UVs follow the corresponding raw camera points. The inner-mouth fan contains the current teeth, tongue, and cavity pixels. The inner mouth and lip surface have full live alpha; only the surrounding perioral strip fades into the transformed face. SOURCE mode bypasses the live patch.

## Root cause found

The Phase 1A texture was mapped onto a patch generated from `ExpressionDeformer.positions`, then widened by 8% padding on each side. That made live pixels inherit the source mouth's jaw, smile, and width changes. In the raw live-mesh path, `projectLiveMeshPositions` also added the source expression delta on top of already expressive MediaPipe lip landmarks. Both mechanisms could enlarge the displayed mouth and expose a second lip. Phase 1B uses raw live lip landmarks for the overlay and suppresses the extra source expression delta on lip vertices while live preservation is selected. The wider perioral boundary remains a feather region; it no longer defines lip width.

## Stabilization and guardrails

- The lip filter runs only on new, paired inference frames in face-local coordinates. Small movement gets stronger filtering; coordinated opening, smiling, and pucker get a faster response.
- An isolated point jump is bounded when its neighbors and the rest of the mouth stay comparatively still. The central opening and paired inner lip points cannot invert.
- Filtered outer-corner width stays within 0.94–1.06 of the current measured local width. Inner opening follows the current measurement within roughly 0.92–1.08 when open.
- A missing, stale, or disabled feed clears the texture and the filter state. No optical flow, extra model, or new render loop was added.

## Developer review

In Transformation Studio, choose FACE render and AUTO or LIVE mouth preservation. Under **Mouth geometry overlay · Developer**, enable any of the six lines separately: green raw outer lip, cyan raw inner lip, blue filtered outer lip, purple filtered inner lip, red mask boundary, and yellow feather boundary. **Mouth / Nose Diagnostics · Developer** shows live and rendered widths, heights, opening, ratios, corners, filter motion/alpha, rejected points, and pose. Measurements labeled `Local` are canonical face units; corner positions are normalized camera coordinates.

Compare AUTO/LIVE with SOURCE at the same pose. Test neutral speech, wide opening, large smile, pucker, repeated open/close, left/right yaw around 10°, 20°, 30°, and 40°, up/down pitch while talking, changing camera distance, and rapid expression changes. Check the live camera and rendered mouth side by side. Physical acceptance remains pending; automated tests cannot establish natural appearance or speech timing on a phone.

## Automated evidence and limits

- Unit checks cover width, opening, head translation and scale independence, yaw projection at 0° and ±10/20/30/40°, adaptive filtering, coordinated movement, isolated outliers, nonnegative opening, and mesh topology.
- A focused browser renderer check covers current-frame texture, authentic local width/opening, opaque interior, transparent exterior, attachment to `faceRoot`, and SOURCE clearing.
- On the software renderer, a 40-draw mask sample measured about 0.135 ms for the prior feather mask and 0.105 ms for the three-zone mask. The order and runtime load make this a rough indication only. Mouth processing per render frame was about 0.1–0.5 ms in the focused checks; device tracking FPS and full end-to-end FPS remain for physical review.
- Eye and face-root code paths were not redesigned. The older M8.7 browser portrait check now selects the actual eye interior start rather than including face-boundary extension vertices in its eye assertion.
- The separate M8.8 browser suite is still written for the former inner-mouth-only effect. Its GPU check rejects all perioral camera skin and expects a closed *source jaw* to hide an open *live camera mouth*; both conflict with the accepted Phase 1A behavior. Its real-Studio flow waits for a consent checkbox in a panel hidden by the newer Studio shell. These two legacy checks fail until that suite is rewritten for the current UI and live-mouth contract. The focused Phase 1B renderer/browser checks pass.

## Review status

Automated geometry, mask, source-mode, and attachment checks pass. Visual lip-edge behavior, double-lip appearance, speech lag, yaw/pitch quality, and real-device performance need physical review before this milestone can be accepted. The stale M8.8 browser suite remains a test-maintenance item.
