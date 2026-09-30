# Milestone 8: facial expression transfer

## Data flow

The existing FaceTracker reports named MediaPipe blendshapes and normalized
landmarks. The Studio scheduler calls `computeExpressionMotion` once for each
face result. It writes the eight supported values to a ref beside the existing
global `CalibrationMotion` ref. The renderer reads both refs on its animation
frame. It does not run inference. A development slider supplies the same
`ExpressionMotion` contract when enabled.

The source analyzer records `SourceExpressionProfile` from the selected frame.
It contains eye opening, mouth opening, four expression scores, and limitations.
It is source appearance, never operator data. Its profile version and analysis
version are 2. Calibration version 2 records eight median neutral blendshape
scores from its short accepted window, along with the existing eye and mouth
openness. Calibration frames and landmark histories are discarded. A fresh
calibration changes only this operator reference; it does not require a new
source mesh or texture. Camera flip freezes the renderer until a new reference
is ready.

## Signals and coordinates

Named blendshapes drive left/right blink, jaw open, left/right smile, inner brow
up, and outer brow up left/right. Eye and lip distances divided by the feature
width are fallbacks when the matching semantic score is absent. Neutral scores
are subtracted and the positive range normalized. The model's expressions are
already solved in face space; the landmark fallback divides by local feature
width, removing translation and scale. The fallback is deliberately limited
for large yaw. No operator face shape is copied into the mesh.

Source image coordinates have x right and y down. The M7 local mesh has x
right and y up. The deformer moves source-local vertices before the M7 global
head transform. It never changes UVs or triangle indices. The fixed M7 oval
wedges are subdivided once when the renderer opens. The deformer precomputes
compact-support regional weights once and writes into the same position buffer
each frame. `DynamicDrawUsage` marks that buffer for upload. Mesh diagnostics
use the live position buffer in wireframe mode.

The region anchors use the Face Mesh's stable landmark indices: left eye
33/133/159/145, right eye 263/362/386/374, mouth corners 61/291, upper/lower
lip 13/14, chin 152, inner brow 107/336, outer brow 70/300, nose 1, cheeks
234/454. Only these selected points are used to configure source-local weights;
the source profile already carries its full source landmarks from preparation.
No live landmarks persist in calibration.

Blink pulls upper and lower eyelid regions toward each other with independent
weights. Jaw moves the lower mouth and chin together with soft falloff. Smile
lifts each corner and slightly widens it. Brow movement lifts only the brow
band. The nose and outer proportions retain the source shape. All requested
values are clamped to a source envelope. A closed-mouth source limits jaw
further because it has no inner-mouth pixels; a narrow eye similarly limits
blink. Existing smiles and raised brows reduce further range.

Expression smoothing has a 28 ms blink attack, 55 ms blink release, 45 ms jaw
constant, and 75 ms smile/brow constant. These are shorter than global head
motion smoothing. On tracking loss it holds for 130 ms and then eases toward
source neutral. The global face fade remains owned by the M7 renderer.

## Evidence and limits

Unit tests check neutral shape, independent wink, jaw and chin direction,
smile and brow locality, source clamps, responsive smoothing, UV immutability,
buffer reuse, and expression independence from head yaw. Browser tests capture
deterministic expression states and exercise an actual FaceTracker result through
the expression contract and renderer using the approved local portrait.

This is a geometric first pass. A closed-mouth source still looks closed when
the jaw stretches because teeth and mouth interior are absent. Blink compresses
existing eye pixels; it cannot reveal hidden eyelid skin and may look like a
narrowed eye rather than a natural full blink. Eyeglasses remain part of the
face texture and may warp. The source face oval still cuts off hair, ears, and
parts of the outer head. No upper body, compositing, OpenCV, or WebRTC work is
in this renderer.
