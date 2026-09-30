import { expect, test, type Page } from "@playwright/test";

/**
 * The Studio's real horizontal overflow, measured in the states that cause it.
 *
 * The mobile sweep checks the Studio while it is IDLE and passes — yet a physical
 * iPhone still dragged sideways. That gap is the point of this file: the panels
 * which overflow only exist once a source is chosen and the diagnostics drawer is
 * open.
 *
 * Asserted on `document.documentElement.scrollWidth` against `window.innerWidth`
 * — the acceptance the milestone names — PLUS the offending element, so a failure
 * is actionable. Checking `scrollWidth` alone could be satisfied by clipping the
 * page, which hides the cause instead of fixing it.
 *
 * Lives in the transformation suite rather than the e2e one: it needs a single
 * dev server, not the signalling stack, and the heavier harness timed out on a
 * contended machine before it could measure anything.
 */

const WIDTHS = [360, 375, 390, 393, 430] as const;
const DEV_SESSION_KEY = "callastar.development-admin";

interface Offender {
  selector: string;
  right: number;
  width: number;
  scrollWidth: number;
}

async function findOverflow(page: Page): Promise<{
  offenders: Offender[];
  pageScrollWidth: number;
  innerWidth: number;
}> {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    const offenders: { selector: string; right: number; width: number; scrollWidth: number }[] = [];

    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const cls =
        typeof element.className === "string" && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      return `${tag}${cls}`;
    };

    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      if (style.position === "fixed") continue;

      /*
       * A horizontally scrollable strip is deliberate and is not overflow —
       * nothing outside it can pan the page. So an element contained by a
       * clipping or scrolling ancestor is skipped.
       */
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = window.getComputedStyle(parent).overflowX;
        if (overflowX === "hidden" || overflowX === "clip" || overflowX === "auto" || overflowX === "scroll") {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > limit + 1) {
        offenders.push({
          selector: describe(element),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
        });
      }
    }

    return { offenders: offenders.slice(0, 8), pageScrollWidth: document.documentElement.scrollWidth, innerWidth: limit };
  });
}

async function openStudio(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(
    ({ key }) => {
      try {
        sessionStorage.setItem(key, "active");
      } catch {
        /* the route lands on the login screen and the test says so */
      }
    },
    { key: DEV_SESSION_KEY },
  );

  await page.goto("/admin/profiles");
  await page.evaluate(async () => {
    const { adminRepository } = await import("/src/services/admin/repository.ts");
    const existing = await adminRepository.listProfiles();
    if (existing.length === 0) {
      await adminRepository.createProfile({
        displayName: "Overflow Fixture",
        shortBio: "Studio overflow test",
        status: "active",
      });
    }
  });

  await page.goto("/admin/studio");
  await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();
}

/** Chooses a source and opens every panel a device test would have open. */
async function openPanels(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#c8c8c8";
    context.fillRect(0, 0, 640, 480);
    context.fillStyle = "#e0b89a";
    context.beginPath();
    context.ellipse(320, 240, 110, 145, 0, 0, Math.PI * 2);
    context.fill();

    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    // A deliberately long filename: the one piece of unbounded text on the panel.
    const file = new File([blob], "a-source-file-with-a-very-long-name-indeed-2026.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    const input = document.querySelector<HTMLInputElement>('input[accept*="image/png"]');
    if (!input) throw new Error("no image input");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const diagnostics = page.getByRole("button", { name: "Diagnostics" });
  if (await diagnostics.isVisible().catch(() => false)) await diagnostics.click();
  await page.waitForTimeout(300);
}

for (const width of WIDTHS) {
  test(`the Studio does not drag sideways at ${width}px with its panels open`, async ({ page }) => {
    test.setTimeout(180_000);

    await openStudio(page, width);
    await openPanels(page);

    const result = await findOverflow(page);

    // The acceptance the milestone names.
    expect(
      result.pageScrollWidth,
      `page scrollWidth ${result.pageScrollWidth} exceeds viewport ${result.innerWidth}; offenders: ${JSON.stringify(result.offenders)}`,
    ).toBeLessThanOrEqual(result.innerWidth);

    // And the cause, so a regression is fixable rather than merely hidden.
    expect(
      result.offenders,
      `elements past the right edge at ${width}px: ${JSON.stringify(result.offenders)}`,
    ).toEqual([]);

    // Nothing may actually be dragged.
    const panned = await page.evaluate(() => {
      window.scrollTo(200, 0);
      return window.scrollX;
    });
    expect(panned, "the page must not pan horizontally").toBe(0);
  });
}
