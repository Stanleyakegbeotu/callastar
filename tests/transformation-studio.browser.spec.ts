import { expect, test, type Page } from "@playwright/test";

/**
 * Transformation Studio, in a real browser.
 *
 * The unit suites prove each piece with stubs. This proves what a stub cannot:
 * that the route asks for no camera until an operator does, that a real
 * `getUserMedia` stream reaches the models and comes back with measurements,
 * that pausing genuinely stops inference, and — the one that matters most —
 * that leaving the Studio ends every track.
 *
 * Chrome's fake camera is a rolling pattern with no person in it, so a
 * detection is not expected and is never asserted. What is asserted is that
 * frames reached the models and that the counters moved, which is the whole of
 * what Milestone 4 claims.
 *
 * Deliberately no frames-per-second thresholds. This config forces the
 * SwiftShader software rasteriser, so any rate measured here says more about
 * the CI machine than about the pipeline.
 */

// Granted for the file. Holding a permission is not using a device, so the
// gating test below still proves the Studio asks for nothing on its own.
test.use({ permissions: ["camera"] });

const DEV_SESSION_KEY = "callastar.development-admin";
const STUDIO = "/admin/studio";

/** Records every stream `getUserMedia` hands out, and every call, before any app code runs. */
const INSTRUMENT = () => {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  const scope = window as unknown as {
    __gumCalls: MediaStreamConstraints[];
    __gumStreams: MediaStream[];
  };
  scope.__gumCalls = [];
  scope.__gumStreams = [];
  if (!media?.getUserMedia) return;

  const original = media.getUserMedia.bind(media);
  media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    scope.__gumCalls.push(constraints ?? {});
    const stream = await original(constraints);
    scope.__gumStreams.push(stream);
    return stream;
  };
};

interface TrackReport {
  kind: string;
  readyState: string;
}

async function trackReport(page: Page): Promise<TrackReport[]> {
  return page.evaluate(() => {
    const scope = window as unknown as { __gumStreams?: MediaStream[] };
    return (scope.__gumStreams ?? []).flatMap((stream) =>
      stream.getTracks().map((track) => ({ kind: track.kind, readyState: track.readyState })),
    );
  });
}

async function gumCalls(page: Page): Promise<MediaStreamConstraints[]> {
  return page.evaluate(() => (window as unknown as { __gumCalls?: MediaStreamConstraints[] }).__gumCalls ?? []);
}

/** Reads one diagnostics row by its `data-metric`. */
async function metric(page: Page, name: string): Promise<string> {
  return (await page.locator(`[data-metric="${name}"] dd`).innerText()).trim();
}

async function metricNumber(page: Page, name: string): Promise<number | null> {
  const text = await metric(page, name);
  const parsed = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function openStudio(page: Page): Promise<void> {
  await page.addInitScript(INSTRUMENT);
  await page.addInitScript(
    ({ key }) => {
      try {
        sessionStorage.setItem(key, "active");
      } catch {
        // Without storage the route lands on the login screen and the test says so.
      }
    },
    { key: DEV_SESSION_KEY },
  );
  await page.goto(STUDIO);
  await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();
}

/** Starts the camera and waits until the loop has actually produced a frame. */
async function startTracking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start camera" }).click();

  // Model download plus task creation under SwiftShader; the config's timeout
  // covers it, and the status chip only appears once the camera is live.
  await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible({ timeout: 240_000 });

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect
    .poll(async () => await metricNumber(page, "camera-frames"), { timeout: 60_000 })
    .toBeGreaterThan(0);
}

test.describe("permission gating", () => {
  test("asks for no camera until the operator does", async ({ page }) => {
    /*
     * The rule this enforces.
     *
     * A permission prompt nobody asked for is a prompt people dismiss, and a
     * dismissed prompt is expensive to recover from. Opening the route must
     * touch no device at all.
     */
    await openStudio(page);

    // Long enough for any effect-driven request to have fired.
    await page.waitForTimeout(1500);

    expect(await gumCalls(page), "opening the Studio must not call getUserMedia").toEqual([]);
    await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  });

  test("shows the full six-step pipeline, with the unbuilt steps labelled", async ({ page }) => {
    // The Studio has to look partial, because it is.
    await openStudio(page);

    const rail = page.getByRole("list", { name: "Transformation Studio steps" });
    for (const label of ["Source", "Analyze", "Camera", "Calibrate", "Preview", "Save"]) {
      await expect(rail.getByText(label, { exact: true })).toBeVisible();
    }
    /*
     * Preview now exists as a clearly-labelled experimental face renderer.
     * Save remains unavailable until a later milestone adds persistence.
     */
    const unbuilt = rail.locator("li.is-unbuilt");
    await expect(unbuilt).toHaveCount(await rail.getByText("Not built yet").count());
    await expect(rail.locator("li.is-unbuilt", { hasText: "Save" })).toHaveCount(1);
    await expect(rail.locator("li", { hasText: "Preview" })).not.toHaveClass(/is-unbuilt/);
    await expect(page.getByRole("heading", { name: /Face Renderer Preview · Experimental/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save transformation" })).toBeDisabled();
  });
});

test.describe("live tracking", () => {
  test("runs the models on real camera frames and reports measurements", async ({ page }) => {
    await openStudio(page);
    await startTracking(page);

    const calls = await gumCalls(page);
    expect(calls).toHaveLength(1);
    // The Studio previews appearance. It has no business with the microphone.
    expect(calls[0]?.audio, "the Studio must never request audio").toBe(false);

    // Frames reached the tracker: this value comes from `video.videoWidth`
    // inside the loop, so it cannot be set without one running.
    expect(await metric(page, "camera-frame-size")).toMatch(/^\d+ × \d+$/);

    // Both models ran. The fake camera contains no person, so a detection is
    // neither expected nor asserted.
    await expect
      .poll(async () => await metricNumber(page, "face-inferences"), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await metricNumber(page, "pose-inferences"), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Init was measured rather than defaulted.
    expect(await metric(page, "face-init")).toMatch(/ms$/);
    expect(await metric(page, "pose-init")).toMatch(/ms$/);
  });

  test("sizes the overlay canvas to the preview it draws on", async ({ page }) => {
    /*
     * Alignment, as far as a browser can check it without a face.
     *
     * The mapping itself is pinned by unit tests. What only a real browser can
     * show is that the canvas actually covers the video and carries a backing
     * store scaled for the device, since a canvas at the wrong size puts every
     * landmark at the wrong place by a fixed factor.
     */
    await openStudio(page);
    await startTracking(page);

    const geometry = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(".studio-video");
      const overlay = document.querySelector<HTMLCanvasElement>(".studio-overlay");
      if (!video || !overlay) return null;

      const videoBox = video.getBoundingClientRect();
      const overlayBox = overlay.getBoundingClientRect();
      return {
        videoBox: { x: videoBox.x, y: videoBox.y, width: videoBox.width, height: videoBox.height },
        overlayBox: { x: overlayBox.x, y: overlayBox.y, width: overlayBox.width, height: overlayBox.height },
        backing: { width: overlay.width, height: overlay.height },
        ratio: window.devicePixelRatio,
      };
    });

    expect(geometry).not.toBeNull();
    const { videoBox, overlayBox, backing, ratio } = geometry!;

    expect(overlayBox.x).toBeCloseTo(videoBox.x, 0);
    expect(overlayBox.y).toBeCloseTo(videoBox.y, 0);
    expect(overlayBox.width).toBeCloseTo(videoBox.width, 0);
    expect(overlayBox.height).toBeCloseTo(videoBox.height, 0);

    // Capped at 2 by `computeOverlayCanvasSize`.
    const expected = Math.max(1, Math.min(ratio || 1, 2));
    expect(backing.width).toBe(Math.round(overlayBox.width * expected));
    expect(backing.height).toBe(Math.round(overlayBox.height * expected));
  });

  test("pausing stops inference and resuming restarts it", async ({ page }) => {
    await openStudio(page);
    await startTracking(page);

    await page.getByRole("button", { name: "Pause tracking" }).click();
    await expect(page.getByRole("button", { name: "Resume tracking" })).toBeVisible();

    // Let any frame already in flight finish and the summary refresh.
    await page.waitForTimeout(1200);
    const paused = await metricNumber(page, "face-inferences");
    await page.waitForTimeout(1500);

    expect(paused).not.toBeNull();
    expect(await metricNumber(page, "face-inferences"), "paused means no further inference").toBe(paused);

    await page.getByRole("button", { name: "Resume tracking" }).click();
    await expect
      .poll(async () => await metricNumber(page, "face-inferences"), { timeout: 30_000 })
      .toBeGreaterThan(paused!);

    // The camera was never released: pausing stops inference, not the preview.
    const tracks = await trackReport(page);
    expect(tracks.every((track) => track.readyState === "live")).toBe(true);
  });

  test("flipping the camera keeps the session alive", async ({ page }) => {
    /*
     * A fake device has no second camera, so the honest assertion is not "the
     * rear camera opened" — it is that the Studio is still tracking afterwards,
     * whichever way the request resolved. The recovery path itself is pinned by
     * the camera controller's unit tests.
     */
    await openStudio(page);
    await startTracking(page);

    const before = await metricNumber(page, "face-inferences");

    await page.getByRole("button", { name: "Flip camera" }).click();
    await expect(page.getByRole("button", { name: "Flip camera" })).toBeEnabled({ timeout: 30_000 });

    // No failure screen, and the loop kept going.
    await expect(page.locator(".studio-placeholder.is-error")).toHaveCount(0);
    await expect
      .poll(async () => await metricNumber(page, "face-inferences"), { timeout: 60_000 })
      .toBeGreaterThan(before!);
  });

  test("stopping ends every track", async ({ page }) => {
    await openStudio(page);
    await startTracking(page);

    expect((await trackReport(page)).some((track) => track.readyState === "live")).toBe(true);

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();

    const tracks = await trackReport(page);
    expect(tracks.length).toBeGreaterThan(0);
    expect(
      tracks.every((track) => track.readyState === "ended"),
      `tracks after stopping: ${JSON.stringify(tracks)}`,
    ).toBe(true);
  });

  test("leaving the route ends every track", async ({ page }) => {
    /*
     * The failure that matters most.
     *
     * A camera light left on after somebody navigated away is the one bug here
     * that is both invisible in code review and obvious to the person it
     * happens to.
     */
    await openStudio(page);
    await startTracking(page);

    // A client-side navigation, not a reload: a reload would tear the page down
    // and prove nothing about the cleanup.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page).toHaveURL(/\/admin\/settings/);

    /*
     * Polled, not read once.
     *
     * React Router changes the URL before React commits the new tree and runs
     * the old one's effect cleanups, so a single read immediately after the URL
     * assertion is racing the unmount rather than testing it. The contract is
     * that leaving the route ends every track — a few hundred milliseconds
     * later is still leaving the route, and a track that never ends still fails
     * here, loudly.
     */
    await expect
      .poll(async () => (await trackReport(page)).map((track) => track.readyState).join(","), {
        timeout: 5_000,
      })
      .toBe("ended");

    expect((await trackReport(page)).length).toBeGreaterThan(0);
  });

  test("a hidden tab stops inference", async ({ page }) => {
    // A backgrounded tab gets no new frames and should not hold a GPU context.
    await openStudio(page);
    await startTracking(page);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(page.getByRole("button", { name: "Resume tracking" })).toBeVisible();
    await page.waitForTimeout(1200);
    const hidden = await metricNumber(page, "camera-frames");
    await page.waitForTimeout(1200);
    expect(await metricNumber(page, "camera-frames")).toBe(hidden);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect
      .poll(async () => await metricNumber(page, "camera-frames"), { timeout: 30_000 })
      .toBeGreaterThan(hidden!);
  });
});
