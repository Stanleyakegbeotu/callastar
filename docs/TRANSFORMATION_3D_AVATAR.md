# Experimental 3D avatar source (Transformation Studio)

An additional source mode, beside image and video rather than instead of either.
The question it exists to answer: can a rigged 3D model be driven by the
operator's live camera more reliably than the M7/M8 image-texture renderer?

The reason to expect so is geometric. Stretching one photograph means inventing
the side of a head that was never photographed. A complete 3D head already
contains ears, a skull, hair and a neck, so turning it reveals real modelled
geometry.

**The model is the puppet; the camera is the control system.** No animation mixer
is created and no clip is played — a GLB shipping an idle loop will not play it,
because the operator's camera is the only thing entitled to move the model.

## Architecture

```
Live FaceTracker ─┐
PoseTracker       ├─► CalibrationMotion ─┐
calibration      ─┘                      │
                   ExpressionMotion ─────┤
                                         ▼
                                   AvatarMotion          (avatarMotion.ts)
                                         ▼
                                  AvatarRigAdapter       (avatarRigAdapter.ts)
                                         ▼
                                 ThreeAvatarRenderer     (ThreeAvatarRenderer.ts)
                                         ▼
                                     GLB / glTF
```

`src/features/transformation/avatar/` — `avatarTypes.ts`, `avatarMotion.ts`,
`morphAliases.ts`, `avatarRigAdapter.ts`, `modelAnalyzer.ts`,
`ThreeAvatarRenderer.ts`.

The renderer never sees a MediaPipe result, a blendshape name or a calibration
profile. That boundary is what keeps tracking from being wired into GLTF nodes
across the UI.

### Signs are not duplicated

`avatarMotion.ts` takes its yaw, pitch, roll and translation from
`engine/rendering/rendererMotion.ts` — the same function the face renderer uses.
That file became the single authoritative sign layer after a physical iPhone
showed head movement rendering backwards on two axes; writing a second copy here
would have recreated exactly the scattered-negation problem it solved.

So both surfaces turn the same way, there is still one place to look if a
direction is ever wrong, and a unit test asserts the avatar has not drifted from
the face renderer.

## No second render loop

The avatar renderer reads motion through a **getter**, not a stored value:

```ts
const avatarMotionRef = useMemo(() => ({
  get current(): AvatarMotion { /* built from the tracking refs */ },
}), […]);
```

It is read once per frame from inside the renderer's own animation loop, so the
motion is always fresh with no second loop anywhere. A stored value would need
something to write it, and that something would be the duplicate loop this
feature is not allowed to have.

## Formats

`.glb` primary, `.gltf` accepted. Detected from the **bytes** (`glTF` magic), not
the filename — a `.gltf` is JSON with no signature, so it is trusted only when
the extension asks for it and the parse itself is the real validation. FBX and
OBJ are deliberately absent; OBJ has no concept of a skeleton or a morph target
at all.

Ceiling 64 MB (above video's, because a rigged head with 2K textures is routinely
20–40 MB). Mobile weight is warned about separately from **measured** vertex and
texture counts rather than from file size.

## The three model classes, reported honestly

| Class | Reported as | Supports |
|---|---|---|
| A | `rigged-facial` | head motion **and** expressions |
| B | `rigged-head` | head motion; jaw too if a jaw bone exists |
| C | `static` | whole-model transform only |

A static model cannot blink, and the panel says so — *"Head motion is available,
but this model does not contain compatible facial blendshapes."* Telling an
operator otherwise sends them hunting a tracking fault that does not exist.

Capabilities are derived **from the discovered mapping** rather than declared
beside it, so a capability and the morph behind it cannot disagree.

## Morph discovery and aliasing

There is no standard. A GLB from Ready Player Me, one from Blender's ARKit
add-on, one from VRoid and one modelled by hand each name a left blink
differently — and a single hardcoded vocabulary would work for one pipeline and
fail silently for every other, which on screen is indistinguishable from a broken
rig.

Matching is by **normalised alias**: case, separators and decorative prefixes
(`Fcl_`, `mixamorig`, `blendShape_`) are stripped, then exact aliases are tried,
then base-plus-side patterns. So `eyeBlinkLeft`, `EyeBlink_L`, `blink.L` and
`Fcl_EYE_Close_L` all resolve without every spelling being listed.

Two rules worth naming:

- **One morph per expression per mesh.** A model with both `eyeBlinkLeft` and
  `eyeClosedLeft` would otherwise drive both at full influence, shutting the eye
  through the skull.
- **A sideless `blink` matches neither eye.** Driving both from one morph would
  make every wink a blink.

Influences are written to **every** mesh carrying a morph, because a head is
routinely split into face, eyes, teeth, tongue and brows — driving only the first
would close the eyelid skin and leave the eyeball open.

Unmapped morphs (`cheekPuff`, `noseSneer`, the other 44 ARKit shapes) are
reported, not hidden.

## Head pivot

The pivot is the difference between a head turning and a door swinging. Resolved
once, and its source recorded so a wrong one is diagnosable:

1. `head-bone` — the head bone's world position. Correct where one exists.
2. `head-mesh-bounds` — the centre of the mesh most likely to be the head, scored
   on its name and on whether it carries facial morphs.
3. `scene-bounds` — last resort.

`HeadTop_End` is explicitly excluded from head-bone discovery: rotating about the
crown reads as a nod originating in the forehead.

Scale normalises the model's **largest** dimension, not its height, because an
upload may be a bare head, a bust or a whole body — and scaling a full body by
height would leave the face a few pixels tall.

## Coordinate mapping

One layer, no scattered fixes. From `rendererMotion.ts`:

| Tracking | Renderer | Inverted? |
|---|---|---|
| `yawDelta` | `rotation.y` | no |
| `pitchDelta` | `rotation.x` | **yes** (MediaPipe up-positive vs Three nose-down-positive) |
| `rollDelta` | `rotation.z` | no |
| `translationX` | world x | no |
| `translationY` | world y | **yes** (tracking y grows down) |

Mirroring is a **display** decision: `mirrorScaleX("selfie")` applies one negative
x scale at the scene boundary, matching the camera preview. `"faithful"` is what a
caller must receive.

Depth (`translationZ`) is **derived from apparent scale**, not measured — a single
camera cannot measure distance — so a model comes towards the viewer as it grows
without the code pretending to know how far away anyone is.

## Calibration

Reused entirely. The avatar's neutral **is** the operator's calibrated neutral, so
someone whose resting head sits four degrees off centre does not drive a
permanently turned avatar. Recalibration resets only the tracking baseline and
never reloads the GLB. A camera flip invalidates calibration exactly as before.

## Tracking loss

Hold ~420 ms, then ease to neutral over ~520 ms. Never freeze: an avatar held
mid-blink or mid-turn reads as a crash, and the operator cannot tell whether the
renderer died or they simply left the frame.

## Smoothing

Head and expressions on deliberately different characters — yaw jitter on a
rendered head reads as a shiver, and a blink that takes 200 ms to arrive is not a
blink. Blink rises faster than it falls, as real eyelids do.

| | |
|---|---|
| Head | τ 60 ms |
| Blink | τ 24 ms attack / 55 ms release |
| Jaw | τ 42 ms |
| Everything else | τ 70 ms |

## Manual rig panel

Development-only, and **required**. Each expression has a 0→1 slider that travels
the **same `AvatarRigAdapter`** the camera does. That is the fastest isolation
available: a working slider beside a dead live input points at the input pipeline;
both dead points at the rig. If the slider took a different path it would prove
nothing.

Head motion stays live while the sliders drive the face, so a rig can be tested
without holding perfectly still.

Per-expression gains exist (default 1.0 — an honest default that changes nothing)
so a loosely modelled rig can be raised later. Gained influences are still clamped
to 0..1, because a morph driven past 1 tears most rigs.

## Resource cleanup

GPU memory is not collected on scene removal. `disposeAvatarScene` traverses the
whole scene and disposes every geometry, material and texture; the renderer calls
it, and so does every path that drops a model — choosing a different source,
Change Source, a replaced analysis, and hook unmount. A `runToken` means a model
still loading when the operator moves on is discarded **and** disposed on arrival
rather than becoming live.

## Mobile overflow — fixed at the source

The device report was real, and the existing sweep could not see it because it
checks the Studio while **idle**.

Measured cause: `document.documentElement.scrollWidth` was **684 px on a 360 px
viewport**, with *no element* overhanging. The culprit was
`span.admin-visually-hidden` inside the step rail — it is `position: absolute`,
`.studio-step` was `position: static`, so it resolved against a distant ancestor,
escaped the rail's `overflow-x: auto` clipping, and landed 683 px out.

Chromium hid that behind `html { overflow-x: clip }`. Older iOS Safari does not
honour `clip`, which is why a real phone dragged while every automated check
passed.

Fixed by giving `.studio-step` and `.studio-source-angles li` a containing block
(`position: relative`), so the hidden text is clipped by the strip it belongs to.
Verified: `html.scrollWidth` is now **360 = innerWidth**, and
`transformation-studio-overflow.browser.spec.ts` asserts it at 360/375/390/393/430
with the source panel and diagnostics open — plus the offending element, so the
check cannot be satisfied by clipping the page.

## Measurements

Synthetic rigged GLB (221 vertices, 8 ARKit morphs, Head/Neck/Jaw skeleton), on
the SwiftShader software rasteriser this suite forces:

| | |
|---|---|
| Renderer | **60.0 fps**, 329 frames over the run |
| Rig class | `rigged-facial`, warnings `[]` |
| Head bone | `Head` (chosen over the `Neck` decoy) |
| Pivot | `head-bone` |
| Applied yaw | right **−0.350**, left **+0.350** |
| Blink influences | `[1.00, 0.00, 0.00, …]` |
| Jaw influences | `[0.00, 0.00, 1.00, …]` |

A static GLB reports `static` with `[no-morph-targets, no-skeleton]`.

**Pixels are not sampled.** A WebGL drawing buffer is undefined after compositing
unless the context sets `preserveDrawingBuffer`, which production does not because
it costs a full-buffer copy every frame. So "the renderer works" is proved by its
own frame and fps counters, and "the model is driven" by morph influences and
applied head values read straight off the scene.

## Test fixture

Generated in the browser, not committed: a `SkinnedMesh` with named morph targets
and a bone chain is built with Three.js, exported through `GLTFExporter`, and fed
back through the real `GLTFLoader`. No binary asset in the repository, a
deterministic rig, and the actual loader under test.

A first version used loose `Bone` objects and produced a file with **no bones at
all** — `GLTFExporter` only writes a skeleton bound to a `SkinnedMesh`. Caught by
the test asserting `head-bone` and getting `head-mesh-bounds`.

## Verification

| | |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test` | 637 passed (37 files) |
| `pnpm build` | clean |
| Avatar browser proofs | 4 passed |
| Studio overflow | 5 passed (360/375/390/393/430) |
| Transformation browser suite | 46 of 48 passed |
| `pnpm test:e2e` | 18 passed |

The two failures are both the video-source metadata check, timing out on
`VideoFrameReader`'s fixed 15 s budget during a 16.4-minute suite run on a heavily
contended machine. Nothing in this milestone touches that code, and the same tests
passed in the immediately preceding run. It was **not** re-confirmed in isolation,
so it is recorded as an unverified contention attribution rather than a clean
result.

Three, GLTFLoader, `FaceRenderer` and `ThreeAvatarRenderer` all build as separate
lazy chunks — nothing 3D loads until a model is chosen.

## Deliberately not built

- **No WebRTC.** `ThreeAvatarRenderer.getOutputCanvas()` is the seam a future
  `captureStream()` would use; no sender track is touched.
- **No live-mouth compositing.** The extension point is named
  (`AvatarMouthCompositor` in the plan) and nothing is implemented. A model that
  already contains teeth and a tongue renders them; none are fabricated.
- No hair or cloth physics — imported hair moves rigidly with the head.
- No Supabase, no schema change: a model lives in the Studio session.
- No face recognition, no identity matching. This is motion retargeting.

## NOT VERIFIED ON A DEVICE

**iPhone: NOT TESTED. Android: NOT TESTED.**

Every figure above comes from a development machine under a software rasteriser.
The previous milestone's nine failures were all invisible to automation, and the
same is true of what matters here: whether a rigged head reads as a puppet of the
person driving it.
