import { expect, test, type Page, type Route } from "@playwright/test"

const TEST_EMAIL = "admin@example.test"
const TEST_PASSWORD = "test-admin-password-123"
const TEST_BOOTSTRAP_SECRET = "manual-bootstrap-secret-value"

async function mockAdminExists(page: Page, exists: boolean) {
  await page.route("**/rest/v1/rpc/admin_exists", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(exists),
    }),
  )
}

async function fulfillAdminSession(route: Route) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      access_token: "test-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test-refresh-token",
      user: {
        id: "admin-user-id",
        aud: "authenticated",
        role: "authenticated",
        email: TEST_EMAIL,
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      },
    }),
  })
}

test("existing admin sees the plain CallaStar login and the form stays responsive", async ({
  page,
}) => {
  await mockAdminExists(page, true)
  await page.goto("/admin/login")

  await expect(
    page.getByRole("heading", { name: "Admin access" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Create Admin" })).toHaveCount(
    0,
  )
  await expect(page.locator(".admin-login-form")).toBeVisible()
  await expect(page.locator(".admin-login-form.admin-card")).toHaveCount(0)
  await expect(page.getByLabel("Email")).toHaveAttribute(
    "autocomplete",
    "email",
  )
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  )

  await page.getByRole("button", { name: "Show password" }).click()
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  )
  await page.getByRole("button", { name: "Hide password" }).click()
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  )

  for (const width of [
    320, 360, 375, 390, 393, 414, 430, 768, 1024, 1280, 1440,
  ]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      form:
        document.querySelector(".admin-login-form")?.getBoundingClientRect()
          .width ?? 0,
    }))
    expect(
      layout.page,
      `horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(layout.viewport)
    expect(layout.form, `form width at ${width}px`).toBeLessThanOrEqual(
      Math.min(width - 40, 544),
    )
  }
})

test("first-run setup reveals the create form and validates confirmation inline", async ({
  page,
}) => {
  await mockAdminExists(page, false)
  await page.goto("/admin/login")
  await page.getByRole("button", { name: "Create Admin" }).click()

  await expect(
    page.getByRole("heading", { name: "Create admin account" }),
  ).toBeVisible()
  await expect(page.getByLabel("Display name")).toHaveAttribute(
    "autocomplete",
    "name",
  )
  await expect(
    page.getByLabel("Confirm password", { exact: true }),
  ).toHaveAttribute("autocomplete", "new-password")
  await expect(
    page.getByLabel("Bootstrap secret", { exact: true }),
  ).toHaveAttribute("type", "password")
  await expect(
    page.getByLabel("Bootstrap secret", { exact: true }),
  ).toHaveValue("")
  await expect(
    page.getByRole("button", { name: "Create Admin", exact: true }),
  ).toBeVisible()

  await page.getByLabel("Display name").fill("CallaStar Admin")
  await page.getByLabel("Email").fill(TEST_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD)
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("different-password")
  await page
    .getByLabel("Bootstrap secret", { exact: true })
    .fill(TEST_BOOTSTRAP_SECRET)
  await page.getByRole("button", { name: "Create Admin", exact: true }).click()

  await expect(page.getByText("Passwords do not match.")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Create admin account" }),
  ).toBeVisible()
})

test("invalid login shows a restrained inline error and a processing label", async ({
  page,
}) => {
  await mockAdminExists(page, true)
  let releaseAuth: () => void
  const authPending = new Promise<void>((resolve) => {
    releaseAuth = resolve
  })
  await page.route("**/auth/v1/token?grant_type=password", async (route) => {
    await authPending
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "invalid_credentials",
        message: "Invalid login credentials",
      }),
    })
  })
  await page.goto("/admin/login")
  await page.getByLabel("Email").fill(TEST_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill("wrong-password")
  await page.getByRole("button", { name: "Sign In" }).click()
  await expect(page.getByRole("button", { name: "Signing In…" })).toBeDisabled()
  releaseAuth()
  await expect(
    page.getByText("We couldn’t sign you in with those details."),
  ).toBeVisible()
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  )
})

test("successful first-admin creation uses bootstrap, Supabase Auth, then the admin profile", async ({
  page,
}) => {
  await mockAdminExists(page, false)
  let bootstrapBody: {
    email: string
    password: string
    displayName: string
    bootstrapSecret: string
  } | undefined
  await page.route("**/functions/v1/bootstrap-admin", async (route) => {
    bootstrapBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    })
  })
  await page.route("**/auth/v1/token?grant_type=password", fulfillAdminSession)
  await page.route("**/rest/v1/admin_profiles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { user_id: "admin-user-id", role: "admin", is_active: true },
      ]),
    }),
  )

  await page.goto("/admin/login")
  await page.getByRole("button", { name: "Create Admin" }).click()
  await page.getByLabel("Display name").fill("CallaStar Admin")
  await page.getByLabel("Email").fill(TEST_EMAIL)
  await page.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD)
  await page.getByLabel("Confirm password", { exact: true }).fill(TEST_PASSWORD)
  await page
    .getByLabel("Bootstrap secret", { exact: true })
    .fill(TEST_BOOTSTRAP_SECRET)
  await page.getByRole("button", { name: "Create Admin", exact: true }).click()

  await expect(page).toHaveURL(/\/admin$/)
  expect(bootstrapBody).toEqual({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    displayName: "CallaStar Admin",
    bootstrapSecret: TEST_BOOTSTRAP_SECRET,
  })
  const localStorage = await page.evaluate(() =>
    JSON.stringify(window.localStorage),
  )
  expect(localStorage).not.toContain(TEST_PASSWORD)
  expect(localStorage).not.toContain(TEST_BOOTSTRAP_SECRET)
})

test("ten brand clicks reveal only the login route, including on touch devices", async ({
  page,
  browser,
}) => {
  await page.goto("/")
  const logo = page.getByRole("button", { name: "Return to CallaStar home" })
  for (let index = 0; index < 9; index += 1) await logo.click()
  await expect(page).toHaveURL(/\/$/)
  await logo.click()
  await expect(page).toHaveURL(/\/admin\/login$/)

  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })
  const touchPage = await context.newPage()
  await touchPage.goto("/")
  const touchLogo = touchPage.getByRole("button", {
    name: "Return to CallaStar home",
  })
  const box = await touchLogo.boundingBox()
  if (!box) throw new Error("Onboarding logo is not visible for touch input.")
  for (let index = 0; index < 10; index += 1) {
    await touchPage.touchscreen.tap(
      box.x + box.width / 2,
      box.y + box.height / 2,
    )
  }
  await expect(touchPage).toHaveURL(/\/admin\/login$/)
  await context.close()
})

test("slow taps reset and direct admin routes still require Supabase authorization", async ({
  page,
}) => {
  await page.goto("/")
  const logo = page.getByRole("button", { name: "Return to CallaStar home" })
  for (let index = 0; index < 5; index += 1) await logo.click()
  await page.waitForTimeout(5_100)
  for (let index = 0; index < 5; index += 1) await logo.click()
  await expect(page).toHaveURL(/\/$/)

  await page.goto("/admin")
  await expect(page).toHaveURL(/\/admin\/login$/)
})
