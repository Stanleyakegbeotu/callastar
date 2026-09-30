import { expect, test, type Page } from "@playwright/test";

type Check = "mediapipe" | "opencv" | "three" | "worker";

async function preflight(page: Page, check: Check) {
  await page.goto("/");
  const evaluate = () => page.evaluate(async (selectedCheck) => {
      const module = await import("/src/features/transformation/preflight.ts");
      return module.runTransformationPreflight([selectedCheck]);
    }, check);
  try {
    return await evaluate();
  } catch (error) {
    // Vite reloads on the first discovery of a large optimized dependency.
    if (!String(error).includes("Execution context was destroyed")) throw error;
    await page.waitForLoadState("load");
    return evaluate();
  }
}

test("MediaPipe imports and finds locally hosted WASM without a model", async ({ page }) => {
  test.setTimeout(180_000);
  const result = await preflight(page, "mediapipe");
  expect(result.mediaPipeImport).toBe(true);
  expect(result.mediaPipeWasmAssetsReachable).toBe(true);
  expect(result.mediaPipeWasmInitialized).toBe(false);
  /*
   * Both were `false` when this file was written, because no model binaries
   * existed yet. Milestone 3 added `scripts/fetch-transformation-models.mjs`
   * and wired the generated paths, so a build that reaches this point MUST have
   * them — a checkout where these are false is one where the Studio would load
   * and then fail at the first inference.
   */
  expect(result.faceModelConfigured).toBe(true);
  expect(result.poseModelConfigured).toBe(true);
  expect(result.failures).toEqual([]);
});

test("OpenCV initializes and releases a Mat", async ({ page }) => {
  test.setTimeout(180_000);
  const result = await preflight(page, "opencv");
  expect(result.openCvInitialized).toBe(true);
  expect(result.failures).toEqual([]);
});

test("Three creates and disposes a WebGL2 renderer when supported", async ({ page }) => {
  test.setTimeout(180_000);
  const result = await preflight(page, "three");
  if (result.browser.webGl2) expect(result.threeRendererInitialized).toBe(true);
  expect(result.failures).toEqual([]);
});

test("Comlink starts and terminates a worker without camera permission", async ({ page }) => {
  test.setTimeout(180_000);
  const result = await preflight(page, "worker");
  expect(result.browser.getUserMedia).toBe(true); // API presence only.
  expect(result.workerComlinkReady).toBe(true);
  expect(result.failures).toEqual([]);
});
