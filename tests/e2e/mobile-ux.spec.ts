import { expect, test, type Page } from "@playwright/test";

import { ADMIN_PROFILE, seedAdminSession, seedProfile } from "./support/seed";

/**
 * Mobile layout stability.
 *
 * Two things are being proved here, and neither can be proved by looking at the
 * page scroll width.
 *
 * The root now carries `overflow-x: clip` as a last guard, which would make a
 * `scrollWidth` assertion pass whatever happened underneath — the exact
 * masking the guard is not supposed to provide. So this measures real element
 * geometry: nothing may have a right edge past the viewport, and the failure
 * names the element so it is actionable rather than just red.
 *
 * The second is iOS focus zoom. Mobile Safari zooms when a control smaller than
 * 16px takes focus, and the zoomed page is wider than the viewport — which is
 * what produced the sideways shake on the admin forms. Playwright cannot
 * reproduce Safari's zoom, but it can assert the condition that triggers it.
 */

const PHONE_SIZES = [
  { name: "iPhone 12/13/14", width: 390, height: 844 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932 },
] as const;

/** Elements legitimately parked off-canvas, which are not overflow. */
const OFF_CANVAS = [".admin-sidebar", ".admin-scrim"];

interface Overflow {
  selector: string;
  right: number;
  width: number;
}

/**
 * Every element whose box extends past the viewport's right edge.
 *
 * Deliberately not `scrollWidth`: that measures the document after clipping and
 * would hide the very thing this is looking for.
 */
async function findOverflow(page: Page, ignore: readonly string[] = OFF_CANVAS): Promise<Overflow[]> {
  return page.evaluate((ignored) => {
    const limit = window.innerWidth;
    const found: { selector: string; right: number; width: number }[] = [];

    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const cls =
        typeof element.className === "string" && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      return `${tag}${id}${cls}`;
    };

    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      if (ignored.some((selector) => element.closest(selector))) continue;

      const style = window.getComputedStyle(element);
      // Invisible things cannot push the page sideways.
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      // A fixed overlay intentionally spanning the viewport is not overflow.
      if (style.position === "fixed") continue;

      /*
       * An element clipped by an ancestor cannot pan the page.
       *
       * `getBoundingClientRect` reports an element's own geometry whether or not
       * a parent clips it, so a decorative blurred orb deliberately hanging past
       * the edge of an `overflow: hidden` backdrop looks identical to a genuine
       * overflow. It is not one: nothing outside the clip is reachable or
       * scrollable. Walking up for a clipping ancestor is what tells them apart.
       */
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const parentStyle = window.getComputedStyle(parent);
        const overflowX = parentStyle.overflowX;
        if (overflowX === "hidden" || overflowX === "clip" || overflowX === "auto" || overflowX === "scroll") {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // A generous single pixel for sub-pixel rounding.
      if (rect.right > limit + 1) {
        found.push({ selector: describe(element), right: Math.round(rect.right), width: Math.round(rect.width) });
      }
    }

    // The outermost offender is the useful one; its children usually follow.
    return found.slice(0, 8);
  }, ignore);
}

/** Computed font size, in px, of every editable control on the page. */
async function controlFontSizes(page: Page): Promise<{ selector: string; px: number }[]> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    return controls
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        // A file input is never focused for typing, so it cannot trigger zoom.
        return !(element instanceof HTMLInputElement && element.type === "file");
      })
      .map((element) => {
        const style = window.getComputedStyle(element);
        const tag = element.tagName.toLowerCase();
        const name = element.getAttribute("name") ?? element.getAttribute("aria-label") ?? "";
        return { selector: `${tag}${name ? `[${name}]` : ""}`, px: Number.parseFloat(style.fontSize) };
      });
  });
}

for (const size of PHONE_SIZES) {
  test.describe(`mobile layout at ${size.width}×${size.height}`, () => {
    test(`public and admin screens do not overflow sideways (${size.name})`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      });
      await seedAdminSession(context);
      const page = await context.newPage();

      try {
        await seedProfile(page, ADMIN_PROFILE);

        const routes = [
          "/",
          "/connect",
          "/join/video",
          "/join/audio",
          "/support",
          "/admin",
          "/admin/profiles",
          "/admin/profiles/new",
          `/admin/profiles/${ADMIN_PROFILE.id}`,
          `/admin/profiles/${ADMIN_PROFILE.id}/edit`,
          "/admin/media",
          "/admin/sessions",
          "/admin/subscriptions",
          "/admin/support",
          "/admin/settings",
          "/admin/studio",
        ];

        for (const route of routes) {
          await page.goto(route);
          // Something must have rendered, or the check is vacuous.
          await expect(page.locator("body")).toBeVisible();
          await page.waitForTimeout(250);

          const overflow = await findOverflow(page);
          expect(
            overflow,
            `${route} at ${size.width}px has elements past the right edge: ${JSON.stringify(overflow)}`,
          ).toEqual([]);
        }
      } finally {
        await context.close();
      }
    });

    test(`editable controls are at least 16px, so Safari does not zoom (${size.name})`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      });
      await seedAdminSession(context);
      const page = await context.newPage();

      try {
        await seedProfile(page, ADMIN_PROFILE);

        // The forms an operator and a caller actually type into.
        const routes = [
          "/join/video",
          "/support",
          "/admin/profiles/new",
          `/admin/profiles/${ADMIN_PROFILE.id}/edit`,
          "/admin/settings",
        ];

        for (const route of routes) {
          await page.goto(route);
          await page.waitForTimeout(250);

          const sizes = await controlFontSizes(page);
          const tooSmall = sizes.filter((control) => control.px < 16);
          expect(
            tooSmall,
            `${route} has controls under 16px, which makes iOS Safari zoom on focus: ${JSON.stringify(tooSmall)}`,
          ).toEqual([]);
        }
      } finally {
        await context.close();
      }
    });
  });
}

/**
 * The Transformation Studio, across every width the mobile pass named.
 *
 * Its own sweep rather than five more passes of the whole route list: the
 * Studio is the new screen, and it introduces a preview with a fixed aspect
 * ratio, a horizontally scrolling step rail and a wrapping control row — three
 * of the most reliable ways to make a page pan sideways on a phone.
 */
const STUDIO_WIDTHS = [360, 375, 390, 393, 430] as const;

test.describe("Transformation Studio on a phone", () => {
  for (const width of STUDIO_WIDTHS) {
    test(`does not overflow sideways at ${width}px`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      });
      await seedAdminSession(context);
      const page = await context.newPage();

      try {
        // A source is prepared FOR a profile, and the step refuses to guess
        // which — so a realistic install has one.
        await seedProfile(page, ADMIN_PROFILE);

        await page.goto("/admin/studio");
        await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();
        await page.waitForTimeout(250);

        const overflow = await findOverflow(page);
        expect(
          overflow,
          `/admin/studio at ${width}px has elements past the right edge: ${JSON.stringify(overflow)}`,
        ).toEqual([]);

        // The step rail scrolls on purpose; the page must not scroll with it.
        const panned = await page.evaluate(() => {
          const rail = document.querySelector(".studio-steps");
          rail?.scrollBy(400, 0);
          return { pageScroll: window.scrollX, railScroll: Math.round(rail?.scrollLeft ?? 0) };
        });
        expect(panned.railScroll, "the rail itself should scroll").toBeGreaterThan(0);
        expect(panned.pageScroll, "the page must not pan with it").toBe(0);

        /*
         * The calibration control.
         *
         * It is the one thing on this page an operator must be able to reach,
         * and it is the last card in a column — so it is also the control most
         * likely to end up under a home indicator or half off the side.
         */
        const cta = page.getByRole("button", { name: "Start calibration" });
        await expect(cta).toBeVisible();

        const box = await cta.boundingBox();
        expect(box, "the calibration button must have a box").not.toBeNull();
        expect(box!.x, `calibration CTA starts off-screen at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `calibration CTA overflows at ${width}px`).toBeLessThanOrEqual(width + 1);
        // A comfortable tap target, and never a hairline row.
        expect(box!.height).toBeGreaterThanOrEqual(44);

        // In the document flow, so the admin shell's own scrolling and safe-area
        // padding carry it clear of the home indicator. A fixed CTA would not.
        const positioning = await cta.evaluate((element) => window.getComputedStyle(element).position);
        expect(positioning).not.toBe("fixed");

        /*
         * The source controls.
         *
         * This is the step most likely to be used on the device holding the
         * photograph, so the upload buttons have to be reachable rather than
         * merely present.
         */
        for (const name of ["Upload image", "Upload video"]) {
          const control = page.getByRole("button", { name });
          await expect(control).toBeVisible();

          const controlBox = await control.boundingBox();
          expect(controlBox, `${name} must have a box`).not.toBeNull();
          expect(controlBox!.x, `${name} starts off-screen at ${width}px`).toBeGreaterThanOrEqual(0);
          expect(controlBox!.x + controlBox!.width, `${name} overflows at ${width}px`).toBeLessThanOrEqual(
            width + 1,
          );
          expect(controlBox!.height, `${name} is not a comfortable tap target`).toBeGreaterThanOrEqual(44);
        }
      } finally {
        await context.close();
      }
    });
  }
});
