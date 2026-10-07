import { expect, test } from "@playwright/test"

import { renderVerificationPage } from "../../netlify/edge-functions/_shared/access-gate.mjs"

const TEST_SITE_KEY = "1x00000000000000000000AA"
const MOCK_TURNSTILE = `window.turnstile = {
  render: (_selector, options) => { window.__turnstileOptions = options; return "test-widget"; },
  execute: () => window.__turnstileOptions.callback("test-turnstile-token"),
  reset: () => {},
};`

async function installGate(page: import("@playwright/test").Page) {
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: MOCK_TURNSTILE,
      }),
  )
  await page.goto("/")
  await page.setContent(renderVerificationPage(TEST_SITE_KEY))
}

test("verification bar stays in the viewport from phone through desktop", async ({
  page,
}) => {
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 })
    await installGate(page)

    await expect(page.getByRole("status")).toHaveText("Checking your browser…")
    await expect(page.getByRole("checkbox")).toBeVisible()

    const dimensions = await page.locator(".verify-bar").evaluate((bar) => {
      const bounds = bar.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }
    })
    expect(dimensions.width).toBeLessThanOrEqual(width - 32)
    expect(dimensions.left).toBeGreaterThanOrEqual(0)
    expect(dimensions.right).toBeLessThanOrEqual(width)
    expect(dimensions.documentWidth).toBeLessThanOrEqual(width)
  }
})

test("Turnstile success verifies with the server endpoint and announces completion", async ({
  page,
}) => {
  let requestBody: unknown
  await page.route("**/api/verify-human", async (route) => {
    requestBody = route.request().postDataJSON()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Set-Cookie":
          "human_verified=signed-token; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: JSON.stringify({ verified: true }),
    })
  })
  await installGate(page)

  const checkbox = page.getByRole("checkbox", {
    name: "Please confirm you're human",
  })
  await expect(checkbox).toBeVisible()
  await checkbox.press("Space")
  await expect(page.getByRole("status")).toHaveText("Verifying…")
  await expect(page.getByRole("status")).toHaveText("✓ Verification complete")
  expect(requestBody).toEqual({ token: "test-turnstile-token" })
})

test("failed verification offers an accessible retry and supports Enter", async ({
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

  const checkbox = page.getByRole("checkbox", {
    name: "Please confirm you're human",
  })
  await expect(checkbox).toBeVisible()
  await checkbox.press("Enter")
  await expect(page.getByRole("status")).toHaveText(
    "Verification couldn't be completed. Please try again.",
  )

  const retry = page.getByRole("button", { name: "Try again" })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(checkbox).toBeVisible()
  await expect(checkbox).toBeFocused()
})
