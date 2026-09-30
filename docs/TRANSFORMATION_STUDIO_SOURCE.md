# Transformation Studio — source analysis (Milestone 6)

Milestones 4 and 5 prepared the LIVE OPERATOR: a tracking pipeline and a
calibrated baseline. This prepares the SOURCE PERSON — the face a caller will
eventually see — into a contract a renderer can plan against.

Nothing is transformed. No source is mapped onto the operator, no renderer
exists, and nothing reaches a call.

## Architecture

```
SourceAsset ──► SourceAnalyzer ──► TransformationSourceProfile
                  ├── sourceTrackers        (Face + Pose, IMAGE mode)
                  ├── videoFrameReader      (seek + decode one frame)
                  ├── videoSampling         (which moments to look at)
                  ├── referenceFrames       (classify + select)
                  └── sourceQuality         (regions, warnings, grade, envelope)
```

Everything above lives in `src/features/transformation/source/` and knows
nothing about React. `useSourceSelection` picks an asset, starts a run, watches
progress and owns the preview URL; `SourcePanel` displays it. No component
touches a model, a video element or an `ImageBitmap`.

**Independent of the camera.** Source analysis needs no live camera, no
calibration and no signalling. A browser test asserts `getUserMedia` is never
called during the whole Studio source flow.

## Media architecture: what was reused

Audited before anything was written, and deliberately **not** duplicated:

| Existing | Used how |
| --- | --- |
| `AdminRepository.getAssetBlob` / `getAssetMeta` | Reading a stored avatar or call-source video as a source |
| `AssetKind`, `StoredAssetMeta` | Unchanged — no new asset kind, no schema migration |
| Object-URL ownership rule | `useSourceSelection` revokes every URL it creates |

Direct uploads are **temporary**: the `File` is held in memory for the Studio
visit and never written to storage. That avoids a second media-storage
subsystem and an IndexedDB version bump in accepted code. `checkPortraitSource`
is deliberately *not* applied — 9:16 is a rule about a clip played full-frame as
a call participant, and a source photograph has no such constraint.

## Media type detection

From the **bytes**, never the filename. A browser fills `File.type` from the
extension on most platforms, so an MP4 renamed `.jpg` arrives claiming to be an
image, and the failure lands much later inside a decoder.

Accepted: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/webm`.
Size is checked against the kind the bytes say it is, so a 30 MB video renamed
`.png` cannot slip under the 10 MB image ceiling. A Matroska file wearing the
shared EBML signature is refused rather than hoped for.

## Consent

A single local confirmation — *"I confirm I have permission to use this
source"* — required before the first analysis of a newly supplied source, and
**reset whenever a source changes**. A confirmation that survived a source
change would mean the operator confirmed permission for a file they had not
seen. Nothing in the media library is analysed on its own.

## Image analysis

Decoded **once** per attempt, by the browser, via
`createImageBitmap(blob, { imageOrientation: "from-image" })`. That flag applies
the EXIF orientation — a phone photograph is very often stored rotated with a
flag saying so, and a model handed the raw pixels finds no face at all.

### Model strategy

Dedicated **IMAGE-mode** wrappers (`SourceAnalysisTasks`), separate from the
VIDEO-mode `FaceTracker` / `PoseTracker`. The live trackers are built around a
monotonic clock, a per-frame busy guard, rolling timing averages, and results
allowed to be "skipped" because another frame arrives in 33 ms. None of that
applies to a still, where a skipped result is a failure and a timestamp would
have to be invented to satisfy an API whose semantics do not fit.

Both tasks are created for one analysis and **disposed when it ends**. Source
analysis is finite; leaving a second pair of models resident would double the
Studio's memory for something nothing is using.

A face is **required**. Pose is optional and its absence is not fatal — a clear
face with no shoulders still drives head movement.

## Video analysis

A video is **reference material**, not output. The prerecorded clip is never
played as the transformed result; the live operator drives that later.

### Sampling

Cost must not grow with duration. A minute at 30 fps is 1800 frames; at
IMAGE-mode inference cost that is minutes of waiting for what a dozen frames
would show.

| | |
|---|---|
| Minimum samples | 8 |
| **Maximum samples** | **20, whatever the duration** |
| Roughly | one per 1.5 s, between those bounds |
| Edge trim | 6% each end, capped at 1.5 s |
| Minimum spacing | 0.12 s (duplicates removed) |

Deterministic: the same duration always gives the same timestamps, so a failing
analysis reproduces exactly. Ends are inset because the first and last moments
catch somebody reaching for the camera — and because a seek to exactly
`duration` lands past the last decodable frame on plenty of encoders.

### Seeking

Setting `currentTime` does **not** mean the frame is ready. The assignment
returns immediately and the decoder works asynchronously, so drawing straight
afterwards paints whatever was on the element before — usually frame one, for
every sample. The result looks like a video whose head never moves and reads as
no bug at all.

So every seek waits for `seeked`, then for a presented frame via
`requestVideoFrameCallback` where the browser offers it, with a 120 ms fallback
because a paused element may never present one. Seek timeout is 6 s; a seek that
fails is skipped rather than failing the analysis.

Two settings were corrected during this milestone after a real failure:
`preload="auto"` made Chromium buffer a 4.4 MB file past the metadata timeout,
and `crossOrigin="anonymous"` on a blob URL made it refuse to load at all. Both
are now documented at the point of use.

### Candidate rejection

A frame is refused for: non-finite geometry, a face below 0.035 normalised
interocular scale, a face centre within 8% of a frame edge, an angle past ±0.7
rad yaw or ±0.5 rad pitch, or belonging to none of the five buckets. One terrible
frame does not enter the bank merely because the sampler landed on it — a
renderer asking for "the left reference" gets whatever is there.

### Reference bank

Five buckets: `front`, `slight-left`, `slight-right`, `slight-up`,
`slight-down`. One frame each, **at most five entries by construction**. Only
buckets the source actually fills are created — a missing angle stays missing
rather than being filled with the nearest frame and quietly mislabelled.

Classification uses the head pose the model solved for, never a filename or a
position in the timeline. Yaw is considered before pitch, because a
turned-and-tilted head reads primarily as turned and horizontal coverage is what
a renderer most needs.

**The sign convention is the documented one:** positive yaw is the head turned
towards the SUBJECT'S LEFT, so positive yaw is `slight-left`. This is the
Milestone 2 risk in different clothes — an inverted reading would produce a bank
whose every side label is mirrored, and nothing about it would look wrong. Pinned
by test, in those terms.

Selection is deterministic, weighted: closeness to the bucket's target angle
(0.5), framing (0.2), both shoulders present (0.2), face size (0.1). Ties break
on the earlier timestamp.

Entries hold a **timestamp and geometry, never pixels**. A renderer decodes the
frame it wants by seeking to that timestamp; keeping twenty decoded frames alive
to avoid one seek would trade milliseconds for tens of megabytes.

## Quality

Every rule is measured. **Nothing claims anything about blur or lighting** —
neither is measured anywhere in this project, and telling somebody their
photograph is blurry on a guess makes them replace an image that was fine.
Product copy may suggest good lighting; automated analysis may not claim to have
checked it. No percentages either.

| Grade | Conditions |
|---|---|
| Excellent | Multi-angle, both shoulders, head rotation available, nothing else to say |
| Good | Clean single image, or multi-angle with cosmetic warnings |
| Limited | No shoulders, no head-rotation room, low resolution, or cropped head |
| Unusable | No face, or a face too small to land landmarks on |

A clean still is **good, never excellent** — excellence here means more than one
angle to draw from, which a photograph cannot have.

Capabilities are booleans a renderer asks directly: `face`, `expressions`,
`headRotation`, `upperBody`, `multiAngleReference`.

Warnings: face near edge, head strongly angled, shoulders not visible, one
shoulder only, shoulders cropped, head region cropped, low resolution, small
face, single-image limited coverage, few reference angles. All informational.

### Regions

Face landmarks stop at the face. A renderer cropping to their bounds would cut
off a forehead, both ears and all the hair — so `regions.head` expands the face
bounds by measured, asymmetric proportions (+22% sides, +38% top, +12% bottom;
the 478-point mesh already reaches the hairline, so the remaining hair is about a
third of the bounds height, not most of it). `regions.upperBody` adds the
shoulders where they exist and is the head alone where they do not: putting a
torso under a cropped photograph invents what was never taken.

`headClipped` / `upperBodyClipped` matter as much as the rectangles — a clamped
region means the source does not contain the whole head, and the renderer needs
to know rather than discover it as a hard edge.

### Movement envelope

The governing fact: a photograph contains no information about a side of a head
it never showed. So the envelope is **asymmetric and centred on the source's own
pose**, not on zero. A source already turned 25° towards the subject's left has
spent part of its leftward room and gained the same rightward, because turning
back towards centre reveals only what is already there.

A still starts at ±0.44 rad yaw, ±0.26 pitch, 0.82–1.25× scale. A video that
genuinely showed a direction earns +0.26 rad that way and a wider scale range.
Translation is null without shoulders — there is no anchor to measure it against.

**Quality metadata only.** Nothing clamps anything yet, and these should be
revisited against a real renderer before they do.

## Progress and cancellation

Stages are entered when that work begins, and `Analyzing 3 / 12` counts frames
genuinely analysed. A determinate bar appears only where there is something real
to count; elsewhere it is indeterminate rather than advancing on a timer.

Cancellation stops further seeks and inference, disposes the tasks, releases the
video element, object URLs and any `ImageBitmap`, and returns the Studio to the
selected-source state. A `runToken` guards every resumption point, so a
cancelled run still inside an `await` cannot mark a replaced source ready — a
browser test starts a video analysis, cancels it, analyses an image instead, and
asserts the Studio shows the image.

**Change Source** releases everything that source owned and nothing else. The
runtime — WASM, live models, camera, calibration — is untouched, so changing a
source costs no 35 MB reload.

## Separation from calibration

`TransformationSourceProfile` and `TransformationCalibrationProfile` stay
independent. One describes the source asset, the other the live operator; they
have different lifetimes, different privacy rules and different invalidation
triggers. The future renderer consumes both plus `CalibrationMotion`, and that
separation is the architecture.

A test asserts the source profile's serialised form contains no calibration
field, and lists its exact fourteen top-level keys.

## Privacy

- Analysis is entirely browser-local. No source image or video is uploaded
  anywhere; models and WASM are same-origin.
- No face recognition, no identity matching, no embeddings.
- The profile contains **nothing about the live operator** — no camera frame, no
  live landmark. That belongs to calibration.
- No decoded image buffers, raw frames or MediaPipe objects are retained.

## Persistence

Source profiles are **held in memory for the Studio visit** and not persisted.
`analysisVersion` exists so a stored profile from an older analyser can be
invalidated rather than reinterpreted, and `profileId` scopes it — but writing
them to IndexedDB would mean a new store and a database version bump in accepted
code, for a temporary upload that has no durable asset to reference. That is a
deliberate deferral, not an oversight.

Scoping is still enforced now: `profileMatchesSource` refuses a profile prepared
for another admin profile, pinned by test. Giving one person another person's
face is the single worst thing this feature could do.

## Measurements

Intel HD Graphics 4600, ANGLE/D3D11 — a 2013 integrated GPU. **Not a phone.**

### Image (640×480 synthetic face)

| | |
|---|---|
| Decode | 5 ms |
| Model init | 8570 ms |
| Face analysis | 7847 ms |
| Pose analysis | 11528 ms |
| **Total** | **27951 ms** |

### Video (14.4 s clip)

| | |
|---|---|
| Metadata load | 5 ms |
| Model init | 567 ms |
| Frames analysed | 10 (of 10 planned) |
| Per frame | 2227 ms |
| **Total** | **24855 ms** |
| Reference bank | 2 angles |

### What these numbers mean

**IMAGE mode costs roughly 40× VIDEO mode per inference.** Milestone 4 measured
face+pose at ~55 ms per frame in VIDEO mode on this same machine; here it is
~2.2 s. That is not a defect: VIDEO mode tracks from the previous frame and skips
the expensive detector, which is exactly what must NOT happen across
non-contiguous seeks. Sampled frames are seconds apart, so tracking from the
previous one would be meaningless. IMAGE mode is the correct choice and the cost
is the price of correctness.

**Model init dominates a single image.** 8.5 s of a 28 s image analysis is task
creation. §52 requires stopping analysis inference when it completes, so every
analysis pays it again — a deliberate trade of time for resident memory. Keeping
the tasks warm across analyses within one Studio visit is the obvious
optimisation and should be measured against memory on a phone before it is made.

**A 14 s video takes 25 s.** Within the stated bar of "not a minute for a
ten-second source", but not comfortable. The sampling cap is what keeps it
bounded: a ten-minute clip costs the same 20 frames.

## Verification

Run on 2026-09-29.

| Suite | Result |
| --- | --- |
| `pnpm test` | 552 passed (30 files) |
| `pnpm typecheck` | clean |
| `pnpm build` | clean |
| `pnpm test:transformation:browser` | 34 passed |
| `pnpm test:e2e` | 18 passed |
| `pnpm test:transformation:benchmark --headed` | tables above |

`playwright.transformation.config.ts` no longer matches the benchmark spec. It
forces a software rasteriser, so running the benchmark there spent minutes
producing numbers the benchmark itself then labelled as meaningless.

### Real-model image result

478 landmarks, 52 blendshapes, a 16-element facial transformation matrix; yaw
1.2°, pitch −0.9°, roll 1.1°, scale 0.2067; pose not detected (a drawn face has
no body); grade `limited` with warnings `shoulders-not-visible` and
`single-image-limited-coverage`.

### Real-model video result

14.4 s clip, 10 planned samples, 10 analysed, bank of 2 angles
(`slight-right`, `slight-left`), grade `limited`.

### Fixtures

Images are drawn on a canvas at test time — synthetic, fictional and
deterministic, so no real person's photograph enters the repository. The video
fixture is the demo clip already present: there is no ffmpeg here and the only
browser encoder is `MediaRecorder`, which this project is instructed not to
introduce, so the video assertions cover the **pipeline** (metadata, bounded
sampling, real seeking, progress, cancellation) and do not claim to know what
the clip contains.

## Not in this milestone

- No Three.js. No renderer, no mesh, no UV mapping, no texture.
- No OpenCV: the milestone completes with browser decoding, MediaPipe and pure
  JS geometry.
- No segmentation compositing. Whether the pose model offered a mask is
  **recorded** (`segmentationAvailable`); no mask cleanup, feathering or
  compositing exists.
- No WebRTC: no call, no sender, no `replaceTrack`.
- No recording, no Supabase, no additional ML runtime.

## iPhone: NOT TESTED. Android: NOT TESTED.

No mobile device measurement exists for this milestone or the previous two. The
memory soak (image → change → image → video → cancel → video) is a
development-machine observation and is explicitly **not** an iOS memory proof.
