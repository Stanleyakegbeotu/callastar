import { describe, expect, it, vi } from "vitest"

import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  ACCESS_COOKIE_NAME,
  clearAccessCookie,
  createAccessCookie,
  createAccessToken,
  createVerificationNonce,
  createVerificationRateLimiter,
  isValidAccessToken,
  readAccessCookie,
  readValidVerificationNonce,
  VERIFY_MIN_INTERACTION_MS,
  VERIFY_NONCE_MAX_AGE_MS,
} from "../netlify/edge-functions/_shared/access-gate.mjs"
import { createPrivateAccessHandler } from "../netlify/edge-functions/private-access"

const SIGNING_SECRET = "private-access-test-signing-secret-0123456789"
const SITE_ORIGIN = "https://callastar.netlify.app"

function makeContext(ip = "192.0.2.10") {
  const next = vi.fn(
    async () => new Response("private application response", { status: 200 }),
  )
  return { ip, next }
}

function makeHandler(secret = SIGNING_SECRET) {
  return createPrivateAccessHandler({
    getEnv: (key) => (key === "ACCESS_GATE_SECRET" ? secret : ""),
    limiter: createVerificationRateLimiter(),
  })
}

function makeVerifyRequest(body: unknown, origin = SITE_ORIGIN) {
  return new Request(`${SITE_ORIGIN}/api/verify-human`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("signed private-access cookie", () => {
  it("issues the intended 30-day secure, HttpOnly cookie", async () => {
    const now = 1_800_000_000_000
    const token = await createAccessToken(SIGNING_SECRET, now)
    const cookie = createAccessCookie(token)

    expect(await isValidAccessToken(token, SIGNING_SECRET, now + 1000)).toBe(
      true,
    )
    expect(cookie).toContain(`${ACCESS_COOKIE_NAME}=`)
    expect(cookie).toContain(`Max-Age=${ACCESS_COOKIE_MAX_AGE_SECONDS}`)
    expect(cookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax")
  })

  it("rejects forged, altered, malformed, wrong-secret, and expired cookies", async () => {
    const now = 1_800_000_000_000
    const token = await createAccessToken(SIGNING_SECRET, now)
    const [payload, signature] = token.split(".")
    const changedSignature = `${
      signature.startsWith("A") ? "B" : "A"
    }${signature.slice(1)}`
    const expired = await createAccessToken(
      SIGNING_SECRET,
      now - (ACCESS_COOKIE_MAX_AGE_SECONDS + 10) * 1000,
    )

    expect(await isValidAccessToken("true", SIGNING_SECRET, now)).toBe(false)
    expect(
      await isValidAccessToken(
        `${payload}.${changedSignature}`,
        SIGNING_SECRET,
        now,
      ),
    ).toBe(false)
    expect(
      await isValidAccessToken(
        token,
        "a-different-signing-secret-that-is-long-enough",
        now,
      ),
    ).toBe(false)
    expect(await isValidAccessToken(expired, SIGNING_SECRET, now)).toBe(false)
    expect(
      await isValidAccessToken("not.a.valid.token", SIGNING_SECRET, now),
    ).toBe(false)
  })

  it("reads only the exact cookie name and clears it with matching attributes", () => {
    expect(
      readAccessCookie("other=x; human_verified=signed.payload; session=y"),
    ).toBe("signed.payload")
    expect(readAccessCookie("not_human_verified=true")).toBe("")
    expect(clearAccessCookie()).toContain("Max-Age=0; Expires=")
    expect(clearAccessCookie()).toContain(
      "Path=/; HttpOnly; Secure; SameSite=Lax",
    )
  })
})

describe("signed manual-verification nonce", () => {
  it("is random, signed, short-lived, and rejects tampering and expiry", async () => {
    const now = 1_800_000_000_000
    const nonce = await createVerificationNonce(SIGNING_SECRET, now)
    const secondNonce = await createVerificationNonce(SIGNING_SECRET, now)
    const [payload, signature] = nonce.split(".")
    const tampered = `${payload}.${
      signature.startsWith("A") ? "B" : "A"
    }${signature.slice(1)}`

    expect(nonce).not.toBe(secondNonce)
    expect(
      await readValidVerificationNonce(nonce, SIGNING_SECRET, now + 1000),
    ).toMatchObject({
      version: 1,
      purpose: "human-confirmation",
      issuedAt: now,
      expiresAt: now + VERIFY_NONCE_MAX_AGE_MS,
    })
    expect(
      await readValidVerificationNonce(tampered, SIGNING_SECRET, now),
    ).toBeNull()
    expect(
      await readValidVerificationNonce(
        nonce,
        SIGNING_SECRET,
        now + VERIFY_NONCE_MAX_AGE_MS,
      ),
    ).toBeNull()
  })
})

describe("Netlify edge access gate", () => {
  it("returns a protected non-HTML error for expired-cookie module requests", async () => {
    const context = makeContext();
    const response = await makeHandler()(new Request(`${SITE_ORIGIN}/assets/app.js`), context);
    expect(response!.status).toBe(403);
    expect(response!.headers.get("content-type")).toContain("application/json");
    expect(context.next).not.toHaveBeenCalled();
    const token = await createAccessToken(SIGNING_SECRET);
    const allowed = await makeHandler()(new Request(`${SITE_ORIGIN}/assets/app.js`, { headers: { cookie: `human_verified=${token}` } }), context);
    expect(allowed!.status).toBe(200);
    expect(context.next).toHaveBeenCalledOnce();
  });
  it.each([
    "/",
    "/connect",
    "/join/abc",
    "/call/abc",
    "/support/abc",
    "/admin/login",
    "/admin/settings",
  ])(
    "withholds app and assets at direct route %s until the cookie verifies",
    async (path) => {
      const context = makeContext()
      const response = await makeHandler()(
        new Request(`${SITE_ORIGIN}${path}`),
        context,
      )
      const html = await response!.text()

      expect(response!.status).toBe(200)
      expect(response!.headers.get("x-robots-tag")).toContain("noindex")
      expect(html).toContain('class="verify-bar"')
      expect(html).toContain("Please confirm you're human")
      expect(html).not.toContain("Human Verification")
      expect(html).not.toContain('id="continue"')
      expect(html).toContain('name="robots" content="noindex,nofollow')
      expect(html).toContain("safe-area-inset-bottom")
      expect(html).not.toContain("private application response")
      expect(html).not.toContain("/src/main.tsx")
      expect(html).not.toContain('<script type="module"')
      expect(context.next).not.toHaveBeenCalled()
    },
  )

  it("adds a fresh signed nonce to the self-contained, noindex page", async () => {
    const context = makeContext()
    const response = await makeHandler()(
      new Request(`${SITE_ORIGIN}/admin/login`),
      context,
    )
    const html = await response!.text()
    const nonce = html.match(/const nonce = ("[^"]+")/)?.[1]

    expect(response!.headers.get("cache-control")).toContain("no-store")
    expect(response!.headers.get("content-security-policy")).not.toContain(
      "cloudflare",
    )
    expect(nonce).toBeTruthy()
    expect(
      await readValidVerificationNonce(JSON.parse(nonce!), SIGNING_SECRET),
    ).not.toBeNull()
  })

  it("rejects forged and expired cookies while allowing a valid signed cookie", async () => {
    const now = Date.now()
    const valid = await createAccessToken(SIGNING_SECRET, now)
    const expired = await createAccessToken(
      SIGNING_SECRET,
      now - (ACCESS_COOKIE_MAX_AGE_SECONDS + 1) * 1000,
    )

    for (const cookie of ["human_verified=true", `human_verified=${expired}`]) {
      const deniedContext = makeContext()
      const denied = await makeHandler()(
        new Request(`${SITE_ORIGIN}/admin`, { headers: { cookie } }),
        deniedContext,
      )
      expect(denied!.headers.get("content-type")).toContain("text/html")
      expect(deniedContext.next).not.toHaveBeenCalled()
    }

    const allowedContext = makeContext()
    const allowed = await makeHandler()(
      new Request(`${SITE_ORIGIN}/admin`, {
        headers: { cookie: `human_verified=${valid}` },
      }),
      allowedContext,
    )
    expect(await allowed!.text()).toBe("private application response")
    expect(allowed!.headers.get("x-robots-tag")).toContain("nosnippet")
  })

  it.each(["/robots.txt", "/sw.js"])(
    "allows the %s technical resource through with noindex headers",
    async (path) => {
      const body =
        path === "/robots.txt"
          ? "User-agent: *\nDisallow: /\n"
          : "self.addEventListener('fetch', () => {})"
      const context = {
        ...makeContext(),
        next: async () =>
          new Response(body, { headers: { "content-type": "text/plain" } }),
      }
      const response = await makeHandler()(
        new Request(`${SITE_ORIGIN}${path}`),
        context,
      )
      expect(await response!.text()).toBe(body)
      expect(response!.headers.get("x-robots-tag")).toContain("noindex")
    },
  )

  it("issues a signed cookie for confirmed visitors with a valid nonce", async () => {
    const nonce = await createVerificationNonce(
      SIGNING_SECRET,
      Date.now() - VERIFY_MIN_INTERACTION_MS - 100,
    )
    const response = await makeHandler()(
      makeVerifyRequest({ confirmed: true, nonce, honeypot: "" }),
      makeContext(),
    )
    const setCookie = response!.headers.get("set-cookie") ?? ""

    expect(response!.status).toBe(200)
    expect(
      await isValidAccessToken(readAccessCookie(setCookie), SIGNING_SECRET),
    ).toBe(true)
    expect(setCookie).toContain("HttpOnly; Secure; SameSite=Lax")
    expect(response!.headers.get("cache-control")).toContain("no-store")
  })

  it("accepts the explicit local development origin", async () => {
    const origin = "http://localhost:5173"
    const nonce = await createVerificationNonce(
      SIGNING_SECRET,
      Date.now() - VERIFY_MIN_INTERACTION_MS - 100,
    )
    const request = new Request(`${origin}/api/verify-human`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, nonce, honeypot: "" }),
    })
    const response = await makeHandler()(request, makeContext())

    expect(response!.status).toBe(200)
  })

  it("rejects missing, tampered, expired, too-fast, or unconfirmed requests", async () => {
    const fresh = await createVerificationNonce(SIGNING_SECRET, Date.now())
    const expired = await createVerificationNonce(
      SIGNING_SECRET,
      Date.now() - VERIFY_NONCE_MAX_AGE_MS - 1,
    )
    const [payload, signature] = fresh.split(".")
    const tampered = `${payload}.${
      signature.startsWith("A") ? "B" : "A"
    }${signature.slice(1)}`
    const handler = makeHandler()
    const tooFast = await handler(
      makeVerifyRequest({ confirmed: true, nonce: fresh, honeypot: "" }),
      makeContext(),
    )
    const requests = [
      makeVerifyRequest({ confirmed: true, nonce: "", honeypot: "" }),
      makeVerifyRequest({ confirmed: true, nonce: tampered, honeypot: "" }),
      makeVerifyRequest({ confirmed: true, nonce: expired, honeypot: "" }),
      makeVerifyRequest({ confirmed: false, nonce: fresh, honeypot: "" }),
    ]
    expect(tooFast!.status).toBe(403)
    for (const request of requests) {
      const response = await handler(request, makeContext())
      expect(response!.status).not.toBe(200)
      expect(response!.headers.has("set-cookie")).toBe(false)
    }
  })

  it("rejects a populated honeypot, wrong origin, mismatched host, and missing gate secret", async () => {
    const nonce = await createVerificationNonce(
      SIGNING_SECRET,
      Date.now() - VERIFY_MIN_INTERACTION_MS - 100,
    )
    const handler = makeHandler()
    const honeypot = await handler(
      makeVerifyRequest({ confirmed: true, nonce, honeypot: "bot" }),
      makeContext(),
    )
    const wrongOrigin = await handler(
      makeVerifyRequest(
        { confirmed: true, nonce, honeypot: "" },
        "https://attacker.test",
      ),
      makeContext(),
    )
    const wrongHost = await handler(
      new Request(`${SITE_ORIGIN}/api/verify-human`, {
        method: "POST",
        headers: {
          origin: SITE_ORIGIN,
          host: "attacker.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirmed: true, nonce, honeypot: "" }),
      }),
      makeContext(),
    )
    const noSecret = await makeHandler("")(
      makeVerifyRequest({ confirmed: true, nonce, honeypot: "" }),
      makeContext(),
    )

    expect(honeypot!.status).toBe(400)
    expect(wrongOrigin!.status).toBe(403)
    expect(wrongHost!.status).toBe(403)
    expect(noSecret!.status).toBe(503)
  })

  it("requires POST for verification and clears access only on same-origin POST", async () => {
    const handler = makeHandler()
    const wrongMethod = await handler(
      new Request(`${SITE_ORIGIN}/api/verify-human`),
      makeContext(),
    )
    const denied = await handler(
      new Request(`${SITE_ORIGIN}/api/clear-access`, {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      makeContext(),
    )
    const cleared = await handler(
      new Request(`${SITE_ORIGIN}/api/clear-access`, {
        method: "POST",
        headers: { origin: SITE_ORIGIN },
      }),
      makeContext(),
    )

    expect(wrongMethod!.status).toBe(405)
    expect(denied!.status).toBe(403)
    expect(cleared!.status).toBe(200)
    expect(cleared!.headers.get("set-cookie")).toContain("Max-Age=0")
  })
})

describe("verification rate limit", () => {
  it("limits repeated verification attempts and resets after the window", () => {
    const limit = createVerificationRateLimiter({ limit: 2, windowMs: 1000 })
    expect(limit("192.0.2.1", 1000).allowed).toBe(true)
    expect(limit("192.0.2.1", 1100).allowed).toBe(true)
    expect(limit("192.0.2.1", 1200).allowed).toBe(false)
    expect(limit("192.0.2.1", 2101).allowed).toBe(true)
    expect(limit("192.0.2.2", 1200).allowed).toBe(true)
  })
})
