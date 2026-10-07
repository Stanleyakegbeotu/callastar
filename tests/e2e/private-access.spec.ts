import { expect, test } from "@playwright/test"

import { renderVerificationPage } from "../../netlify/edge-functions/_shared/access-gate.mjs"

const TEST_NONCE = "signed-test-nonce.payload"

async function installGate(
  page: import("@playwright/test").Page,
  navigate = true,
) {
  if (navigate) await page.goto("/")
  await page.setContent(renderVerificationPage(TEST_NONCE))
}

test("compact checkbox verification panel fits phone through desktop widths", async ({
  page,
}) => {
  await page.goto("/")
  for (const width of [
    320, 360, 375, 390, 393, 414, 430, 768, 1024, 1280, 1440,
  ]) {
    await page.setViewportSize({ width, height: 850 })
    await installGate(page, false)

    await expect(
      page.getByRole("checkbox", { name: "Please confirm you're human" }),
    ).toBeVisible()
    await expect(page.getByRole("heading")).toHaveCount(0)
    await expect(page.getByRole("button")).toHaveCount(0)

    const visualStyles = await page.evaluate(() => ({
      backdropFilter: getComputedStyle(document.querySelector(".backdrop")!)
        .filter,
      backdropOpacity: getComputedStyle(document.querySelector(".backdrop")!)
        .opacity,
      panelBackground: getComputedStyle(document.querySelector(".verify-bar")!)
        .backgroundColor,
      scrimBackground: getComputedStyle(document.querySelector(".scrim")!)
        .backgroundColor,
    }))
    expect(visualStyles.backdropFilter).toBe("blur(5px)")
    expect(visualStyles.backdropOpacity).toBe("0.94")
    expect(visualStyles.panelBackground).toBe("rgb(255, 254, 250)")
    expect(visualStyles.scrimBackground).toContain("0.08")

    const dimensions = await page.locator(".verify-bar").evaluate((bar) => {
      const bounds = bar.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        documentWidth: document.documentElement.scrollWidth,
      }
    })
    expect(dimensions.width).toBeLessThanOrEqual(width - 32)
    expect(dimensions.left).toBeGreaterThanOrEqual(0)
    expect(dimensions.right).toBeLessThanOrEqual(width)
    expect(dimensions.documentWidth).toBeLessThanOrEqual(width)
  }
})

test("checking the box sends the signed nonce with explicit confirmation", async ({
  page,
}) => {
  let requestBody: unknown
  await page.route("**/api/verify-human", async (route) => {
    requestBody = route.request().postDataJSON()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ verified: true }),
    })
  })
  await installGate(page)

  const checkbox = page.getByRole("checkbox", {
    name: "Please confirm you're human",
  })
  await checkbox.press("Space")
  await expect(page.getByRole("status")).toHaveText("Verifying…")
  await expect
    .poll(() => requestBody)
    .toEqual({
      confirmed: true,
      nonce: TEST_NONCE,
      honeypot: "",
    })
})

test("failed verification resets the checkbox so it can be tried again", async ({
  page,
}) => {
  let requests = 0
  await page.route("**/api/verify-human", async (route) => {
    requests += 1
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "verification_failed" }),
    })
  })
  await installGate(page)

  const checkbox = page.getByRole("checkbox", {
    name: "Please confirm you're human",
  })
  await checkbox.press("Space")
  await expect(page.getByRole("status")).toHaveText(
    "Verification couldn't be completed. Please try again.",
  )
  await expect(checkbox).not.toBeChecked()
  await expect(checkbox).toBeFocused()
  await expect(page.getByRole("button")).toHaveCount(0)

  await checkbox.press("Space")
  await expect.poll(() => requests).toBe(2)
})

test("install instructions overlay escapes the animated onboarding header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto("/")
  await page.getByRole("button", { name: "Get the app" }).click()
  await expect(
    page.getByRole("dialog", { name: "Your people, closer." }),
  ).toBeVisible()

  const mobileBounds = await page.evaluate(() => {
    const backdrop = document.querySelector(".pwa-install-backdrop")!
    const card = document.querySelector(".pwa-install-card")!
    const backdropRect = backdrop.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    return {
      parentIsBody: backdrop.parentElement === document.body,
      position: getComputedStyle(backdrop).position,
      backdropTop: backdropRect.top,
      backdropHeight: backdropRect.height,
      cardTop: cardRect.top,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }
  })
  expect(mobileBounds.parentIsBody).toBe(true)
  expect(mobileBounds.position).toBe("fixed")
  expect(mobileBounds.backdropTop).toBe(0)
  expect(mobileBounds.backdropHeight).toBe(mobileBounds.viewportHeight)
  expect(mobileBounds.cardTop).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.cardLeft).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.cardRight).toBeLessThanOrEqual(mobileBounds.viewportWidth)

  await page.setViewportSize({ width: 1366, height: 768 })
  const desktopBackdrop = await page
    .locator(".pwa-install-backdrop")
    .boundingBox()
  expect(desktopBackdrop).toMatchObject({
    x: 0,
    y: 0,
    width: 1366,
    height: 768,
  })
})

test("service worker never serves cached app HTML while offline", async ({
  page,
}) => {
  await page.goto("/")
  await page.evaluate(async () => {
    await caches.open("callastar-shell-v1")
    await caches.open("callastar-assets-v1")
    await navigator.serviceWorker.register("/sw.js")
    await navigator.serviceWorker.ready
  })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const cacheKeys = await page.evaluate(() => caches.keys())
  expect(cacheKeys).not.toContain("callastar-shell-v1")
  expect(cacheKeys).not.toContain("callastar-assets-v1")

  await page.context().setOffline(true)
  try {
    const response = await page.goto("/admin/login")
    expect(response?.status()).toBe(503)
    await expect(
      page.getByText("CallaStar is offline. Reconnect to continue."),
    ).toBeVisible()
    await expect(page.locator("#root")).toHaveCount(0)
  } finally {
    await page.context().setOffline(false)
  }
})
