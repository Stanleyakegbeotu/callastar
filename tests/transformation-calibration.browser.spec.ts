import { expect, test, type Page } from "@playwright/test";

/**
 * Calibration, in a real browser.
 *
 * Split deliberately into two kinds of proof, because Chrome's fake camera
 * contains a rolling pattern and no person. That is what makes it deterministic
 * and therefore worth using — and it also means a calibration cannot COMPLETE
 * through the UI here, since there is no face to capture.
 *
 * So:
 *
 *  - the engine is proved end to end in the browser against a deterministic
 *    fixture, including a completed capture and live motion against it;
 *  - the UI is proved against the real fake camera, where the honest outcome is
 *    that calibration asks for a face, never finds one, and says so.
 *
 * Asserting a completed capture through the UI would need a synthetic face the
 * model actually detects. Milestone 4 established that a drawn one is not
 * reliably detected, so that check belongs on a device with a person in front
 * of it, and the milestone report says it has not been done any other way.
 */

test.use({ permissions: ["camera"] });

const DEV_SESSION_KEY = "callastar.development-admin";
const STUDIO = "/admin/studio";

async function openStudio(page: Page): Promise<void> {
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

async function metric(page: Page, name: string): Promise<string> {
  return (await page.locator(`[data-metric="${name}"] dd`).innerText()).trim();
}

test.describe("the calibration engine in a browser", () => {
  test("captures a baseline from a steady fixture and measures motion against it", async ({ page }) => {
    await page.goto("/");

    const report = await page.evaluate(async () => {
      const [{ CalibrationCollector }, { computeRelativeMotion }] = await Promise.all([
        import("/src/features/transformation/engine/calibrationCollector.ts"),
        import("/src/features/transformation/engine/relativeMotion.ts"),
      ]);

      /*
       * A deterministic operator.
       *
       * Resting at 0.04 rad of yaw with sub-tolerance jitter — the case that
       * matters, because a baseline of zero would make this person's neutral
       * face read as a permanent turn.
       */
      const NEUTRAL_YAW = 0.04;
      const makeFace = (overrides: Record<string, unknown> = {}, jitter = 0) => ({
        timestampMs: 0,
        status: "tracked",
        detected: true,
        confidence: 0.9,
        landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
        blendshapes: {},
        facialTransformationMatrix: null,
        derived: {
          center: { x: 0.5 + jitter, y: 0.45, z: 0 },
          scale: 0.1,
          yaw: NEUTRAL_YAW,
          pitch: -0.02,
          roll: 0.01,
          eyeOpenness: 0.8,
          eyeOpennessLeft: 0.8,
          eyeOpennessRight: 0.8,
          mouthOpenness: 0.05,
          bounds: { minX: 0.35, minY: 0.2, maxX: 0.65, maxY: 0.7 },
          ...overrides,
        },
      });

      const makePose = (overrides: Record<string, unknown> = {}) => ({
        timestampMs: 0,
        status: "tracked",
        detected: true,
        landmarks: [{ x: 0.5, y: 0.5, z: 0 }],
        worldLandmarks: [],
        segmentation: { available: false, width: null, height: null, representation: null },
        derived: {
          leftShoulder: { x: 0.35, y: 0.72, z: 0 },
          rightShoulder: { x: 0.65, y: 0.72, z: 0 },
          shoulderCenter: { x: 0.5, y: 0.72, z: 0 },
          shoulderWidth: 0.3,
          shoulderAngle: 0.02,
          torsoCenter: null,
          torsoScale: null,
          torsoLean: null,
          trackability: "tracked",
          visibility: 0.9,
          ...overrides,
        },
      });

      const collector = new CalibrationCollector();
      collector.start(
        "full",
        { cameraFacing: "user", trackingWidth: 360, trackingHeight: 640, mirrored: true },
        0,
      );

      let now = 0;
      for (let index = 0; index < 40 && collector.getState().phase !== "ready"; index += 1) {
        const jitter = index % 2 === 0 ? 0.0008 : -0.0008;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        collector.accept(makeFace({}, jitter) as any, makePose() as any, now);
        now += 60;
      }

      const state = collector.getState();
      const profile = state.profile;

      // Now move: turn towards the subject's left, and lean closer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const turned = computeRelativeMotion(profile, makeFace({ yaw: NEUTRAL_YAW + 0.3 }) as any, makePose() as any);
      const closer = computeRelativeMotion(
        profile,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeFace({ scale: 0.12 }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makePose() as any,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const still = computeRelativeMotion(profile, makeFace() as any, makePose() as any);

      return {
        phase: state.phase,
        quality: profile?.quality.quality ?? null,
        poseAvailable: profile?.quality.poseAvailable ?? null,
        frameCount: profile?.quality.frameCount ?? null,
        neutralYaw: profile?.face.yaw ?? null,
        stability: profile?.quality.stabilityScore ?? null,
        turnedYaw: turned.head?.yawDelta ?? null,
        turnedPitch: turned.head?.pitchDelta ?? null,
        closerScale: closer.head?.scaleDelta ?? null,
        stillYaw: still.head?.yawDelta ?? null,
        profileKeys: profile ? Object.keys(profile).sort() : [],
        serialised: profile ? JSON.stringify(profile).length : 0,
      };
    });

    expect(report.phase).toBe("ready");
    expect(report.quality).toBe("excellent");
    expect(report.poseAvailable).toBe(true);
    expect(report.frameCount).toBeGreaterThanOrEqual(12);

    // The resting pose was captured, not assumed to be zero.
    expect(report.neutralYaw!).toBeCloseTo(0.04, 3);
    expect(report.stability!).toBeGreaterThan(0.7);

    // Sitting still is zero motion; turning is a turn and not a nod.
    expect(report.stillYaw!).toBeCloseTo(0, 6);
    expect(report.turnedYaw!).toBeCloseTo(0.3, 6);
    expect(report.turnedPitch!).toBeCloseTo(0, 6);

    // Scale is a ratio, not a difference.
    expect(report.closerScale!).toBeCloseTo(1.2, 6);

    // And the profile carries geometry only — no frame history of any kind.
    expect(report.profileKeys).toEqual(
      ["cameraFacing", "createdAt", "face", "mode", "pose", "quality", "trackingSpace", "version"].sort(),
    );
    // A few hundred bytes. Landmark history would be orders of magnitude more.
    expect(report.serialised).toBeLessThan(2000);
  });
});

test.describe("the calibration UI", () => {
  test("offers calibration only once a camera is live", async ({ page }) => {
    await openStudio(page);

    const start = page.getByRole("button", { name: "Start calibration" });
    await expect(start).toBeVisible();
    // Nothing to calibrate against before a camera exists.
    await expect(start).toBeDisabled();
  });

  test("explains that motion needs a baseline before there is one", async ({ page }) => {
    await openStudio(page);
    await page.getByRole("button", { name: "Diagnostics" }).click();

    await expect(page.getByText(/Calibrate to see movement measured against your resting position/i)).toBeVisible();
    await expect(page.locator('[data-metric="calibration-phase"] dd')).toHaveText("idle");
  });

  test("runs a capture against the live camera and asks for a face it cannot find", async ({ page }) => {
    /*
     * The fake camera has no person in it, so this is the correct outcome and
     * the useful one: it proves the whole path — button, collector, frame
     * acceptance, guidance — without inventing a detection.
     */
    await openStudio(page);
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible({ timeout: 240_000 });

    const start = page.getByRole("button", { name: "Start calibration" });
    await expect(start).toBeEnabled();
    await start.click();

    // The rail moves on, the guide appears, and the copy asks for a face.
    await expect(page.locator(".studio-calibration-guide")).toBeVisible();
    await expect(page.getByText("Look at the camera", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Diagnostics" }).click();
    await expect
      .poll(async () => await metric(page, "calibration-rejected"), { timeout: 30_000 })
      .not.toBe("0");
    expect(await metric(page, "calibration-accepted")).toBe("0");
  });

  test("can be cancelled, leaving the camera and the loop running", async ({ page }) => {
    await openStudio(page);
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible({ timeout: 240_000 });

    await page.getByRole("button", { name: "Start calibration" }).click();
    await expect(page.locator(".studio-calibration-guide")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Calibration cancelled")).toBeVisible();

    // Nothing about the engine was disturbed.
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible();
    await expect(page.locator(".studio-placeholder.is-error")).toHaveCount(0);

    const tracks = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(".studio-video");
      const stream = video?.srcObject as MediaStream | null;
      return stream?.getTracks().map((track) => track.readyState) ?? [];
    });
    expect(tracks).toContain("live");
  });

  test("gives up on a face it never finds, and says what to do", async ({ page }) => {
    test.setTimeout(300_000);

    await openStudio(page);
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible({ timeout: 240_000 });

    await page.getByRole("button", { name: "Start calibration" }).click();

    // The collector's own twenty-second budget, plus room for a loaded machine.
    await expect(page.getByText("Could not find your face")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

    // A failed calibration leaves the models and the camera exactly as they were.
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Flip camera" })).toBeEnabled();
  });

  test("a camera flip drops the old capture and begins face-only reacquisition", async ({ page }) => {
    /*
     * Proved through the state the UI actually shows, because the failure this
     * guards against is silent: a front-camera neutral reused on a rear camera
     * produces motion measured from a pose the operator was never in.
     */
    await openStudio(page);
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible({ timeout: 240_000 });

    await page.getByRole("button", { name: "Start calibration" }).click();
    await page.getByRole("button", { name: "Diagnostics" }).click();
    await expect
      .poll(async () => await metric(page, "calibration-phase"), { timeout: 30_000 })
      .toBe("waiting-for-stable-tracking");

    const faceInit = await metric(page, "face-init");

    await page.getByRole("button", { name: "Flip camera" }).click();
    await expect(page.getByRole("button", { name: "Flip camera" })).toBeEnabled({ timeout: 30_000 });

    // Current M8.3 behavior starts a NEW face-only capture on the new camera.
    // The old capture/profile cannot survive and no old neutral drives motion.
    await expect.poll(async () => await metric(page, "calibration-phase"), { timeout: 30_000 }).toBe("waiting-for-stable-tracking");
    await expect(page.locator('.studio-guide-shoulders')).toHaveCount(0);
    await expect(page.locator('[data-metric="calibration-quality"] dd')).toHaveText('—');

    // ...and nothing else was: no reload, no re-prompt, no model init.
    await expect(page.getByRole("button", { name: "Pause tracking" })).toBeVisible();
    expect(await metric(page, "face-init")).toBe(faceInit);
  });
});
