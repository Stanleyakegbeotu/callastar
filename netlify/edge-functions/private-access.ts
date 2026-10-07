import {
  createAccessCookie,
  createAccessToken,
  createVerificationRateLimiter,
  clearAccessCookie,
  isValidAccessToken,
  readAccessCookie,
  renderVerificationPage,
} from "./_shared/access-gate.mjs"

const ROBOTS_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex"
const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const rateLimit = createVerificationRateLimiter()

type EdgeContext = {
  ip?: string
  next: () => Promise<Response>
}

function environment(name: string): string {
  const runtime = (globalThis as typeof globalThis & {
    Netlify?: { env?: { get: (key: string) => string | undefined } }
  }).Netlify
  return runtime?.env?.get(name) ?? ""
}

function commonHeaders(headers = new Headers()): Headers {
  headers.set("X-Robots-Tag", ROBOTS_HEADER)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  headers.set("X-Frame-Options", "DENY")
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=()",
  )
  return headers
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders?: HeadersInit,
): Response {
  const headers = commonHeaders(new Headers(extraHeaders))
  headers.set("Content-Type", "application/json; charset=utf-8")
  headers.set("Cache-Control", "no-store")
  return new Response(JSON.stringify(body), { status, headers })
}

function htmlResponse(html: string): Response {
  const headers = commonHeaders()
  headers.set("Content-Type", "text/html; charset=utf-8")
  headers.set("Cache-Control", "private, no-store, max-age=0")
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'unsafe-inline'",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "img-src data: https://challenges.cloudflare.com",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  )
  return new Response(html, { status: 200, headers })
}

function withResponseHeaders(response: Response): Response {
  const headers = commonHeaders(new Headers(response.headers))
  headers.set("Cache-Control", "private, no-store")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function getRequestCookie(request: Request): string {
  return readAccessCookie(request.headers.get("cookie") ?? "")
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function isUnprotectedTechnicalRoute(pathname: string): boolean {
  return (
    pathname === "/robots.txt" ||
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg"
  )
}

async function handleVerification(
  request: Request,
  context: EdgeContext,
  getEnv: (name: string) => string,
  limiter: ReturnType<typeof createVerificationRateLimiter>,
): Promise<Response> {
  if (request.method !== "POST")
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: "POST, OPTIONS",
    })
  if (!isSameOriginRequest(request))
    return jsonResponse({ error: "verification_failed" }, 403)

  const attempt = limiter(context.ip || "unknown")
  if (!attempt.allowed) {
    return jsonResponse({ error: "verification_failed" }, 429, {
      "Retry-After": String(attempt.retryAfterSeconds),
    })
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (declaredLength > 4096)
    return jsonResponse({ error: "verification_failed" }, 413)

  const accessSecret = getEnv("ACCESS_GATE_SECRET")
  const turnstileSecret = getEnv("TURNSTILE_SECRET_KEY")
  if (accessSecret.length < 32 || !turnstileSecret)
    return jsonResponse({ error: "verification_failed" }, 503)

  let bodyText = ""
  try {
    const reader = request.body?.getReader()
    if (!reader) return jsonResponse({ error: "verification_failed" }, 400)
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > 4096) {
        await reader.cancel()
        return jsonResponse({ error: "verification_failed" }, 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    bodyText = new TextDecoder().decode(bytes)
  } catch {
    return jsonResponse({ error: "verification_failed" }, 400)
  }
  let token = ""
  try {
    const body = JSON.parse(bodyText)
    token = typeof body?.token === "string" ? body.token : ""
  } catch {
    return jsonResponse({ error: "verification_failed" }, 400)
  }
  if (!token || token.length > 2048)
    return jsonResponse({ error: "verification_failed" }, 400)

  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: turnstileSecret,
        response: token,
        remoteip: context.ip,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return jsonResponse({ error: "verification_failed" }, 503)
    const result = await response.json()
    const expectedHostname = new URL(request.url).hostname
    if (
      result?.success !== true ||
      result?.hostname !== expectedHostname ||
      result?.action !== "private_access"
    ) {
      return jsonResponse({ error: "verification_failed" }, 403)
    }

    const tokenCookie = await createAccessToken(accessSecret)
    return jsonResponse({ verified: true }, 200, {
      "Set-Cookie": createAccessCookie(tokenCookie),
    })
  } catch {
    return jsonResponse({ error: "verification_failed" }, 503)
  }
}

async function handleClearAccess(request: Request): Promise<Response> {
  if (request.method !== "POST")
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: "POST, OPTIONS",
    })
  if (!isSameOriginRequest(request))
    return jsonResponse({ error: "request_rejected" }, 403)
  return jsonResponse({ cleared: true }, 200, {
    "Set-Cookie": clearAccessCookie(),
  })
}

export function createPrivateAccessHandler({
  getEnv = environment,
  limiter = rateLimit,
} = {}) {
  return async (
    request: Request,
    context: EdgeContext,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname === "/api/verify-human")
      return handleVerification(request, context, getEnv, limiter)
    if (pathname === "/api/clear-access") return handleClearAccess(request)
    if (isUnprotectedTechnicalRoute(pathname))
      return withResponseHeaders(await context.next())

    const cookie = getRequestCookie(request)
    const secret = getEnv("ACCESS_GATE_SECRET")
    if (await isValidAccessToken(cookie, secret))
      return withResponseHeaders(await context.next())

    return htmlResponse(renderVerificationPage(getEnv("TURNSTILE_SITE_KEY")))
  }
}

const handler = createPrivateAccessHandler()

export default handler
