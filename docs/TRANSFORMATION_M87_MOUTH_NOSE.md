# M8.7 mouth, lips, jaw and nose

MOUTH MODULE: **READY FOR MANUAL ACCEPTANCE**

NOSE MODULE: **READY FOR MANUAL ACCEPTANCE**

EYE MODULE: **LOCKED BASELINE**, physically accepted by the user before this milestone.

The checked-out commit remains `11ac465`. M8.7 extends the existing dirty M8.6
baseline; it imports no other branch or workstation code. No M9, outer-head
geometry, renderer rewrite, tracker rewrite, commit or push is included.
MediaPipe remains the production tracker. Jeeliz 3.4.3/local assets/Tracker Lab
and disabled production hybrid flags are preserved.

## Implementation contract

The existing camera/scheduler/calibration flow owns inference. Mouth/nose consume
its latest face result, without another camera, tracker, queue or render loop.

- `mouthControls.ts` owns anatomical left/right jaw, lips, corner and shape
  controls. The existing five-pair aperture measurement is reused. Calibration
  adds median aperture, width, corner, chin, compression and shape neutrals;
  naturally parted lips stay neutral. No early averaging of sides.
- `mouthNoseLocalGeometry.ts` removes translation, aspect and the model's full
  rotation basis, including compound yaw/pitch/roll. Ratios cancel scale. It
  falls back to the existing canonical geometry when no usable matrix exists.
  The locked eye coordinate path remains unchanged.
- Canonical jaw uses the existing maximum-fusion principle: calibrated model
  jaw score, multi-point aperture and a bounded chin vote. Chin cannot overwhelm
  still lips. Jaw-induced smile leakage is gated by independent corner elevation.
- `mouthRegionDeformer.ts` precomputes bounded lip/corner/chin attachment fields.
  Lower lip and chin follow the jaw; upper lip moves less. A zero-gap source
  separates progressively. Pucker narrows/protrudes, funnel narrows/opens,
  EE stretches, press closes, and asymmetric upper/lower/corner fields combine.
  No original source UV or topology is changed. The cavity follows the actual
  outer contour. Source-visible teeth remain on the pinned source fill.
  Canonical mouth travel can open a closed seam beyond the older scalar pixel
  envelope; the legacy scalar envelope and eye controls remain unchanged.
- `noseControls.ts` and `noseRegionDeformer.ts` add only subtle independent wing
  motion. Bridge/tip/base anchors stay fixed under expressions; existing source
  depth and rigid renderer rotation supply head perspective. Missing sneer
  categories stay unsupported, never fabricated.
- Speech controls use a fast adaptive renderer filter (14 ms intentional,
  28 ms neutral); low confidence gets a finite 120 ms hold and 160 ms decay.
  Eye filtering, blink/gaze mapping and eye fields are unchanged. Existing
  smile/cheek contributions to lower lids are preserved exactly.
- Live interior remains optional. Only pixels inside the live inner contour
  are sampled, with a 1.5 pixel safety inset. A uniformly scaled texture plane
  preserves tooth aspect. The current deformed source inner contour clips it
  behind source lips; lower-lip travel reveals pixels rather than stretching
  teeth vertically. Opening hysteresis and 85 ms fade remain. Invalid/collapsed
  masks are rejected; results older than 250 ms fade away. No stale work queue.
- Developer-only Mouth/Nose Diagnostics show controls, confidence, missing
  signals, pose, compositor mask status/timing, opacity and A–S/nose/eye sequences.
  They do not appear in production UI.

## Validation evidence

Four passes: measurements, deformation/rendering, combined movement/stability,
then serial regression. Completed 2 October 2026, without concurrent heavy suites.

| Check | Result |
| --- | --- |
| pnpm typecheck | PASS |
| Focused mouth/nose + locked-eye units | 66 PASS |
| pnpm test | 828 PASS, 54 files |
| Full Transformation suite | 92/93 PASS initially; one slow-closure timing failure |
| Unchanged failing eye test, isolated repeats | 3/3 PASS |
| New M8.7 browser cases | 6/6 PASS in the full suite |
| pnpm test:e2e | 18 PASS |
| pnpm build | PASS |
| git diff --check | PASS |

The final preservation audit checked all 511 starting files: 502 remain
byte-identical, nine existing paths have planned regional/metadata edits, and
11 new paths implement/document/test M8.7. Dedicated eye implementation/tests,
the original M8.6 browser fixtures, Jeeliz assets/lab and the user's screenshot
edits remain byte-identical. Generated model/WASM path files were restored to
their exact starting bytes after the build's timestamp preparation. HEAD remains
`11ac465`; nothing was committed or pushed. The desktop Studio remains available
at `http://localhost:8443/admin/studio` (HTTP 200 verified).

The full suite ran all 93 cases (23.2 minutes). Its single failure was the
existing M8.6 staircase slow-closure fixture: a 0.10 closure jump over a
33.3 ms tracking interval sits exactly at the 3/s fast-blink threshold and
can latch closed. The unchanged case passed all three isolated repetitions.
No eye implementation, fixture, test assertion or threshold was modified to
hide the failure. Report this as timing-sensitive automation, not a clean
93/93 first-pass result or proof of physical slow-blink accuracy.

Desktop automation measurements (SwiftShader, not a hardware/device baseline):

| Measurement | Current-run observation |
| --- | --- |
| Camera / MediaPipe tracking FPS | 2.358 / 2.201, bounded portrait-camera sample |
| Frame age / face inference | 249.0 / 247.1 ms in that sample |
| Tracking dropped frames / stale summary polls | 2 / 0 in that sample |
| M8.7 renderer FPS / render time | 24.7 / 1.2 ms, scripted real-source test |
| Expression calculation | 0.6 ms in that renderer snapshot |
| Active mouth compositor | 1.8 ms snapshot |
| Dropped display frames | 82 in the scripted source/screenshot/stale-feed test |
| Deliberately stale live interior | Opacity 0, mask status stale |

Camera/tracker and renderer numbers come from separate fixtures. The existing
bounded hybrid regression also ran; no production flags changed. Its assistance
sample was slower (1.821 tracking FPS) and provided no reason to enable Jeeliz.

Focused unit fixtures cover local axes, multi-pair aperture, parted/asymmetric
neutral, jaw fusion/isolation, compound full-matrix rotation, filtering/recovery,
independent lip/corner fields, closed/parted source opening, pinned teeth/UVs,
subtle unilateral nose fields, rigid perspective and protected eyes/brows.

Browser fixtures exercise the real Studio scheduler/calibration with controlled
landmarks, mobile widths 320–430, real-photo source analysis/rendering, progressive
jaw and distinct shapes, physical head direction after the existing safe pose
envelope, live layer contour/depth matching, closure/stale fade, tooth aspect and
zero operator-skin leakage. A separately labelled synthetic closed source uses
a real face topology with a sealed seam; it proves opening cavity pixels and
coverage without claiming photographed hidden anatomy. Existing eye/color/glasses
fixtures and provider lifecycle tests remain part of the full regression.

Automated evidence is desktop Chromium/SwiftShader, with controlled expression
inputs and portrait/canvas camera fixtures. It is not a phone measurement or
physical speech/expression accuracy test. Physical mouth/nose acceptance remains
pending. iPhone: NOT TESTED. Android: NOT TESTED.

## Physical acceptance, approximately 3–4 minutes

1. Calibrate with relaxed lips. Use a closed-mouth source, then a source already
   showing teeth. Open slowly through small/medium/full and close; watch for
   progressive separation, stable source teeth and a filled cavity.
2. Press, kiss/pucker, O, EE; smile left, right, both, then smile with open jaw.
   Upper/lower lip motion should stay smooth; neutral opening should not smile.
3. Enable Live mouth interior, show teeth and tongue, close/hold, then reopen.
   Pixels must stay inside source lips with no operator skin or stretched teeth.
4. Turn each way and look up/down while opening and making O. Check attached
   nose tip/bridge and subtle left/right sneer if supported; jaw must not drag nose.
5. Quick locked-eye check: blink, each wink, wide eyes and gaze while turning.
   Repeat with glasses if available. Report any regression before accepting.

## Known limits

- A closed photograph contains no hidden source teeth/tongue; cavity shading or
  the explicitly enabled live interior supplies visibility, not reconstructed anatomy.
- Closed-source pixel automation uses a synthetic seam fixture; a real closed
  portrait and physical controller still need manual acceptance.
- Large openings stretch available lip/skin pixels; fine roll/tuck is deliberately subtle.
- Extreme source yaw/pitch remains constrained by the existing single-photo envelope.
- Unsupported or weak sneer/lip model signals remain unavailable or conservative.
- Static source teeth remain pinned; a photograph cannot reveal new source tongue motion.
- Legacy smile-to-cheek/lower-lid behavior is preserved; this milestone does not rebuild cheeks.
- Physical lighting, speech, glasses and mobile performance need the manual check.
- The existing staircase slow-closure browser fixture is timing-sensitive;
  initial full run failed it, but all three unchanged isolated reruns passed.

No automatic mouth/nose lock. Stop here and wait for the user's physical test.
