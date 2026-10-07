export const ACCESS_COOKIE_NAME = "human_verified"
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const VERIFY_WINDOW_MS = 10 * 60 * 1000
export const VERIFY_ATTEMPT_LIMIT = 20

const encoder = new TextEncoder()

function base64UrlEncode(bytes) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function signingKey(secret) {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32)
    return null
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

export async function createAccessToken(secret, now = Date.now()) {
  const key = await signingKey(secret)
  if (!key) throw new Error("Access gate signing key is not configured.")

  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)))
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        version: 1,
        issuedAt: now,
        expiresAt: now + ACCESS_COOKIE_MAX_AGE_SECONDS * 1000,
        nonce,
      }),
    ),
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  )
  return `${payload}.${base64UrlEncode(signature)}`
}

export async function isValidAccessToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1200) return false
  const [payloadPart, signaturePart, extra] = token.split(".")
  if (!payloadPart || !signaturePart || extra !== undefined) return false

  const signature = base64UrlDecode(signaturePart)
  const payloadBytes = base64UrlDecode(payloadPart)
  const key = await signingKey(secret)
  if (!signature || signature.byteLength !== 32 || !payloadBytes || !key)
    return false

  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return false
  }

  if (
    payload?.version !== 1 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{20,40}$/.test(payload.nonce) ||
    payload.issuedAt > now + 60_000 ||
    payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > ACCESS_COOKIE_MAX_AGE_SECONDS * 1000
  ) {
    return false
  }

  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(payloadPart),
  )
}

export function createAccessCookie(token) {
  return `${ACCESS_COOKIE_NAME}=${token}; Max-Age=${ACCESS_COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function clearAccessCookie() {
  return `${ACCESS_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function readAccessCookie(cookieHeader = "") {
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=")
    if (separator < 0 || pair.slice(0, separator).trim() !== ACCESS_COOKIE_NAME)
      continue
    return pair.slice(separator + 1).trim()
  }
  return ""
}

export function createVerificationRateLimiter({
  limit = VERIFY_ATTEMPT_LIMIT,
  windowMs = VERIFY_WINDOW_MS,
} = {}) {
  const attempts = new Map()

  return (key, now = Date.now()) => {
    const active = (attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > now - windowMs,
    )
    if (active.length >= limit) {
      attempts.set(key, active)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((active[0] + windowMs - now) / 1000),
        ),
      }
    }

    active.push(now)
    attempts.set(key, active)

    if (attempts.size > 10_000) {
      for (const [attemptKey, timestamps] of attempts) {
        if (!timestamps.some((timestamp) => timestamp > now - windowMs))
          attempts.delete(attemptKey)
      }
    }

    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export function renderVerificationPage(siteKey = "") {
  const safeSiteKey = JSON.stringify(siteKey)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
  const turnstileScript = siteKey
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>'
    : ""

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <meta name="googlebot" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
  <meta name="theme-color" content="#f6f5f2">
  <title>Verify access · CallaStar</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; }
    * { box-sizing: border-box; }
    html, body { min-width: 320px; min-height: 100%; margin: 0; }
    body { min-height: 100svh; overflow: hidden; color: #171918; background: #f2f1ee; }
    .backdrop { position: fixed; inset: 0; overflow: hidden; filter: blur(9px); opacity: .72; transform: scale(1.025); pointer-events: none; user-select: none; }
    .backdrop::before { position: absolute; inset: 0; content: ""; background: radial-gradient(ellipse at 78% 16%, #e7e1d3 0, transparent 32%), radial-gradient(ellipse at 14% 82%, #dddeda 0, transparent 36%), linear-gradient(135deg, #f8f7f4, #ecebe7); }
    .preview { position: relative; display: grid; grid-template-columns: 220px 1fr; gap: 20px; width: min(1040px, calc(100vw - 80px)); margin: 7vh auto 0; }
    .preview-rail, .preview-main, .preview-tile { border: 1px solid rgba(42, 47, 43, .12); background: rgba(255,255,255,.72); box-shadow: 0 18px 60px rgba(37, 40, 36, .07); }
    .preview-rail { min-height: 70vh; padding: 24px 18px; border-radius: 24px; }
    .brand { display: flex; align-items: center; gap: 12px; color: #242925; font-size: 14px; font-weight: 650; }
    .brand-mark { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 12px; background: #141917; color: #fff; font-family: Georgia, serif; font-size: 20px; }
    .rail-line { height: 10px; margin-top: 36px; border-radius: 20px; background: #e8e7e2; }
    .rail-line:nth-child(3) { width: 72%; margin-top: 22px; }
    .rail-line:nth-child(4) { width: 84%; margin-top: 18px; }
    .rail-line:nth-child(5) { width: 62%; margin-top: 18px; }
    .preview-main { min-height: 70vh; padding: 34px; border-radius: 28px; }
    .preview-title { width: min(360px, 72%); height: 22px; margin: 6px 0 12px; border-radius: 20px; background: #dcded8; }
    .preview-subtitle { width: min(500px, 90%); height: 12px; border-radius: 20px; background: #e9e9e4; }
    .preview-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 40px; }
    .preview-tile { height: 230px; border-radius: 20px; background: linear-gradient(155deg, rgba(255,255,255,.86), rgba(232,233,227,.72)); }
    .scrim { position: fixed; inset: 0; background: rgba(22, 25, 23, .22); }
    .gate { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; }
    .verify-bar { position: relative; display: flex; align-items: center; gap: 14px; width: min(384px, calc(100vw - 32px)); min-height: 70px; padding: 12px 16px; border: 1px solid rgba(20, 24, 22, .12); border-radius: 16px; background: #fffefa; box-shadow: 0 20px 70px rgba(0, 0, 0, .20), 0 2px 8px rgba(0,0,0,.08); }
    .spinner { flex: 0 0 20px; width: 20px; height: 20px; border: 2px solid #d9dcd8; border-top-color: #232925; border-radius: 50%; animation: spin .85s linear infinite; }
    .message { flex: 1; min-width: 0; color: #202522; font-size: 14px; font-weight: 550; line-height: 1.35; }
    .check-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; cursor: pointer; }
    .check-row input { appearance: none; display: grid; flex: 0 0 22px; width: 22px; height: 22px; margin: 0; place-content: center; border: 1.5px solid #9b9f9a; border-radius: 6px; background: #fff; cursor: pointer; }
    .check-row input::before { width: 10px; height: 6px; border-bottom: 2px solid white; border-left: 2px solid white; content: ""; transform: rotate(-45deg) scale(0); }
    .check-row input:checked { border-color: #191e1b; background: #191e1b; }
    .check-row input:checked::before { transform: rotate(-45deg) scale(1); }
    .check-row input:focus-visible, .retry:focus-visible { outline: 3px solid #68776d; outline-offset: 3px; }
    .retry { border: 0; border-radius: 9px; padding: 9px 12px; color: white; background: #202622; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
    .retry:hover { background: #39413b; }
    .check-row[hidden], .spinner[hidden], .retry[hidden] { display: none; }
    .turnstile-host { position: absolute; top: calc(100% + 8px); left: 50%; z-index: 2; width: 300px; min-height: 0; transform: translateX(-50%); }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 600px) {
      .preview { grid-template-columns: 1fr; width: calc(100vw - 40px); margin-top: 5vh; }
      .preview-rail { display: none; }
      .preview-main { min-height: 82vh; padding: 22px; }
      .preview-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 30px; }
      .preview-tile { height: 150px; }
      .verify-bar { gap: 12px; min-height: 68px; padding: 10px 14px; }
      .message { font-size: 13px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
    }
  </style>
  ${turnstileScript}
</head>
<body>
  <div class="backdrop" aria-hidden="true">
    <div class="preview"><aside class="preview-rail"><div class="brand"><span class="brand-mark">C</span><span>CallaStar</span></div><div class="rail-line"></div><div class="rail-line"></div><div class="rail-line"></div><div class="rail-line"></div></aside><main class="preview-main"><div class="preview-title"></div><div class="preview-subtitle"></div><div class="preview-grid"><div class="preview-tile"></div><div class="preview-tile"></div><div class="preview-tile"></div></div></main></div>
  </div>
  <div class="scrim" aria-hidden="true"></div>
  <main class="gate" aria-label="Human verification">
    <section class="verify-bar" aria-live="polite" aria-atomic="true">
      <span class="spinner" id="spinner" aria-hidden="true"></span>
      <span class="message" id="status" role="status">Checking your browser…</span>
      <label class="check-row" id="check-row" hidden><input id="human-check" type="checkbox"><span>Please confirm you're human</span></label>
      <button class="retry" id="retry" type="button" hidden>Try again</button>
      <div class="turnstile-host" id="turnstile-host"></div>
    </section>
  </main>
  <script>
    (() => {
      const siteKey = ${safeSiteKey};
      const status = document.getElementById("status");
      const spinner = document.getElementById("spinner");
      const checkRow = document.getElementById("check-row");
      const checkbox = document.getElementById("human-check");
      const retry = document.getElementById("retry");
      let widgetId = null;
      let busy = false;
      let submitted = false;

      function showFailure() {
        busy = false;
        submitted = false;
        spinner.hidden = true;
        checkRow.hidden = true;
        retry.hidden = false;
        status.textContent = "Verification couldn't be completed. Please try again.";
        checkbox.checked = false;
      }

      async function submitToken(token) {
        if (!token || !busy) return showFailure();
        if (submitted) return;
        submitted = true;
        try {
          const response = await fetch("/api/verify-human", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) return showFailure();
          status.textContent = "✓ Verification complete";
          spinner.hidden = true;
          window.setTimeout(() => window.location.reload(), 550);
        } catch {
          showFailure();
        }
      }

      function setUpWidget() {
        if (!siteKey || !window.turnstile || widgetId !== null) return;
        widgetId = window.turnstile.render("#turnstile-host", {
          sitekey: siteKey,
          action: "private_access",
          appearance: "interaction-only",
          execution: "execute",
          theme: "light",
          callback: submitToken,
          "error-callback": showFailure,
          "expired-callback": showFailure,
        });
      }

      if (window.turnstile) setUpWidget();
      else {
        const script = document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]');
        if (script) script.addEventListener("load", setUpWidget, { once: true });
      }

      window.setTimeout(() => {
        spinner.hidden = true;
        status.textContent = "";
        checkRow.hidden = false;
        checkbox.focus({ preventScroll: true });
      }, 1100);

      checkbox.addEventListener("change", () => {
        if (!checkbox.checked || busy) return;
        busy = true;
        submitted = false;
        checkRow.hidden = true;
        retry.hidden = true;
        spinner.hidden = false;
        status.textContent = "Verifying…";
        setUpWidget();
        if (!widgetId || !window.turnstile) return showFailure();
        try { window.turnstile.execute(widgetId); } catch { showFailure(); }
      });

      checkbox.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || checkbox.disabled) return;
        event.preventDefault();
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      });

      retry.addEventListener("click", () => {
        busy = false;
        submitted = false;
        retry.hidden = true;
        status.textContent = "";
        checkRow.hidden = false;
        checkbox.checked = false;
        if (widgetId !== null && window.turnstile) {
          try { window.turnstile.reset(widgetId); } catch { widgetId = null; }
        }
        checkbox.focus({ preventScroll: true });
      });
    })();
  </script>
</body>
</html>`
}
