# Private site access gate

CallaStar's Netlify Edge Function gates every incoming application route before
static assets or the SPA rewrite are served. Without a valid `human_verified`
cookie, the edge returns a self-contained CallaStar confirmation page; it does
not load the application bundle or request application data. The manual gate
reduces casual automated access and provides an intentional user confirmation
step. It is not sophisticated bot detection and is not authentication.

The signed cookie controls only access to the public website. Admin access
continues to require Supabase Auth and the existing administrator authorization
checks. Supabase RLS, Edge Function authorization, and private storage policies
remain the authorization boundary for application data and APIs. The human
verification cookie never authorizes admin API calls.

## Netlify environment variable

Configure `ACCESS_GATE_SECRET` in Netlify's environment settings with the Edge
Functions scope enabled. Use at least 32 cryptographically random bytes. This
is the only gate-specific secret. Do not place it in a `VITE_` variable,
frontend source, HTML, or a committed environment file. It is intentionally
absent from `.env.example` because the Netlify edge runtime is its only
consumer.

Generate a value with a secure generator, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Confirmation nonce and cookie

The verification page keeps the compact confirmation-bar design: one checkbox is
the only initial control. Checking it submits automatically after the short
interaction delay; a separate Continue button or third-party challenge is not
shown. A failed request resets the checkbox so the visitor can try again.

The edge creates a random, versioned confirmation nonce with an issue time and
an expiry 10 minutes later, then signs its payload using HMAC-SHA-256 and
`ACCESS_GATE_SECRET`. The browser cannot mint a valid nonce. The verify endpoint
accepts a confirmation only after the nonce signature, purpose, age, confirmation
flag, honeypot, request origin, and host are checked. A 900 ms minimum elapsed
time is required; this brief interaction check is not bot detection.

After a valid confirmation, the edge signs a versioned cookie payload containing
`issuedAt`, `expiresAt`, and a random nonce. Every protected request checks the
signature and expiry. Forged values such as `human_verified=true`, altered
signatures, expired tokens, and tokens signed by another key are rejected. The
cookie lasts 30 days and is `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.

- `POST /api/verify-human` validates the signed nonce and issues the cookie.
- `POST /api/clear-access` clears the cookie; it does not grant access.

Verification attempts are limited to 20 per 10 minutes per client IP within an
edge runtime instance. Instances do not share this in-memory counter, so it is
not a globally authoritative rate limit. Use a persistent rate-limit service or
provider firewall rule if a distributed hard limit is required.

Verification accepts only the production origin `https://callastar.netlify.app`
and the explicit local origins `http://localhost:5173` and
`http://localhost:8443`. Wildcard CORS is not used.

## Request handling and crawling

The gate covers SPA routes, including direct deep links such as `/admin/login`,
and static `/assets/*.js` and `/assets/*.css` requests. Only the robots file,
favicon resources, the service-worker script (so existing installs can update),
and the two gate endpoints are available before verification. The robots file
and HTML/HTTP directives (`noindex`, `nofollow`, and
`X-Robots-Tag`) remain enabled. The verification page uses inline HTML, CSS, and
JavaScript only; it does not load the app bundle or third-party verification
services.

The Netlify edge mapping in `netlify.toml` remains on `/*` ahead of the SPA
rewrite. API routes on the Supabase origin are not made public by this site gate
and must continue to enforce their own authorization and RLS policies. PWA
service-worker navigation requests remain network-first, so the edge gate stays
authoritative for protected access.

The focused unit tests cover nonce and cookie signatures, tampering, expiry,
rate limiting, origin and host checks, the honeypot, direct route and asset
gating, robots headers, and cookie clearing. The browser tests cover the
checkbox and keyboard behavior, submit/retry flow, and mobile, tablet, and
desktop viewport widths.
