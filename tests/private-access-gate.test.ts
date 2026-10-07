import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  ACCESS_COOKIE_NAME,
  clearAccessCookie,
  createAccessCookie,
  createAccessToken,
  createVerificationRateLimiter,
  isValidAccessToken,
  readAccessCookie,
} from "../netlify/edge-functions/_shared/access-gate.mjs"
import { createPrivateAccessHandler } from "../netlify/edge-functions/private-access"

const SIGNING_SECRET = "private-access-test-signing-secret-0123456789"

function makeContext(ip = "192.0.2.10") {
  const next = vi.fn(
    async () => new Response("private application response", { status: 200 }),
  )
  return { ip, next }
}

function makeHandler(overrides: Record<string, string> = {}) {
  const values = {
    ACCESS_GATE_SECRET: SIGNING_SECRET,
    TURNSTILE_SITE_KEY: "public-test-site-key",
    TURNSTILE_SECRET_KEY: "server-test-secret-key",
    ...overrides,
  }
  return createPrivateAccessHandler({
    getEnv: (key) => values[key] ?? "",
    limiter: createVerificationRateLimiter(),
  })
}

function makeVerifyRequest(body: unknown, origin = "https://callastar.test") {
  return new Request("https://callastar.test/api/verify-human", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("signed private-access cookie", () => {
  it("signs a versioned payload and issues the intended secure cookie", async () => {
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

  it("rejects forged, altered, malformed, wrong-secret, and expired tokens", async () => {
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

    expect(await isValidAccessToken("verified=true", SIGNING_SECRET, now)).toBe(
      false,
    )
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

  it("reads only the exact cookie name and clears it using secure attributes", () => {
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

describe("Netlify edge access gate", () => {
  it.each(["/", "/shipment/123", "/support/abc", "/admin", "/admin/settings"])(
    "withholds the app at direct route %s until the cookie verifies",
    async (path) => {
      const handler = makeHandler()
      const context = makeContext()
      const response = await handler(
        new Request(`https://callastar.test${path}`),
        context,
      )
      const html = await response!.text()

      expect(response!.status).toBe(200)
      expect(response!.headers.get("x-robots-tag")).toContain("noindex")
      expect(html).toContain("Checking your browser…")
      expect(html).not.toContain("private application response")
      expect(html).not.toContain("/src/main.tsx")
      expect(context.next).not.toHaveBeenCalled()
    },
  )

  it("denies forged or expired cookies and passes a valid signed cookie through", async () => {
    const handler = makeHandler()
    const now = Date.now()
    const valid = await createAccessToken(SIGNING_SECRET, now)
    const expired = await createAccessToken(
      SIGNING_SECRET,
      now - (ACCESS_COOKIE_MAX_AGE_SECONDS + 1) * 1000,
    )

    for (const cookie of ["human_verified=true", `human_verified=${expired}`]) {
      const deniedContext = makeContext()
      const denied = await handler(
        new Request("https://callastar.test/admin", { headers: { cookie } }),
        deniedContext,
      )
      expect(denied!.headers.get("content-type")).toContain("text/html")
      expect(deniedContext.next).not.toHaveBeenCalled()
    }

    const allowedContext = makeContext()
    const allowed = await handler(
      new Request("https://callastar.test/admin", {
        headers: { cookie: `human_verified=${valid}` },
      }),
      allowedContext,
    )
    expect(await allowed!.text()).toBe("private application response")
    expect(allowed!.headers.get("x-robots-tag")).toContain("nosnippet")
    expect(allowedContext.next).toHaveBeenCalledOnce()
  })

  it("allows robots.txt through the edge and applies noindex headers", async () => {
    const handler = makeHandler()
    const context = {
      ...makeContext(),
      next: vi.fn(
        async () =>
          new Response("User-agent: *\nDisallow: /\n", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    }
    const response = await handler(
      new Request("https://callastar.test/robots.txt"),
      context,
    )

    expect(await response!.text()).toBe("User-agent: *\nDisallow: /\n")
    expect(response!.headers.get("x-robots-tag")).toContain("noindex")
    expect(context.next).toHaveBeenCalledOnce()
  })

  it("issues an HttpOnly cookie only after successful same-host Turnstile validation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: "callastar.test",
            action: "private_access",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const handler = makeHandler()
    const response = await handler(
      makeVerifyRequest({ token: "turnstile-token" }),
      makeContext(),
    )
    const setCookie = response!.headers.get("set-cookie") ?? ""
    const token = readAccessCookie(setCookie)

    expect(response!.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await isValidAccessToken(token, SIGNING_SECRET)).toBe(true)
    expect(setCookie).toContain("HttpOnly; Secure; SameSite=Lax")
    expect(response!.headers.get("cache-control")).toContain("no-store")
  })

  it("fails closed for missing tokens, wrong origins, challenge rejection, and missing secrets", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: "callastar.test",
            action: "wrong_action",
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const handler = makeHandler()

    const missing = await handler(makeVerifyRequest({}), makeContext())
    const wrongOrigin = await handler(
      makeVerifyRequest({ token: "token" }, "https://attacker.test"),
      makeContext(),
    )
    const rejected = await handler(
      makeVerifyRequest({ token: "token" }),
      makeContext(),
    )
    const noSecret = await makeHandler({
      ACCESS_GATE_SECRET: "",
      TURNSTILE_SECRET_KEY: "",
    })(makeVerifyRequest({ token: "token" }), makeContext())

    expect(missing!.status).toBe(400)
    expect(wrongOrigin!.status).toBe(403)
    expect(rejected!.status).toBe(403)
    expect(noSecret!.status).toBe(503)
    for (const response of [missing!, wrongOrigin!, rejected!, noSecret!]) {
      expect(response.headers.has("set-cookie")).toBe(false)
      expect(await response.json()).toEqual({ error: "verification_failed" })
    }
  })

  it("clears access only for same-origin POST requests", async () => {
    const handler = makeHandler()
    const denied = await handler(
      new Request("https://callastar.test/api/clear-access", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      makeContext(),
    )
    const cleared = await handler(
      new Request("https://callastar.test/api/clear-access", {
        method: "POST",
        headers: { origin: "https://callastar.test" },
      }),
      makeContext(),
    )

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
