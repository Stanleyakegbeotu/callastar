# Controlled-use Call IDs: implementation and validation

Date: 20 October 2026. Source changes remain uncommitted. The user subsequently authorized the prepared Supabase update, which was applied to the existing project. No new Supabase project, hosting deployment, commit, or push was performed.

## Critical correction: callable Free source sessions

This section supersedes the earlier activation-time accounting and universal operator-presence requirement recorded below.

**Root cause of Free mode unavailable:** availability and mode were already independent in storage (`hosts.status` versus `hosts.profile_mode`). With signaling configured, every video call entered live-operator authorization. An active profile with an uploaded source but no registered operator therefore received the live-call “Currently unavailable” outcome. Free mode did not change the availability field. The prior DNS repair exposed this separate presence blocker.

**Correction:** source delivery is now explicit and independent of monetization. The resolver identifies selected-source profiles with `callDelivery: source_video`. Free and Premium source calls use server ticket authorization, the existing permission explainer, Connecting/Ringing establishment stages, the selected host source in the main canvas, and the original caller camera stream in PiP. They do not attempt live-operator authorization or require Receive Calls. Actual live camera/audio calls retain operator-presence checks. A signaling failure never selects a different delivery path.

**Completion authority:** new video reservations snapshot the selected asset ID and duration. Private media signing uses that snapshot. Activation holds a slot and leaves `use_count` unchanged. The main host video's real `ended` callback sends `SOURCE_VIDEO_ENDED` through the ordered lifecycle writer; the successful ending waits for the server transaction. That transaction consumes one use, updates the audit/counter, and rotates only upon exhaustion. Repeated completion writes are idempotent. The short finalizing delay controls presentation after persistence; it never determines video duration or consumption.

Active reservations remain in the capacity calculation. A 20-second renewal extends the three-minute lease while connecting/ringing/playing; expired leases cannot be revived or consumed. Early hangup, decline, timeout, media failure and technical failure release unconsumed capacity, including after activation. Premium bonus and paid reservations are also released on unsuccessful source calls; the bonus is consumed at successful source completion. Free authorization does not read or mutate the Premium bonus ledger. Existing already-consumed sessions and audio/live accounting are preserved.

Exhausted Free IDs display: **This Call ID is no longer available.** / **This free Call ID has reached its allowed call limit.** / **Ask the host for a new Call ID to make another call.** Actions remain Enter Another Call ID, Customer Care and Back Home. No package gate appears for Free calls or exhausted Free IDs. Capacity contention has its own `CALL_ID_TEMPORARILY_RESERVED` outcome; inactive profiles, retired IDs, exhausted IDs, missing sources and Premium eligibility remain distinct.

The existing admin refresh refetches visible profiles every 30 seconds and on focus/visibility return. Current counter and automatically rotated ID update without regenerating another ticket. Source calls also qualify for the existing private evidence capture, using the rendered source plus camera PiP; capture errors cannot spend a use or interrupt a call.

Current correction files:

- `supabase/migrations/20261020120000_source_completion_tickets.sql`: source snapshots/delivery, begin/transition authority and scoped renewal. The already-applied migration is untouched.
- Existing Edge handlers: `resolve-call-id`, `get-public-profile`, `start-call-session`, `update-call-session`, `get-session-media`, `begin-call-evidence`.
- Routing/mapping: `CallSessionRoute.tsx`, `JoinCallForm.tsx`, `HostPreview`, `callBackend.ts`, access/public-profile mappings and the unavailable screen.
- Lifecycle/evidence: `useSessionRecorder`, `useSourceCompletion`, establishment pacing and existing evidence eligibility/composition.
- Regressions: PostgreSQL ticket tests, scoped media tests, evidence completion/proof tests, Chromium/WebKit ticket flows with an unreachable signaling endpoint, and `supabase/tests/source_completion.sql` (hosted assertions with rollback).

Evidence compatibility: `begin-call-evidence` uses the authenticated session's original ticket even if completion has exhausted or retired that ticket. It still requires the matching session token, host and ticket; an unrelated replacement ticket cannot be substituted. A late evidence save therefore does not require an active Call ID and does not authorize another call.

### Correction validation

The browser regressions explicitly configure unreachable signaling (`ws://127.0.0.1:1`) while resolving an active Free source profile. They verify playback, no signaling authorization request, camera preparation, and zero completed uses during playback. Chromium decodes a synthetic caller camera track in PiP. WebKit lacks canvas stream capture in this runner, so its device fixture is an empty stream: WebKit verifies the PiP container and actual host source playback, while Chromium verifies decoded PiP video. Physical-device permission dialogs and camera hardware remain manual validation.

The full 28-case Chromium/WebKit ticket suite completed 27 cases successfully; a test-file edit caused a dev-server reload during the remaining WebKit paid case. After the final build with files stable, all four focused Free/paid completion cases passed, including that interrupted case. All 28 distinct ticket cases are verified. A separate real two-context Chromium call passed live camera negotiation, decoded media, evidence capture/review and hangup. Its initial run was interrupted by trace HTML files inside Vite's watched workspace; rerunning with artifacts outside the workspace passed.

Hosted verification used the actual applied SQL. `supabase/tests/source_completion.sql` passed 1/2/3/5 limits, unchanged usage during activation, failed-call release, renewal, idempotent completion, exhaustion, replacement and old-ID rejection. Every fixture in that script was rolled back. A separate temporary fixture verified the deployed public-profile and Call ID responses (`free`, `active`, `source_video`, `VALID_FREE_CALL`). Two simultaneous HTTPS `start-call-session` requests produced exactly one authorized reservation and one `CALL_ID_TEMPORARILY_RESERVED`; server checks then verified active capacity protection and release/retry after early hangup. An attempted concurrent CLI transport check stalled during login initialization, so the contention test used the actual Edge HTTPS path instead. The temporary fixture and its sessions/events were removed; the cleanup query returned zero remaining fixture rows. No customer profile was changed and no notification was sent as a test.

| Required correction check | Result / evidence |
| --- | --- |
| PROFILE AVAILABILITY SEPARATE FROM MODE | PASS — independent fields, both modes reject inactive hosts; hosted Free mapping verified |
| FREE PROFILE CALLABLE | PASS — browser regression and deployed Edge authorization |
| FREE MODE ENTERS NORMAL CALL FLOW | PASS — permission explainer, establishment stages and active source canvas |
| CAMERA PERMISSION | PASS — explainer and one device request; system dialog is stubbed in automation |
| CONNECTING | PASS — existing Connecting/Ringing flow reaches playback |
| HOST SOURCE VIDEO | PASS — actual MP4 decoded in Chromium/WebKit; session asset snapshot verified |
| CALLER CAMERA PIP | PASS — decoded synthetic camera in Chromium; WebKit fixture limitation above |
| VIDEO NATURAL END DETECTED | PASS — real browser media ended event, no synthetic dispatch or duration timer |
| USE CONSUMED AT VIDEO END | PASS — actual PostgreSQL and hosted counter remains unchanged at activation |
| ADMIN USE COUNTER UPDATED | PASS — authoritative usage rows and repository mapping; automatic refetch on focus/visibility or within 30 seconds |
| FAILED CALL RELEASES RESERVATION | PASS — before/after activation, media/technical failure, decline, cancellation and no answer |
| EARLY USER HANGUP RELEASES RESERVATION | PASS — browser and hosted release/retry verification |
| FINAL USE EXHAUSTS ID | PASS — actual PostgreSQL and hosted assertions |
| NEW ID AUTOMATICALLY GENERATED | PASS — one replacement, current mode/configured limit, zero initial usage |
| OLD ID REUSE BLOCKED | PASS — hosted `CALL_ID_EXHAUSTED`, before another session/device request |
| EXHAUSTED FREE ID DOES NOT SHOW SUBSCRIPTION | PASS — browser outcome and Customer Care navigation |
| 1-USE TEST | PASS — PostgreSQL plus hosted rollback test |
| 2-USE TEST | PASS — PostgreSQL plus hosted rollback test |
| 3-USE TEST | PASS — PostgreSQL plus hosted rollback test |
| 5-USE TEST | PASS — PostgreSQL plus hosted rollback test |
| CONCURRENCY TEST | PASS — competing database submissions plus simultaneous deployed Edge requests |
| PREMIUM ACCESS REMAINS SEPARATE | PASS — normalized bonus, paid grant, failure release and returning-customer plan gate |
| COMPLETION FAILURE DOES NOT REPORT SUCCESS | PASS — browser 503 regression, no successful Free ending |

Final validation: `pnpm.cmd typecheck` PASS; `pnpm.cmd test --maxWorkers=2` **1,070 tests / 93 files PASS**; `pnpm.cmd build` PASS (existing OpenCV externalization/bundle-size warnings). Deno checks passed for all six updated Edge handlers. The final four evidence proof/rotation regressions also passed independently. Source composition capture is verified in Chromium; this correction did not upload test images into hosted private storage. Physical-device camera, microphone and OS permission dialogs remain manual checks.

### Correction deployment: complete

Applied `20261020120000_source_completion_tickets.sql` to the same existing Supabase project, `moxkckfrccpteqwfiums`, as a correction to the authorized rollout. A subsequent migration dry run reports up to date, with no pending migrations, seeds or roles. Six existing functions were updated using API bundling; encryption keys, secrets, gateway verification and existing storage policies were preserved.

| Function | Active version | Gateway JWT verification |
| --- | --- | --- |
| resolve-call-id | 10 | true |
| get-public-profile | 9 | true |
| start-call-session | 12 | true |
| update-call-session | 12 | true |
| get-session-media | 10 | false |
| begin-call-evidence | 10 | true |

The client changes are in the local workspace and the build output. No frontend hosting deployment, commit or push was performed. Refresh the local app and use the host's current Call ID when checking the corrected flow; old in-memory profile data predates the new delivery metadata. The pre-existing generated model-path file was preserved and refreshed only by the existing build scripts.

## Historical deployment and validation log

The following sections describe the earlier implementation and rollout. For source delivery and consumption timing, the correction above takes precedence.

## Authorized backend deployment: complete

Authorization: the user answered "yes please apply" to the prepared migration and seven Supabase Function updates. Target: existing project `moxkckfrccpteqwfiums`.

- Dry run confirmed exactly one pending migration and no seeds/roles. Applied `20261020100000_controlled_call_tickets.sql` with `db push --linked --skip-vault --yes`; the remote migration history now matches all local versions.
- Deployed the seven prepared existing functions using API bundling. `generate-call-id` was deployed before `admin-call-ids`; admin metadata was deployed last.
- Preserved existing JWT verification settings, the existing encryption key and hosted origin settings. No secrets were replaced.

| Function | Active deployed version | Gateway JWT verification |
| --- | --- | --- |
| generate-call-id | 7 | true |
| admin-call-ids | 7 | true |
| resolve-call-id | 9 | true |
| start-call-session | 11 | true |
| update-call-session | 11 | true |
| check-call-eligibility | 2 | false |
| get-session-media | 9 | false |

Hosted verification: three zero-row REST schema probes now return HTTP 200 for profile mode/limits, ticket usage/configuration and session audit fields. Both admin handlers reject non-admin authentication with HTTP 401. Unknown-code resolution returns `CALL_ID_NOT_FOUND`; session update, media retrieval, call initiation and customer eligibility reject invalid input with HTTP 400. All seven functions report ACTIVE. These probes create no customer call sessions or grants and do not switch an existing profile's mode.

The local frontend can now save Free/Premium settings after a refresh. Existing profiles remain Premium by the migration's compatibility default; choosing Free and confirming rotates the selected profile's Call ID. An authenticated admin mode-switch against real customer data was not performed as a smoke test. Independent-device calls and hosted multi-connection contention remain additional validation, as described below. The separate signaling server and frontend hosting were not deployed by this authorization.

## Follow-up: expired signaling address during a Free call

The user's `ERR_NAME_NOT_RESOLVED` log matched the configured expired `trycloudflare.com` signaling hostname. Direct checks confirmed DNS `ENOTFOUND` for that hostname and `ECONNREFUSED` for the stopped local service on port 8787. Supabase had reserved the ticket successfully; signaling authorization failed afterward. The early reservation also incorrectly emitted a new-call notification before an invitation existed.

The ignored local environment now explicitly enables `VITE_DEV_SIGNALING_PROXY=true` with the local service at `ws://127.0.0.1:8787`. The browser derives the WebSocket and authorization address from its current app origin using `/__callastar_signaling`; Vite forwards HTTP and WebSockets to the separate service. A single mobile app tunnel can carry both, without a second temporary signaling hostname. Root `pnpm dev` now starts the local signaling process when this explicit option is enabled, reusing existing server credentials and supplying Supabase ticket-proof enforcement. The service has been restarted in the background for the already-running app. Both direct and proxied health endpoints return HTTP 200; unknown-code authorization now returns structured `unavailable` rather than a DNS failure.

The reservation no longer emits the new-call email. Live invitations use the cloud session ID for deduplication; successful playback activation uses the same notification identity. Failed preflight/reservation attempts do not emit that new-call notification. No message was sent to a real customer as a test.

For live camera/audio calls, an operator still needs **Receive Calls** enabled for the selected host profile. Active status alone is not a socket registration. Selected source delivery uses the corrected independent path above. Production WSS hosting, TLS/TURN and operator credentials retain their existing deployment requirements. The DNS repair itself added no production Supabase migration or function deployment.

Repair validation: **1,047 unit tests passed / 0 failed (92 files)**; frontend typecheck and production build pass. The Vite integration test exercises HTTP authorization and real WebSocket upgrade/echo through the proxy. The actual localhost app was inspected in Chromium and reports `ws://localhost:8443/__callastar_signaling`, with a healthy HTTP 200 response. The real two-context Chromium host/caller regression passed through the same-origin proxy, including connected media, hangup and screenshot evidence. Free source completion passed in both Chromium and WebKit (two additional browser cases). `node scripts/dev.mjs --signaling-only` also confirms safe reuse of the healthy existing listener. No external call notification was sent as a verification step.

## Follow-up: profile presence, playback badge and Free mode

- Profiles this tab does not operate no longer receive an assumed Offline badge. Confirmed live presence is preserved; a disconnected operated profile says "Live calls disconnected". The detail panel labels unobserved presence "Not connected on this device". Availability remains the saved Active/Inactive setting.
- Removed "Preview session" from uploaded video and audio playback.
- **Initial Free-mode blocker (now resolved by the authorized deployment above):** a read-only schema request returned PostgreSQL `42703: column hosts.profile_mode does not exist`. The migration list confirmed that only `20261020100000` was pending on the existing project.
- The UI now explains that mode settings await the server update. Repository validation prevents calling a legacy generator for unsupported mode settings, and verifies that successful requests actually persisted the requested mode/limit. This avoids a false success or an unintended regeneration while the old backend is still deployed.
- Eight focused browser checks passed in Chromium/WebKit, including actual Premium-to-Free confirmation and persistence against the updated backend fixture, missing-migration behavior, no false Offline label, and playback without the preview badge. Typecheck and build pass. **1,041 unit tests passed / 0 failed (90 files)**.

The prepared production change is the single migration and the seven existing Edge Functions listed in this report, applied to the same existing project. Deploy `generate-call-id` before exposing updated `admin-call-ids` capability metadata, and coordinate the full rollout because the migration replaces the session RPC contract. This does not authorize a Netlify deployment or a commit/push.

The original request required separate deployment authorization. That authorization was subsequently given and the backend update was completed, as recorded above.

## Follow-up: localhost profiles loading repair

The pasted browser log identified a hosted `admin-call-ids` CORS response allowing only the Netlify origin while the development app used `http://localhost:8443`. The profile query itself succeeded, but the dependent Call ID lookup rejected the entire list.

Development now sends only the configured project's Edge Function requests through Vite's same-origin `/__supabase/functions/v1/` proxy. JWTs, API keys, methods and bodies are preserved; the server-to-server request omits the browser Origin header. Auth, database and storage requests keep their existing URLs. Production builds use direct Supabase requests; hosted CORS settings are unchanged. No new environment value or backend deployment is required for this local repair.

Profile list/detail reads also survive a separate Call ID lookup failure. They show an explicit unavailable message, disable copy and omit ticket mutation controls until the lookup recovers, while retaining profile settings/media access. No code or counter is fabricated. Normal background refresh can recover the code.

Follow-up validation: **1,035 unit tests passed / 0 failed (89 files)**; frontend typecheck and build pass; **four focused Chromium/WebKit checks pass** (failure/recovery and existing admin controls in each engine). An actual Vite proxy integration test reproduces a production-only upstream CORS header and verifies preserved authorization. A request through the running localhost server reaches the existing project's authentication gateway. The development proxy route is absent from the production bundle. The user's authenticated production data was not accessed or changed.

Additional/updated repair paths: `vite.config.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/developmentFetch.ts`, its unit test, `tests/supabase-dev-proxy.test.ts`, `src/services/admin/types.ts`, `src/services/admin/supabaseAdminRepository.ts` and its tests, `ProfileAvailabilityCard.tsx`, `CallIdCard.tsx`, `CallTicketControls.tsx`, `tests/e2e/call-tickets.spec.ts`, and `.env.example`.

## Result and scope

The existing Supabase Call ID architecture now supports issued Free/Premium modes, 1/2/3/5-use tickets, expiring reservations, atomic consumption and rotation, and explicit old-ticket rejection. Admin availability remains independent. Actual uploaded-video playback starts timing and its natural `ended` event ends the call. Free completion and expiry screens bypass subscriptions; Premium bonus completion opens plans, while paid completion ends normally.

The original architecture used hashed lookup and encrypted recoverable codes, an Edge session-token boundary, a customer email bonus ledger, paid grants, and an independent availability status. Those seams are extended rather than replaced. Code generation uses the existing cryptographic generator and AES-GCM key; plaintext is returned only at the existing authorized admin boundary. Counter/configuration mutations run through service-only database functions. The signaling service additionally binds a reserved session to one immutable attempt before authorizing an invitation.

## Requested PASS / FAIL matrix

PASS in this matrix describes implementation and the stated local checks. The separate authorized deployment and limited hosted verification are recorded above. Database tests execute the actual forward SQL in PGlite against an existing-schema fixture. PGlite serializes queries, so competing-submission tests verify capacity logic but do not replace a multi-connection PostgreSQL contention test.

| Requirement | Result | Evidence / qualification |
| --- | --- | --- |
| DATABASE MIGRATION | PASS | Actual forward migration executes in the database test fixture; historical migrations unchanged. |
| FREE/PREMIUM MODE | PASS | Exclusive database enum checks, radio controls, issued-mode snapshot, switching tests. |
| PROFILE AVAILABILITY PRESERVED | PASS | Existing Active status preserved; inactive profiles rejected independently. |
| ALLOWED USES 1/2/3/5 | PASS | Database constraints, admin selector, all four exhaustion cases tested. |
| ATOMIC RESERVATION | PASS | Host/ticket row locks, pending-capacity accounting, expiring leases; local SQL tests. Hosted contention test pending. |
| FAILED-CALL RELEASE | PASS | Decline, failure, cancellation, no answer, expiry and source-load failure covered. |
| USE CONSUMPTION | PASS | Idempotent activation transaction; frontend activation waits for real source playback and, for live calls, RTC connection. |
| AUTOMATIC ID ROTATION | PASS | Last consumption and encrypted replacement insert share a transaction; repeated activation cannot rotate twice. |
| OLD ID INVALIDATION | PASS | Exhausted/retired codes reject new reservations; no forwarding to replacement codes. |
| NEW ID ADMIN DISPLAY | PASS | New badge, timestamp, usage and remaining counts; visible-page 30-second refresh plus focus/visibility refresh tested. |
| MANUAL REGENERATION | PASS | Confirmation, server-side retirement and replacement, mode/limit inheritance tested. |
| FREE MODE NO SUBSCRIPTION | PASS | Skips customer bonus ledger and paid gates; browser verifies no packages after Free completion/expiry. |
| PREMIUM FIRST BONUS | PASS | Normalized unverified email ledger; reservation does not consume bonus; activation does; bonus precedes paid access. |
| PREMIUM RETURNING GATE | PASS | Returning customer without entitlement reaches plans before device requests or signaling. |
| PAID PREMIUM USER | PASS | Existing paid grant reservation and failed-attempt release; ordinary source completion tested. |
| VIDEO DURATION CONTROLS CALL | PASS | Valid actual metadata/decoded frame and playback start; real browser `ended` triggers finalization. |
| VIDEO LOOP DISABLED | PASS | Both uploaded-source components explicitly disable looping; browser assertion. |
| FREE SESSION END SCREEN | PASS | Home, another ID and Customer Care actions; no subscription transition. |
| FREE ID EXPIRED SCREEN | PASS | Dedicated expiry screen, no package gate, responsive widths and usable support destination. |
| PREMIUM PLAN TRANSITION | PASS | Natural bonus completion opens existing selector with complimentary-call completion copy. |
| REAL NETWORK FAILURE DISTINGUISHED | PASS | Natural end has `SOURCE_VIDEO_ENDED`; media errors have recovery UI; synthetic video reconnect/failure removed; existing RTC failure classifications preserved. |
| CUSTOMER CARE UNAFFECTED | PASS | Both expired modes open usable accountless support; subscription/WhatsApp architecture unchanged; existing unit suite retained. No real WhatsApp message sent. |
| CALL EVIDENCE UNAFFECTED | PASS | Real two-context call captures one frame while active, then admin opens it after hangup. Existing cloud repository tests retained. Local fallback remains intentionally volatile. |
| MAIN HOST SOURCE | PASS | Existing main host surface preserved; source completion browser tests and composition capture tests. |
| CALLER CAMERA PIP | PASS | Existing independent local stream/PiP preserved; real two-context RTC and screenshot checks pass. |
| CHROMIUM | PASS | Nine ticket scenarios plus real two-context live-call/evidence regression. |
| WEBKIT | PASS | Nine ticket scenarios, with device permission stubbed; real MP4 decoding and natural completion. |
| TYPECHECK | PASS | Frontend TypeScript, signaling TypeScript and all seven changed Deno entrypoints. |
| BUILD | PASS | Production build succeeds; existing large-chunk/OpenCV externalization warnings remain. |

## Validation

- `pnpm.cmd typecheck`: PASS.
- `pnpm.cmd exec tsc --noEmit -p server/signaling/tsconfig.json`: PASS.
- `pnpm.cmd test --maxWorkers=2`: **1,025 passed / 0 failed**, 87 test files.
- `pnpm.cmd build`: PASS.
- `pnpm.cmd dlx deno check --no-lock` against all seven changed Edge entrypoints: PASS.
- `pnpm.cmd exec playwright test --config playwright.call-tickets.config.ts`: 17 passed initially; one WebKit failure fixture reused a previously decoded source. The missing-source fixture now uses a separate URL. The targeted failure-path rerun passed in **both engines (2/2)**. All **18 unique ticket browser scenarios** passed across those runs, with no unresolved failures.
- `pnpm.cmd exec playwright test tests/e2e/live-call.spec.ts --config=playwright.config.ts --project=chromium --grep 'guest calls, host answers with Live Camera'`: **1 passed**. Real WebSockets and peer connections, synthetic camera/microphone, two isolated browser contexts.
- Browser total: **19 unique scenarios passed / 0 unresolved failures**. This is focused coverage, not the entire repository browser suite.
- Admin and expiry layouts checked at **320, 360, 375, 390, 393, 414, 430, 768, 1024, 1280 and 1440 px** in Chromium and WebKit. Desktop admin screenshot visually inspected.

The live regression fixture was updated for the current Supabase auth boundary and current evidence CSS selectors. It previously assumed a removed development login flag and IndexedDB screenshot persistence. The existing local screenshot store is deliberately in memory: the test now verifies viewing after hangup through SPA navigation and expected clearing after a full reload. Production cloud screenshot persistence was not changed or exercised against hosted Supabase.

New coverage includes 23 actual-SQL ticket tests, source-metadata validation, completion versus network reducer behavior and attempt cleanup, six signaling bridge cases, four private-media reservation cases, and a real HTTP/WebSocket test for reservation proof binding and replay rejection.

## Required migration and data defaults

Apply only the new forward migration:

`supabase/migrations/20261020100000_controlled_call_tickets.sql`

- Existing profiles and tickets default to **Premium**, preserving the previous global subscription/trial behavior.
- Existing tickets default to **max_uses=1, use_count=0**. Accounting begins at rollout. Historical unbounded sessions do not reliably establish consumption under the new issued-ticket rules; they are not retroactively charged.
- Current shared codes remain valid. If an interrupted old regeneration left multiple active rows, the newest is retained and older active rows become manually retired before the unique active-ticket index is added.
- Legacy in-flight sessions without `mode_at_start` remain grandfathered. New sessions capture issued mode, access kind, reservation, consumption timestamp/use number, signaling attempt and end reason.
- Availability status and existing package minute metadata remain intact.
- Mode changes retire the current ticket and issue a fresh ticket. Lowering a limit at/below already consumed usage rotates immediately. Previously authorized in-flight calls keep their original mode/access; new callers must use the replacement.
- Unused reservations expire after three minutes. Preconnection failures release ticket capacity and any reserved bonus/paid entitlement. Active consumption does not interrupt the call that used the final slot.
- Authenticated clients cannot directly update authoritative ticket counters or profile mode/limit columns. Existing profile edits use an explicit permitted-column grant and server timestamp trigger.

Do not apply this migration alone to a live deployment: the old session functions depend on the replaced RPC contract. Coordinate migration, all changed functions, frontend and signaling rollout.

## Edge Functions requiring deployment

Deploy these **seven existing functions** to the **existing project**, with their shared dependencies:

1. `generate-call-id`
2. `admin-call-ids`
3. `resolve-call-id`
4. `start-call-session`
5. `update-call-session`
6. `check-call-eligibility`
7. `get-session-media`

New helper: `supabase/functions/_shared/callTickets.ts` (bundled into importing functions; not a standalone function). Preserve the project's existing function gateway/auth configuration. Admin functions still require authenticated admin access; accountless call functions validate their scoped session proofs. The signaling bridge sends the existing public anon key as both `apikey` and bearer header for gateway compatibility.

No evidence, Customer Care, WhatsApp or subscription payment function deployment is newly required by this change.

## Environment, hosting and operational dependencies

- Reuse the existing Supabase URL and public anon key. Keep `VITE_ADMIN_DATA_MODE=supabase` and `VITE_CALL_BACKEND=supabase` for hosted authoritative behavior.
- Keep the existing **server-only `CALL_ID_ENCRYPTION_KEY` unchanged**. `update-call-session` now also needs it to prepare encrypted automatic replacements. Do not put it or the service-role key in any `VITE_` variable.
- The separate signaling server needs:

  ```dotenv
  NODE_ENV=production
  SIGNALING_CALL_ACCESS_URL=https://<existing-project-ref>.supabase.co/functions/v1/update-call-session
  SIGNALING_SUPABASE_ANON_KEY=<existing-project-public-anon-key>
  ```

  Production startup refuses a missing access endpoint. The endpoint/anon key are server configuration; no new frontend secret is needed. Deploy the changed signaling service with its frontend caller proof support.
- **Production origin dependency:** the changed Edge handlers still use the existing single-origin `CALLASTAR_PUBLIC_ORIGIN` CORS contract. Set it to the separately authorized frontend hosting origin. Align `SIGNALING_ALLOWED_ORIGINS`, HTTPS/WSS and the existing Supabase Auth redirect configuration with that hosting migration. The existing multi-origin helper used elsewhere does not automatically make these handlers multi-origin. No production origin setting was changed here.
- Uploaded video profiles need a selected source with valid duration and dimensions. Admin shows detected filename/duration or flags the missing source. Existing private storage/signed URLs and RLS are preserved.
- Uploaded video completion takes precedence over package minute timers. The minute timer is disabled for this finite uploaded-video path; package metadata and existing camera/audio limits are retained. No call is kept open after its source ends.
- Admin refresh is bounded polling while visible (30 seconds) plus focus/visibility events, rather than an immediate realtime subscription. It does not require a full application reload.

## Remaining issues / verification limits

1. The hosted migration and seven functions are now deployed and their schema/authentication/validation smoke checks pass. Independent-device Supabase persistence, an authenticated admin mode switch and multi-connection contention tests remain unperformed; the hosted probes above are not a complete call-flow acceptance test.
2. Windows WebKit tests use camera permission/stream stubs. Source decoding is real; physical Safari/iOS/Android and WebKit two-device RTC were not tested.
3. The existing production operator credential provider is explicitly unimplemented in `src/services/signaling/hostCredentials.ts`. Production live-host registration still needs scoped, expiring operator credentials. Existing TURN/TLS and multi-instance signaling requirements also remain; a loopback RTC test does not verify carrier-network reachability.
4. Local development mode supports admin configuration but is not the authoritative ticket-accounting engine. Local evidence remains volatile by existing design; production uses the existing private cloud evidence flow.
5. Real WhatsApp delivery and hosted cloud screenshot upload/view were not invoked. No external message was sent.
6. Existing build warnings for bundle size and OpenCV Node module externalization remain nonblocking.

## Files changed

The manifest below includes implementation, validation and documentation files. `src/features/transformation/modelAssetPaths.generated.ts` was already modified before this task and its diagnostic asset timestamp was refreshed by the required build; it is not part of the ticket implementation and was not reverted.

- `.env.example`
- `docs/CONTROLLED_CALL_TICKETS_REPORT.md`
- `package.json`
- `playwright.call-tickets.config.ts`
- `playwright.config.ts`
- `pnpm-lock.yaml`
- `scripts/dev.mjs`
- `server/signaling/README.md`
- `server/signaling/src/config.ts`
- `server/signaling/src/hub.ts`
- `server/signaling/src/index.ts`
- `server/signaling/src/ticketAccess.ts`
- `server/signaling/src/tokens.ts`
- `src/components/call/RemoteVideoSurface.tsx`
- `src/features/admin/components/ConfirmDialog.tsx`
- `src/features/admin/hooks/useAdminData.ts`
- `src/features/admin/profiles/CallIdCard.tsx`
- `src/features/admin/profiles/CallTicketControls.tsx`
- `src/features/admin/profiles/ProfileAvailabilityCard.tsx`
- `src/features/admin/profiles/ProfileDetailPage.tsx`
- `src/features/call-session/ActiveAudioCallPage.tsx`
- `src/features/call-session/ActiveVideoCallPage.tsx`
- `src/features/call-session/CallSessionRoute.tsx`
- `src/features/call-session/SourceSessionEndedPage.tsx`
- `src/features/call-session/hooks/useCallEvidenceScreenshot.ts`
- `src/features/call-session/hooks/useLiveGuestCall.ts`
- `src/features/call-session/hooks/useSessionRecorder.ts`
- `src/features/call-session/hooks/useSourceCompletion.ts`
- `src/features/call-session/subscription/SubscriptionAccessScreen.tsx`
- `src/features/calls/components/LiveCallCanvas.tsx`
- `src/features/calls/components/UploadedCallVideo.tsx`
- `src/features/host-calls/HostCallProvider.tsx`
- `src/features/host-calls/components/LiveCallingCard.tsx`
- `src/features/host-calls/components/PresenceBadge.tsx`
- `src/features/join-call/CallTicketUnavailable.tsx`
- `src/features/join-call/JoinCallPage.tsx`
- `src/i18n/locales/de.ts`
- `src/i18n/locales/en.ts`
- `src/i18n/locales/es.ts`
- `src/i18n/locales/fr.ts`
- `src/i18n/locales/it.ts`
- `src/i18n/locales/pt.ts`
- `src/lib/config.ts`
- `src/lib/developmentSignaling.test.ts`
- `src/lib/developmentSignaling.ts`
- `src/lib/productionDiagnostics.ts`
- `src/lib/supabase/client.ts`
- `src/lib/supabase/developmentFetch.test.ts`
- `src/lib/supabase/developmentFetch.ts`
- `src/services/access/resolveEntry.ts`
- `src/services/admin/localAdminRepository.ts`
- `src/services/admin/repository.ts`
- `src/services/admin/supabaseAdminRepository.test.ts`
- `src/services/admin/supabaseAdminRepository.ts`
- `src/services/admin/types.ts`
- `src/services/callBackend.ts`
- `src/services/callSession.ts`
- `src/services/media/sourcePlayback.test.ts`
- `src/services/media/sourcePlayback.ts`
- `src/services/signaling/callAuthorization.ts`
- `src/state/callSessionReducer.test.ts`
- `src/state/callSessionReducer.ts`
- `src/styles/admin.css`
- `src/styles/globals.css`
- `src/types/call.ts`
- `src/types/host.ts`
- `supabase/functions/_shared/callTickets.ts`
- `supabase/functions/admin-call-ids/index.ts`
- `supabase/functions/check-call-eligibility/index.ts`
- `supabase/functions/generate-call-id/index.ts`
- `supabase/functions/get-session-media/index.ts`
- `supabase/functions/resolve-call-id/index.ts`
- `supabase/functions/start-call-session/index.ts`
- `supabase/functions/update-call-session/index.ts`
- `supabase/migrations/20261020100000_controlled_call_tickets.sql`
- `tests/call-notification-timing.test.ts`
- `tests/call-tickets.database.test.ts`
- `tests/e2e/call-tickets.spec.ts`
- `tests/e2e/live-call.spec.ts`
- `tests/e2e/support/seed.ts`
- `tests/profile-presence.test.ts`
- `tests/session-media-ticket.test.ts`
- `tests/signaling-ticket-access.test.ts`
- `tests/signaling.integration.test.ts`
- `tests/supabase-dev-proxy.test.ts`
- `vite.config.ts`
