# CallaStar

A public video-call app plus an admin workspace for the profiles it calls.

## Local development mode

Supabase is intentionally not connected yet. The dashboard and the call flow run
against a **local development engine**: profiles, avatars, remote call videos and
call sessions are stored in this browser using IndexedDB.

Copy `.env.example` to `.env` and keep the local defaults:

```sh
VITE_ADMIN_DATA_MODE=local        # profiles + media live in browser storage
VITE_ADMIN_AUTH_MODE=development  # opens /admin without Supabase auth (dev builds only)
VITE_CALL_BACKEND=local           # the public app resolves Call IDs from those profiles
```

Then:

```sh
pnpm install
pnpm dev          # http://localhost:8443
pnpm typecheck
pnpm build
```

Open `/admin`, create a profile, copy its Call ID, and call it from `/`.

### What "local" means, exactly

- Everything lives in **one browser profile on one device**. It is not cloud
  storage and there is no synchronisation.
- That includes **caller details from call history** (name, email, phone). They
  are development data in IndexedDB, never in the URL or `localStorage`, and
  Supabase replaces this persistence later.
- **Clearing site data deletes every profile and uploaded file.** So does using a
  different browser, a different machine, or a private window.
- Uploads are capped for a browser store: 10 MB an avatar, 100 MB a video. If the
  browser refuses more, the UI says storage is full rather than failing silently.
- `VITE_ADMIN_AUTH_MODE=development` is honoured **only** when
  `import.meta.env.DEV` is true. A production build ignores it completely, so it
  cannot ship as an auth bypass.
- Nothing falls back automatically: a failing Supabase never quietly switches to
  local data, and local mode never pretends to be Supabase.

## Call sessions and events

Every call is recorded locally, from the moment devices are granted:

- A session row holds who called whom, the Call ID as it was dialled, and the
  lifecycle timestamps (`createdAt`, `ringingAt`, `connectedAt`, `endedAt`).
- A call that was hung up before it connected is stored as **cancelled**, with
  no connection time and no duration. Duration is always
  `endedAt - connectedAt`, never the on-screen timer.
- Each meaningful transition appends an event (created, granted, connecting,
  ringing, connected, mute, camera, ended/cancelled/failed), which the admin
  shows as a plain-language timeline.
- Opening the Call ID dialog and walking away records nothing, and a call whose
  camera was refused records nothing either.

Review it all under **Call sessions** in the admin, or on a profile under
**Recent calls**.

### Audio calls

Choosing **Audio Call** asks for the microphone only — `getUserMedia` is called
with `video: false` and the flow never mentions a camera. The call screen shows
the host avatar, name and timer with mute, speaker and end controls. If the
profile has an uploaded video its **sound** is played behind the avatar; its
picture is deliberately not shown. Browsers may refuse to start that audio
without a gesture, so a "Tap to hear audio" control appears when they do. Real
two-way audio arrives with the later WebRTC phase.

## How a call finds a profile

```
Admin creates a profile        ->  a unique Call ID is generated automatically
Caller enters that Call ID     ->  resolveCallId finds the ACTIVE profile
Call connects                  ->  the profile avatar holds the frame
Call becomes active            ->  the uploaded video plays as the other participant
```

Inactive profiles do not resolve. Regenerating a Call ID invalidates the old one
immediately.

## Switching to Supabase later

The admin UI only talks to the `AdminRepository` interface in
`src/services/admin/repository.ts`. Two implementations sit behind it:

| Concern            | Local (today)                       | Supabase (later)                                 |
| ------------------ | ----------------------------------- | ------------------------------------------------ |
| Profiles           | `profiles` store                    | `hosts` table                                     |
| Avatar / video     | `assets` + `blobs` stores           | Storage buckets + `host_media` rows               |
| Call IDs           | `profiles.callId` (+ indexed key)   | `call_ids` (hashed; only the last four in plain)  |
| Public lookup      | `localAdminRepository.resolveCallId`| `resolve-call-id` Edge Function                   |
| Call sessions      | `sessions` store                    | `call_sessions`, written by the Edge Functions    |
| Call events        | `callEvents` store                  | `call_events`                                     |

To migrate: implement `src/services/admin/supabaseAdminRepository.ts` (every
method currently throws a clear "not connected" error), then set
`VITE_ADMIN_DATA_MODE=supabase`. The domain types in
`src/services/admin/types.ts` already match the migration columns, so no admin
screen changes.

### Known differences to reconcile at swap time

The local session model was kept close to `call_sessions`, with three gaps that
need a decision (and possibly one additive migration) when Supabase is connected:

- `ringingAt` has no column yet. Either add `ringing_at`, or derive it from the
  `ringing` row in `call_events`.
- `callIdSnapshot` stores the dialled code in plain text locally. The database
  deliberately never stores a plain Call ID, so this maps to `code_last4` plus
  the `call_id_id` reference instead.
- `durationSeconds` is stored locally for convenience; in SQL it is better
  computed from `connected_at` and `ended_at`.

Everything else lines up: statuses, `failureCode` -> `error_code`, caller fields
-> `visitor_*`, and the event rows -> `call_events`.

## Supabase setup (not run yet)

The browser uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Never
place a service-role key in a Vite environment file.

This repository contains an additive migration in `supabase/migrations` and five
Edge Functions: `generate-call-id`, `resolve-call-id`, `start-call-session`,
`update-call-session`, and `get-session-media`.

Before deployment, link the intended project and inspect its migration state:

```sh
supabase link --project-ref <project-ref>
supabase migration list
supabase db push
supabase functions deploy generate-call-id
supabase functions deploy resolve-call-id
supabase functions deploy start-call-session
supabase functions deploy update-call-session
supabase functions deploy get-session-media
```

Set Edge Function secrets in Supabase only: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `CALLASTAR_PUBLIC_ORIGIN`. The migration makes
both host buckets private; Edge Functions provide short-lived signed URLs.

The Call ID format is fixed by `supabase/functions/_shared/utils.ts`
(`CS-XXXX-XXXX-XXXX`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), and
`src/lib/callId.ts` generates exactly the same shape, so codes minted locally
today look like the ones Supabase will mint later.

## Admin bootstrap (production)

Create the administrator through Supabase Auth or its dashboard, then insert the
resulting Auth user UUID into `admin_profiles`. There is intentionally no public
admin signup route. Sign in at `/admin/login`.

## Other modes

`VITE_CALL_BACKEND=mock` serves a single built-in demo host for deliberate
offline UI work. `VITE_ENABLE_DEMO_VIDEO=true` plays the bundled clip instead of
the real camera, and labels it on screen.
