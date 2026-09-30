# CallaStar signalling service

Call control for real two-party calls: invitation, accept/decline, SDP, ICE
candidates, presence and hangup.

**It never carries media.** Once a peer connection is negotiated, audio and video
travel directly between the two devices (or via TURN — see below). Nothing is
persisted: there is no database, and restarting loses only calls that were
mid-dial.

## Why it is a separate process

Signalling cannot live in Vite middleware. Development middleware is not
deployable, and two phones on a real network need something that is. It is its
own package rather than part of the web app because it is its own deployment,
with its own secrets and its own scaling characteristics.

## Running it

```bash
cd server/signaling
pnpm install

export SIGNALING_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export SIGNALING_HOST_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export SIGNALING_ALLOWED_ORIGINS=http://localhost:8443

pnpm dev
```

The service refuses to start without both secrets. That is deliberate: a
signalling service with a guessable host credential lets a stranger answer
someone else's calls.

Then point the web app at it:

```
VITE_SIGNALING_URL=ws://localhost:8787
VITE_SIGNALING_HOST_TOKEN=<the same value as SIGNALING_HOST_SECRET>
```

**`SIGNALING_ALLOWED_ORIGINS` is not optional.** The web app and this service are
different origins, so a guest's `POST /calls/authorize` is a cross-origin request.
Without the origin on the allowlist the browser blocks it and the caller is told
CallaStar was unreachable — correctly, but for a reason that is a
misconfiguration rather than an absent host. This is easy to miss because the
WebSocket itself is unaffected.

## Two-client local development

A guest and a host are two different browsers, and they must not share storage:
the development admin session lives in `sessionStorage`, and profiles live in
IndexedDB. Two tabs of the same profile would share both.

- **Guest** — a normal window at `http://localhost:8443/`
- **Host** — a separate browser *profile* (not just a separate window), signed
  into `/admin`, with Receive Calls on for the profile being called

For physical devices, both must reach the same two services over the network, and
both need a secure context — see the TLS note below. Automated coverage uses two
isolated Playwright contexts, which is the same isolation by another route.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNALING_PORT` | `8787` | Listen port |
| `SIGNALING_HOST` | `0.0.0.0` | Listen address |
| `SIGNALING_TOKEN_SECRET` | *(required)* | Signs ephemeral guest call tokens |
| `SIGNALING_HOST_SECRET` | *(required)* | What a host presents to operate a profile |
| `SIGNALING_ALLOWED_ORIGINS` | *(empty)* | Comma-separated CORS allowlist. Never `*` |
| `SIGNALING_GUEST_TOKEN_TTL_MS` | `120000` | How long a call token stays valid |
| `SIGNALING_RING_TIMEOUT_MS` | `35000` | When an unanswered ring becomes `no_answer` |
| `SIGNALING_PRESENCE_TIMEOUT_MS` | `45000` | When a quiet socket stops being available |
| `SIGNALING_HEARTBEAT_MS` | `15000` | Ping cadence |
| `SIGNALING_AUTHORIZE_PER_MINUTE` | `10` | Call ID lookups per client |
| `SIGNALING_INVITES_PER_MINUTE` | `12` | Invitations per client |
| `SIGNALING_MESSAGES_PER_SECOND` | `60` | Per-socket message budget |
| `SIGNALING_CONNECTIONS_PER_MINUTE` | `30` | Socket opens per client |

## Endpoints

### `POST /calls/authorize`

```jsonc
// request
{ "callId": "CS-7K4P-Q9MX-2J8R" }

// response — a host is there
{ "state": "available", "callAttemptId": "att_…", "token": "…", "expiresAt": 1730000000000 }

// response — host is on another call
{ "state": "busy" }

// response — no host registered, operator offline, or the code was never real
{ "state": "unavailable" }
```

The check and the mint happen together, so a token only exists for a call that
could actually connect.

`unavailable` covers all three cases with one answer on purpose: this endpoint
must not become a way to discover which Call IDs are real.

### `WS /`

First frame must be `hello`. Everything else is refused until it arrives, and a
socket that never sends one is closed after ten seconds. The protocol is
`src/services/signaling/protocol.ts`, imported by both ends so it cannot drift.

## Architecture notes

- **No profile database.** Profiles live in the operator's own storage, so a host
  registers the Call ID it answers for on connect, and this service is a pure
  rendezvous. A code nobody registered is indistinguishable from a code that was
  never real.
- **Presence is server-authoritative.** It is a live socket, not a stored flag. A
  host whose phone loses signal expires on the sweep timer, so nobody rings a
  host who is not there. Registering is not the same as being available — the
  operator still has to turn Receive Calls on.
- **A guest token authorises one attempt.** It names the `callAttemptId` and the
  `callIdKey`, both checked on every message, so a guest cannot redirect it at
  another host or subscribe to anybody else's call. It is signed, not stored.
- **A Call ID is not a credential.** Knowing one buys the right to ring a profile
  once. It never authenticates.
- **One host per Call ID.** A second registration replaces the first, which is
  what happens when an operator moves from laptop to phone; the stale socket must
  not keep receiving that profile's calls.
- **Rate limits are in-memory**, so they are per instance. Behind more than one
  instance they need a shared store.

## What still needs deploying or building

Stated plainly rather than left to be discovered:

1. **TURN.** Not optional for production. Mobile carrier NAT, CGNAT, enterprise
   networks and restricted Wi-Fi all require a relay, and without one those calls
   simply fail. Configure a TURN server and set `VITE_RTC_TURN_URLS`,
   `VITE_RTC_TURN_USERNAME` and `VITE_RTC_TURN_CREDENTIAL` in the web app.
   `describeRtcReadiness()` reports the truth about this, and a build without
   TURN must not be described as production ready.

2. **TLS.** A browser will not open `ws://` from an HTTPS page, and
   `getUserMedia` needs a secure context. Terminate TLS in front of this service
   and serve `wss://`.

3. **Per-operator host credentials.** `SIGNALING_HOST_SECRET` is a shared secret
   and therefore a development stand-in: revoking one operator currently means
   rotating a secret every host shares. Production should mint a short-lived
   per-operator token from the admin session, carrying the profiles that operator
   may act for — which is the `ProfileOperator` seam, so that "admin" is not
   hard-wired as "host" forever.

4. **Remote media storage, for the Uploaded Source call path.** This is the one
   piece that is *architecturally* incomplete rather than merely unconfigured. A
   host's call source currently lives in that browser's IndexedDB, and a blob in
   one browser cannot be fetched by another device by any mechanism. Until the
   asset is in object storage with an endpoint that exchanges an asset id plus a
   call attempt for a short-lived signed URL, `call.source_selected` can only
   answer `storage_unreachable` — which it does, honestly, instead of relaying a
   reference the guest could never load.

   **Live Camera calling does not depend on this** and works end to end.

5. **A shared rate-limit store**, if this runs as more than one instance.
