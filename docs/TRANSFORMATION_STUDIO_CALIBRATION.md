# Transformation Studio — calibration (Milestone 5)

Milestone 4 proved the live input pipeline. This turns raw tracking into a
stable coordinate system: a captured neutral pose, and live motion expressed
relative to it. Still nothing is transformed, no source image exists, and
nothing reaches a call.

## Why it exists

A raw yaw of 7° does not mean the operator turned 7°. Their resting pose may
already sit angled, their camera may be below eye level, and they may be sitting
closer than the last person. Driving a deformation from absolute landmarks bakes
all of that into the output permanently.

So everything downstream reads deltas:

```
relativeYaw = currentYaw − neutralYaw
```

Sitting perfectly still reads as **no movement**, not as a permanent two-degree
turn.

## State

Calibration is its own machine, separate from `TransformationPhase`:

```
idle → waiting-for-stable-tracking → collecting → evaluating → ready
                     ↑                    │
                     └────────────────────┘   (operator moved)
                                          → failed
```

Separate because the engine can be running perfectly while calibration is idle,
collecting or failed — and a calibration failure must leave the models, the
camera and the loop exactly where they were. A browser test asserts that: after
a failed capture, tracking continues and the camera is still live.

## Collection policy

| | |
|---|---|
| Minimum frames | 12 |
| Minimum duration | 1200 ms |
| Maximum frames | 60 |
| Stability window | 10 frames |
| Timeout | 20 s |
| Consecutive refusals that abandon a window | 8 |

**Both** the frame count and the elapsed time must be met. A frame count alone
finishes in 200 ms at 60 fps — a snapshot, not a pose. An elapsed time alone
accepts three frames on a slow device. Neither assumes a frame rate, which is
the point.

A capture typically completes in about 1.5 s. It is deliberately not a five- to
ten-second procedure.

## Frame acceptance

A frame joins the window only if the face is tracked with confidence ≥ 0.4, all
geometry is finite, and it sits inside the forward-facing envelope:

| | |
|---|---|
| Face scale | 0.03 – 0.25 (normalised interocular) |
| Yaw / pitch / roll | ±0.45 / ±0.35 / ±0.35 rad (≈26° / 20° / 20°) |
| Face centre | at least 5% from each frame edge |

The envelope is generous on purpose. A neutral pose *is* slightly off-axis, and
an envelope tight enough to demand a perfectly square-on head would refuse to
calibrate most people — a worse outcome than a baseline taken at four degrees of
yaw.

In `full` mode both shoulders must be tracked. `partial` is refused; that is
what triggers the face-only offer.

## Stability

Measured as **median absolute deviation** over the window, per quantity, against
a documented tolerance:

| Quantity | Tolerance |
|---|---|
| Face centre X / Y | 0.012 |
| Face scale | 0.006 |
| Yaw / pitch | 0.05 rad |
| Roll | 0.04 rad |
| Shoulder centre X / Y | 0.02 |
| Shoulder width | 0.02 |
| Shoulder angle | 0.06 rad |

MAD rather than variance, for the same reason the baseline is a median: one
frame where the model briefly lost an eye would dominate a variance and make a
still operator read as moving. Not scaled by 1.4826 — that constant assumes
normally distributed noise, and tracker jitter is not.

The **worst** quantity decides, never an average of them. A perfectly steady
head over a swaying torso is not a usable baseline for upper-body motion, and
averaging ratios would let five good axes hide one bad one.

```
stabilityScore = clamp(1 − worst / 2, 0, 1)
```

So perfectly still is 1.0, exactly at the tolerance is 0.5 — which is also where
`stable` flips — and twice the tolerance is 0. A stated formula over measured
dispersion. Not a percentage, and not a model's opinion.

Quantities with **no** samples (shoulders, in a face-only capture) are skipped
rather than scored as perfect.

## Robust statistic: the median

Throughout, for centre, scale, angles and shoulder geometry.

Not the mean, which one dropped-landmark frame can move a long way. Not a
trimmed mean either, though it was the obvious alternative: over a dozen-odd
frames a 20% trim still averages the near-outliers it did not cut, and it needs
a tie-break policy at the trim boundary that would have to be pinned by test
anyway. The median needs one stated rule — for an even count, the mean of the
two middle values — and is otherwise a sample the operator actually produced.

Angles are treated linearly, not circularly: the acceptance envelope keeps yaw,
pitch and roll well inside ±90°, so there is no wrap, and a circular mean would
only add a failure mode.

## The profile

`TransformationCalibrationProfile` holds aggregated geometry and nothing else:
neutral face centre, scale and orientation; resting eye and mouth openness;
shoulder centre, width and angle; torso fields where available; the camera
facing; the tracking space; and a quality report.

**Nothing frame-by-frame survives.** The samples are discarded the moment the
baseline is computed. No camera image, no landmark history, no pose history, no
video, no identity embedding — and the profile lives in memory for the length of
a Studio visit, never reaching IndexedDB, `localStorage`, session history or
analytics. A serialised profile is a few hundred bytes; a browser test asserts
it is under 2 KB and carries exactly eight top-level keys.

## Pose optionality and the face-only fallback

A seated operator close to the camera usually has **no visible hips**. Torso
fields stay null and calibration succeeds — requiring full torso geometry would
fail for most desks.

Shoulders are different. If they cannot be tracked, a `full` capture times out
with `pose-unavailable`, and only then does the Studio offer **face-only**. It
is labelled *Limited — head movement only* wherever it appears, and graded
`limited` however steady it was. It is genuinely less, and is never presented as
equivalent.

## Quality and warnings

| Grade | Conditions |
|---|---|
| Excellent | Full capture, stability ≥ 0.7, ≥ 20 frames, no warnings |
| Good | Full capture, stability ≥ 0.5 |
| Limited | Face-only, no pose, or stability < 0.5 |

Warnings are informational and never stop a baseline being used: shoulders at
the frame edge, a resting head angled past ~15°, stability below 0.6, a face
near the frame edge, and upper body unavailable.

## Relative motion

`computeRelativeMotion` is pure and renderer-independent. It emits no pixels —
a deformation driven by pixels would behave differently at every camera
resolution.

**Translation** is divided by the neutral face scale (or neutral shoulder width
for the upper body), so movement is measured in face widths. A frame fraction
means a different physical distance at every distance from the camera; half a
face width sideways is the same movement whatever the camera. The vertical axis
is additionally divided by the tracking aspect ratio, because landmarks are
normalised against width and height separately — without that, on a 9:16 phone
frame a vertical movement reads as nearly twice the equivalent horizontal one.

**Scale** is a **ratio**, `current / neutral`, never a difference. Distance from
a camera is multiplicative: a face twice as far away is half as wide, wherever
it started.

**Expression is passed through live** and is *not* neutralised the way head pose
is. Head orientation has a meaningful resting value to subtract; a blink does
not. Someone with naturally narrow eyes has a lower resting openness, and
neutralising it would make their ordinary face read as a permanent half-blink
and their actual blink read as nothing. The profile records the resting values
and the motion helper offers `eyeOpennessFromNeutral` / `mouthOpennessFromNeutral`
for a consumer that wants them — never applied by default.

**Tracking loss is absent, not zero.** Zero would claim the operator is in the
neutral pose, and a renderer reading it would snap the source to centre instead
of holding position. Losing the face for two seconds does not invalidate the
baseline; motion resumes against the same neutral.

### Sign conventions

All motion is computed in the **unmirrored tracking space** the models saw.
Mirroring is a display concern and lives in `coordinateMapping.ts`.

| Positive means | |
|---|---|
| `yawDelta` | turned further towards the subject's **left** |
| `pitchDelta` | tilted further **back** |
| `rollDelta` | tilted further towards the subject's **right** ear |
| `translationX` | moved towards the **right of the camera frame** (looks like *left* on a mirrored preview) |
| `translationY` | moved **down** the frame |
| `shoulderAngleDelta` | subject's **right** shoulder dropped further |

These are verified against real model output, not just asserted — see below.

## Invalidation rules

| Trigger | Baseline |
|---|---|
| Camera facing changed (flip) | **Dropped.** Recalibration required. |
| Operator recalibrates | Replaced. |
| Studio disposed | Dropped. |
| Quality mode changed | **Kept.** |
| Tracking lost temporarily | **Kept.** |

A flip changes mirror, optics, field of view and where the operator sits in
frame. Silently reusing a front-camera neutral on a rear camera produces motion
measured from a pose the operator was never in — subtly and unfixably wrong. The
models, the camera and the loop are untouched; only the baseline goes, and the
Studio says *Recalibration required*.

A quality-mode change adjusts frame size and cadence. It does **not** change the
coordinate convention: landmarks stay normalised 0..1, the tracking frame keeps
the camera's aspect, and mirroring and cropping are untouched. Invalidating here
would cost a recalibration for nothing. If a future preset ever changed the crop
or the mirror, that *would* have to invalidate — which is why the rule is
written down rather than implied.

Recalibration reuses everything: no model reload, no camera re-request, no
runtime rebuild. A browser test asserts the models stay initialised across a
flip by reading the recorded init time afterwards.

## Motion envelopes (provisional)

Diagnostics only in this milestone. They become deformation clamps later.

| | |
|---|---|
| Yaw | ±0.52 rad (30°) |
| Pitch | ±0.35 rad (20°) |
| Roll | ±0.26 rad (15°) |
| Scale | 0.75× – 1.35× |
| Translation X / Y | ±0.6 / ±0.5 face widths |
| Shoulder angle | ±0.2 rad (11°) |

Chosen from the acceptance envelope and ordinary desk movement, **not** measured
against a product requirement — which is why they are documented here rather
than buried as literals. They should be revisited with a real source and a real
phone before they clamp anything.

## Verification

Run on 2026-09-29.

| Suite | Result |
| --- | --- |
| `pnpm test` | 409 passed (24 files) |
| `pnpm typecheck` | clean |
| `pnpm build` | clean |
| `pnpm test:transformation:browser` | 27 passed |
| `pnpm test:e2e` | 18 passed |

### Signs against real model output

`tests/transformation-motion-signs.browser.spec.ts` runs the **actual Face
Landmarker** on a real decoded image, calibrates through the real collector, and
reads motion back through the real helper. Applying a known transform to the
fixture and checking the delta is the closest thing to the physical check that
can be done without a person.

Measured, at 15° of in-plane image rotation:

```
roll  −14.96°     yaw −0.09°     pitch +2.79°
```

The rotation lands on **roll**, with under 3° of leakage onto the other two
axes. That is the Milestone 2 failure reproduced deliberately: an axis mix-up
anywhere between the model and the motion helper would show up here as the
rotation landing on the wrong line.

The direction is the documented one. Rotating the image clockwise moves the top
of the head towards the right of the frame; unmirrored, that is the subject's
**left**, so a tilt towards their left ear — and positive roll is defined as a
tilt towards their right. Negative is correct.

Also measured: a 1.25× scale returns 1.222, a 0.8× scale returns 0.785, ±60 px
vertical returns ±0.44 face widths, and the calibrated pose itself returns zero
on every axis.

### What this does NOT cover

**Yaw and pitch are not verified against real model output.** A drawn 2D fixture
cannot be turned in three dimensions, and faking one by shifting features would
test the drawing rather than the pipeline. Those two axes are verified in unit
tests against synthetic geometry, and their real-world behaviour still needs a
person in front of a camera.

## Manual device check (§36) — NOT PERFORMED

This requires a human in front of a camera and has not been done. The procedure:

1. Open Admin → Transformation on a hardware-accelerated browser, start the
   camera, and calibrate.
2. Open **Diagnostics** and read *Motion, relative to neutral*.
3. Sitting still: every value at 0.0 and scale at 1.00×.
4. Turn left, then right — **yaw** changes sign, pitch and roll stay near zero.
5. Nod up, then down — **pitch** changes sign, yaw and roll stay near zero.
6. Tilt one ear towards a shoulder, then the other — **roll** changes sign.
7. Lean left and right — **Move X** changes sign.
8. Lean closer and further — **Scale** goes above and below 1.00×.
9. Drop one shoulder, then the other — **Shoulder angle** changes sign.

Record any inversion or drift. Values are signed in the panel specifically so an
inversion is visible at a glance.

**iPhone: NOT TESTED. Android: NOT TESTED.** No mobile device measurement exists
for this milestone or the previous one.

## Not in this milestone

- No source image, no analysis, no deformation, no Three.js, no OpenCV, no UV
  work.
- No WebRTC: no call, no sender, no `replaceTrack`, no signalling requirement.
- No recording, no Supabase, no additional ML runtime.
- No new worker, model or resource: calibration is pure JS data over frames the
  Milestone 4 scheduler already produced.
