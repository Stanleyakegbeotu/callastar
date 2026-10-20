import { expect, test, type Page } from "@playwright/test"

const hostId = "7e676a23-ce9c-400b-bc81-28ef625a1378"
const code = "CS-AAAA-BBBB-CCCC"
const widths = [320, 360, 375, 390, 393, 414, 430, 768, 1024, 1280, 1440]
async function setup(
  page: Page,
  initialMode: "free" | "premium" = "free",
  expired = false,
  paid = false,
  startCode?: string,
  mediaPath = "/media/call-demo.mp4",
  completionFails = false,
  interruptions: { startMs: number; endMs: number; type?: "connection" }[] = [],
) {
  let mode = initialMode,
    maxUses = 1,
    generation = 0
  const statuses: string[] = []
  let completedUses = 0
  let savedAssetInterruptions: { startMs: number; endMs: number; type?: "connection" }[] = []
  const signalingRequests: string[] = []
  page.on("request", request => { if (request.url().includes("/calls/authorize")) signalingRequests.push(request.url()) })
  const host = () => ({
    id: hostId,
    display_name: "Ticket Test Host",
    short_bio: "Test host",
    profile_mode: mode,
    call_id_max_uses: maxUses,
    status: "active",
    remote_video_asset_id: "source",
    created_at: "2026-10-20T10:00:00Z",
    updated_at: "2026-10-20T10:00:00Z",
  })
  await page.addInitScript(() => {
    const b64 = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
    const id = "52f36694-5bfe-48fb-b80b-8bff31574b94",
      exp = Math.floor(Date.now() / 1000) + 3600
    const user = {
      id,
      email: "admin@example.test",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-10-20T10:00:00Z",
    }
    localStorage.setItem(
      "sb-127-auth-token",
      JSON.stringify({
        access_token:
          b64({ alg: "HS256", typ: "JWT" }) +
          "." +
          b64({ sub: id, exp, role: "authenticated" }) +
          ".fixture",
        refresh_token: "fixture",
        expires_at: exp,
        expires_in: 3600,
        token_type: "bearer",
        user,
      }),
    )
    // Device permission is stubbed; the selected source is a real decoded MP4.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          ;(window as any).testGumCalls =
            ((window as any).testGumCalls ?? 0) + 1
          const camera = document.createElement("canvas")
          camera.width = 320; camera.height = 240
          const ctx = camera.getContext("2d")!
          ctx.fillStyle = "#26a269"; ctx.fillRect(0, 0, 320, 240)
          if (typeof camera.captureStream === "function") {
            const stream = camera.captureStream(15)
            const timer = setInterval(() => { ctx.fillRect(0, 0, 320, 240); if (!stream.getTracks().some(t => t.readyState === "live")) clearInterval(timer) }, 66)
            return stream
          }
          return typeof MediaStream === "function"
            ? new MediaStream()
            : {
                getTracks: () => [],
                getVideoTracks: () => [],
                getAudioTracks: () => [],
              } as unknown as MediaStream
        },
        getSupportedConstraints: () => ({}),
        enumerateDevices: async () => [],
      },
    })
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          ;(window as any).copiedText = text
        },
      },
    })
  })
  await page.route("**/auth/v1/user", (r) =>
    r.fulfill({
      json: {
        id: "52f36694-5bfe-48fb-b80b-8bff31574b94",
        email: "admin@example.test",
      },
    }),
  )
  await page.route("**/rest/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/host_assets") && route.request().method() === "PATCH") {
      savedAssetInterruptions = route.request().postDataJSON()?.interruptions ?? []
      return route.fulfill({ json: [] })
    }
    const rows = path.endsWith("/subscription_plans")
      ? ["plus", "pro"].map((id, i) => ({
          id,
          display_name: i ? "Pro" : "Plus",
          price_minor_units: 1000,
          currency_code: "USD",
          sort_order: i,
          session_duration_minutes: 20,
          support_priority: "standard",
          description: "Call access",
          features: [],
          is_active: true,
          is_most_popular: false,
        }))
      : path.endsWith("/admin_profiles")
        ? [
            {
              user_id: "52f36694-5bfe-48fb-b80b-8bff31574b94",
              role: "admin",
              is_active: true,
            },
          ]
        : path.endsWith("/hosts")
          ? [host()]
          : path.endsWith("/host_assets")
            ? [
                {
                  id: "source",
                  host_id: hostId,
                  kind: "remote_video",
                  file_name: "source.mp4",
                  duration_seconds: 5,
                  width: 640,
                  height: 360,
                  storage_path: "ticket-test/source.mp4",
                  has_audio: false,
                  interruptions: savedAssetInterruptions,
                },
              ]
            : []
    return route.fulfill({ json: rows })
  })
  await page.route("**/functions/v1/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()
    const body = route.request().postDataJSON()
    let result: any = {}
    if (name === "admin-call-ids")
      result = {
        callIds: [
          {
            id: `ticket-${generation}`,
            hostId,
            code: generation ? "CS-DDDD-EEEE-FFFF" : code,
            mode,
            maxUses,
            useCount: 0,
            status: "active",
            createdAt: "2026-10-20T10:00:00Z",
            generationReason: generation ? "exhausted" : "initial",
          },
        ],
      }
    if (name === "generate-call-id") {
      if (body.mode) mode = body.mode
      if (body.maxUses) maxUses = body.maxUses
      generation++
      result = { id: `ticket-${generation}`, code: "CS-DDDD-EEEE-FFFF" }
    }
    if (name === "resolve-call-id")
      result = expired
        ? { found: false, code: "CALL_ID_EXHAUSTED", mode }
        : {
            found: true,
            host: {
              id: hostId,
              displayName: "Ticket Test Host",
              status: "active",
              callDelivery: "source_video",
              mode,
              avatarUrl: "/icons/icon-192.png",
            },
          }
    if (name === "start-call-session")
      result = {
        sessionId: "session-test",
        sessionToken: "test".repeat(20),
        mode,
        accessKind: mode === "free" ? "free" : paid ? "paid" : "premium_bonus",
        host: { displayName: "Ticket Test Host" },
        access: paid
          ? {
              grantId: "grant",
              planId: "plus",
              planName: "Plus",
              sessionDurationMinutes: 20,
            }
          : null,
      }
    if (name === "start-call-session" && startCode) result = { code: startCode }
    if (name === "update-call-session") {
      if (body.status === "ended" && body.failureCode === "SOURCE_VIDEO_ENDED") {
        if (completionFails) return route.fulfill({ status: 503, json: { error: "session_update_failed" } })
        completedUses++
      }
      if (body.status) statuses.push(body.status)
      result = body.action === "renew_reservation" ? { renewed: true } : { status: body.status }
    }
    if (name === "get-session-media")
      result = {
        available: true,
        media: {
          url: new URL(mediaPath, page.url()).href,
          hasAudio: interruptions.length > 0,
          interruptions,
        },
      }
    if (name === "support-customer") {
      const conversation = {
        id: "support-ticket",
        customer_email: "ticket@example.test",
        customer_email_normalized: "ticket@example.test",
        customer_name: "Ticket Caller",
        subject: "Customer Care",
        status: "open",
        subscription_request_id: null,
        package_brief_seen_at: "2026-10-20T10:00:00Z",
        checkout_draft: null,
        last_message_preview: "",
        last_message_at: "2026-10-20T10:00:00Z",
        last_message_sender: "customer",
        unread_for_admin: 0,
        unread_for_customer: 0,
        created_at: "2026-10-20T10:00:00Z",
        updated_at: "2026-10-20T10:00:00Z",
      }
      result =
        body.action === "messages"
          ? { messages: [], assets: [] }
          : { conversation, grants: [], requests: [] }
    }
    if (name === "public-settings") result = { settings: {} }
    await route.fulfill({ json: result })
  })
  return {
    statuses,
    signalingRequests,
    get completedUses() { return completedUses },
    rotate: () => {
      generation++
    },
  }
}

for (const mode of ["free", "premium"] as const)
test(`${mode} source interruptions cover frames while video time advances without pause or seek`, async ({ page, browserName }) => {
  const state = await setup(page, mode, false, false, undefined, "/media/call-demo.mp4", false, [
    { startMs: 100, endMs: 1500 },
    { startMs: 2700, endMs: 3400 },
  ])
  await page.addInitScript(() => {
    const drawImage = CanvasRenderingContext2D.prototype.drawImage
    ;(window as any).evidenceSourceFrames = []
    CanvasRenderingContext2D.prototype.drawImage = function (source: CanvasImageSource, ...args: any[]) {
      if (source instanceof HTMLVideoElement && source.classList.contains("main-video-overlay")) {
        ;(window as any).evidenceSourceFrames.push({ timeMs: source.currentTime * 1000, overlay: Boolean(document.querySelector(".source-interruption-overlay")) })
      }
      return (drawImage as any).call(this, source, ...args)
    } as typeof drawImage
  })
  await join(page)
  await page.getByRole("button", { name: /start.*call/i }).click()
  await page.getByRole("button", { name: "Allow access", exact: true }).click()
  const video = page.locator("video.main-video-overlay")
  await expect(video).toBeVisible({ timeout: 30000 })
  const interruption = page.locator(".source-interruption-overlay")
  await expect(interruption).toBeVisible()
  await expect(interruption).toHaveCSS("background-color", "rgb(4, 18, 43)")
  await expect(interruption).toHaveCSS("backdrop-filter", "none")
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true)
  expect(state.completedUses).toBe(0)
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>("video.main-video-overlay")!
    const proto = HTMLMediaElement.prototype
    const currentTime = Object.getOwnPropertyDescriptor(proto, "currentTime")!
    ;(window as any).interruptOps = { pause: 0, load: 0, seek: 0 }
    Object.defineProperty(v, "pause", { configurable: true, value: () => { (window as any).interruptOps.pause++ } })
    Object.defineProperty(v, "load", { configurable: true, value: () => { (window as any).interruptOps.load++ } })
    Object.defineProperty(v, "currentTime", { configurable: true, get: () => currentTime.get!.call(v), set: (next) => { (window as any).interruptOps.seek++; currentTime.set!.call(v, next) } })
  })
  await page.waitForTimeout(350)
  const during = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  expect(during).toBeGreaterThan(before + 0.2)
  expect(await page.evaluate(() => (window as any).interruptOps)).toEqual({ pause: 0, load: 0, seek: 0 })
  await expect(page.locator(".source-interruption-overlay")).toHaveCount(0, { timeout: 3000 })
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5)
  await expect(page.locator(".source-interruption-overlay")).toBeVisible({ timeout: 3000 })
  const secondBefore = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  await page.waitForTimeout(250)
  const secondDuring = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  expect(secondDuring).toBeGreaterThan(secondBefore + 0.1)
  expect(await page.evaluate(() => (window as any).interruptOps)).toEqual({ pause: 0, load: 0, seek: 0 })
  expect(await page.evaluate(() => (window as any).testGumCalls)).toBe(1)
  expect(state.signalingRequests).toEqual([])
  expect(state.completedUses).toBe(0)
  if (browserName === "chromium") {
    const evidenceFrames = await page.evaluate(() => (window as any).evidenceSourceFrames as { timeMs: number; overlay: boolean }[])
    expect(evidenceFrames.length).toBe(1)
    expect(evidenceFrames[0].overlay).toBe(false)
    expect(evidenceFrames[0].timeMs).toBeGreaterThanOrEqual(1500)
  }
  await video.evaluate((v: HTMLVideoElement) => {
    delete (v as any).pause
    delete (v as any).load
    delete (v as any).currentTime
    v.currentTime = Math.max(0, v.duration - 0.4)
    void v.play()
  })
  await expect.poll(() => state.statuses.includes("ended"), { timeout: 10000 }).toBe(true)
  expect(state.completedUses).toBe(1)
})

test("live uploaded source shows the interruption on a plain background and resumes its video", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js")
    const { default: ReactDOM } = await import("/node_modules/.vite/deps/react-dom_client.js")
    const { LiveCallCanvas } = await import("/src/features/calls/components/LiveCallCanvas.tsx")
    const mount = document.createElement("div")
    mount.id = "live-source-interruption-test"
    mount.style.cssText = "position:fixed;inset:0;z-index:1000"
    document.body.appendChild(mount)
    ReactDOM.createRoot(mount).render(React.createElement(LiveCallCanvas, {
      uploadedSource: true,
      uploadedUrl: "/media/call-demo.mp4",
      uploadedInterruptions: [{ startMs: 0, endMs: 1200, type: "connection" }],
      remoteName: "Test Guest",
      remoteShortName: "Test",
      localStream: null,
      remoteStream: null,
      hasRemoteMedia: false,
      seconds: 0,
      micEnabled: true,
      cameraEnabled: false,
      canSwitchCamera: false,
      showCameraControls: false,
      reconnecting: false,
      onToggleMic: () => {},
      onToggleCamera: () => {},
      onSwitchCamera: () => {},
      onEnd: () => {},
      onRetryUploaded: () => {},
    }))
  })

  const video = page.locator("#live-source-interruption-test video.live-call-main")
  const interruption = page.locator("#live-source-interruption-test .source-interruption-overlay")
  await expect(video).toBeVisible()
  await expect(interruption).toBeVisible()
  await expect(interruption).toHaveText(/Resuming call/)
  await expect(interruption).toHaveCSS("background-color", "rgb(4, 18, 43)")
  await expect(interruption).toHaveCSS("backdrop-filter", "none")
  await expect(video).toHaveJSProperty("muted", true)
  const tapToPlay = page.getByRole("button", { name: "Tap to play host video" })
  if (await tapToPlay.isVisible().catch(() => false)) await tapToPlay.click()
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await page.waitForTimeout(300)
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before + 0.1)
  await expect(interruption).toHaveCount(0, { timeout: 4000 })
  await expect(video).toHaveJSProperty("muted", false)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1.2)
})

async function join(page: Page) {
  await page.goto("/join/video")
  await page
    .getByRole("textbox", { name: "Full Name", exact: true })
    .fill("Ticket Caller")
  await page
    .getByRole("textbox", { name: "Email Address", exact: true })
    .fill("ticket@example.test")
  await page.getByRole("textbox", { name: /phone number/i }).fill("08031234567")
  await page.getByRole("button", { name: "Next", exact: true }).click()
  await page.getByRole("textbox", { name: "Call ID", exact: true }).fill(code)
  await page.getByRole("button", { name: "Find Profile", exact: true }).click()
}

test("admin can configure and persist interruption markers on the selected source video", async ({ page }) => {
  await setup(page)
  let savedTimeline: unknown = null
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname.endsWith("/host_assets")) savedTimeline = request.postDataJSON()?.interruptions
  })
  await page.route("**/storage/v1/object/sign/host-call-media/**", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { signedURL: "/../../media/call-demo.mp4" } })
    return route.continue()
  })
  await page.goto("/admin/profiles")
  const profile = page.locator(".availability-card").filter({ hasText: "Ticket Test Host" })
  await profile.getByRole("link", { name: "View", exact: true }).click()
  const mediaCard = page.locator("#media")
  await mediaCard.getByRole("button", { name: "Configure Call Timeline" }).click()
  const dialog = page.getByRole("dialog", { name: "Configure Call Timeline" })
  const filmstrip = dialog.locator("canvas.source-timeline-filmstrip")
  await expect(filmstrip).toBeVisible()
  await expect(dialog.getByRole("slider", { name: "Video playhead" })).toBeVisible()
  await expect.poll(() => filmstrip.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
    let painted = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 0) painted++
    return painted
  })).toBeGreaterThan(0)
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 })
    const bounds = await dialog.evaluate((element) => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, document: document.documentElement.scrollWidth }))
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(width + 1)
    expect(bounds.document).toBeLessThanOrEqual(width)
  }
  await dialog.locator(".source-timeline-footer").getByRole("button", { name: "Add Interruption" }).click()
  await dialog.getByRole("group", { name: "New interruption" }).getByRole("button", { name: "Add interruption" }).click()
  await expect(dialog.getByText("Connection Interruption 1")).toBeVisible()
  const preview = dialog.locator("video.source-timeline-preview")
  await dialog.getByRole("button", { name: "Play preview" }).click()
  await expect(dialog.locator(".source-timeline-preview-overlay")).toBeVisible()
  const previewBefore = await preview.evaluate((video: HTMLVideoElement) => video.currentTime)
  await page.waitForTimeout(250)
  expect(await preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(previewBefore + 0.1)
  await expect(dialog.locator(".source-timeline-preview-overlay")).toHaveCount(0, { timeout: 3000 })
  await preview.evaluate((video: HTMLVideoElement) => video.pause())
  await dialog.getByRole("button", { name: "Save timeline" }).click()
  await expect(page.getByText("Call timeline saved.", { exact: true })).toBeVisible()
  expect(savedTimeline).toEqual([{ startMs: 0, endMs: 1000, type: "connection" }])
  await page.reload()
  const reopenedMediaCard = page.locator("#media")
  await reopenedMediaCard.getByRole("button", { name: "Configure Call Timeline" }).click()
  await expect(page.getByRole("dialog", { name: "Configure Call Timeline" }).getByText("Connection Interruption 1")).toBeVisible()
})

test("profiles remain visible when Call ID loading fails and recover when it returns", async ({ page }) => {
  await setup(page)
  const endpoint = "**/functions/v1/admin-call-ids"
  await page.route(endpoint, route => route.abort("failed"))
  await page.goto("/admin/profiles")
  const card = page.locator(".availability-card")
  await expect(card).toContainText("Ticket Test Host")
  await expect(card.getByRole("status")).toContainText("Call ID unavailable")
  await expect(card.getByRole("button", { name: /Copy Call ID/ })).toBeDisabled()
  await expect(card.getByRole("switch")).toBeEnabled()
  await expect(card.getByRole("link", { name: "Edit", exact: true })).toBeVisible()
  await expect(card.getByRole("radio")).toHaveCount(0)
  await card.getByRole("link", { name: "View", exact: true }).click()
  await expect(page.locator(".admin-callid")).toContainText("Unavailable")
  await expect(page.locator(".admin-callid").getByRole("button", { name: "Copy", exact: true })).toBeDisabled()
  await page.unroute(endpoint)
  await page.goto("/admin/profiles")
  await expect(page.locator(".availability-callid")).toContainText(code)
  await expect(card.getByRole("button", { name: /Copy Call ID/ })).toBeEnabled()
  await expect(card.getByRole("radio", { name: "Free Mode" })).toBeChecked()
})

test("admin mode, uses, confirmation, copy and regeneration fit all required widths", async ({
  page,
}) => {
  await setup(page)
  await page.goto("/admin/profiles")
  const card = page.locator(".availability-card")
  await expect(card.getByText("Active", { exact: true })).toBeVisible()
  await expect(card.getByText("Offline", { exact: true })).toHaveCount(0)
  await expect(card.getByRole("radio", { name: "Free Mode" })).toBeChecked()
  await card.getByRole("radio", { name: "Premium Mode" }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "Changing this profile's mode will retire its current Call ID",
  )
  await page.getByRole("button", { name: "Change Mode", exact: true }).click()
  await expect(card.getByRole("radio", { name: "Premium Mode" })).toBeChecked()
  await card.getByRole("combobox", { name: /Allowed Uses/ }).selectOption("5")
  await expect(card.getByRole("combobox")).toHaveValue("5")
  await card.getByRole("button", { name: /Copy Call ID/ }).click()
  await expect(page.getByText("Call ID copied.", { exact: true })).toBeVisible()
  await card.getByRole("button", { name: "Regenerate ID", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "The current Call ID will stop working immediately",
  )
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Regenerate ID", exact: true })
    .click()
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(card).toContainText("New Call ID")
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    const bounds = await card.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      document: document.documentElement.scrollWidth,
    }))
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(width + 1)
    expect(bounds.document).toBeLessThanOrEqual(width)
  }
  await page.screenshot({
    path: "test-results/call-tickets-admin.png",
    fullPage: true,
  })
})
test("a Premium profile switches to Free after confirmation and persists after reload", async ({ page }) => {
  await setup(page, "premium")
  await page.goto("/admin/profiles")
  const card = page.locator(".availability-card")
  await card.getByRole("radio", { name: "Free Mode" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Change Mode", exact: true }).click()
  await expect(card.getByRole("radio", { name: "Free Mode" })).toBeChecked()
  await page.reload()
  await expect(card.getByRole("radio", { name: "Free Mode" })).toBeChecked()
  await expect(card.locator(".availability-callid")).toContainText("CS-DDDD-EEEE-FFFF")
})

test("missing server migration disables Free-mode changes without sending a regeneration request", async ({ page }) => {
  await setup(page, "premium")
  let generatorCalls = 0
  await page.route("**/rest/v1/hosts*", route => route.fulfill({ json: [{
    id: hostId, display_name: "Legacy Host", status: "active", short_bio: "", remote_video_asset_id: null,
    created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
  }] }))
  page.on("request", request => { if (request.url().endsWith("/generate-call-id")) generatorCalls++ })
  await page.goto("/admin/profiles")
  const card = page.locator(".availability-card")
  await expect(card.getByText("Free/Premium settings are awaiting the server update.")).toBeVisible()
  await expect(card.getByRole("radio", { name: "Free Mode" })).toBeDisabled()
  expect(generatorCalls).toBe(0)
})
for (const mode of ["free", "premium"] as const)
  test(`${mode} expired ticket has no package gate and support remains reachable`, async ({
    page,
  }) => {
    await setup(page, mode, true)
    await join(page)
    await expect(
      page.getByRole("heading", { name: "This Call ID is no longer available." }),
    ).toBeVisible()
    await expect(page.getByText("Plus", { exact: true })).toHaveCount(0)
    for (const width of widths) {
      await page.setViewportSize({ width, height: 850 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width)
    }
    await page
      .getByRole("button", { name: "Customer Care", exact: true })
      .click()
    await expect(page).toHaveURL(/\/support/)
    await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible()
  })
for (const [mode, paid] of [
  ["free", false],
  ["premium", false],
  ["premium", true],
] as const)
  test(`${mode} ${
    paid ? "paid" : "complimentary"
  } source completes from its real ended event`, async ({ page, browserName }) => {
    const state = await setup(page, mode, false, paid)
    await join(page)
    await page.getByRole("button", { name: /start.*call/i }).click()
    await page
      .getByRole("button", { name: "Allow access", exact: true })
      .click()
    const video = page.locator("video.main-video-overlay")
    await expect(video).toBeVisible({ timeout: 30000 })
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0)
    expect(await video.evaluate((v: HTMLVideoElement) => v.loop)).toBe(false)
    await expect(page.getByText("Preview session", { exact: true })).toHaveCount(0)
    await expect(page.getByText("Currently unavailable", { exact: true })).toHaveCount(0)
    await expect(page.locator('.video-pip[aria-label="You"]')).toBeVisible()
    // WebKit has no canvas.captureStream in this runner. Chromium supplies a
    // real synthetic camera track, so also verify that the PiP decodes it.
    if (browserName === "chromium") {
      await expect(page.locator("video.pip-video")).toBeVisible()
      await expect.poll(() => page.locator("video.pip-video").evaluate((v:HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
    }
    expect(state.signalingRequests).toEqual([])
    expect(state.completedUses).toBe(0)
    expect(await page.evaluate(() => (window as any).testGumCalls)).toBe(1)
    await expect.poll(() => state.statuses.includes("active")).toBe(true)
    // Move close to the actual duration; the browser still emits natural ended.
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = Math.max(0, v.duration - 0.4)
      void v.play()
    })
    await expect(
      page.getByRole("status").filter({ hasText: "Finalizing call" }),
    ).toBeVisible()
    await expect.poll(() => state.statuses.includes("ended")).toBe(true)
    expect(state.completedUses).toBe(1)
    if (!paid) {
      const ending = page.locator(".trial-ended")
      await expect(page.getByRole("heading", { name: "Your free trial has ended." })).toBeVisible()
      await expect(ending).toContainText("contact your host and ask for a subscription link")
      await expect(ending.getByRole("button")).toHaveCount(1)
      await expect(ending.locator("img, svg")).toHaveCount(0)
      await expect(page.getByText("Plus", { exact: true })).toHaveCount(0)
      for (const width of widths) {
        await page.setViewportSize({ width, height: 568 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        const bounds = await ending.getByRole("button").boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: "test-results/trial-ended-" + mode + "-" + browserName + ".png", fullPage: true })
      await ending.getByRole("button", { name: "Return Home", exact: true }).click()
      await expect(page).toHaveURL(/\/$/)
    } else {
      await expect(page.getByRole("heading", { name: "Call ended", exact: true })).toBeVisible()
    }
    await expect(
      page.getByText(/check your internet|bad network/i),
    ).toHaveCount(0)
  })

test("returning Premium customer reaches plans before device permission or signaling", async ({
  page,
}) => {
  const state = await setup(
    page,
    "premium",
    false,
    false,
    "PREMIUM_SUBSCRIPTION_REQUIRED",
  )
  await join(page)
  await page.getByRole("button", { name: /start.*call/i }).click()
  await page.getByRole("button", { name: "Allow access", exact: true }).click()
  await expect(page).toHaveURL(/\/plans$/)
  await expect(page.getByRole("radio", { name: /^Plus,/i })).toBeVisible()
  expect(await page.evaluate(() => (window as any).testGumCalls ?? 0)).toBe(0)
  expect(state.statuses).toEqual([])
})

test("a real source load failure releases the attempt without consuming a use", async ({
  page,
}) => {
  // Use a different source from the successful calls: WebKit's native media
  // cache can otherwise reuse their decoded asset across browser contexts.
  const state = await setup(page, "free", false, false, undefined, "/media/missing-ticket-source.mp4")
  await page.route("**/media/missing-ticket-source.mp4", (route) =>
    route.fulfill({ status: 404, body: "source unavailable" }),
  )
  await join(page)
  await page.getByRole("button", { name: /start.*call/i }).click()
  await page.getByRole("button", { name: "Allow access", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Host video unavailable" }),
  ).toBeVisible({ timeout: 30000 })
  await expect.poll(() => state.statuses.includes("failed")).toBe(true)
  expect(state.statuses).not.toContain("active")
  await expect(page.getByText(/bad network|check your internet/i)).toHaveCount(
    0,
  )
})

test("admin sees a remotely rotated ticket on the next visibility refresh", async ({
  page,
}) => {
  const state = await setup(page)
  await page.goto("/admin/profiles")
  await expect(page.locator(".availability-callid")).toContainText(code)
  state.rotate()
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  )
  await expect(page.locator(".availability-callid")).toContainText(
    "CS-DDDD-EEEE-FFFF",
  )
  await expect(page.locator(".call-ticket-facts")).toContainText(
    "Auto-generated",
  )
})


test("early hangup releases the active Free attempt without a completed use", async ({page})=>{
  const state=await setup(page);
  await join(page);await page.getByRole("button",{name:/start.*call/i}).click();
  await page.getByRole("button",{name:"Allow access",exact:true}).click();
  const video=page.locator("video.main-video-overlay");
  await expect(video).toBeVisible({timeout:30000});
  await expect.poll(()=>state.statuses.includes("active")).toBe(true);
  await page.getByRole("button",{name:/end call/i}).click();
  await expect.poll(()=>state.statuses.includes("ended")).toBe(true);
  expect(state.completedUses).toBe(0);
  expect(state.signalingRequests).toEqual([]);
});

test("a failed completion write cannot display successful source completion", async ({page})=>{
  const state=await setup(page,"free",false,false,undefined,"/media/call-demo.mp4",true);
  await join(page);await page.getByRole("button",{name:/start.*call/i}).click();
  await page.getByRole("button",{name:"Allow access",exact:true}).click();
  const video=page.locator("video.main-video-overlay");
  await expect.poll(()=>state.statuses.includes("active"),{timeout:30000}).toBe(true);
  await video.evaluate((v:HTMLVideoElement)=>{v.currentTime=v.duration-0.3;void v.play()});
  await expect.poll(()=>state.statuses.includes("failed")).toBe(true);
  await expect(page.getByRole("heading",{name:"Your free trial has ended."})).toHaveCount(0);
  expect(state.completedUses).toBe(0);
});
