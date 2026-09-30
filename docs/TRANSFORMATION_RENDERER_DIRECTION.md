# Renderer direction and expression correction (Milestone 8.1)

A physical iPhone test rejected M7/M8 on nine points: head movement rendered
backwards on two axes, and no expression produced a visible response despite the
diagnostics reporting live values. Automated tests were green throughout, which
is the most useful thing about the failure.

This records what was actually wrong, measured rather than guessed.

## Part A — global motion direction

### The three causes

**1. Mesh depth was inverted — the hollow-mask illusion.**

`sourceMesh.ts` copied MediaPipe landmark z straight into Three.js. MediaPipe z
is **smaller the closer** a point is to the camera, so the nose tip (the mesh
centre) held the smallest value and every cheek, brow and jaw point came out
positive relative to it. Three.js z grows **towards** the viewer. The face was
therefore built inside-out: the oval nearer the camera than the nose.

This is the dominant cause, and it does not read as a depth bug. A concave face
rotating one way is visually indistinguishable from a convex face rotating the
**other** way — so the head appeared to turn backwards even where the yaw sign
was correct. Fixed by negating once, at the point of construction, with the
reasoning recorded there.

**2. Pitch was never inverted.**

A genuine conflict of conventions about one axis. MediaPipe pitch is positive
when the head tilts **back** to look up. A positive Three.js rotation about +x
carries +z towards −y, pitching the nose **down**. Opposite meanings, same axis.
This is the only axis that needs inverting, and it explains "physical up →
rendered down" exactly.

**3. The rendered face was not mirrored, while the camera preview was.**

`.studio-viewport.is-mirrored` applied `scaleX(-1)` to `.studio-video` only. The
operator sat in front of a mirrored self-view, turned right, saw the preview turn
right — and the rendered face beside it used unmirrored semantics and went the
other way. The two surfaces disagreed about handedness.

### Was yaw's sign wrong?

**No**, and this matters for not "fixing" it twice. Subject-frame yaw and
viewer-frame `rotation.y` already agree: a physical turn to the subject's right
is negative yaw, the subject's right is the viewer's left, and a negative
`rotation.y` puts the nose there. The renderer's `rotation.set(pitch, -yaw, roll)`
was a lone negation compensating for the inverted depth — two wrongs that did not
quite cancel.

### Was roll wrong?

**No.** Positive roll is a tilt towards the subject's right ear; the top of the
head is +y, the subject's right is −x, and a positive rotation about +z carries
+y towards −x. They agree. Roll needed no correction beyond the depth fix and the
display mirror.

### The fix

One layer, `engine/rendering/rendererMotion.ts`, documenting the four coordinate
frames and every sign. Nothing downstream may negate an axis:

| Tracking | Renderer | Inverted? |
|---|---|---|
| `yawDelta` | `rotation.y` | no |
| `pitchDelta` | `rotation.x` | **yes** |
| `rollDelta` | `rotation.z` | no |
| `translationX` | world x | no |
| `translationY` | world y | **yes** (tracking y grows down) |

Mirroring is **not** done there. The mapping produces motion in the faithful,
unmirrored frame — which is what a caller must eventually receive — and a surface
applies `mirrorScaleX(mode)` to the scene at the display boundary. `selfie`
mirrors, `faithful` does not. Baking the mirror into the signs would make the
motion lie about which way somebody turned, and would have to be undone before
the output could reach a call.

### Verification

`rendererMotion.test.ts` — 19 tests named in physical language
(`physical_right_turn_renders_right_turn`, …). They assert where the rendered
face is **pointing**, via `faceDirectionVectors`, which rotates the mesh's own
forward and up vectors by the Euler the renderer applies. A test asserting
`mapped.yaw === -input.yaw` would only prove the implementation agrees with
itself, and would have passed throughout this failure.

`transformation-render-direction.browser.spec.ts` drives the **real** renderer —
source analysis, mesh build, clamping, smoothing, Three.js — and probes it.
Measured on a mirrored self-view:

| Movement | nose x | nose y | up x |
|---|---|---|---|
| turn right | **+0.343** | 0.000 | 0.000 |
| turn left | **−0.343** | 0.000 | 0.000 |
| look up | −0.000 | **+0.242** | 0.000 |
| look down | −0.000 | **−0.242** | 0.000 |
| tilt right | −0.000 | −0.000 | **+0.199** |
| tilt left | −0.000 | −0.000 | **−0.199** |

All six correct, with zero cross-axis leakage.

## Part B–I — expressions

### The isolation measurement, done first

Part J's manual-override test, run as a browser measurement before anything was
tuned. Driving every expression to maximum through the real path and measuring
the mesh gave this, on a rendered face **199 px wide** with a **27 px eye gap**:

| expression | src max | applied | source Δ | **pixels** | moved | region |
|---|---|---|---|---|---|---|
| blinkLeft | 1.00 | 1.00 | 0.01131 | **6.8** | 460 | x 0.38–0.49 y 0.35–0.50 |
| blinkRight | 1.00 | 1.00 | 0.01047 | **6.3** | 399 | x 0.52–0.63 y 0.36–0.49 |
| jawOpen | **0.29** | 0.29 | 0.00802 | **4.8** | 1797 | x 0.38–0.62 y 0.57–0.79 |
| smileLeft | **0.25** | 0.25 | 0.00466 | **2.8** | 572 | x 0.37–0.50 y 0.57–0.70 |
| smileRight | **0.32** | 0.32 | 0.00612 | **3.7** | 570 | x 0.51–0.64 y 0.56–0.69 |
| browInnerUp | **0.15** | 0.15 | 0.00170 | **1.0** | 349 | x 0.42–0.58 y 0.31–0.39 |
| browOuterUpLeft | **0.22** | 0.22 | 0.00290 | **1.7** | 291 | x 0.34–0.44 y 0.33–0.44 |
| browOuterUpRight | **0.27** | 0.27 | 0.00355 | **2.1** | 281 | x 0.57–0.66 y 0.33–0.43 |

### What that settled

**The vertex regions were already correct.** `blinkLeft` moves x 0.38–0.49 and
`blinkRight` x 0.52–0.63 — separate halves, non-overlapping, independent. Jaw sits
at the mouth and chin, brows above the eyes. Part G's suspected index
mis-mapping was **not** the fault, and no region remapping was needed. The
deformer's weights are positional rather than index-based, which is why.

So the causes were two, and both measured:

**1. The source envelope crushed six of eight expressions.** `deriveExpressionEnvelope`
reduced the allowed range because the source already showed some of that
expression. A source photographed mid-smile with slightly raised brows therefore
capped every live smile at 0.25 and every brow at 0.15. That conflates two
different things: a photograph of a **closed mouth** genuinely has no teeth
behind the lips, but a photograph of someone **already smiling** has every pixel
needed to smile further — their smile is a starting position, not a ceiling.

Now only the mouth interior keeps a hard limit; a present expression shifts the
rest position and never caps below 0.5.

**2. Amplitudes were far too small even at full applied value.** A full blink
moved 6.8 px against a 27 px eye gap — roughly a quarter closure. The eyelid gap
was additionally being clamped by `min(gap, width × 0.5)`, cutting it ~40% before
the coefficient applied.

Tuned per region, each as a fraction of the anatomy it moves — not a blanket
multiplier, which would have fixed the eyelid and torn the mouth:

| | before | after |
|---|---|---|
| blink (per lid, of eyelid gap) | 0.43 of a clamped gap | **0.55 of the true gap** |
| jaw lip (of mouth width) | 0.24 | **0.5** |
| jaw chin (of face width) | 0.075 | **0.15** |
| smile lateral (of mouth width) | 0.055 | **0.1** |
| smile vertical (of mouth width) | 0.12 | **0.2** |
| brow inner / outer (of face width) | 0.035 / 0.04 | **0.085 / 0.095** |

### After

| expression | src max | applied | source Δ | **pixels** |
|---|---|---|---|---|
| blinkLeft | 1.00 | 1.00 | 0.01915 | **11.5** |
| blinkRight | 1.00 | 1.00 | 0.01663 | **10.0** |
| jawOpen | 0.58 | 0.58 | 0.03318 | **19.9** |
| smileLeft | 0.80 | 0.80 | 0.02523 | **15.1** |
| smileRight | 0.84 | 0.84 | 0.02680 | **16.1** |
| browInnerUp | 0.74 | 0.74 | 0.02031 | **12.2** |
| browOuterUpLeft | 0.80 | 0.80 | 0.02519 | **15.1** |
| browOuterUpRight | 0.84 | 0.84 | 0.02635 | **15.8** |

10–20 px on a 199 px face, up from 1–7 px. Blink now closes ~23 px of a 27 px
gap with both lids moving. Regions unchanged and still independent. The trace
test asserts a floor of 8 px so this cannot silently regress.

### Parts C, D, E — input fusion

The device diagnostics showed `jawOpen ≈ 0.00` with the mouth visibly open, and
blinks of 0.01 against 0.29 with both eyes doing the same thing. Geometry was
only consulted when a blendshape **name was missing**, so a name that was present
but reading near zero suppressed the expression entirely.

Each expression now takes the **larger** of its blendshape and its landmark
geometry. Both measure how far open something is, both are zero at rest, and the
failure being guarded against is a false *low* from either input — which a
maximum ignores and an average would only halve.

- **blink** — eyelid aspect against the operator's calibrated opening.
- **jaw** — lip separation normalised by mouth width.
- **smile** — `mouthCornerLift`, new: corner height above the lip centre, over
  mouth width. Its geometric baseline is zero because a relaxed mouth has corners
  roughly level with the centre. Documented as an approximation; calibration
  stores no corner-lift neutral.
- **brows** — **no** geometric fallback, deliberately. The mesh's brow points move
  with the forehead, so a geometric measure would largely track head pitch and
  would raise the brows every time somebody nodded. The blendshape is the only
  honest input, and the trace says so rather than implying a fusion that is not
  happening.

**A flaw in that fusion, caught by an existing test:** `eyeOpenness` returns 0
both for a closed eye *and* for absent landmarks, so a frame carrying no mesh
fused to a full blink on both eyes and destroyed the left/right independence the
milestone requires. Geometry is now gated on a real mesh (≥ 468 points) and
reported as `null` rather than `0` when unavailable — absent is not a reading.

No new model was installed.

### Category names (Part E)

`EXPRESSION_BLENDSHAPE_NAMES` and `describeBlendshapeCoverage` check the expected
categories against the live frame. The Studio shows any that this build does not
report, so a renamed category presents as itself rather than as an expression
that mysteriously does not work.

## The diagnostics trace

Studio → Diagnostics → Expressions now shows, per expression:

```
expression        raw   neutral  norm  src max  applied  from
jawOpen          0.71   0.04     0.67  0.58     0.58     shape
```

plus `Mesh movement N px · face N px wide · source Δ` for the combined frame, and
any missing categories. That is the full raw → neutral → normalized → source
limit → applied → vertex-displacement chain the milestone asked for, readable on
a phone.

Per-expression displacement is measured by
`transformation-expression-trace.browser.spec.ts` rather than live, because
isolating eight expressions per frame would mean eight deformer passes.

## Verification

| | |
|---|---|
| `pnpm test` | 584 passed (35 files) |
| `pnpm typecheck` | clean |
| `pnpm build` | clean |
| Transformation browser suite | see report |
| Wider WebRTC/admin e2e | see report |

## NOT YET VERIFIED ON A DEVICE

Every number above comes from a development machine under a software rasteriser
or a desktop GPU. **M8.1 cannot be accepted from this.** The nine reported
failures were all invisible to automation, and the same is true of what remains:
whether a blink *reads* as a blink, whether identity survives, whether the
texture slides.

**iPhone: NOT TESTED. Android: NOT TESTED.** Awaiting manual verification against
the live test matrix.
