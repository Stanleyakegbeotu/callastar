import { expect, test, type Page } from "@playwright/test";

import {
  boxes,
  horizontalOverflow,
  openFaceRender,
  openStudioWithFaceCamera,
  prepareSource,
  startAndCalibrate,
  type Box,
} from "./support/studioFlow";

/**
 * M8.3 Phase 1: the preview is a test instrument before it is anything else.
 *
 * Raw is the operator's live camera with the source as a small reference; Face
 * Render is the output with the live camera beside it for comparison; expanding
 * restyles the same elements. Driven end to end — real MediaPipe on a real
 * photograph fed through the camera, a real calibration, the real renderer.
 */

const WIDTHS = [320, 360, 375, 390, 393, 414, 430] as const;
const area = (b: Box) => b.width * b.height;

async function assertNoOverflowAtEveryWidth(page: Page, state: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(120);
    const result = await horizontalOverflow(page);
    expect(result.scrollWidth, `${state} at ${width}px: ${JSON.stringify(result.offenders)}`).toBeLessThanOrEqual(result.clientWidth + 1);
    expect(result.offenders, `${state} at ${width}px`).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
}

/** Marks the live elements so a later check can prove they were not replaced. */
async function tagLiveElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const video = document.querySelector<HTMLVideoElement>(".studio-video")!;
    w.__video = video;
    w.__stream = video.srcObject;
    w.__renderer = document.querySelector(".studio-face-renderer.is-visible");
  });
}

async function sameLiveElements(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown> & { __faceCamera: { calls: number } };
    const video = document.querySelector<HTMLVideoElement>(".studio-video")!;
    const stream = video.srcObject as MediaStream | null;
    const before = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      sameVideo: video === w.__video,
      sameStream: stream === w.__stream,
      streamLive: !!stream && stream.getVideoTracks().every((track) => track.readyState === "live"),
      advancing: video.currentTime > before,
      sameRenderer: document.querySelector(".studio-face-renderer.is-visible") === w.__renderer,
      cameraRequests: w.__faceCamera.calls,
    };
  });
}

test("raw is the live camera, face render keeps it as a PiP, and expanding restyles the same elements", async ({ page }) => {
  test.setTimeout(420_000);
  await openStudioWithFaceCamera(page);
  await prepareSource(page);

  // Before the camera starts, the source may fill the stage so it can be judged.
  expect(await page.getByTestId("studio-source-reference").getAttribute("class")).toContain("is-full");

  await startAndCalibrate(page);

  // RAW: the live camera owns the stage; the source is a small reference.
  const raw = await boxes(page);
  expect(area(raw.video) / area(raw.viewport)).toBeGreaterThan(0.95);
  expect(raw.source, "the source reference thumbnail is visible").not.toBeNull();
  expect(area(raw.source!) / area(raw.viewport)).toBeLessThan(0.12);
  expect(raw.renderer).toBeNull();
  await expect(page.getByRole("button", { name: "Raw camera" })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".studio-stage").screenshot({ path: test.info().outputPath("phase1-raw.png") });
  await assertNoOverflowAtEveryWidth(page, "raw");

  // FACE RENDER: output owns the stage, the live camera is a comparison PiP.
  await openFaceRender(page);
  const face = await boxes(page);
  expect(area(face.renderer!) / area(face.viewport)).toBeGreaterThan(0.95);
  expect(area(face.video) / area(face.viewport)).toBeLessThan(0.12);
  expect(area(face.video)).toBeGreaterThan(0);
  // Top-right, clear of the face at the centre of the output.
  expect(face.video.x + face.video.width).toBeGreaterThan(face.viewport.x + face.viewport.width * 0.85);
  expect(face.video.y + face.video.height).toBeLessThan(face.viewport.y + face.viewport.height * 0.35);
  const pip = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(".studio-video")!;
    const style = getComputedStyle(video);
    return { visible: style.visibility !== "hidden" && style.display !== "none", zIndex: Number(style.zIndex) };
  });
  expect(pip.visible).toBe(true);
  await page.waitForTimeout(600);
  await page.locator(".studio-stage").screenshot({ path: test.info().outputPath("phase1-face-render.png") });
  await assertNoOverflowAtEveryWidth(page, "face render");

  // EXPAND, where the Fullscreen API exists: same camera element, same stream,
  // same renderer canvas, and the stage is what the browser shows.
  await tagLiveElements(page);
  await page.getByRole("button", { name: "Expand preview" }).click();
  await expect(page.locator(".studio-stage.is-expanded")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("studio-stage") ?? false)).toBe(true);
  expect(await sameLiveElements(page)).toMatchObject({ sameVideo: true, sameStream: true, streamLive: true, advancing: true, sameRenderer: true, cameraRequests: 1 });
  await page.getByRole("button", { name: "Minimize preview" }).click();
  await expect(page.locator(".studio-stage.is-expanded")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByRole("button", { name: "Face render" })).toHaveAttribute("aria-pressed", "true");

  // EXPAND WITHOUT the Fullscreen API, as on iPhone Safari: the CSS layer alone
  // must fill the viewport at every phone width.
  await page.evaluate(() => Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => false }));
  await page.getByRole("button", { name: "Expand preview" }).click();
  await expect(page.locator(".studio-stage.is-expanded")).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(120);
    const layer = await page.evaluate(() => {
      const stage = document.querySelector(".studio-stage")!.getBoundingClientRect();
      const viewport = document.querySelector(".studio-viewport")!.getBoundingClientRect();
      const stop = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Stop")!.getBoundingClientRect();
      return { stage: { w: stage.width, h: stage.height }, viewport: { w: viewport.width, h: viewport.height }, stopBottom: stop.bottom, innerWidth, innerHeight };
    });
    expect(layer.stage.w, `stage width at ${width}`).toBeCloseTo(layer.innerWidth, 0);
    expect(layer.stage.h, `stage height at ${width}`).toBeCloseTo(layer.innerHeight, 0);
    expect(layer.viewport.h, `preview height at ${width}`).toBeGreaterThan(layer.innerHeight * 0.7);
    // The camera controls stay reachable inside the screen.
    expect(layer.stopBottom).toBeLessThanOrEqual(layer.innerHeight + 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath("phase1-expanded.png") });
  await assertNoOverflowAtEveryWidth(page, "expanded");
  expect(await sameLiveElements(page)).toMatchObject({ sameVideo: true, sameStream: true, streamLive: true, advancing: true, sameRenderer: true, cameraRequests: 1 });

  // The expanded toolbar switches modes without leaving expanded view.
  const modes = page.getByRole("group", { name: "Expanded preview mode" });
  await modes.getByRole("button", { name: "Camera" }).click();
  const cameraExpanded = await boxes(page);
  expect(area(cameraExpanded.video) / area(cameraExpanded.viewport)).toBeGreaterThan(0.95);
  await modes.getByRole("button", { name: "Face" }).click();
  await expect(page.locator(".studio-face-renderer.is-visible").first()).toBeVisible();
  await tagLiveElements(page);

  // MINIMIZE: back in the page, still in Face Render, nothing restarted.
  await page.getByRole("button", { name: "Minimize preview" }).click();
  await expect(page.locator(".studio-stage.is-expanded")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Face render" })).toHaveAttribute("aria-pressed", "true");
  expect(await sameLiveElements(page)).toMatchObject({ sameVideo: true, sameStream: true, streamLive: true, advancing: true, sameRenderer: true, cameraRequests: 1 });
});
