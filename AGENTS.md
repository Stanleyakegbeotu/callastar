# figma-make-app

CallaStar — a React + Vite + Tailwind CSS video call app running inside Figma Make.

## Development Server

A Vite development server is **already running** on `$PORT` (default 8443). You don't need to start it manually.

- Preview URL: The user can access the running app through the preview panel
- Hot reload: Changes to source files are reflected immediately
- The camera needs a secure context. `localhost` counts, so the dev server is fine; a deployed build needs HTTPS.

## Project Structure

This is the canonical project structure. Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `src/main.tsx` - React entrypoint; imports `src/styles/globals.css` and mounts `src/app/App.tsx` into the `#root` element
- `src/app/` - Shell: `App.tsx`, `router.tsx` (routes), `providers.tsx`
- `src/features/` - One folder per step of the flow: `onboarding`, `call-selection`, `join-call`, `call-session`, `support` (customer care), plus `admin` (the CRM workspace: `layout`, `overview`, `profiles`, `media`, `sessions`, `subscriptions`, `support`, `notifications`, `settings`, `components`, `hooks`, `auth`)
- `src/features/call-session/CallSessionRoute.tsx` - Owns the camera and microphone and renders the screen the session status calls for
- `src/features/call-session/hooks/` - `useLocalMedia` (devices), `useCallFlow` (connect/ring pacing), `useCallTimer`, `useRingbackTone` (the outgoing ring, synthesised), `useCallAccessGate` (the subscription checkpoint), `useMediaDevices`, `useCameraPermission`
- `src/state/` - `CallSessionContext.tsx` and `callSessionReducer.ts`: the typed call session, its actions and its allowed transitions
- `src/services/callBackend.ts` - How the public app resolves a Call ID and fetches remote media: `local`, `supabase` or `mock`, chosen by config and never by fallback
- `src/services/admin/sessionInsights.ts` - duration, metrics, status labels and timeline wording, defined once
- `src/services/admin/` - `repository.ts` (the `AdminRepository` seam), `localAdminRepository.ts` (IndexedDB engine), `supabaseAdminRepository.ts` (deliberately unimplemented), `indexeddb.ts`, `mediaFiles.ts`, `profileInsights.ts`, `types.ts`
- `src/services/subscriptions/`, `src/services/support/`, `src/services/notifications/`, `src/services/settings/` - the same seam pattern for plans and access grants, customer care, admin notifications and operator-editable settings. Each has a local IndexedDB implementation and a Supabase one that throws until it is connected
- `src/i18n/` - i18next setup, browser-language detection and the `en`/`es`/`fr`/`de`/`pt`/`it` locales. `en.ts` is the source of truth; every other locale is typed against it
- `src/services/media/mediaDevices.ts` - getUserMedia, constraints, error mapping
- `src/components/` - Presentational only: `ui/`, `branding/`, `layout/`, `call/`
- `src/types/` - `call.ts`, `media.ts`, `user.ts`, `host.ts`
- `src/lib/` - `config.ts` (modes, call timings, media and profile limits), `callId.ts` (generate/normalise/format), `avatar.ts` (initials mark), `constants.ts` (mock-mode demo host), `utils.ts`
- `src/styles/` - `globals.css` (entrypoint, Tailwind import, public component CSS), `admin.css` (the CRM workspace), `admin-crm.css` (subscriptions, customer care, notifications), `support.css` (post-call access and the chat), `tokens.css`, `safe-area.css`
- `src/assets/images.ts` - Approved Figma imagery
- `public/media/call-demo.mp4` - Demo clip, only used when `VITE_ENABLE_DEMO_VIDEO=true`
- `src/features/calls/` - Real-time internals shared by both sides of a call: `hooks/useRtcSession` (one peer connection, wired to signalling), `hooks/useOrientationGuard`, `components/` (`LiveCallCanvas`, `AudioCallCanvas`, `RtcVideo`, `CallOverlays`)
- `src/features/host-calls/` - The operator's side: `HostCallProvider` (global, above the admin routes), `HostCallSurface`, `state/hostCallReducer`, `components/` (incoming call, source selection, Live Calling card, presence badge)
- `src/services/signaling/` - `protocol.ts` (the typed wire protocol, shared verbatim with the service), `provider.ts` (the `SignalingProvider` seam), `websocketSignalingProvider.ts`, `callAuthorization.ts`, `hostCredentials.ts`
- `src/services/rtc/` - `RtcCallEngine` (offer/answer, trickle ICE, ICE restart, track replacement) and `rtcConfiguration.ts` (STUN/TURN from env, honest readiness reporting)
- `src/services/device/deviceCapability.ts` - Which device this is, for call-type gating only
- `src/services/videoSource/`, `src/services/media/mediaAssetProvider.ts` - How a host appears, and how a stored asset becomes playable
- `server/signaling/` - The WebSocket signalling service. Its own package; runs straight from TypeScript on Node 22
- `src/features/transformation/` - The Transformation Studio laboratory. `engine/` (face and pose trackers, the frame scheduler, the camera, coordinate mapping, the phase machine), `studio/` (the `/admin/studio` route, the overlay, guidance and diagnostics), `modelAssets.ts` and the generated paths
- `docs/` - `PHYSICAL_DEVICE_TESTING.md`, `REAL_DEVICE_CALL_QA.md`, `REMOTE_MEDIA_CONTRACT.md`, `TRANSFORMATION_ENGINE_FOUNDATION.md`, `TRANSFORMATION_STUDIO_TRACKING.md`, `TRANSFORMATION_STUDIO_CALIBRATION.md`, `TRANSFORMATION_STUDIO_SOURCE.md`, `TRANSFORMATION_RENDERER_DIRECTION.md`, `TRANSFORMATION_3D_AVATAR.md`
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `package.json` - Project dependencies and the Vite build, development, preview, typecheck, and formatting scripts
- `vite.config.ts` - Vite configuration with React, Tailwind CSS v4, and Figma Make plugins plus the `@` alias for `src`
- `.mise.toml` - Toolchain versions for Node.js and pnpm

## Architecture notes

- Screens render from `session.status`; they never sequence each other. New call behaviour belongs in the reducer or in `useCallFlow`, not in a `setTimeout` inside a screen.
- `useLocalMedia` is the only place that calls `getUserMedia`. Mute and camera toggles flip `track.enabled`; ending a call stops every track.
- Leaving the call flow is a navigation. The screen you arrive on clears the old session (`useClearStaleSession`) — resetting it inside a click handler races React Router's transition.
- Call lifecycle is persisted by `features/call-session/hooks/useSessionRecorder.ts`. Every write is keyed and remembered, so StrictMode and re-renders cannot duplicate a session or an event, and recording never blocks a call.
- Duration comes from `getCallDuration` in `services/admin/sessionInsights.ts` (`endedAt - connectedAt`). The visible timer is never the stored truth, and a call that never connected has no duration.
- The admin screens talk only to `AdminRepository`, never to IndexedDB or Supabase directly. Finishing `supabaseAdminRepository.ts` is the whole migration.
- Profiles own exactly one Call ID, zero or one avatar and zero or one remote video. Readiness and dashboard counts come from `profileInsights.ts` so no two screens can disagree.
- Multi-part writes (profile + asset + blob) happen in one IndexedDB transaction, and only IndexedDB promises are awaited inside it — awaiting anything else lets the transaction close mid-write.
- Media blobs are read by id, never while listing: profile lists and the media page use metadata only.
- Every `URL.createObjectURL` has a matching revoke, owned by the hook that made it (`useAssetUrl`, `useFilePreview`, `useRemoteVideo`).
- Local development only: `VITE_ADMIN_AUTH_MODE=development` is gated on `import.meta.env.DEV`, so it cannot ship as an auth bypass.
- There is no remote WebRTC peer yet: the remote participant is the video the admin uploaded for that profile, played from local storage once the call is active. An audio call plays the profile's uploaded audio instead, falling back to the video's soundtrack when it has none.
- The subscription checkpoint is a separate state machine from the call (`useCallAccessGate`), and the two only line up three ways: `checking` while the call is still `active` and its media still playing; `granted`, where nothing is shown; and `required`, which ENDS the call. Nothing pauses a call to check it, and a call that ends for want of a subscription is final — confirmation leads to a NEW call with a new id, media and history record.
- An access grant belongs to a customer, not to the call that asked for it: that call is already over by the time an admin confirms it. `claimAccess` spends one unclaimed grant on the next call the customer starts.
- Plan prices are global and editable, so every request snapshots the amount and plan name it was created with. Editing a price later must never rewrite what somebody was asked to pay.
- Customer care identifies people by email and nothing else — no code, no link, no verification. `resolveConversation` dedupes concurrent lookups per email, because "find one or create one" is read-then-write and would otherwise split somebody's history in two.
- The WhatsApp support number is operator-editable in Admin → Settings and read through `SettingsRepository`. Never read `SUPPORT.fallbackWhatsappNumber` from a component: that is the fresh-install fallback, and reaching for it directly would mean changing the number in the dashboard changed nothing.
- The onboarding brand mark carries a hidden five-tap shortcut to `/admin`. It is gated on `import.meta.env.DEV` *and* `VITE_ENABLE_DEV_ADMIN_SHORTCUT`, grants nothing of its own, and only starts the development session `AdminRoute` already accepts. A production build compiles it away.
- `body` scrolls normally. Only the screens that own the viewport — the live call, the audio call and the landing hero — opt out through `:has()`. Scrollbars are hidden everywhere; scrolling itself is untouched.
- The admin shell names its grid rows (`auto 1fr`) on mobile. A grid with `min-height: 100dvh` stretches implicit rows, which silently inflated the top bar to 240px on any page with little content.
- The self-view tile is draggable and snaps to one of four corners (`useDraggablePip`). A drag and a tap share one pointer, so they are told apart by distance — under 8px swaps the participants, over it moves the tile and the click that follows is suppressed. The bottom corners clear the control tray by construction.
- The remote is `object-fit: contain` once it is the main surface, over a blurred copy of the avatar. Filling the frame would crop a 16:9 clip to a vast centre zoom on a portrait phone.
- The three plans are drawn as a ladder: plain, tinted-and-badged, then solid navy. "Gold Access" is a product name — the top tier is deliberately not gold.
- `globals.css` imports the other stylesheets at the top, so its own rules win any equal-specificity contest with them. A rule in `support.css` or `access-tiers.css` that must override one in `globals.css` doubles its class (`.cs-sheet.access-panel-wide`, `.plan-card.plan-card-gold`) rather than relying on order.
- Prices are USD in every language. Localising an interface and converting a currency are separate decisions, and only the first has been made.

- Live calling is configuration, never a fallback. `VITE_SIGNALING_URL` unset means live calling is OFF and `useSimulatedCallFlow` drives the legacy pacing instead; the two paths are branched explicitly in `CallSessionRoute` and never mixed.
- Signalling carries call control and SDP/ICE. It never carries media, and the service holds no profile database: a host registers the Call ID it answers for, which is why an unregistered code and a code that was never real are indistinguishable from outside.
- A Call ID identifies a profile and is not a credential. A guest's authorisation is an ephemeral token scoped to one `callAttemptId` and one `callIdKey`, checked on every message.
- Profile **Active** and realtime **presence** are different questions. Active is an operator's setting that survives the browser closing; presence is a live socket that does not. Both are required to receive a call, and the UI shows them as two badges — one green dot for the pair is how somebody ends up ringing a profile nobody is behind.
- The guest is the impolite peer and the host is polite, fixed by role. Perfect negotiation then has no tie to break at runtime.
- `RtcCallEngine` owns the whole WebRTC protocol. No component calls `setLocalDescription`, `addIceCandidate` or touches an `RTCPeerConnection`; `useRtcSession` is the only consumer, and it buffers signals that arrive before the engine exists.
- Video calling is phone-only and portrait-only, enforced before any device is requested. Audio runs everywhere. `deviceCapability` reads the physical screen, never the viewport, so a narrowed desktop window stays a desktop.
- The orientation guard reports only. Turning a phone sideways puts an overlay over a call that keeps running — it never touches the peer connection, the tracks or the session.
- The host's source choice is per call and is never written to the profile. An audio call has no source to choose and goes straight from Answer to connecting.
- Uploaded Source cannot reach another device while assets live in IndexedDB. The service answers `storage_unreachable` rather than inventing a URL - see `docs/REMOTE_MEDIA_CONTRACT.md`. Live Camera is unaffected.
- The host signalling credential is gated on `import.meta.env.DEV`. A production bundle compiles it away, because a shared secret in public JavaScript would let a stranger register as any profile. `hostCredentials.ts` is the seam for server-issued operator tokens.
- Call diagnostics go through `lib/callDiagnostics.ts`, which is an allowlist: SDP, ICE candidates, tokens, playback URLs and caller contact details can never reach a log, and a production build emits nothing at all.
- The signalling HTTP endpoint needs the web app's origin in `SIGNALING_ALLOWED_ORIGINS`. A working WebSocket proves nothing about it — they are different mechanisms and only the HTTP one is subject to CORS.

- Transformation Studio tracks; it does not transform. Nothing it produces reaches a call, a source image or a recording, and it is not offered as a host source. See `docs/TRANSFORMATION_STUDIO_TRACKING.md` for what exists and what the two models actually cost.
- `TrackingScheduler` is the single owner of the frame loop and drives both models off one clock. A frame arriving while inference is running is counted and DROPPED, never queued: queueing builds latency that never recovers, and on a phone the preview ends up visibly behind the person in it.
- `coordinateMapping.ts` is the only place a normalised landmark becomes a screen pixel. Cover-crop, front-camera mirroring and device pixel ratio all live there. The video is mirrored in CSS and the landmarks are mirrored in display space by the same flag — doing it twice, or in the tracking frame, is how an overlay ends up correct on one axis and inverted on the other.
- The tracking frame is always the same aspect ratio as the camera frame, merely smaller. A differently shaped canvas would squash faces before the model saw them, and no mapping afterwards could undo it.
- `StudioCamera` is video-only and never touches the microphone; `useLocalMedia` owns the call's devices and is deliberately separate. A flip acquires the replacement before releasing the original, falls back to releasing first for phones that run one camera at a time, and restores the previous facing if both fail.
- The Studio requests the camera only from an explicit click, and only after the models are ready. Asking on route load would hold the camera light through a download somebody might cancel.
- The Studio overlay is drawn imperatively from the scheduler callback, not from React state. React sees a summary four times a second; 60 renders a second carrying 478 landmarks would cost more than the inference does.
- Pose inference costs roughly three times face inference, and tracking resolution barely changes either — MediaPipe resizes to its own input size internally. The quality presets are therefore about cadence, not frame size.
- Landmarks are never persisted, logged or transmitted, and nothing computes identity, embeddings or recognition. Calibration, when it arrives, is measurement — not model training.
- `playwright.transformation.config.ts` forces a SwiftShader rasteriser so the engine proofs are reproducible; nothing measured under it is a device baseline. `playwright.transformation-hardware.config.ts` forces no GL flags and prints the renderer beside every timing.
- Nothing drives motion from absolute landmarks. A resting pose is already slightly angled, so everything downstream reads deltas against a captured neutral — see `docs/TRANSFORMATION_STUDIO_CALIBRATION.md`.
- Calibration has its OWN state machine, separate from `TransformationPhase`. A calibration failure must leave the models, the camera and the loop exactly where they were, and never starts by itself: it is always an explicit operator action.
- A baseline is the MEDIAN of a short stable window, never one frame. Both a frame count and an elapsed time must be met, so neither assumes a frame rate, and the worst-moving quantity decides whether the operator held still — an average would let five steady axes hide one that was not.
- Scale is a RATIO against neutral, translation is divided by the neutral face or shoulder width, and the vertical axis is additionally divided by the tracking aspect. Nothing in calibration maths emits a pixel.
- Expression is passed through LIVE and is not neutralised the way head pose is. Subtracting a resting eye openness would make a narrow-eyed operator's ordinary face read as a permanent half-blink.
- A camera flip DROPS the calibration; a quality-mode change keeps it. Flipping changes mirror, optics and framing, while a preset changes only frame size and cadence and leaves the coordinate convention alone. Losing tracking for a moment keeps it too.
- A calibration profile holds aggregated geometry and nothing else. No frame history, no landmarks, no images, no embeddings, and it never leaves memory.
- Source analysis lives in `src/features/transformation/source/` and knows nothing about React. It needs no camera, no calibration and no signalling — a source is prepared independently, and a browser test asserts `getUserMedia` is never called during the whole flow.
- A source's media type comes from its BYTES, never its filename. `File.type` is filled from the extension on most platforms, so an MP4 renamed `.jpg` arrives claiming to be an image; size is then checked against the kind the bytes say it is.
- Source stills use MediaPipe IMAGE mode through dedicated wrappers, not the live VIDEO-mode trackers. IMAGE mode costs roughly 40x per inference because it cannot track from a previous frame — which is exactly right for seeks seconds apart, and is why sampling is capped.
- Video sampling is bounded at 20 frames whatever the duration, and deterministic. Setting `currentTime` does not mean a frame is ready: every seek waits for `seeked` and then for a presented frame, or the sampler analyses frame one twenty times and the bug looks like a video whose head never moves.
- The reference bank holds at most one frame per angle and never fabricates a missing one. Classification uses the documented yaw sign — positive yaw is the subject's LEFT — and holds timestamps and geometry, never pixels.
- Source quality claims nothing about blur or lighting, because neither is measured anywhere in this project. Product copy may suggest good lighting; analysis may not claim to have checked it.
- The source movement envelope is asymmetric and centred on the source's own pose: a photograph contains no information about a side of a head it never showed, so a source already turned one way has less room that way.
- `TransformationSourceProfile` and `TransformationCalibrationProfile` stay separate objects with separate lifetimes. The future renderer consumes both plus `CalibrationMotion`; merging them would make one object whose halves invalidate differently.
- Source analysis reuses `AdminRepository` for stored assets and adds no media-storage subsystem. A direct upload is temporary and never written to storage; a prepared profile is held in memory for the Studio visit.
- Head motion has exactly two sign decisions: MediaPipe → PHYSICAL in `engine/rigidFaceMotion.ts` (`RigidFaceMotion`: pitch + looking UP, y + up), and physical → Three in `engine/rendering/rendererMotion.ts`. MediaPipe pitch is positive looking DOWN — MEASURED by `transformation-m83-roundtrip.browser.spec.ts`, which renders the face nose-up and has MediaPipe read it back. M5–M8.2 assumed positive-up without measuring it; that one belief rendered every nod backwards, doubled a source's pitch instead of removing it, and let nods leak into brow geometry. Anything that needs "up" or "down" calls `physicalOrientation`, never reads raw pitch.
- The face renderer is GLUED to the camera preview (`rendering/faceFraming.ts`): at calibration it sits where, and as large as, the cover-cropped preview showed the operator's face, then moves by the calibrated deltas in neutral eye spans. The mesh pivots about its own 2D-bounds centre, because that is the point calibration measures. Only yaw and pitch are limited by the source photograph; translation, scale and roll reveal nothing it lacks and are not clamped by it.
- "Too close" is framing advice, never a tracking limit: nothing stops when it shows. An ordinary head-and-shoulders call measured an eye span of 0.23 of frame width, which the old 0.22 threshold called too close.
- `sourceMesh.ts` negates MediaPipe landmark z. MediaPipe z is smaller when closer, Three z is larger when closer — copied across unchanged the face is inside-out, and a concave face rotating one way is indistinguishable from a convex one rotating the other. That was the real cause of a device appearing to turn the wrong way.
- Mirroring is a DISPLAY decision, never baked into motion. `mirrorScaleX("selfie")` flips the scene for the Studio self-view so turning right looks like turning right; `"faithful"` is what a caller must receive. Baking it in would make the motion lie about which way somebody turned.
- Direction tests are named in physical language and assert where the face POINTS, via `faceDirectionVectors`. A test asserting `output === -input` only proves the code agrees with itself and stayed green through a device failure on two axes.
- Expression inputs are FUSED: each takes the larger of its blendshape and its landmark geometry. A present-but-near-zero blendshape used to suppress an expression entirely. Geometry is gated on a real mesh (>= 468 landmarks) because `eyeOpenness` returns 0 for both a closed eye and absent landmarks — absent is not a reading.
- Expression geometry (eyes, mouth, smile, brows) is measured on landmarks canonicalised by `faceLocalGeometry.ts`, never in camera space. Brows once had no geometric input because a camera-space measure read every nod as a raise; face-local it does not, and `m82Isolation.test.ts` pins nod-versus-raise independence. `leakage` only reports a blendshape riding a nod — it never corrects one.
- The source mesh is the fixed 468-point MediaPipe tessellation plus two mouth fans: a pinned FILL over the inner-lip ring, textured from the source, and a dark untextured CAVITY over the outer-lip ring that opens with the jaw. The tessellation alone leaves the mouth open, and a smiling source then showed the canvas where its teeth were. The cavity is shading, not teeth or a tongue.
- The source expression envelope limits what the source PIXELS cannot support, not what the source already shows. Only a closed mouth is a real limit; an already-smiling photograph has every pixel needed to smile further.
- Expression amplitudes are per-region fractions of measured anatomy, tuned from measurement. `transformation-expression-trace.browser.spec.ts` asserts a floor of 8px of mesh movement — 1 to 7px was invisible on a device while the numbers looked fine.
- `src/features/transformation/avatar/` is the EXPERIMENTAL 3D model source, beside image and video rather than replacing either. The renderer never sees a MediaPipe result: `AvatarMotion` and `AvatarRigAdapter` stand between them. See `docs/TRANSFORMATION_3D_AVATAR.md`.
- The avatar takes its signs from `rendererMotion.ts`, the same function the face renderer uses. It does not own a copy — a second one would recreate the scattered-negation bug that layer exists to prevent, and a test asserts the two have not drifted.
- The avatar renderer reads motion through a GETTER on a ref object, so it is sampled once per frame inside the renderer's own loop. A stored value would need something writing it, and that something would be a duplicate render loop.
- A model's rig class is measured, never assumed: `rigged-facial`, `rigged-head` or `static`. A static model cannot blink and the UI says so — claiming otherwise sends an operator hunting a tracking fault that does not exist.
- Morph names have no standard, so matching is by normalised alias with side suffixes handled separately. One morph per expression per mesh (two would shut an eye through the skull), a sideless `blink` matches neither eye, and influences are written to EVERY mesh carrying a morph because a head is split into face, eyes, teeth and brows.
- The head pivot is the head bone where one exists, the head mesh's bounds otherwise, and the scene centre only as a last resort — recorded so a wrong pivot is diagnosable. `HeadTop_End` is excluded: rotating about the crown reads as a nod from the forehead.
- `disposeAvatarScene` must run on every path that drops a model. GPU memory is not collected on scene removal, and a model swapped a few times without it will exhaust a phone.
- `.admin-visually-hidden` is absolutely positioned, so any horizontally scrolling strip containing it needs `position: relative` on the item. Without it the span escapes the strip's clipping and extends `document.documentElement.scrollWidth` — which Chromium hides behind `html { overflow-x: clip }` and older iOS Safari does not, so a real phone drags while every automated check passes.

## Dependencies

- Runtime: React 19, React DOM 19, React Router 7
- Localisation: i18next and react-i18next
- Styling: Tailwind CSS v4 with the `@tailwindcss/vite` plugin
- Build tooling: Vite 8, TypeScript 5.7, and `@vitejs/plugin-react`
- Formatting: oxfmt
- Testing: Vitest (unit and service integration) and Playwright (two-context browser flows), both development-only

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin configured in `vite.config.ts`. `src/styles/globals.css` imports Tailwind with `@import 'tailwindcss';`, then the design tokens and the safe-area tokens. Because the stylesheet is not at the `src` root, it declares `@source "../"` so Tailwind still scans the components for utility classes. This scaffold does not need a Tailwind config file or PostCSS config.

`src/main.tsx` imports `src/styles/globals.css`, so global font wiring belongs there. Keep CSS `@import` statements first, then add any `@font-face` rules and font-family defaults.

Use the safe-area tokens (`var(--safe-top)`, `var(--safe-bottom)`, …) rather than bare `env(safe-area-inset-*)`, and never hard-code a device inset.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export components as default exports.
- Run `pnpm typecheck`, `pnpm test` and `pnpm build` before calling a change done. `pnpm test:e2e` runs the browser suites and starts its own servers on ports 5199 and 8793.
