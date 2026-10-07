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

test("manual verification panel fits phone through desktop widths", async ({
  page,
}) => {
  await page.goto("/")
  for (const width of [
    320, 360, 375, 390, 393, 414, 430, 768, 1024, 1280, 1440,
  ]) {
    await page.setViewportSize({ width, height: 850 })
    await installGate(page, false)

    await expect(
      page.getByRole("heading", { name: "Human Verification" }),
    ).toBeVisible()
    await expect(
      page.getByRole("checkbox", { name: "I am a real person" }),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled()

    const visualStyles = await page.evaluate(() => ({
      backdropFilter: getComputedStyle(document.querySelector(".backdrop")!)
        .filter,
      backdropOpacity: getComputedStyle(document.querySelector(".backdrop")!)
        .opacity,
      panelBackground: getComputedStyle(document.querySelector(".verify-card")!)
        .backgroundColor,
      panelBackdropFilter: getComputedStyle(
        document.querySelector(".verify-card")!,
      ).backdropFilter,
      scrimBackground: getComputedStyle(document.querySelector(".scrim")!)
        .backgroundColor,
    }))
    expect(visualStyles.backdropFilter).toBe("blur(5px)")
    expect(visualStyles.backdropOpacity).toBe("0.94")
    expect(visualStyles.panelBackground).toContain("0.94")
    expect(visualStyles.panelBackdropFilter).toBe("blur(8px)")
    expect(visualStyles.scrimBackground).toContain("0.08")

    const dimensions = await page.locator(".verify-card").evaluate((card) => {
      const bounds = card.getBoundingClientRect()
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

test("checkbox enables Continue and sends the signed nonce with explicit confirmation", async ({
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

  const checkbox = page.getByRole("checkbox", { name: "I am a real person" })
  const continueButton = page.getByRole("button", { name: "Continue" })
  await expect(continueButton).toBeDisabled()
  await checkbox.press("Space")
  await expect(continueButton).toBeEnabled()
  await continueButton.click()
  await expect(page.getByRole("status")).toHaveText("Verifying…")
  expect(requestBody).toEqual({
    confirmed: true,
    nonce: TEST_NONCE,
    honeypot: "",
  })
})

test("failed verification offers an accessible retry and resets confirmation", async ({
  page,
}) => {
  await page.route("**/api/verify-human", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "verification_failed" }),
    }),
  )
  await installGate(page)

  const checkbox = page.getByRole("checkbox", { name: "I am a real person" })
  const continueButton = page.getByRole("button", { name: "Continue" })
  await checkbox.press("Space")
  await continueButton.click()
  await expect(page.getByRole("status")).toHaveText(
    "Verification couldn't be completed. Please try again.",
  )

  const retry = page.getByRole("button", { name: "Try again" })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(checkbox).not.toBeChecked()
  await expect(checkbox).toBeFocused()
  await expect(continueButton).toBeDisabled()
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
