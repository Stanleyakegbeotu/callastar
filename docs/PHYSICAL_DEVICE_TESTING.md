# Testing CallaStar on real phones

## Why HTTPS is not optional

`getUserMedia` and `RTCPeerConnection` only exist in a **secure context**.
Browsers grant one exception: `localhost` and `127.0.0.1` are treated as secure
even over plain HTTP, because traffic that never leaves the machine cannot be
intercepted.

That exception is about the **origin in the address bar**, not about the network.
A phone opening `http://192.168.1.20:8443` is not on localhost. It gets:

- no camera
- no microphone
- no working call

`deviceCapability.ts` reports this as `insecure-context` and the UI says a secure
connection is needed — deliberately a different message from "video calls are
mobile only", because sending somebody to fetch their phone when the real problem
is the URL scheme wastes their time.

A browser will also refuse `ws://` from an HTTPS page. Once the app is on HTTPS,
the signalling service must be on `wss://`; mixed content is blocked outright.

**Do not disable browser security to get around this.** Flags that weaken origin
handling produce a build that behaves unlike the one users get, and
`--unsafely-treat-insecure-origin-as-secure` in particular puts the origin in an
isolated context where IndexedDB is denied — which breaks Call ID lookup. That
cost us real debugging time; it is written down so nobody pays it twice.

## Two workable setups

### A. A tunnel (simplest)

Expose both services over HTTPS with any reverse-tunnel tool:

```bash
# Terminal 1 — the web app
pnpm dev                 # http://localhost:8443

# Terminal 2 — signalling
cd server/signaling && pnpm dev    # http://localhost:8787

# Terminals 3 and 4 — one tunnel each, giving two https:// URLs
```

Then:

```bash
# Web app (.env)
VITE_SIGNALING_URL=wss://<signalling-tunnel-host>
VITE_SIGNALING_HOST_TOKEN=<same value as SIGNALING_HOST_SECRET>

# Signalling service — the WEB APP's origin, not the service's own
SIGNALING_ALLOWED_ORIGINS=https://<web-tunnel-host>
```

Open the web tunnel URL on both phones.

### B. Local HTTPS on the LAN

Issue a certificate for your machine's LAN address with a local CA, serve both
over HTTPS, and install the CA on each phone. More setup, no third party, and
it survives losing your internet connection.

Either way the two rules are the same: **both services on HTTPS/WSS**, and **the
web app's origin on the service's CORS allowlist**.

## CORS: the failure that looks like something else

The WebSocket connecting proves nothing about the HTTP endpoint. They are
different mechanisms with different rules, and only the HTTP one is subject to
CORS.

With the origin missing from `SIGNALING_ALLOWED_ORIGINS`, the browser blocks
`POST /calls/authorize` and the caller is told **"We couldn't reach CallaStar"** —
accurate, but the cause is configuration rather than a network fault or an absent
host. Our own browser tests hit this exact wall.

```bash
# Correct: the web app's origin, explicitly.
SIGNALING_ALLOWED_ORIGINS=https://app.example.com

# Several origins are fine.
SIGNALING_ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com
```

Never `*`. This endpoint mints call credentials, and a wildcard would let any
site on the internet ask for one on a visitor's behalf.

To check it without a phone:

```bash
curl -i -X POST https://<signalling-host>/calls/authorize \
  -H 'Origin: https://app.example.com' \
  -H 'content-type: application/json' \
  -d '{"callId":"CS-0000-0000-0000"}'
```

Look for `Access-Control-Allow-Origin` in the response headers. If it is absent,
a browser will block the call even though `curl` was perfectly happy.

## Guest and host must be separate sessions

The development admin session lives in `sessionStorage` and profiles live in
IndexedDB. Two tabs of the same browser profile share both, so a "guest" tab
would also be signed into the dashboard.

- **Guest** — a normal window, or one phone
- **Host** — a different browser profile, or a second phone, signed into
  `/admin` with Receive Calls on

Both devices need the profile present, because in local mode each browser
resolves the Call ID against its own IndexedDB. Create it once per device
through Admin → Profiles, or use the same Call ID on both after creating it on
each.

## Checklist before you call anything tested

- [ ] Both services on HTTPS / WSS
- [ ] `VITE_SIGNALING_URL` uses `wss://`
- [ ] Web app origin in `SIGNALING_ALLOWED_ORIGINS`
- [ ] `Access-Control-Allow-Origin` present in the `curl` check above
- [ ] The profile exists on both devices, and is **Active**
- [ ] Receive Calls is on, and the card says **Available**
- [ ] TURN configured, if the devices are not on one Wi-Fi network

Then work through [`REAL_DEVICE_CALL_QA.md`](./REAL_DEVICE_CALL_QA.md).
