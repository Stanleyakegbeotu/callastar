import { expect, test, type Page } from "@playwright/test";

/**
 * Source analysis, in a real browser, against the real models.
 *
 * Two fixtures, both deliberate:
 *
 *  - IMAGES are drawn on a canvas at test time. Synthetic and fictional, so no
 *    real person's photograph lives in this repository, and deterministic, so a
 *    failure is reproducible. This is the same drawn face the Milestone 2 proof
 *    uses, which this build does detect with 478 landmarks.
 *
 *  - The VIDEO is the demo clip already in the repository. Generating a
 *    synthetic one would need an encoder: there is no ffmpeg here, and the only
 *    browser route is MediaRecorder, which this project is under instruction
 *    not to introduce. So the video assertions are about the PIPELINE —
 *    metadata, bounded sampling, real seeking, progress, cancellation — and not
 *    about what the clip contains, which the test does not claim to know.
 *
 * No camera is requested anywhere in this file. Source analysis must work
 * before a camera has ever been started.
 */

const DEV_SESSION_KEY = "callastar.development-admin";

/** Draws a fictional face. Rough proportions; the point is a real decoded image. */
const DRAW_FACE = `(context, width, height, options) => {
  const dx = options.dx || 0;
  context.fillStyle = "#c8c8c8";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(dx, 0);
  context.fillStyle = "#e0b89a";
  context.beginPath();
  context.ellipse(320, 240, 110, 145, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.ellipse(280, 205, 26, 15, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(360, 205, 26, 15, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#3b2c22";
  context.beginPath();
  context.ellipse(280, 205, 9, 9, 0, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(360, 205, 9, 9, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#8a6a52";
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(320, 215);
  context.lineTo(320, 262);
  context.stroke();
  context.beginPath();
  context.moveTo(288, 300);
  context.quadraticCurveTo(320, 320, 352, 300);
  context.stroke();
  context.restore();
}`;

async function openApp(page: Page, path = "/"): Promise<void> {
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
  await page.goto(path);
}

test.describe("image sources, with the real models", () => {
  test("analyses a face into a source profile", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page);

    const report = await page.evaluate(async (drawSource) => {
      const [{ SourceAnalyzer }] = await Promise.all([
        import("/src/features/transformation/source/sourceAnalyzer.ts"),
      ]);

      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      draw(canvas.getContext("2d")!, 640, 480, {});

      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));

      const analyzer = new SourceAnalyzer();
      const stages: string[] = [];
      const result = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "fictional.png", blob, assetId: null },
        profileId: "profile-under-test",
        onProgress: (progress) => stages.push(progress.stage),
      });

      const timings = analyzer.getTimings();
      if (!result.ok) return { ok: false as const, failure: result.failure, stages };

      const profile = result.profile;
      return {
        ok: true as const,
        stages,
        timings,
        landmarkCount: profile.primaryFace.landmarks.length,
        blendshapeCount: Object.keys(profile.primaryFace.blendshapes).length,
        hasMatrix: profile.primaryFace.facialTransformationMatrix?.length ?? 0,
        yaw: (profile.primaryFace.yaw * 180) / Math.PI,
        pitch: (profile.primaryFace.pitch * 180) / Math.PI,
        roll: (profile.primaryFace.roll * 180) / Math.PI,
        scale: profile.primaryFace.scale,
        poseDetected: profile.primaryPose !== null,
        segmentationAvailable: profile.primaryPose?.segmentationAvailable ?? false,
        grade: profile.quality.grade,
        capabilities: profile.quality.capabilities,
        warnings: profile.quality.warnings,
        dimensions: profile.dimensions,
        envelope: profile.movementEnvelope,
        referenceFrames: profile.referenceFrames.length,
        profileBytes: JSON.stringify(profile).length,
      };
    }, DRAW_FACE);

    expect(report.ok, `analysis failed: ${JSON.stringify(report)}`).toBe(true);
    if (!report.ok) return;

    console.log(
      `[source/image] landmarks=${report.landmarkCount} blendshapes=${report.blendshapeCount} ` +
        `matrix=${report.hasMatrix} yaw=${report.yaw.toFixed(1)}° pitch=${report.pitch.toFixed(1)}° ` +
        `roll=${report.roll.toFixed(1)}° scale=${report.scale.toFixed(4)} pose=${report.poseDetected} ` +
        `segmentation=${report.segmentationAvailable} grade=${report.grade} ` +
        `warnings=[${report.warnings.join(", ")}]\n` +
        `[source/image] decode=${report.timings.decodeMs?.toFixed(0)}ms ` +
        `modelInit=${report.timings.modelInitMs?.toFixed(0)}ms face=${report.timings.faceMs?.toFixed(0)}ms ` +
        `pose=${report.timings.poseMs?.toFixed(0)}ms total=${report.timings.totalMs?.toFixed(0)}ms`,
    );

    // The real model, with the outputs this pipeline was built around.
    expect(report.landmarkCount).toBe(478);
    expect(report.blendshapeCount).toBeGreaterThan(0);
    expect(report.hasMatrix).toBe(16);
    expect(report.capabilities.face).toBe(true);
    expect(report.capabilities.expressions).toBe(true);

    // Every derived number is finite and in a sane range.
    for (const value of [report.yaw, report.pitch, report.roll, report.scale]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(report.scale).toBeGreaterThan(0);
    expect(report.dimensions).toEqual({ width: 640, height: 480, aspectRatio: 640 / 480 });

    // A still is one angle, not a bank.
    expect(report.referenceFrames).toBe(0);
    expect(report.envelope.basis).toBe("single-image");

    // Real stages, in order, with nothing advancing on a timer.
    expect(report.stages).toEqual([
      "decoding",
      "loading-models",
      "analyzing-face",
      "analyzing-pose",
      "evaluating",
      "done",
    ]);

    // Geometry and metadata only. A landmark set is a few hundred points, not
    // a decoded image.
    expect(report.profileBytes).toBeLessThan(200_000);
  });

  test("fails gracefully on a source with no face, and stays usable", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page);

    const report = await page.evaluate(async (drawSource) => {
      const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");

      const blank = document.createElement("canvas");
      blank.width = 640;
      blank.height = 480;
      const context = blank.getContext("2d")!;
      const gradient = context.createLinearGradient(0, 0, 640, 480);
      gradient.addColorStop(0, "#334155");
      gradient.addColorStop(1, "#94a3b8");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 640, 480);
      const emptyBlob = await new Promise<Blob>((resolve) => blank.toBlob((v) => resolve(v!), "image/png"));

      const analyzer = new SourceAnalyzer();
      const first = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "empty.png", blob: emptyBlob, assetId: null },
        profileId: "profile-under-test",
      });

      // The operator immediately chooses another source. The runtime must be
      // healthy enough to analyse it without a reload.
      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;
      const faceCanvas = document.createElement("canvas");
      faceCanvas.width = 640;
      faceCanvas.height = 480;
      draw(faceCanvas.getContext("2d")!, 640, 480, {});
      const faceBlob = await new Promise<Blob>((resolve) => faceCanvas.toBlob((v) => resolve(v!), "image/png"));

      const second = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "face.png", blob: faceBlob, assetId: null },
        profileId: "profile-under-test",
      });

      return {
        firstOk: first.ok,
        firstFailure: first.ok ? null : first.failure,
        firstMessage: first.ok ? null : first.message,
        secondOk: second.ok,
      };
    }, DRAW_FACE);

    expect(report.firstOk).toBe(false);
    expect(report.firstFailure).toBe("no-face");
    expect(report.firstMessage).toMatch(/no clear face/i);
    // The recovery that matters: another source works straight away.
    expect(report.secondOk).toBe(true);
  });
});

test.describe("video sources", () => {
  test("loads metadata, samples a bounded number of frames, and reports progress", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page);

    const report = await page.evaluate(async () => {
      const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");
      const { sampleTimestamps } = await import("/src/features/transformation/source/videoSampling.ts");

      const response = await fetch("/media/call-demo.mp4");
      const blob = await response.blob();

      const analyzer = new SourceAnalyzer();
      const stages: string[] = [];
      const frames: number[] = [];

      const result = await analyzer.analyze({
        asset: { kind: "video", mimeType: "video/mp4", fileName: "call-demo.mp4", blob, assetId: null },
        profileId: "profile-under-test",
        onProgress: (progress) => {
          stages.push(progress.stage);
          if (progress.stage === "analyzing-frames" && progress.frame) frames.push(progress.frame);
        },
      });

      const timings = analyzer.getTimings();

      // Read the duration independently, so the sampling bound can be checked
      // against what the policy would choose for this file.
      const probe = document.createElement("video");
      const probeUrl = URL.createObjectURL(blob);
      probe.preload = "metadata";
      probe.src = probeUrl;
      const duration = await new Promise<number>((resolve) => {
        probe.onloadedmetadata = () => resolve(probe.duration);
        probe.onerror = () => resolve(0);
      });
      probe.removeAttribute("src");
      URL.revokeObjectURL(probeUrl);

      return {
        ok: result.ok,
        failure: result.ok ? null : result.failure,
        stages,
        frames,
        timings,
        duration,
        plannedSamples: sampleTimestamps(duration).length,
        sourceKind: result.ok ? result.profile.sourceKind : null,
        durationSeconds: result.ok ? result.profile.durationSeconds : null,
        dimensions: result.ok ? result.profile.dimensions : null,
        referenceFrames: result.ok ? result.profile.referenceFrames.map((f) => f.angle) : [],
        grade: result.ok ? result.profile.quality.grade : null,
        envelope: result.ok ? result.profile.movementEnvelope.basis : null,
        bankBytes: result.ok ? JSON.stringify(result.profile.referenceFrames).length : 0,
      };
    });

    console.log(
      `[source/video] duration=${report.duration.toFixed(1)}s planned=${report.plannedSamples} ` +
        `analysed=${report.timings.framesAnalyzed} perFrame=${report.timings.perFrameMs?.toFixed(0)}ms ` +
        `total=${report.timings.totalMs?.toFixed(0)}ms ok=${report.ok} failure=${report.failure} ` +
        `grade=${report.grade} angles=[${report.referenceFrames.join(", ")}]`,
    );

    // The policy that matters, whatever the clip contains: cost does not grow
    // with the file.
    expect(report.plannedSamples).toBeLessThanOrEqual(20);
    expect(report.timings.framesAnalyzed).toBeLessThanOrEqual(20);

    // Real metadata, and real per-frame progress.
    expect(report.duration).toBeGreaterThan(0);
    expect(report.stages).toContain("loading-video");
    expect(report.stages).toContain("sampling");
    expect(report.frames.length).toBeGreaterThan(0);
    expect(report.frames[0]).toBe(1);
    expect(report.frames).toEqual([...report.frames].sort((a, b) => a - b));

    /*
     * Whether this particular clip yields a bank is not asserted: the fixture
     * is the repository's demo video and the test does not claim to know what
     * is in it. Either outcome must be a clean one.
     */
    if (report.ok) {
      expect(report.sourceKind).toBe("video");
      expect(report.durationSeconds).toBeGreaterThan(0);
      expect(report.dimensions!.width).toBeGreaterThan(0);
      expect(report.referenceFrames.length).toBeGreaterThan(0);
      // At most one per angle, and geometry only.
      expect(report.referenceFrames.length).toBeLessThanOrEqual(5);
      expect(new Set(report.referenceFrames).size).toBe(report.referenceFrames.length);
      expect(report.bankBytes).toBeLessThan(500_000);
      expect(report.envelope).toBeTruthy();
    } else {
      expect(["no-face", "no-usable-frames"]).toContain(report.failure);
    }
  });

  test("cancelling stops the work and cannot mark a later source ready", async ({ page }) => {
    test.setTimeout(300_000);
    await openApp(page);

    const report = await page.evaluate(async (drawSource) => {
      const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");

      const response = await fetch("/media/call-demo.mp4");
      const videoBlob = await response.blob();

      const analyzer = new SourceAnalyzer();
      let framesSeen = 0;

      const abandoned = analyzer.analyze({
        asset: { kind: "video", mimeType: "video/mp4", fileName: "abandoned.mp4", blob: videoBlob, assetId: null },
        profileId: "profile-under-test",
        onProgress: (progress) => {
          if (progress.stage === "analyzing-frames") framesSeen = progress.frame ?? 0;
        },
      });

      // Let it genuinely start, then stop it.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const framesAtCancel = framesSeen;
      analyzer.cancel();

      // The operator immediately picks an image instead.
      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      draw(canvas.getContext("2d")!, 640, 480, {});
      const imageBlob = await new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));

      const replacement = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "replacement.png", blob: imageBlob, assetId: null },
        profileId: "profile-under-test",
      });

      const cancelled = await abandoned;
      await new Promise((resolve) => setTimeout(resolve, 1500));

      return {
        cancelledOk: cancelled.ok,
        cancelledFailure: cancelled.ok ? null : cancelled.failure,
        replacementOk: replacement.ok,
        replacementFile: replacement.ok ? replacement.profile.asset.fileName : null,
        framesAtCancel,
        framesAfter: framesSeen,
      };
    }, DRAW_FACE);

    // The abandoned run ended as cancelled, not as a result.
    expect(report.cancelledOk).toBe(false);
    expect(report.cancelledFailure).toBe("cancelled");

    // Seeking and inference stopped: no further frames were reported.
    expect(report.framesAfter).toBe(report.framesAtCancel);

    // And the replacement is what the Studio would show.
    expect(report.replacementOk).toBe(true);
    expect(report.replacementFile).toBe("replacement.png");
  });

  test("repeated source changes do not accumulate resources", async ({ page }) => {
    /*
     * The soak: image, change, image, video, cancel, video again.
     *
     * Asserted through what can actually be observed in a browser — that every
     * analysis still succeeds, and that no video element or object URL is left
     * behind. This is a development-machine observation and is NOT an iOS
     * memory proof.
     */
    test.setTimeout(300_000);
    await openApp(page);

    const report = await page.evaluate(async (drawSource) => {
      const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");

      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;

      const imageBlob = async (dx: number) => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        draw(canvas.getContext("2d")!, 640, 480, { dx });
        return new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));
      };

      const videoBlob = await (await fetch("/media/call-demo.mp4")).blob();
      const analyzer = new SourceAnalyzer();
      const outcomes: string[] = [];

      const a = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "a.png", blob: await imageBlob(0), assetId: null },
        profileId: "p",
      });
      outcomes.push(a.ok ? "a:ok" : `a:${a.failure}`);

      const b = await analyzer.analyze({
        asset: { kind: "image", mimeType: "image/png", fileName: "b.png", blob: await imageBlob(20), assetId: null },
        profileId: "p",
      });
      outcomes.push(b.ok ? "b:ok" : `b:${b.failure}`);

      const firstVideo = analyzer.analyze({
        asset: { kind: "video", mimeType: "video/mp4", fileName: "v1.mp4", blob: videoBlob, assetId: null },
        profileId: "p",
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      analyzer.cancel();
      const cancelled = await firstVideo;
      outcomes.push(cancelled.ok ? "v1:ok" : `v1:${cancelled.failure}`);

      const secondVideo = await analyzer.analyze({
        asset: { kind: "video", mimeType: "video/mp4", fileName: "v2.mp4", blob: videoBlob, assetId: null },
        profileId: "p",
      });
      outcomes.push(secondVideo.ok ? "v2:ok" : `v2:${secondVideo.failure}`);

      // Nothing the analyser created should still be attached to the document.
      const strayVideos = document.querySelectorAll("video").length;
      return { outcomes, strayVideos };
    }, DRAW_FACE);

    console.log(`[source/soak] ${report.outcomes.join(" · ")} strayVideos=${report.strayVideos}`);

    expect(report.outcomes[0]).toBe("a:ok");
    expect(report.outcomes[1]).toBe("b:ok");
    expect(report.outcomes[2]).toBe("v1:cancelled");
    // The second video run is a real run again, not a corpse of the first.
    expect(report.outcomes[3]).toMatch(/^v2:(ok|no-face|no-usable-frames)$/);
    // The analyser attaches nothing to the document and cleans up what it made.
    expect(report.strayVideos).toBe(0);
  });
});

test.describe("the Studio source step", () => {
  test("uploads, confirms permission and analyses, without ever asking for a camera", async ({ page }) => {
    test.setTimeout(300_000);

    const cameraCalls: string[] = [];
    await page.addInitScript(() => {
      const scope = window as unknown as { __gumCalls: unknown[] };
      scope.__gumCalls = [];
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) return;
      const original = media.getUserMedia.bind(media);
      media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        scope.__gumCalls.push(constraints ?? {});
        return original(constraints);
      };
    });

    await openApp(page, "/admin/profiles");

    // A profile to prepare the source for, created through the app's own
    // repository rather than by writing a schema this test would then own.
    await page.evaluate(async () => {
      const { adminRepository } = await import("/src/services/admin/repository.ts");
      const existing = await adminRepository.listProfiles();
      if (existing.length === 0) {
        await adminRepository.createProfile({
          displayName: "Source Fixture",
          shortBio: "Studio source test",
          status: "active",
        });
      }
    });

    await page.goto("/admin/studio");
    await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();

    // The operator picks a file. Dispatched onto the real input so the whole
    // component path runs.
    await page.evaluate(async (drawSource) => {
      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      draw(canvas.getContext("2d")!, 640, 480, {});
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));

      const file = new File([blob], "fictional-source.png", { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);

      const input = document.querySelector<HTMLInputElement>('input[accept*="image/png"]');
      if (!input) throw new Error("no image input");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, DRAW_FACE);

    // The selected source appears both in the source panel and the renderer's
    // persistent reference thumbnail.
    await expect(page.getByText("fictional-source.png").first()).toBeVisible();

    // Analysis is gated on the confirmation.
    const analyze = page.getByRole("button", { name: "Analyze source" });
    await expect(analyze).toBeDisabled();

    await page.getByLabel(/I confirm I have permission/i).check();
    await expect(analyze).toBeEnabled();
    await analyze.click();

    // A real result, from the real models.
    await expect(page.getByRole("button", { name: "Change source" })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText(/^(Excellent|Good|Limited)$/)).toBeVisible();
    await expect(page.getByText("Face", { exact: true })).toBeVisible();

    // The whole point: none of this needed a camera.
    const calls = await page.evaluate(() => (window as unknown as { __gumCalls: unknown[] }).__gumCalls);
    expect(calls, "source analysis must not request a camera").toEqual([]);
    expect(cameraCalls).toEqual([]);
  });

  test("resets the permission confirmation when the source changes", async ({ page }) => {
    /*
     * A confirmation that survived a source change would mean the operator
     * confirmed permission for a file they had not seen.
     */
    test.setTimeout(300_000);
    await openApp(page, "/admin/profiles");

    await page.evaluate(async () => {
      const { adminRepository } = await import("/src/services/admin/repository.ts");
      const existing = await adminRepository.listProfiles();
      if (existing.length === 0) {
        await adminRepository.createProfile({
          displayName: "Source Fixture",
          shortBio: "Studio source test",
          status: "active",
        });
      }
    });

    await page.goto("/admin/studio");

    const pick = async (name: string) => {
      await page.evaluate(
        async ({ drawSource, fileName }) => {
          const draw = eval(`(${drawSource})`) as (
            context: CanvasRenderingContext2D,
            width: number,
            height: number,
            options: { dx?: number },
          ) => void;
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 480;
          draw(canvas.getContext("2d")!, 640, 480, {});
          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));
          const file = new File([blob], fileName, { type: "image/png" });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const input = document.querySelector<HTMLInputElement>('input[accept*="image/png"]');
          if (!input) throw new Error("no image input");
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { drawSource: DRAW_FACE, fileName: name },
      );
    };

    await pick("first.png");
    await page.getByLabel(/I confirm I have permission/i).check();
    await expect(page.getByRole("button", { name: "Analyze source" })).toBeEnabled();

    await page.getByRole("button", { name: "Change source" }).click();
    await pick("second.png");

    await expect(page.getByLabel(/I confirm I have permission/i)).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Analyze source" })).toBeDisabled();
  });

  test("shows the results without panning the page on a 360px phone", async ({ page }) => {
    /*
     * The narrowest width the mobile pass names, with real results on screen.
     *
     * The empty source step is covered across every width by the mobile suite;
     * what only a real analysis can show is the results panel — capability rows,
     * warnings and a long filename — none of which may widen the page.
     */
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await openApp(page, "/admin/profiles");

    await page.evaluate(async () => {
      const { adminRepository } = await import("/src/services/admin/repository.ts");
      const existing = await adminRepository.listProfiles();
      if (existing.length === 0) {
        await adminRepository.createProfile({
          displayName: "Source Fixture",
          shortBio: "Studio source test",
          status: "active",
        });
      }
    });

    await page.goto("/admin/studio");
    await expect(page.getByRole("heading", { name: "Transformation Studio" })).toBeVisible();

    await page.evaluate(async (drawSource) => {
      const draw = eval(`(${drawSource})`) as (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        options: { dx?: number },
      ) => void;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      draw(canvas.getContext("2d")!, 640, 480, {});
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));
      // A deliberately long filename: the one piece of unbounded text here.
      const file = new File([blob], "a-very-long-source-filename-that-should-wrap-not-widen.png", {
        type: "image/png",
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[accept*="image/png"]');
      if (!input) throw new Error("no image input");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, DRAW_FACE);

    await page.getByLabel(/I confirm I have permission/i).check();
    await page.getByRole("button", { name: "Analyze source" }).click();
    await expect(page.getByRole("button", { name: "Change source" })).toBeVisible({ timeout: 240_000 });

    const overflow = await page.evaluate(() => {
      const limit = window.innerWidth;
      const offenders: string[] = [];
      for (const element of Array.from(document.querySelectorAll(".studio-source *"))) {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (element.getBoundingClientRect().right > limit + 1) offenders.push(element.className || element.tagName);
      }
      return { offenders: offenders.slice(0, 5), pageScroll: window.scrollX };
    });

    expect(overflow.offenders, "source results must fit the viewport").toEqual([]);
    expect(overflow.pageScroll).toBe(0);
  });
});
