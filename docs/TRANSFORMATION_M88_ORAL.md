# M8.8 lip/interior/nose correction baseline

Current checkout: `main`, HEAD `11ac465`. The accepted M8.6 eyes and working
M8.7 progressive jaw are the starting baseline. No M9, tracker replacement,
renderer rewrite, commit or push. Physical M8.8 acceptance is pending.

## Findings and changes

The M8.7 GPU could display teeth/tongue when explicitly enabled with a large,
fresh camera aperture. Its Studio control defaulted OFF. A fixed 1.5 camera
pixel inset could erase a narrow tooth/tongue strip. Its compositor also sampled
the latest video using an older inference polygon, and width-only atlas mapping
could clip the low tongue when the source aperture was shorter than the live one.
These are demonstrated mechanisms, not a claim to have diagnosed every frame of
the user's physical recording.

- AUTO is now the Studio default. SOURCE retains the photograph. LIVE uses the
  camera interior while open. AUTO preserves the source's neutral visible
  aperture and switches to live beyond that aperture; it does not claim to
  semantically recognize good source teeth. Use LIVE for an already-open source
  if you want camera tongue motion at the same aperture.
- One reusable, transient canvas copies the exact inference frame only for an
  enabled face preview and each new face result. No additional inference,
  camera, queue, storage, network transfer or frame history. Camera downscaling
  and eye inputs remain unchanged. The buffer is cleared at runtime teardown.
- The safety inset is 0.5–0.65 camera pixels. A minimum half-pixel prevents
  nearest-sampling exterior bleed; apertures below a one-pixel radius are
  unusable. Equal fractional insets preserve texture aspect. The six-pixel
  aperture fixture retains both small strips without leaking exterior pixels.
- Mouth atlas mapping removes image roll in pixel space. Current source lip
  width, upper lip and aperture drive UVs. Tall interiors fit uniformly in a
  shorter source aperture, retaining tooth aspect and the inside tongue; empty
  side regions reveal the existing cavity. No artificial teeth or recoloring.
- Uniform mappings use one clipped draw, avoiding fan seams. Small camera tooth
  strips use nearest sampling into the atlas; the displayed GL texture still
  uses linear filtering. No luminance crushing or brightness synthesis.
- Pucker/funnel now apply full measured lip-ring narrowing rather than the weak
  generic falloff at corners. Source vermilion rounds and protrudes while jaw,
  smile and stretch remain independent. Independent upper/lower lip strips use
  head-local geometry alongside blendshapes; lower strips reference the chin to
  remove jaw travel. Calibration's existing median capture includes these
  scalar measurements without changing any eye calibration.
- Two small source-measured 3D nostril recesses retain real nose depth and follow
  the existing head transform. Upward pitch reveals their shaded underside;
  downward pitch conceals it. Bridge/tip/source mesh are never rewritten. The
  existing source-safe global pitch envelope remains; diagnostics expose its
  requested and applied pitch. Frontal imagery cannot supply hidden anatomy.

Developer diagnostics use the existing throttled UI, with 4 Hz pixel readback
only in DEV. They show canonical geometry, raw model availability, mask/crop
bounds, area, warped pixels, mean luminance, estimated light tooth pixels,
activation, opacity, age, clock stamps, distinct rejected stale results and
compositor cost. Raw missing model channels explicitly read unavailable.
Camera/result/controls timestamps use media time with paired pixels. Completion
age/render timestamps use `performance.now()`. Do not subtract different clocks.
Canonical oral data expires after 400 ms and fades promptly. Legacy unclocked
scalar-only renderer inputs retain compatibility; Studio always supplies time.

## Tongue protrusion: DEFERRED — SEGMENTER REQUIRED

FaceLandmarker supplies lips, not a tongue skeleton. The installed OpenCV
runtime supplies image processing, but no tongue semantic segmenter. Pink
chroma, connected regions and motion cannot reliably separate matching tongue,
lip and skin pixels across lighting and makeup. No labeled physical protrusion
recording was available to validate an extended mask. The bounded investigation
therefore ends with an inactive `TongueSegmenter` interface instead of enabling
a brittle color crop or loading another large model.

The interface defines a transient camera-resolution alpha mask, frame time and
confidence. Admission tests reject uncertain/stale masks, oversized regions and
pixels beyond a tight oral envelope. These tests prove the future admission
contract, not a working protrusion renderer. Production has no segmenter and
never extends the live mask. Inside-mouth tongue pixels move naturally with
the real camera feed. No protrusion or outside-lip movement is claimed.

## Regression lock

The corrected oral mechanics are protected by `m88OralRegression.test.ts`,
M8.7 mouth/nose regressions and `transformation-m88-oral.browser.spec.ts`.
The browser tests inspect actual WebGL tooth/tongue pixels of a synthetic closed
source over real inferred source geometry, under yaw/pitch, plus closure,
freshness and forbidden exterior pixels. A six-pixel camera aperture checks
small strips and inside tongue movement. Real Studio coverage verifies paired
pixels, AUTO/mode lifecycle, buffer teardown and phone viewport widths.

LOCKED AUTOMATED BASELINE: future region work must preserve these contracts.
DEVICE ACCEPTANCE PENDING: synthetic mechanics and software GL are not phone
quality evidence. The M8.6 eye files, fixtures and tests remain byte-identical.

## Three-minute physical check

1. Prepare a closed-mouth source, start/calibrate, choose Face render and AUTO.
   Open/close progressively; make a kiss, O, EE, press, and smile each side/both.
2. Choose LIVE. Show upper/lower teeth, then move tongue inside the aperture
   left/right. Close lips: interior disappears. Check for external skin leakage.
   Protrusion is deferred; do not expect outside-lip tongue motion.
3. Repeat open mouth/teeth while turning and nodding. Look strongly up/down,
   checking nose attachment/underside. Finish with blink, wink and gaze each way.

Record a short physical clip, source choice, interior mode and lighting. No
following milestone starts before the user's physical result.

## Validation record

Validation ran serially: typecheck PASS; focused units 87/87; full units 849/849
(55 files); focused browser suite 11/11; full Transformation run 95/96. Its one
failure was a 320px cached text-box overflow in collapsed oral disclosures.
Scoped oral CSS fixed it without changing the existing assertion. The unchanged
preview test and all three M8.8 cases subsequently passed (4/4), including the
stronger collapsed/expanded bounds checks. The unrelated 95 cases were not
rerun after this CSS-only repair. E2E 18/18; production build PASS; final
typecheck PASS; `git diff --check` PASS. Developer oral diagnostics are absent
from the production bundle.

DESKTOP AUTOMATION, Chromium ANGLE/SwiftShader, not hardware/phone performance:
the face-only primary sample measured camera/tracking 2.229 fps, frame age
245.025 ms, face inference 242.292 ms, zero dropped tracking frames and zero
stale summary polls. The real Studio snapshot with both models and the renderer
showed camera 3 fps / tracking 2 fps (UI rounded), renderer 3.529 fps, frame age
106.1 ms, face inference 234.8 ms / pose inference 833.1 ms, 5 skipped input
frames, zero dropped tracking frames, 14 dropped display frames and zero rejected
stale oral results at that sample. Scripted portrait rendering measured 41.260
fps; active oral warp samples measured about 0.1–0.2 ms. Scripted renderer
timings exclude real model cost. Deliberate stale-input tests expired the oral
feed; they are not physical face-loss measurements.

PHYSICAL DEVICE: iPhone and Android NOT TESTED. Mouth opening remains the
previously user-accepted baseline; lip/interior/nose visual acceptance still
requires the user's new recording. Protruding tongue and outside-lip movement
are DEFERRED. Automated skin-leak, depth, jaw/nose isolation and eye checks pass
within their fixtures, without claiming phone acceptance.

The final preservation audit checks the existing dirty checkout, dedicated
eyes, calibration, expression measurements, runtime eye block, jaw opening term,
Jeeliz assets and user screenshot bytes. Build-only generated timestamps are
restored to their exact pre-milestone bytes. No commit, push or next milestone.
