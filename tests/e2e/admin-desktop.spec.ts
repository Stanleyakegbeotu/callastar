import { expect, test, type Page } from "@playwright/test";

import { ADMIN_PROFILE, seedAdminSession, seedProfile } from "./support/seed";

/**
 * The admin workspace on a desktop.
 *
 * Video calling is a phone product; the dashboard is not, and the two must not
 * be confused. An operator managing profiles on a 1440px monitor should get a
 * desktop application, not a phone screen centred in a lot of empty space.
 *
 * Deliberately behavioural rather than pixel-exact: the assertions are that the
 * sidebar is there, the header stays put, nothing overflows sideways and the
 * content uses the width. Exact measurements would break on a font change and
 * tell us nothing.
 *
 * One browser context for the whole file, resized between checks. A context per
 * assertion costs a few hundred megabytes each and is the first thing to fail on
 * a loaded machine — and a layout test has no reason to want isolation, since it
 * neither places calls nor holds a session that another test could disturb.
 */

const DESKTOP_SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

/** Nothing should ever scroll sideways; a horizontal scrollbar is a layout bug. */
async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/** How much of the viewport the page content actually occupies. */
async function contentWidthRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const content = document.querySelector(".admin-page-content");
    if (!content) return 0;
    return content.getBoundingClientRect().width / window.innerWidth;
  });
}

test.describe("admin layout", () => {
  test("uses a real desktop shell, and does not inflate the bar on a phone", async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP_SIZES[1] });
    await seedAdminSession(context);
    const page = await context.newPage();

    try {
      await seedProfile(page, ADMIN_PROFILE);

      for (const size of DESKTOP_SIZES) {
        await page.setViewportSize(size);
        const at = `${size.width}×${size.height}`;

        for (const path of ["/admin", "/admin/profiles", `/admin/profiles/${ADMIN_PROFILE.id}`, "/admin/sessions"]) {
          await page.goto(path);
          await expect(page.locator(".admin-page-content")).toBeVisible();

          // The sidebar is persistent on desktop, not a drawer behind a button.
          const sidebar = page.locator(".admin-sidebar");
          await expect(sidebar, `${at} ${path}: sidebar should be visible`).toBeVisible();
          const sidebarBox = await sidebar.boundingBox();
          expect(sidebarBox?.width ?? 0, `${at} ${path}: sidebar width`).toBeGreaterThan(180);

          // The content uses the remaining width rather than sitting in a
          // phone-width column centred in the viewport.
          const ratio = await contentWidthRatio(page);
          expect(ratio, `${at} ${path}: content should use the viewport width`).toBeGreaterThan(0.6);

          expect(await hasHorizontalOverflow(page), `${at} ${path}: horizontal overflow`).toBe(false);
        }

        /* The top bar is sticky: it holds position while the page scrolls. */
        await page.goto(`/admin/profiles/${ADMIN_PROFILE.id}`);
        const topbar = page.locator(".admin-topbar");
        await expect(topbar).toBeVisible();
        const before = await topbar.boundingBox();

        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(400);

        const after = await topbar.boundingBox();
        await expect(topbar, `${at}: top bar should survive scrolling`).toBeVisible();
        expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0)), `${at}: top bar moved`).toBeLessThan(4);

        /*
         * Profiles is a card list, not a table — that is the implemented design,
         * and section 23 allows either. What matters is that each card carries
         * the fields an operator needs, and that Active and realtime presence
         * appear as two separate things rather than one overloaded dot.
         */
        await page.goto("/admin/profiles");
        const card = page.locator(".availability-card").first();
        await expect(card).toBeVisible();
        await expect(card.getByRole("switch")).toBeVisible();
        await expect(card.getByText(/call id/i)).toBeVisible();
        await expect(card.locator(".live-badge")).toBeVisible();

        /*
         * Sessions is a table, but only once there is call history to put in it.
         * This fixture seeds a profile and never places a call, so the page shows
         * its empty state — asserting on column headers here would be asserting
         * on data the test does not create. The `/admin/sessions` sidebar, width
         * and overflow checks above already cover its desktop layout.
         */
      }

      /*
       * The regression this guards.
       *
       * `.admin-app` is a grid with `min-height: 100dvh`. With the sidebar out of
       * the column flow, the bar and the canvas become two implicit rows sharing
       * the viewport, and on a page with little content the bar stretched to
       * nearly 240px. Naming the rows `auto 1fr` pins it to its own height.
       */
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/admin/notifications");
      await expect(page.locator(".admin-page-content")).toBeVisible();

      const phoneBar = await page.locator(".admin-topbar").boundingBox();
      expect(phoneBar?.height ?? 0, "top bar should hug its contents on a phone").toBeLessThan(120);
      expect(await hasHorizontalOverflow(page), "phone: horizontal overflow").toBe(false);
    } finally {
      await context.close();
    }
  });
});
