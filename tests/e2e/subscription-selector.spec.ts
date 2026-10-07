import { expect, test } from "@playwright/test"

test("Plus and Pro selector fits supported phone widths and sends the active plan to checkout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 844 })
  await page.goto("/tests/fixtures/subscription-selector.html")

  await expect(
    page.getByRole("heading", { name: "Unlock more with Amara Vale" }),
  ).toBeVisible()
  const plus = page.getByRole("radio", { name: /^Plus,/i })
  const pro = page.getByRole("radio", { name: /^Pro,/i })
  await expect(plus).toBeVisible()
  await expect(pro).toBeVisible()
  await expect(plus).toBeChecked()
  await page.screenshot({
    path: "test-results/subscription-selector-mobile.png",
    fullPage: true,
  })
  await expect(page.locator(".plan-selector-cover")).toHaveAttribute(
    "src",
    "/media/onboarding/girl-wallpaper.jpg",
  )
  await expect(
    page.getByRole("button", { name: /Continue with Plus/i }),
  ).toBeVisible()

  for (const width of [320, 360, 375, 390, 393, 412, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(plus).toBeVisible()
    await expect(pro).toBeVisible()
    const layout = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>(".plan-selector-option"),
      )
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        cards: cards.map((card) => {
          const { left, right } = card.getBoundingClientRect()
          return { left, right }
        }),
      }
    })
    expect(
      layout.documentWidth,
      `page overflows at ${width}px`,
    ).toBeLessThanOrEqual(width)
    expect(layout.cards).toHaveLength(2)
    expect(
      layout.cards.every(
        (card) => card.left >= 0 && card.right <= layout.viewportWidth + 1,
      ),
    ).toBe(true)
  }

  for (const height of [667, 744, 844]) {
    await page.setViewportSize({ width: 375, height })
    const initial = await page.evaluate(() => {
      const action = document.querySelector<HTMLElement>(".plan-selector-actions")!
      const button = action.querySelector<HTMLElement>("button")!
      const note = action.querySelector<HTMLElement>(".plan-selector-quality")!
      const screen = document.querySelector<HTMLElement>(".access-screen-plan-selector")!
      return {
        actionTop: action.getBoundingClientRect().top,
        buttonTop: button.getBoundingClientRect().top,
        buttonBottom: button.getBoundingClientRect().bottom,
        noteBottom: note.getBoundingClientRect().bottom,
        screenCanScroll: screen.scrollHeight > screen.clientHeight,
      }
    })
    expect(initial.buttonTop, `button hidden at ${height}px height`).toBeGreaterThan(0)
    expect(initial.buttonBottom).toBeLessThanOrEqual(height)
    expect(initial.noteBottom, `note hidden at ${height}px height`).toBeLessThanOrEqual(height)
    expect(initial.screenCanScroll).toBe(true)

    const scrolled = await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>(".access-screen-plan-selector")!
      screen.scrollTop = screen.scrollHeight
      const lastBenefit = document.querySelector<HTMLElement>(".plan-selector-benefit-list li:last-child")!
      const action = document.querySelector<HTMLElement>(".plan-selector-actions")!
      return {
        scrollTop: screen.scrollTop,
        lastBenefitBottom: lastBenefit.getBoundingClientRect().bottom,
        actionTop: action.getBoundingClientRect().top,
      }
    })
    expect(scrolled.scrollTop).toBeGreaterThan(0)
    expect(scrolled.lastBenefitBottom).toBeLessThan(scrolled.actionTop)
  }

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(plus).toBeVisible()
    await expect(pro).toBeVisible()
    await expect(page.getByRole("button", { name: /Continue with Plus/i })).toBeVisible()
    const layout = await page.evaluate(() => {
      const screen = document.querySelector<HTMLElement>(".access-screen-plan-selector")!
      const hero = document.querySelector<HTMLElement>(".plan-selector-hero")!
      const content = document.querySelector<HTMLElement>(".plan-selector-content")!
      const benefits = document.querySelector<HTMLElement>(".plan-selector-benefits")!
      const actions = document.querySelector<HTMLElement>(".plan-selector-actions")!
      return {
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
        screenHeight: screen.getBoundingClientRect().height,
        screenScrolls: screen.scrollHeight > screen.clientHeight + 1,
        contentFits: content.scrollHeight <= content.clientHeight + 1,
        heroRight: hero.getBoundingClientRect().right,
        contentLeft: content.getBoundingClientRect().left,
        benefitsBottom: benefits.getBoundingClientRect().bottom,
        actionsTop: actions.getBoundingClientRect().top,
        actionsBottom: actions.getBoundingClientRect().bottom,
      }
    })
    expect(layout.pageHeight, `document scrolls at ${viewport.height}px`).toBeLessThanOrEqual(viewport.height)
    expect(layout.screenHeight).toBe(viewport.height)
    expect(layout.screenScrolls).toBe(false)
    expect(layout.contentFits).toBe(true)
    expect(layout.heroRight).toBeLessThanOrEqual(layout.contentLeft + 1)
    expect(layout.benefitsBottom).toBeLessThan(layout.actionsTop)
    expect(layout.actionsBottom).toBeLessThanOrEqual(layout.viewportHeight)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: "test-results/subscription-selector-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 393, height: 844 })

  await expect(
    page.getByRole("heading", { name: "Plus benefits" }),
  ).toBeVisible()
  await page.locator(".plan-selector-option.is-pro").click()
  await expect(pro).toBeChecked()
  await expect(
    page.getByRole("heading", { name: "Pro benefits" }),
  ).toBeVisible()
  await expect(page.getByText("Includes everything in Plus")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Continue with Pro.*\$69/i }),
  ).toBeVisible()
  await page.locator(".plan-selector-option.is-plus").click()
  await expect(plus).toBeChecked()
  await expect(
    page.getByRole("heading", { name: "Plus benefits" }),
  ).toBeVisible()
  await page.locator(".plan-selector-option.is-pro").click()
  await expect(pro).toBeChecked()
  await page.getByRole("button", { name: /Continue with Pro/i }).click()

  await expect(page.locator(".plan-summary-text strong")).toHaveText("Pro")
  await expect(page.locator(".plan-summary-price")).toHaveText("$69.00")
})
