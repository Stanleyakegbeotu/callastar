import { expect, test } from "@playwright/test";

/** Browser proof for the first face renderer. */
test("loads Three only for the renderer, draws a fixed source mesh, and disposes it", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    // The default resource-timing buffer holds 250 entries, and the dev server
    // loads every module as its own resource: the app alone reaches ~245, so
    // the Three chunk's entry was silently dropped. Room first, then measure.
    performance.setResourceTimingBufferSize(10_000);
    const hasThreeResource = () => performance.getEntriesByType("resource").some((entry) => /three/i.test(entry.name));
    const threeBefore = hasThreeResource();
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const threeAfterRendererModule = hasThreeResource();

    const source = document.createElement("canvas");
    source.width = 640;
    source.height = 480;
    const context = source.getContext("2d");
    if (!context) throw new Error("A 2D source canvas is unavailable.");
    context.fillStyle = "#203040";
    context.fillRect(0, 0, source.width, source.height);
    context.fillStyle = "#d5a884";
    context.beginPath();
    context.ellipse(320, 240, 140, 185, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.fillRect(260, 205, 34, 12);
    context.fillRect(346, 205, 34, 12);
    context.fillStyle = "#332211";
    context.fillRect(272, 207, 10, 8);
    context.fillRect(358, 207, 10, 8);
    context.strokeStyle = "#a7775d";
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(320, 220);
    context.lineTo(320, 265);
    context.stroke();
    context.beginPath();
    context.moveTo(282, 305);
    context.quadraticCurveTo(320, 330, 358, 305);
    context.stroke();
    const blob = await new Promise<Blob>((resolve, reject) => source.toBlob((value) => value ? resolve(value) : reject(new Error("Source encode failed")), "image/png"));

    const canvas = document.createElement("canvas");
    canvas.dataset.testid = "face-renderer-output";
    canvas.style.width = "390px";
    canvas.style.height = "600px";
    document.body.append(canvas);
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const ring = [10, 109, 67, 103, 54, 21, 162, 127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152,
      377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338];
    ring.forEach((index, i) => {
      const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
      landmarks[index] = { x: 0.5 + Math.cos(angle) * 0.22, y: 0.5 + Math.sin(angle) * 0.29, z: 0 };
    });
    const profile = {
      primaryFace: { landmarks },
      referenceFrames: [],
      movementEnvelope: {
        translation: null, scaleMin: 0.9, scaleMax: 1.1,
        yawLeft: 0.35, yawRight: 0.35, pitchUp: 0.2, pitchDown: 0.2,
        roll: 0.15, basis: "single-image",
      },
    };
    const reports: { status: string; message: string | null }[] = [];
    const renderer = new FaceRenderer({
      canvas,
      asset: { kind: "image", blob, fileName: "fixture.png", mimeType: "image/png", assetId: null },
      profile: profile as never,
      motion: { current: { tracked: true, expression: null, upperBody: null, head: {
        translationX: 0.12, translationY: -0.05, scaleDelta: 1.05, yawDelta: 0.12, pitchDelta: 0.03, rollDelta: -0.02,
      } } },
      onStats: (stats) => {
        reports.push({ status: stats.status, message: stats.message });
        (window as unknown as { __faceRendererStatus?: string }).__faceRendererStatus = stats.status;
      },
    });
    await renderer.initialize();
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && (reports[reports.length - 1]?.status !== "ready" || !canvas.width)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const threeAfterInitialize = hasThreeResource();
    const dimensions = { width: canvas.width, height: canvas.height };
    (window as unknown as { __faceRenderer?: InstanceType<typeof FaceRenderer> }).__faceRenderer = renderer;
    return { threeBefore, threeAfterRendererModule, threeAfterInitialize, dimensions, status: reports[reports.length - 1] };
  });

  expect(report.threeBefore).toBe(false);
  expect(report.threeAfterRendererModule).toBe(false);
  expect(report.threeAfterInitialize).toBe(true);
  expect(report.dimensions.width).toBeGreaterThan(0);
  expect(report.dimensions.height).toBeGreaterThan(0);
  expect(report.status?.status, report.status?.message ?? "renderer did not report a status").toBe("ready");
  await page.locator('[data-testid="face-renderer-output"]').screenshot({ path: "test-results/transformation-face-renderer.png" });
  const finalStatus = await page.evaluate(() => {
    const renderer = (window as unknown as { __faceRenderer?: { dispose(): void } }).__faceRenderer;
    renderer?.dispose();
    return (window as unknown as { __faceRendererStatus?: string }).__faceRendererStatus;
  });
  expect(finalStatus).toBe("disposed");
});
