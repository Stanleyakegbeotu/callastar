# Private site access gate

CallaStar's Netlify Edge Function gates every incoming path before static
assets and the SPA rewrite are served. Without a valid `human_verified` cookie,
the edge returns a small verification document with a neutral CallaStar-branded
background. It does not load the application bundle or request application
data. The visual blur is only a backdrop; it is not used to conceal loaded
private content.

The same policy applies to every visitor. There is no user-agent or crawler
detection. `robots.txt`, the HTML robots directives, and the `X-Robots-Tag`
header discourage compliant crawlers, while the signed cookie controls page
access. This does not guarantee that sophisticated automation cannot access the
site. Supabase RLS, admin authorization, and private storage policies remain the
authorization boundary for application data and APIs.

## Netlify environment variables

Set these in Netlify's environment-variable settings, with the **Functions**
scope enabled, then create a new deploy. Do not put them in `netlify.toml`, a
`VITE_` variable, frontend source, or a committed environment file.

| Variable | Purpose |
| --- | --- |
| `ACCESS_GATE_SECRET` | Random signing secret; use at least 32 random bytes. |
| `TURNSTILE_SITE_KEY` | Public Turnstile site key emitted into the verification document. |
| `TURNSTILE_SECRET_KEY` | Server-only key used to validate challenge tokens. |

Generate the signing secret with a cryptographically secure generator, for
example `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
The code fails closed if the signing or challenge secret is missing or invalid.
Use a real Turnstile widget for each deployed hostname; Cloudflare's published
test keys belong only in local automated test environments.

## Cookie and endpoints

After Turnstile Siteverify returns success for the current hostname and the
`private_access` action, the edge signs a versioned payload containing `issuedAt`,
`expiresAt`, and a random nonce with HMAC-SHA-256. The cookie contains the
base64url payload and signature. Every protected request verifies the signature
and expiration before it can reach the SPA. The 30-day cookie is `HttpOnly`,
`Secure`, `SameSite=Lax`, and `Path=/`.

- `POST /api/verify-human` validates the token server-side and issues the cookie
  only after successful validation.
- `POST /api/clear-access` clears the cookie. It does not grant access.

Verification attempts have a 20-per-10-minute sliding-window limit per client
IP within each edge runtime instance. Edge instances do not share this in-memory
counter, so use a persistent rate-limit service or provider firewall rule if a
distributed hard limit is required. Existing backend APIs continue to enforce
their own authentication, authorization, and RLS.

## Request handling and testing

The edge allows the robots file and favicon through without verification. The
verification interface is self-contained; other assets and application routes
are withheld until the cookie verifies. API routes on the Supabase origin are
not made public by this site gate and must continue to enforce their backend
policies.

Local unit tests exercise valid, malformed, forged, altered, and expired tokens;
direct root and deep-link requests; the verify and clear endpoints; and rate
limits. The browser test covers the compact interface at phone, tablet, and
desktop widths, keyboard activation, loading, success, failure, and retry. The
Netlify Functions-scoped environment variables still need to be configured in
the target Netlify site before a real Turnstile challenge can pass there.
