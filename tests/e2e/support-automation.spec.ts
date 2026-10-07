import { expect, test } from "@playwright/test";

test("support chat keeps its quick actions and composer usable across phone widths and a return visit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 744 });
  await page.goto("/tests/fixtures/support-automation.html");
  await expect(page.getByText("Would you like to continue with your payment?")).toBeVisible();
  await expect(page.getByText("Plus at $39.00", { exact: false })).toBeVisible();
  await page.screenshot({ path: "test-results/support-automation-mobile.png" });

  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 667 });
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-visual-height"))).toBe("667px");
    const layout = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>(".chat-decision-actions")!;
      const composer = document.querySelector<HTMLElement>(".chat-composer-wrap")!;
      const buttons = [...actions.querySelectorAll<HTMLElement>("button")];
      return {
        documentWidth: document.documentElement.scrollWidth,
        actionRight: actions.getBoundingClientRect().right,
        buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
        composerBottom: composer.getBoundingClientRect().bottom,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(width);
    expect(layout.actionRight).toBeLessThanOrEqual(width);
    expect(layout.buttonHeights.every((height) => height >= 44)).toBe(true);
    expect(layout.composerBottom).toBeLessThanOrEqual(667);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await page.setViewportSize({ width: 390, height: 744 });

  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByText("Please select your preferred payment method below.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveCount(0);
  for (const method of ["Bank Transfer", "Cash App", "Cryptocurrency", "Gift Cards", "PayPal"]) {
    await expect(page.getByRole("button", { name: `Select ${method} as payment method` })).toBeVisible();
  }
  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 667 });
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-visual-height"))).toBe("667px");
    const layout = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>(".chat-payment-methods")!;
      const composer = document.querySelector<HTMLElement>(".chat-composer-wrap")!;
      return {
        documentWidth: document.documentElement.scrollWidth,
        actionRight: actions.getBoundingClientRect().right,
        buttonHeights: [...actions.querySelectorAll<HTMLElement>("button")].map((button) => button.getBoundingClientRect().height),
        buttonContentFits: [...actions.querySelectorAll<HTMLElement>("button")].every((button) => button.scrollWidth <= button.clientWidth + 1),
        composerBottom: composer.getBoundingClientRect().bottom,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(width);
    expect(layout.actionRight).toBeLessThanOrEqual(width);
    expect(layout.buttonHeights.every((height) => height >= 44)).toBe(true);
    expect(layout.buttonContentFits).toBe(true);
    expect(layout.composerBottom).toBeLessThanOrEqual(667);
  }
  await page.setViewportSize({ width: 390, height: 744 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopPaymentLayout = await page.evaluate(() => {
    const actions = document.querySelector<HTMLElement>(".chat-payment-methods")!;
    const buttons = [...actions.querySelectorAll<HTMLElement>("button")];
    return {
      documentWidth: document.documentElement.scrollWidth,
      actionRight: actions.getBoundingClientRect().right,
      buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
      buttonContentFits: buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
    };
  });
  expect(desktopPaymentLayout.documentWidth).toBeLessThanOrEqual(1280);
  expect(desktopPaymentLayout.actionRight).toBeLessThanOrEqual(1280);
  expect(desktopPaymentLayout.buttonHeights.every((height) => height >= 44)).toBe(true);
  expect(desktopPaymentLayout.buttonContentFits).toBe(true);
  await page.setViewportSize({ width: 390, height: 744 });
  await page.getByPlaceholder(/Message CallaStar support/i).fill("hi");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText("hi", { exact: true })).toBeVisible();
  await expect(page.getByText("Please select your preferred payment method below.")).toBeVisible();
  await expect(page.getByText(/specialist will confirm the payment details/)).toHaveCount(0);
  await page.getByRole("button", { name: "Select Cash App as payment method" }).click();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText("Cash App", { exact: true })).toBeVisible();
  await expect(page.getByText("Thank you. You've selected Cash App.")).toBeVisible();
  await expect(page.getByText("A CallaStar specialist will confirm the payment details with you here.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Select .* as payment method/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Reopen chat" }).click();
  await expect(page.getByText("Welcome back, Sarah. A CallaStar specialist will continue assisting you with your Cash App payment here.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Select .* as payment method/ })).toHaveCount(0);
  await expect(page.getByText("Hi Sarah, welcome to CallaStar Support.")).toHaveCount(1);
  await page.getByRole("button", { name: /Plus, \$39\.00\. View package details/ }).click();
  await page.getByRole("button", { name: /Pro.*\$69\.00/ }).click();
  await expect(page.getByRole("button", { name: /Pro, \$69\.00\. View package details/ })).toBeVisible();
});

test("a returning customer can resume pending method selection or ask for help", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 744 });
  await page.goto("/tests/fixtures/support-automation.html");
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select PayPal as payment method" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Reopen chat" }).click();
  await expect(page.getByText(/Welcome back, Sarah\. Would you like to continue choosing your payment method\?/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue Payment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "I Need Help" })).toBeVisible();
  await page.getByRole("button", { name: "I Need Help" }).click();
  await expect(page.getByText("Okay, how can we help you today?")).toBeVisible();
  await expect(page.getByRole("button", { name: /Select .* as payment method/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Reopen chat" }).click();
  await expect(page.getByRole("button", { name: "Continue Payment" })).toBeVisible();
});

test("accountless Customer Care opens directly and payment offers both handoff choices", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { openedUrls?: string[] }).openedUrls = [];
    window.open = ((url?: string | URL | null) => {
      (window as Window & { openedUrls?: string[] }).openedUrls?.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto("/support");
  await expect(page.getByPlaceholder(/Message CallaStar support/i)).toBeVisible();
  await expect(page.getByText(/sign-in link|verify your email|verification/i)).toHaveCount(0);
  await page.goto("/tests/fixtures/support-automation.html");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "Select Bank Transfer as payment method" }).click();
  await expect(page.getByRole("button", { name: "Continue on WhatsApp" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue in CallaStar" })).toBeVisible();
  await page.getByRole("button", { name: "Continue in CallaStar" }).click();
  expect(await page.evaluate(() => window.openedUrls?.length ?? 0)).toBe(0);
  await page.getByRole("button", { name: "Continue on WhatsApp" }).click();
  await expect.poll(() => page.evaluate(() => window.openedUrls?.length ?? 0)).toBe(1);
  await expect(page.getByPlaceholder(/Message CallaStar support/i)).toBeVisible();
});
