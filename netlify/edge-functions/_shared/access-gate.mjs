export const ACCESS_COOKIE_NAME = "human_verified"
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const VERIFY_WINDOW_MS = 10 * 60 * 1000
export const VERIFY_ATTEMPT_LIMIT = 20
export const VERIFY_NONCE_MAX_AGE_MS = 10 * 60 * 1000
export const VERIFY_MIN_INTERACTION_MS = 900

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
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
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

async function signPayload(payload, secret) {
  const key = await signingKey(secret)
  if (!key) throw new Error("Access gate signing key is not configured.")
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart)),
  )
  return `${payloadPart}.${base64UrlEncode(signature)}`
}

async function readSignedPayload(token, secret) {
  if (typeof token !== "string" || token.length > 1200) return null
  const [payloadPart, signaturePart, extra] = token.split(".")
  if (!payloadPart || !signaturePart || extra !== undefined) return null
  const signature = base64UrlDecode(signaturePart)
  const payloadBytes = base64UrlDecode(payloadPart)
  const key = await signingKey(secret)
  if (!signature || signature.byteLength !== 32 || !payloadBytes || !key)
    return null
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(payloadPart),
    ))
  )
    return null
  try {
    return JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
}

function hasValidTimes(payload, now, maxAgeMs) {
  return (
    Number.isSafeInteger(payload?.issuedAt) &&
    Number.isSafeInteger(payload?.expiresAt) &&
    payload.issuedAt <= now + 60_000 &&
    payload.expiresAt > now &&
    payload.expiresAt > payload.issuedAt &&
    payload.expiresAt - payload.issuedAt <= maxAgeMs
  )
}

export async function createAccessToken(secret, now = Date.now()) {
  return signPayload(
    {
      version: 1,
      issuedAt: now,
      expiresAt: now + ACCESS_COOKIE_MAX_AGE_SECONDS * 1000,
      nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(18))),
    },
    secret,
  )
}

export async function isValidAccessToken(token, secret, now = Date.now()) {
  const payload = await readSignedPayload(token, secret)
  return Boolean(
    payload?.version === 1 &&
      typeof payload.nonce === "string" &&
      /^[A-Za-z0-9_-]{20,40}$/.test(payload.nonce) &&
      hasValidTimes(payload, now, ACCESS_COOKIE_MAX_AGE_SECONDS * 1000),
  )
}

export async function createVerificationNonce(secret, now = Date.now()) {
  return signPayload(
    {
      version: 1,
      purpose: "human-confirmation",
      issuedAt: now,
      expiresAt: now + VERIFY_NONCE_MAX_AGE_MS,
      randomValue: base64UrlEncode(crypto.getRandomValues(new Uint8Array(18))),
    },
    secret,
  )
}

export async function readValidVerificationNonce(
  token,
  secret,
  now = Date.now(),
) {
  const payload = await readSignedPayload(token, secret)
  if (
    payload?.version !== 1 ||
    payload.purpose !== "human-confirmation" ||
    typeof payload.randomValue !== "string" ||
    !/^[A-Za-z0-9_-]{20,40}$/.test(payload.randomValue) ||
    !hasValidTimes(payload, now, VERIFY_NONCE_MAX_AGE_MS)
  )
    return null
  return payload
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
    if (
      separator >= 0 &&
      pair.slice(0, separator).trim() === ACCESS_COOKIE_NAME
    )
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
    if (attempts.size > 10_000)
      for (const [attemptKey, timestamps] of attempts)
        if (!timestamps.some((timestamp) => timestamp > now - windowMs))
          attempts.delete(attemptKey)
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export function renderVerificationPage(verificationNonce = "") {
  const safeNonce = JSON.stringify(verificationNonce)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex"><meta name="googlebot" content="noindex,nofollow,noarchive,nosnippet,noimageindex"><meta name="theme-color" content="#f6f5f2"><title>Verify access · CallaStar</title><style>:root{--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px)}.gate{padding:max(16px,var(--safe-top)) max(16px,var(--safe-right)) max(16px,var(--safe-bottom)) max(16px,var(--safe-left))!important}.verify-card{width:min(400px,100%)!important}.backdrop{filter:blur(5px)!important;opacity:.94!important}.backdrop:before{background:radial-gradient(ellipse at 78% 16%,rgba(10,132,255,.3) 0,transparent 35%),radial-gradient(ellipse at 14% 82%,rgba(234,243,255,.94) 0,transparent 42%),linear-gradient(150deg,#f6f9fc,#eaf3ff 54%,#f1f7ff)!important}.preview-rail,.preview-main{background:rgba(255,255,255,.64)!important;border-color:rgba(10,132,255,.16)!important}.preview-title{background:#d5e7fb!important}.preview-subtitle,.rail-line{background:#e2effd!important}.preview-tile{background:linear-gradient(155deg,rgba(255,255,255,.82),rgba(234,243,255,.72))!important}.scrim{background:rgba(7,29,66,.08)!important}.verify-card{background:rgba(255,254,250,.94)!important;backdrop-filter:blur(8px);border-color:rgba(255,255,255,.82)!important;box-shadow:0 20px 70px rgba(7,29,66,.16),0 2px 8px rgba(7,29,66,.06)!important}</style><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html,body{min-width:320px;min-height:100%;margin:0}body{min-height:100svh;color:#171918;background:#f2f1ee}.backdrop{position:fixed;inset:0;overflow:hidden;filter:blur(9px);opacity:.72;transform:scale(1.025);pointer-events:none;user-select:none}.backdrop:before{position:absolute;inset:0;content:"";background:radial-gradient(ellipse at 78% 16%,#d9e9fb 0,transparent 32%),radial-gradient(ellipse at 14% 82%,#dddeda 0,transparent 36%),linear-gradient(135deg,#f8f7f4,#ecebe7)}.preview{position:relative;display:grid;grid-template-columns:220px 1fr;gap:20px;width:min(1040px,calc(100vw - 80px));margin:7vh auto 0}.preview-rail,.preview-main,.preview-tile{border:1px solid rgba(42,47,43,.12);background:rgba(255,255,255,.72);box-shadow:0 18px 60px rgba(37,40,36,.07)}.preview-rail{min-height:70vh;padding:24px 18px;border-radius:24px}.brand{display:flex;align-items:center;gap:12px;color:#242925;font-size:14px;font-weight:650}.brand-mark{display:grid;width:36px;height:36px;place-items:center;border-radius:12px;background:#1d5eab;color:#fff;font-family:Georgia,serif;font-size:20px}.rail-line{height:10px;margin-top:36px;border-radius:20px;background:#e8e7e2}.rail-line:nth-child(3){width:72%;margin-top:22px}.rail-line:nth-child(4){width:84%;margin-top:18px}.rail-line:nth-child(5){width:62%;margin-top:18px}.preview-main{min-height:70vh;padding:34px;border-radius:28px}.preview-title{width:min(360px,72%);height:22px;margin:6px 0 12px;border-radius:20px;background:#dcded8}.preview-subtitle{width:min(500px,90%);height:12px;border-radius:20px;background:#e9e9e4}.preview-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:40px}.preview-tile{height:230px;border-radius:20px;background:linear-gradient(155deg,rgba(255,255,255,.86),rgba(232,233,227,.72))}.scrim{position:fixed;inset:0;background:rgba(22,25,23,.22)}.gate{position:fixed;inset:0;display:grid;place-items:center;padding:16px}.verify-card{width:min(400px,calc(100vw - 32px));padding:26px;border:1px solid rgba(20,24,22,.12);border-radius:20px;background:#fffefa;box-shadow:0 20px 70px rgba(0,0,0,.2),0 2px 8px rgba(0,0,0,.08)}.gate-brand{display:flex;align-items:center;gap:10px;color:#1d251f;font-size:15px;font-weight:700}.gate-brand .brand-mark{width:32px;height:32px;border-radius:10px;font-size:18px}h1{margin:24px 0 8px;font-size:24px;letter-spacing:-.02em}.intro,.message{margin:0;color:#59615b;font-size:14px;line-height:1.5}form{margin-top:24px}.check-row{display:flex;align-items:center;gap:11px;min-height:44px;color:#202522;cursor:pointer;font-size:14px;font-weight:600}.check-row input{width:20px;height:20px;margin:0;accent-color:#1d5eab;cursor:pointer}.check-row input:focus-visible,.continue:focus-visible,.retry:focus-visible{outline:3px solid #8db7eb;outline-offset:3px}.continue,.retry{width:100%;min-height:44px;margin-top:18px;border:0;border-radius:10px;color:#fff;background:#1d5eab;font:inherit;font-size:14px;font-weight:700;cursor:pointer}.continue:hover,.retry:hover{background:#174b89}.continue:disabled{cursor:not-allowed;opacity:.48}.message{min-height:21px;margin-top:16px}.retry{display:none}.retry[aria-hidden="false"]{display:block}.honeypot{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}@media(max-width:600px){.preview{grid-template-columns:1fr;width:calc(100vw - 40px);margin-top:5vh}.preview-rail{display:none}.preview-main{min-height:82vh;padding:22px}.preview-grid{grid-template-columns:repeat(2,1fr);gap:10px;margin-top:30px}.preview-tile{height:150px}.verify-card{padding:22px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
</style></head><body><div class="backdrop" aria-hidden="true"><div class="preview"><aside class="preview-rail"><div class="brand"><span class="brand-mark">C</span><span>CallaStar</span></div><div class="rail-line"></div><div class="rail-line"></div><div class="rail-line"></div><div class="rail-line"></div></aside><main class="preview-main"><div class="preview-title"></div><div class="preview-subtitle"></div><div class="preview-grid"><div class="preview-tile"></div><div class="preview-tile"></div><div class="preview-tile"></div></div></main></div></div><div class="scrim" aria-hidden="true"></div><main class="gate" aria-label="Human verification"><section class="verify-card"><div class="gate-brand"><span class="brand-mark">C</span><span>CallaStar</span></div><h1>Human Verification</h1><p class="intro">Please confirm that you're a real visitor before continuing.</p><form id="verification-form"><label class="check-row" for="human-check"><input id="human-check" type="checkbox"><span>I am a real person</span></label><label class="honeypot" aria-hidden="true">Leave this field empty<input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></label><button class="continue" id="continue" type="submit" disabled>Continue</button></form><p class="message" id="status" role="status" aria-live="polite"></p><button class="retry" id="retry" type="button" aria-hidden="true">Try again</button></section></main><script>(()=>{const nonce=${safeNonce},form=document.getElementById("verification-form"),status=document.getElementById("status"),checkbox=document.getElementById("human-check"),continueButton=document.getElementById("continue"),honeypot=document.getElementById("website"),retry=document.getElementById("retry");let busy=false;function showFailure(){busy=false;continueButton.disabled=!checkbox.checked;retry.setAttribute("aria-hidden","false");status.textContent="Verification couldn't be completed. Please try again."}checkbox.addEventListener("change",()=>{if(!busy)continueButton.disabled=!checkbox.checked});form.addEventListener("submit",async event=>{event.preventDefault();if(!checkbox.checked||busy)return;busy=true;continueButton.disabled=true;retry.setAttribute("aria-hidden","true");status.textContent="Verifying…";try{const response=await fetch("/api/verify-human",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({confirmed:true,nonce,honeypot:honeypot.value})});if(!response.ok)return showFailure();status.textContent="Verification complete. Loading CallaStar…";window.location.reload()}catch{showFailure()}});retry.addEventListener("click",()=>{busy=false;retry.setAttribute("aria-hidden","true");status.textContent="";checkbox.checked=false;continueButton.disabled=true;checkbox.focus()})})();</script></body></html>`
}
