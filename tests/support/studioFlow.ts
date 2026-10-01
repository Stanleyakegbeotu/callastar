import { expect, type Page } from "@playwright/test";

import { installFaceCamera } from "./faceCamera";

const DEV_SESSION_KEY = "callastar.development-admin";
export const PORTRAIT = "/media/onboarding/male-participant.jpg";

/** Opens the Studio as a development admin, with exactly one profile to prepare for. */
export async function openStudioWithFaceCamera(page: Page, width = 390, height = 844): Promise<void> {
  await page.setViewportSize({ width, height });
  await installFaceCamera(page, PORTRAIT);
  await page.addInitScript((key: string) => {
    try {
      sessionStorage.setItem(key, "active");
    } catch {
      /* the route lands on the login screen and the test says so */
    }
  }, DEV_SESSION_KEY);
  await page.goto("/admin/profiles");
  await page.evaluate(async () => {
    const { adminRepository } = await import("/src/services/admin/repository.ts");
    if ((await adminRepository.listProfiles()).length === 0) {
      await adminRepository.createProfile({ displayName: "Studio Fixture", shortBio: "M8.3", status: "active" });
    }
  });
  await page.goto("/admin/studio");
  await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();
}

/** Chooses the same real portrait as the source image and analyses it. */
export async function prepareSource(page: Page): Promise<void> {
  await page.evaluate(async (url: string) => {
    const blob = await (await fetch(url)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "portrait.jpg", { type: "image/jpeg" }));
    const input = document.querySelector<HTMLInputElement>('input[accept*="image/jpeg"]');
    if (!input) throw new Error("no image input");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, PORTRAIT);
  await page.getByLabel("I confirm I have permission to use this source.").check();
  await page.getByRole("button", { name: "Analyze source" }).click();
  await expect(page.getByRole("button", { name: "Change source" })).toBeVisible({ timeout: 120_000 });
}

/** Starts the camera and completes calibration, face-only if shoulders are refused. */
export async function startAndCalibrate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start camera" }).first().click();
  const start = page.getByRole("button", { name: "Start calibration" });
  await expect(start).toBeEnabled({ timeout: 120_000 });
  await start.click();
  const recalibrate = page.getByRole("button", { name: "Recalibrate" });
  const faceOnly = page.getByRole("button", { name: "Calibrate face only" });
  await expect(recalibrate.or(faceOnly)).toBeVisible({ timeout: 120_000 });
  if (await faceOnly.isVisible()) {
    await faceOnly.click();
    await expect(recalibrate).toBeVisible({ timeout: 120_000 });
  }
}

export async function openFaceRender(page: Page): Promise<void> {
  const face = page.getByRole("button", { name: "Face render" });
  await expect(face).toBeEnabled({ timeout: 60_000 });
  await face.click();
  await expect(page.locator(".studio-face-renderer.is-visible").first()).toBeVisible();
}

export interface Box { x: number; y: number; width: number; height: number }

export async function boxes(page: Page): Promise<{ viewport: Box; video: Box; source: Box | null; renderer: Box | null }> {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      viewport: box(document.querySelector(".studio-viewport"))!,
      video: box(document.querySelector(".studio-video"))!,
      source: box(document.querySelector('[data-testid="studio-source-reference"]')),
      renderer: box(document.querySelector(".studio-face-renderer.is-visible")),
    };
  });
}

/** The page-level horizontal overflow invariant, with the offending elements named. */
export async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; offenders: string[] }> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX !== "visible") { clipped = true; break; }
      }
      if (clipped) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.right > limit + 1) offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/).slice(0, 2).join(".")} right=${Math.round(rect.right)}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, offenders: offenders.slice(0, 6) };
  });
}
