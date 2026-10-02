# M8.6 eyes — LOCKED BASELINE

Implementation and regression contract for the cleaner baseline at `11ac465`.
Work started 1 October and continued 2 October 2026. The user reported physical
acceptance of the near-perfect eye result before M8.7. Eyes are locked. No M9 code, outer-head layer, renderer
rewrite, branch import, commit or push is part of this milestone.

## Preserved baseline

The initial worktree included the previous Jeeliz installation/Tracker Lab and
three modified M8.3 screenshot pointers. These are preserved. The running Vite
server and Cloudflare tunnel were existing development processes; no other
repository-writing agent was found. A hash snapshot of 500 existing files was
taken before edits. The final audit found 484 existing files byte-identical,
16 intentionally edited existing paths, and zero unexpected changes. This
includes preservation of the prior Jeeliz foundation and screenshot edits.

The camera remains StudioCamera's video-only stream. TrackingScheduler owns the
single MediaPipe face/pose clock, drops busy frames instead of queueing, and
feeds the existing calibration collector. The pipeline is:

`camera → MediaPipe landmarks/irises/blendshapes → head-local geometry → existing
neutral calibration → expression + canonical eye controls → adaptive eye state
→ disabled-by-default hybrid coordinator → existing source deformation/UVs →
FaceRenderer`.

Tracker Lab still borrows the camera, suspends the normal scheduler, uses one
selected provider and keeps Jeeliz on its own WebGL canvas. Neither Jeeliz's
outputs nor a provider-owned callback object reaches the source-face renderer.

## Eye contracts that future regions must preserve

- `engine/eyeControls.ts` owns per-eye openness, blink, wideOpen, gazeX/Y,
  irisX/Y, upper/lower lid travel and derived confidence. The existing expression
  contract carries the eye frame; it is not a parallel renderer architecture.
- Canonical LEFT/RIGHT are anatomical. MediaPipe's official topology puts the
  subject's left eye at 263/362 and iris 473, and right eye at 33/133 and iris 468.
  The older renderer uses image-side channel names. `EYE_RENDER_CHANNELS` adapts
  that boundary. Blink fusion and neutral blendshape capture now use the score
  belonging to the SAME eye as the geometry. [Official MediaPipe topology](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/web/vision/face_landmarker/face_landmarks_connections.ts).
- `canonicalFaceLandmarks` removes the existing measured head rotation, aspect,
  and translation. Eye-width ratios cancel scale. Rigid rotations, portrait
  aspect, translation and distance are pinned by regression tests.
- Eye aperture is measured from three lid pairs. Calibration records medians
  of each eye's width, height, aperture, upper/lower coordinates and iris origin
  independently. Calibration version is 4; profiles still live only in memory.
- Vertical gaze divides by a FIXED width-derived reference, not a changing lid
  gap. Iris coordinates use the eye corner line, so a blink or asymmetric lid
  motion cannot move the gaze origin. Missing irises remain unavailable.
- Slow calibrated closure stays continuous. Decisive fast closures are rendered
  shut, including the measured 0.45 closure under yaw. Reopening hysteresis
  follows each eye's measured closed peak rather than assuming a universal
  peak; held closure stays stable. The older state-machine fallback
  remains for readings without trustworthy detailed geometry.
- Wide-eye geometry is independent of brow position: above an 8% neutral
  envelope, it reaches full control at 40% above calibrated aperture. The source
  aperture expands by at most 25%; no replacement eye, painted sclera or
  controller eye pixels are used.
- Lid meeting uses measured upper/lower travel. A bounded lower-lid contribution
  keeps the upper lid dominant, and both lids meet without crossing. The former
  15% lower-lid value remains only for legacy/manual frames without measurement.
  Source lid/lash boundary UVs stay fixed while their geometry moves.
- Only the original eye fill fans are subdivided, adding 258 eye vertices and
  replacing 28 fan triangles with 448 smaller eye triangles. The original 468
  face vertices, all 852 face triangles and the mouth fill/cavity remain. No
  outer face/head topology was introduced.
- Gaze changes UVs only inside those eye surfaces. Original face, mouth,
  eyelid/lash boundary and glasses-rim UVs are unchanged. Sampling is bounded
  to the source aperture; wide-eye sampling compensates iris stretch as far as
  source pixels permit. Source iris colour and pupil appearance are retained.
- Filtering advances once per fresh face result, not again on a pose-only
  update. Small jitter has stronger stabilization, intentional movements use
  an 8ms time constant, and iris quality gates gaze independently of lid quality.
  Weak eye confidence holds 120ms, then decays. Renderer gaze briefly holds
  through a missed expression and relaxes rather than snapping.
- Nose, mouth/jaw, smile/cheek, brow amplitudes, chin, hair, ears, neck and global
  rigid motion are unchanged. Eye-only tests assert non-eye vertices and UVs.

## Developer diagnostics and test harness

Vite development builds expose **Eye Diagnostics · Developer** in Studio's
settings panel. Both anatomical eyes show all canonical channels and confidence.
Global rows show camera/tracker FPS, estimated presentation-to-face timing, face
inference, dropped camera frames, renderer FPS, face confidence and physical head
angles. Too-close/far guidance advises repositioning while tracking continues.
Diagnostics and the explicit TEST A–Q sequence are absent from production UI.

The sequence covers neutral, ordinary/slow blink, both winks, held closure, wide
eyes, horizontal/vertical/diagonal gaze, centered/opposed gaze during rotation,
blink/wide eyes during rotation, glasses, dim light and distance changes.

## Conservative hybrid experiment

Flags are `enabled`, `poseAssist`, and `reacquisitionAssist`, all false by
default. The production coordinator preserves MediaPipe's pose and eye inputs.
Jeeliz cannot supply irises, gaze, independent blinks or dense eye geometry.
Unproven pose assistance is explicitly rejected; no Euler/position/scale values
or confidence definitions are averaged.

The developer comparison is bounded: 12 seconds of MediaPipe only, then 12
seconds with Jeeliz observing at at most 2Hz, paused after each callback. It uses
the Studio video and a private canvas. Two distinct, fresh, sufficiently
confident Jeeliz detections can confirm a primary reacquisition; they never
resurrect missing detailed geometry. Initialization is outside the B window.
Completion, cancellation, camera changes, route exit and hidden tabs dispose the
assistant. The installed SDK's borrowed-stream cleanup safeguard is retained.

The comparison retains numeric summaries only. Its source is Studio's 4Hz
summary: jitter is sampled dispersion, not full-frequency noise. Head jitter is
RMS angular dispersion across yaw/pitch/roll; eye jitter is RMS dispersion across
both eyes' blink/gaze X/Y. Repeated summary polls are labelled as such, not as
Jeeliz dropped inference frames. Blink/gaze response latency is unavailable
without an externally timed stimulus. A stationary image with no loss cannot
prove physical reacquisition or tracking accuracy.

Production assistance remains disabled pending demonstrated improvement. The
actual automated comparison and hardware limitations are recorded below.

## Regression lock and validation

The durable fixture is `engine/fixtures/eyeRegression.ts`. Focused unit tests:
`eyeControls.test.ts`, `rendering/eyeRegression.test.ts`, and
`tracking/hybridCoordinator.test.ts`, alongside the existing gaze, eyelid,
calibration and isolation tests. Browser fixtures exercise the complete Studio
control path, real source rendering, source-colour/glasses pixel measurements,
assistant lifecycle and seven mobile widths. Future facial-region work must not
change these contracts without explicit eye fixes and passing regression gates.
The repository AGENTS.md records this lock.

| Serial gate | Result |
| --- | --- |
| Typecheck | PASS |
| Focused eye unit suite | 53 tests PASS |
| All unit tests | 791 tests in 52 files PASS |
| Focused Transformation browser suite | 10 tests PASS |
| Full Transformation browser suite | 87 checks validated: 86 PASS in final serial run + the one real A/B comparison PASS earlier |
| E2E | 18 tests PASS |
| Build | PASS |
| Git diff check | PASS |

The final full-suite rerun excluded only the already-passed real A/B comparison,
to honor the one-experiment limit. No behavior assertion was relaxed. Build
retains the existing large-chunk and OpenCV browser-externalization warnings.

Initial focused desktop automation used **SwiftShader**, a software graphics
stack, with a synthetic controller and real uploaded-source analysis/rendering.
One report window measured renderer 37.51 FPS, render submission 0.90ms and
deformer arithmetic 0.20ms. These are desktop software-browser measurements,
not sustained hardware or phone performance. The render submission figure is
not completed GPU wall time. UV warping is outside the deformer-only timing.
The final full-suite renderer sample was 59.99 FPS, 1.10ms render submission,
0.20ms deformer arithmetic, with 16 dropped display frames during the fixture.
The variation between report windows is another reason not to claim sustained
hardware performance from these software tests.

The source-pixel fixture measured roughly 5.8–6.0px of horizontal iris travel,
1.45–3.73px vertically, zero visible iris pixels at full closure, and less than
2px of glasses-centroid displacement. Wide-eye iris pixel area changed by about
7%/−2%, within the bounded fixture tolerance. This is a synthetic source texture
proof, not real glasses or a physical controller accuracy claim. The real source
portrait's neutral/closed/wide/gaze screenshots were visually inspected.

The **one bounded real A/B comparison passed**, with both installed trackers on
the shared Studio stream. Both windows lasted 12 seconds; the controller was a
stationary portrait camera and graphics were SwiftShader. These are desktop
automation numbers only:

| Metric | MediaPipe only | MediaPipe + Jeeliz confirmation |
| --- | ---: | ---: |
| Camera FPS | 2.269 | 2.163 |
| Tracking FPS | 2.113 | 1.923 |
| Estimated frame age, ms | 271.088 | 234.947 |
| Face inference, ms | 268.772 | 234.076 |
| Dropped camera frames | 2 | 3 |
| Repeated summary polls | 0 | 1 |
| Sampled head jitter, radians | 0.000 | 0.000 |
| Sampled eye jitter, normalized | 0.001 | 0.001 |
| Face losses | 0 | 0 |
| Jeeliz callbacks | 0 | 14 |
| Confirmed reacquisitions | 0 | 0 |
| Reacquisition / blink / gaze response latency | Unavailable | Unavailable |

Tracking FPS fell about 9%, sampled jitter did not improve, and no loss occurred
to demonstrate reacquisition benefit. The lower B frame-age/inference estimate
does not establish a device improvement from this single software-browser run.
Hybrid is **not retained in production**. Pose assistance remains unproven and
disabled. The developer coordinator and finite comparison remain available.

The initial full run passed 84/87 checks. It exposed an outdated mesh-count
expectation and a continuous-path fast-blink threshold that missed a real
MediaPipe closure under yaw. Mesh counts were corrected without changing mouth
or lifecycle assertions; the blink implementation was fixed and pinned by a
new independent held-blink regression. The slow-closure browser stimulus now
actually ramps aperture rather than jumping instantly to half-close. A third,
unrelated avatar motion failure passed unchanged both on the original baseline
and in the focused/final reruns. A follow-up browser navigation interruption
also did not recur in the final suite. Neither required an avatar or renderer
lifecycle implementation change.

## Milestone status

| Requested status | Result |
| --- | --- |
| CURRENT BASELINE PRESERVED | YES — `11ac465` plus existing user work |
| M9 REINTRODUCED | NO |
| MEDIAPIPE PRIMARY TRACKER | YES |
| JEELIZ INSTALLED | YES — `facefilter@3.4.3`, verified local models |
| HYBRID TESTED | YES — one bounded desktop automation comparison |
| HYBRID RETAINED | NO — no demonstrated stability benefit; production flags remain false |
| IPHONE | NOT TESTED |
| ANDROID | NOT TESTED |

| Eye gate | Automation | Physical device |
| --- | --- | --- |
| LEFT BLINK | PASS | DEVICE UNTESTED |
| RIGHT BLINK | PASS | DEVICE UNTESTED |
| HELD CLOSURE | PASS | DEVICE UNTESTED |
| WIDE EYES | PASS | DEVICE UNTESTED |
| GAZE LEFT/RIGHT | PASS | DEVICE UNTESTED |
| GAZE UP/DOWN | PASS | DEVICE UNTESTED |
| GAZE DURING HEAD MOTION | PASS — controlled geometry | DEVICE UNTESTED |
| BLINK DURING HEAD MOTION | PASS — includes real-tracker round trip | DEVICE UNTESTED |
| GLASSES | PASS — synthetic source pixel fixture only | DEVICE UNTESTED |
| EYE TEXTURE INTEGRITY | PASS — real portrait and pixel fixtures | DEVICE UNTESTED |

**DESKTOP AUTOMATION:** the software-browser measurements above. **PHYSICAL
DEVICE:** desktop, iPhone and Android remain untested. There is no physical
performance or visual-acceptance claim. The module has a regression lock;
physical acceptance is pending the manual checklist. No commit or push.

## Manual acceptance — about 2–3 minutes

1. Prepare your source, start the camera and calibrate with both eyes normally
   open. Use Face render; optionally open Eye Diagnostics.
2. Blink both five times, then blink slowly. Wink each eye three times. Hold both
   closed for three seconds, then hold each wink. The opposite eye stays open.
3. Open wide three times. Look left/right, up/down and diagonally. Check that the
   source iris stays inside the eye and keeps its colour; lids/lashes move
   together and the eye does not expose a hole.
4. Turn/nod your head while looking center, then look opposite the turn. Blink
   and open wide during the movement. Check for false gaze or opposite-eye pull.
5. Repeat a blink, wide-eye and gaze sweep with glasses, slightly dimmer light,
   and a closer/farther position. Frames should remain usable; brief confidence
   loss should settle rather than flutter or freeze.

iPhone and Android: NOT TESTED. Physical desktop acceptance: NOT TESTED.

## Remaining limits

- Physical eye quality, glasses, lighting and distance acceptance need the user.
- A single source photograph cannot reveal sclera/iris pixels it never showed;
  wide opening and gaze stay deliberately bounded.
- No automatic segmentation separates opaque glasses crossing the eye texture;
  the bounded orbital field reduces movement but cannot guarantee every frame.
- Closed-aperture normalization and wide-eye envelopes are provisional physical
  tuning points, protected by tests rather than claimed universal anatomy.
- Derived eye confidence is geometric and iris-quality based, not a model's
  per-eye probability or a lighting measurement.
- Hybrid sampled dispersion and software-browser timings do not prove device
  accuracy, phone speed, true gaze latency or physical reacquisition benefit.
- The existing Studio Stop/disposed state still needs a reload for a new session.
