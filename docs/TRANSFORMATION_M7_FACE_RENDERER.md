# Milestone 7: face renderer preview

The Preview step draws one analysed source image into a fixed face-only mesh.
It reads the Studio's existing `CalibrationMotion` ref; it does not run
inference, change the camera loop, produce a media track or save a result. Three
is imported only after the operator opens **Face render**. The independent
camera/tracker remains usable if WebGL initialization fails or its context is
lost.

## Coordinates

| Space | Axes and units | Conversion |
| --- | --- | --- |
| Source landmarks | Normalised image coordinates; x right, y down; shallow relative z | Source UVs are prepared once. ImageBitmap preserves decoded row orientation in Three, so `v = y`; render-space vertex y is converted separately. |
| Live tracking | The unmirrored camera frame; x right, y down; normalised by neutral face width for translation | `computeRelativeMotion` already subtracts the calibrated neutral. Mirroring remains a display concern. |
| Calibration motion | Relative translation in face widths, scale ratio, and yaw/pitch/roll deltas in radians | `poseFromMotion` clamps requested values to the renderer and source movement envelopes. Tracking y is negated once to become render y. |
| Render world | Centred x-right/y-up space; orthographic camera looking along -z | The source mesh is built around its nose-centre. Only the mesh's global position, scale and rotation change per frame. |

The orthographic camera is deliberate: a single still does not provide enough
depth to justify a perspective camera. Source landmark z is retained at a
conservative depth scale for moderate yaw. The source landmarks, UVs and fixed
face topology are prepared once; no per-frame triangulation or facial vertex
deformation occurs.

## Ownership and limits

- `useSourceSelection` owns the source Blob and its object URL. The renderer
  decodes one `ImageBitmap` (or captures one frame from the existing source
  video preview) and closes that bitmap on disposal.
- The renderer owns its WebGL renderer, scene, orthographic camera, geometry,
  texture, materials, mesh and animation frame. Source changes and route unmount
  dispose these resources. Context loss reports a renderer failure while the
  camera and tracker remain available.
- The preview is explicitly labelled experimental and face-only. Hair, ears,
  shoulders, segmentation, expression deformation, video-angle switching,
  recording, output tracks and call/WebRTC integration are outside M7.
- Requested and applied pose values, clamp names, renderer rate, render time and
  dropped-frame count are visible beside the preview. Tracker diagnostics stay
  separate.

The conservative renderer limits are provisional. A phone with a real source
face and a person moving in front of the camera has not been tested in this
workspace; device validation remains **NOT TESTED**.
