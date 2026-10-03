# Deep-Live-Cam blend reference study

**Study scope:** local checkouts at `C:\AI\Deep-Live-Cam` and `C:\Users\hp\Projects\callastar`, read before changing CallaStar. The Deep-Live-Cam checkout includes local additions (including its affine-locked paste-back and Poisson path), so this report describes the inspected checkout, not every upstream release or fork. No screenshots or live-camera frames were available; appearance findings below are based on renderer/compositor code. Physical edge quality cannot be certified from code alone.

## 1. Deep-Live-Cam face paste-back

The inspected face-swap path calls InsightFace's swapper with `paste_back=False`, receiving the generated face image `bgr_fake` and the affine `M` returned for target alignment (`modules/processors/frame/face_swapper.py`, `swap_face`). The normal swap model's aligned input is square and the local code asserts that the supplied alpha-template size is square; its comment identifies the current INSwapper input as **128 × 128**. It does not resize `bgr_fake` in `_fast_paste_back`.

`M` maps original-frame coordinates into the aligned crop. Paste-back inverts it with `cv2.invertAffineTransform(M)`, maps the four aligned-square corners to obtain a bounded output crop, adjusts the inverse transform to crop-local coordinates, then warps both `bgr_fake` and the alpha template through that same inverse transform. `cv2.warpAffine` uses linear interpolation for the image and mask; the mask uses a zero border and the image uses replicated borders. Only the output crop is composited.

The regular alpha is a cached, fixed ellipse in aligned-face coordinates: center `(size/2, size/2)`, axes about `0.44 × size` in each direction, filled to 255 and blurred with a 31 × 31 Gaussian kernel at sigma 12. At 128px that is roughly a 24%-of-face-width kernel and sigma 9.4% of face width. Its exact softness in the output frame scales with the affine transform. The ellipse is neither a target-landmark hull nor source/target face geometry; it is a fixed mask template placed by the *same* transform that places the generated face. This guarantees mask and face placement share scale, rotation, translation and per-frame jitter. The crop bounds add only a 2px interpolation margin.

The optional Poisson path likewise prefers a mask created in aligned-face space and transformed by the same inverse affine into the target ROI. It thresholds that warped mask, erodes it by a kernel based on the output ROI's shorter dimension, then sends the swapped frame, original frame, mask and center to `cv2.seamlessClone(..., NORMAL_CLONE)`. It falls back to a bbox ellipse only if affine-based setup fails or is unavailable. The fallback adds 10% bbox padding and caches a mask while the bbox-derived center/radii remain identical.

## 2. Mask and edge architecture

The ordinary paste-back mask is a fixed blurred ellipse, not a landmark-dependent facial oval. Its edge softens the rectangular crop and the four corners, but it can omit forehead/temple/jaw regions because its shape is fixed. It uses target placement through `M` but not target semantic facial contours. It changes pixels inside the ellipse through alpha compositing and leaves pixels outside it untouched.

The optional `create_face_mask` used by the mouth restoration path is a separate mask. It uses target-face 106-point landmarks 0–32, extends eyebrow points upward by the chin-to-brow distance, broadens those forehead points by 20%, takes their convex hull, and Gaussian-blurs with a default 31 × 31 kernel. That is target-landmark-dependent, broader than a central face oval, and used to attenuate the *mouth restoration*, not to place the main swapped face. Its edge scale is fixed in output pixels, unlike the affine-scaled primary alpha.

General principle: defining a mask in the transformed object's local coordinate system and applying the object's placement transform to both means their edges cannot drift independently. In CallaStar's 3D mesh renderer, the analogous implementation is per-vertex coverage attached to the same source mesh positions and scene transform, not a second tracker or a separately drawn screen-space oval.

## 3. Mouth Mask behavior (enabled separately)

Mouth masking is optional (off by default in `modules/globals.py`). When enabled, the analyser requests 106-point landmarks. The swapper takes the target/live face's outer-lip landmarks 52–63 in index order, validates them, and scales the polygon around its centroid according to a 0–100 size slider. At maximum, its X and baseline Y scale reach 3×, with additional downward scaling for points below the centroid; it then adds 10% padding to the bounding box. It does not split upper and lower lips, track lip expression independently, or segment teeth/tongue/cavity.

The pixels in that live-frame ROI are copied before the swap. After face paste-back, the polygon is rasterized in the ROI and Gaussian-feathered with a kernel derived from one eighth of the smaller ROI dimension, clamped to a feather amount of 1–30px. The restoration formula is `live_cutout * mask + swapped_roi * (1-mask)`. The polygon and cutout both stay in target-frame coordinates, so the mouth follows the target landmarks; the option is not warped with the swapper affine. Although `apply_mouth_area` accepts a blurred full-face mask argument, inspection shows it only checks that argument for validity and does not use it in compositing. The operative restoration mask is the expanded lip polygon alone. The debug option shows polygon and bounding box, not a mask-only view.

This preserves a target mouth region when requested; it does **not** amount to independent lip-expression tracking. There are no separate upper/lower lip controls, no jaw reconstruction, no teeth/tongue layers, and no oral semantic segmentation in this path. A feathered polygon can still include external lips and nearby skin, especially at large slider values.

## 4. Edge, color, opacity and Poisson paths

| Path | Inputs and output | Cost | Advantage | Failure mode |
|---|---|---|---|---|
| Standard soft-alpha paste-back | 128px aligned swap, inverse affine, cached blurred ellipse, target crop → alpha composite in bounded ROI | Two ROI affine warps and a fused per-pixel blend; no neural pass beyond swapper | Continuous mask-placement lock, soft corner and edge, crop-bounded work | Fixed ellipse may not fit target face/hairline/jaw; cannot correct color, light, texture or shape mismatch |
| Opacity option | Original full frame and completed swapped frame → `original*(1-opacity)+swap*opacity` | Extra full-frame weighted blend and original-frame copy when opacity < 1 | Simple way to reduce overall swap strength | Uniformly reintroduces the live face everywhere, including features and mouth; does not specifically fix an edge seam |
| Poisson option | Swap, original frame, affine-aligned elliptical mask → `seamlessClone` result copied within mask | Much more costly than alpha compositing; solve scales with cloned ROI and is repeated per frame | Gradient-domain blend can reconcile boundary illumination while preserving target-frame gradients | Can distort/recolor source appearance, produce halos or texture transfer, fail at frame borders, and still does not solve alignment; local affine path erodes the mask before cloning |
| Color correction | The checked-out `face_swapper.py` LAB mean/stddev helper is not called by the active swap path. A second LAB transfer exists inside `face_masking.py`'s `apply_mask_area`, but that module is not in the allowed frame-processor registry. The UI's “Fix Blueish Cam” toggle is read by capture/prediction code for channel conversion; it is not an active face-skin harmonizer. | The unused full-region helper would convert/measure/convert each ROI; the active toggle adds frame conversion at capture/prediction stages | No measured skin-edge advantage in the active paste-back path | No explicit skin-region color transfer or boundary luminance match is applied to the swapped face in the active path. The dormant helper uses whole ROI statistics and could shift texture/color broadly if wired in. |

The standard mask is Gaussian-feathered. Poisson compositing modifies gradients inside its mask and surrounding pixel values can influence the solution; standard alpha compositing samples the current target only per output pixel in the ROI. The active live face-swap path has no explicit local skin-tone match or live edge-band color/luminance matching. `face_masking.py` contains dormant polygon restoration/color-transfer utilities, but it is not a registered frame processor in this checkout.

## 5. Temporal behavior and observed boundary risks

The preferred paste-back mask is deterministic in aligned coordinates and follows the exact current swap affine. That removes an independent mask detector as a source of relative jitter, but the target affine itself still changes as tracking/alignment changes. The Poisson path explicitly avoids EMA/smoothing of its mask. Opacity has no temporal adaptation in `swap_face`. A separate optional post-processing path blends each processed frame with the previous processed frame using a global weight (default 0.2 for the current frame); this smooths the whole image, including expression motion, rather than stabilizing only the mask or appearance estimates. Optional sharpening also applies to the detected swapped-face bounding box, not specifically to the transition band. Neither is a boundary-local adaptive correction.

The affine-locked ellipse is the strongest anti-detachment choice in the inspected DLC compositor. It is not a semantic head mask: it may feather into hair/background near the top or leave target skin uncovered around a different jaw/forehead shape. The optional landmark hull is a different subsystem and must not be confused with the normal swap mask.

CallaStar's existing `FaceRenderer` draws a textured triangular source-face surface over the camera on a transparent WebGL canvas. Its source mesh has a fixed 468-vertex face topology and source UVs; the mesh is moved, scaled, rotated, expression-deformed and rendered with fully opaque texture coverage (`MeshBasicMaterial` with `transparent: true`, but no edge alpha). Thus the code has a hard geometric silhouette at the mesh perimeter. A mismatched perimeter, source/live color or sharpness, and projection mismatch during pose can make a patch-like edge plausible causes. Without camera samples or screenshots, actual color, focus and visible seam contributions are unmeasured, and no claim is made that a particular cause has been visually confirmed.

## 6. CallaStar comparison: mouth and expression

CallaStar already implements an explicit 468-point deforming source mesh, expression-envelope clamping, live expression deformation and gaze UV warping. Its mouth system includes separate inner/outer lip rings, source-pixel aperture fill, a moving shaded cavity, jaw/lip deformation channels, and optional live oral-interior sampling fitted to the inner-lip ring. The source lips remain the source identity; live oral content is drawn as an interior layer with its own enable/freshness/validity checks. Existing mouth and facial geometry share the same render mesh and current pose/deformation update.

These provide substantially richer expression geometry and occlusion than DLC's optional live-mouth restoration. CallaStar should keep that tracking, source identity, and oral layering. The mouth patching idea worth borrowing is the separation of a region that follows the live mouth from the rest of the swapped face, but it should remain an optional oral-interior feed; it is not a replacement for CallaStar lip/jaw tracking. Phase A must not modify mouth code.

## 7. Independent CallaStar design choices

1. **Selected for Phase A:** derive a soft coverage ramp from the existing face mesh topology and store it with the mesh vertices. Apply it through the same textured face material and current mesh transform. Boundary weight is 0, followed by four inward vertex rings at 0.2, 0.48, 0.76, and 1.0. Since vertex positions deform and transform together, the boundary coverage follows the rendered face geometry exactly.
2. **Later, not in Phase A:** sample source and live skin in small semantic boundary bands, use robust bounded luminance/chroma adjustments with a spatial falloff, and slowly adapt appearance estimates. Restrict any texture/sharpness correction to the transition band. Keep source landmarks, wrinkles and pigmentation intact.
3. **Later, only after comparison:** derive pose-aware asymmetric edge weights from the current mesh's pose/visibility and compare them under yaw; do not infer near/far from an unrelated tracker.
4. **Diagnostics:** render source-only, mask-only, boundary-band and final composite modes; visualize live/source sample locations and mouth coverage. Keep diagnostics developer-only and use the same live frame for all views.

The same rendered mesh frame must supply positions, mask weights and composite. Appearance adaptation can be slow and bounded; facial expression motion must remain immediate.

## 8. Concepts rejected or deferred

- **Rejected:** transplanting any Deep-Live-Cam code or adding its neural swapper/dependency to CallaStar.
- **Rejected for Phase A:** Poisson blending every frame; it is a costly CPU/GPU image-space solve, can alter source gradients and is poorly matched to a real-time WebGL mesh.
- **Rejected for Phase A:** global opacity as an edge remedy; it weakens the entire identity and feature render.
- **Rejected:** copying the operator's external lips as the default expression mechanism; it conflicts with CallaStar's source-lip identity and explicit expression controls.
- **Deferred:** full-face LAB mean/variance transfer, whole-face relighting, beauty smoothing, global sharpening, hair/neck replacement, and yaw-specific hand-tuned asymmetry. They risk source texture and identity or need physical comparisons first.

## 9. Performance implications

The Phase A mask adds one small static vertex attribute and one per-vertex interpolation already handled by WebGL; it adds no frame-sized CPU image operations, tracking model, neural dependency or extra render pass. Existing mesh position/deformation upload and draw remain the dominant costs. Bounded skin statistics, if later used, should sample only a small boundary set and avoid a full-frame readback. Poisson blending and full-frame color transfer have materially higher per-frame costs than this mesh coverage ramp.

## 10. Licensing

The inspected Deep-Live-Cam `LICENSE` is GNU AGPL version 3. No Deep-Live-Cam source code has been copied into CallaStar. The implementation here uses the general graphics principle of geometry-locked soft coverage, expressed in CallaStar's existing mesh/Three.js architecture. This report describes observed behavior and mathematical concepts rather than reproducing implementation text. Keep the CallaStar implementation independent and review project licensing separately before distributing combined works.

## 11. Small milestones

- **Phase A — face-boundary coverage and geometry lock (implemented):** topology-derived alpha on the existing face mesh, moved/deformed with the source surface. Physical acceptance remains pending.
- **Phase B — skin/luminance boundary harmonization:** local skin-band measurements, bounded spatial correction, slow adaptation; compare young and textured/older sources.
- **Phase C — mouth-edge refinement:** inspect lips/commissures and oral interior under open/closed speech; preserve CallaStar expression controls and interior-only transfer.
- **Phase D — yaw-aware boundary behavior:** compare near/far contour coverage against front and turned poses before introducing asymmetry.
- **Phase E — temporal stabilization:** smooth only appearance parameters and blend-width changes, never expression motion.

Do not begin Phase B until Phase A receives physical review.
