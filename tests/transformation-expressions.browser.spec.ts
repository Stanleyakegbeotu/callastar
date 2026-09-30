import { expect, test } from "@playwright/test";

test("renders deterministic neutral, wink, jaw, smile, and brow states", async ({ page }) => {
  await page.goto("/");
  const initialized = await page.evaluate(async () => {
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const source = document.createElement("canvas");
    source.width = 640; source.height = 480;
    const ctx = source.getContext("2d")!;
    ctx.fillStyle = "#18263a"; ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#d7aa8c"; ctx.beginPath(); ctx.ellipse(320, 240, 140, 190, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#724b37";
    ctx.fillRect(240, 161, 90, 8); ctx.fillRect(331, 161, 90, 8);
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.ellipse(272, 211, 31, 13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(368, 211, 31, 13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#382920";
    ctx.beginPath(); ctx.ellipse(272, 211, 10, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(368, 211, 10, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#a76d56"; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(320, 220); ctx.lineTo(320, 269); ctx.stroke();
    ctx.strokeStyle = "#7e3536"; ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(276, 304); ctx.quadraticCurveTo(320, 325, 364, 304); ctx.stroke();
    const blob = await new Promise<Blob>((resolve) => source.toBlob((value) => resolve(value!), "image/png"));
    const landmarks = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
    const set = (id: number, x: number, y: number) => { landmarks[id] = { x, y, z: 0 }; };
    const ring = [10, 109, 67, 103, 54, 21, 162, 127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152,
      377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338];
    ring.forEach((id, i) => {
      const angle = -Math.PI / 2 - i / ring.length * Math.PI * 2;
      set(id, .5 + Math.cos(angle) * .22, .5 + Math.sin(angle) * .30);
    });
    set(1, .5, .5); set(234, .28, .5); set(454, .72, .5);
    set(33, .375, .44); set(133, .465, .44); set(159, .42, .413); set(145, .42, .467);
    set(263, .625, .44); set(362, .535, .44); set(386, .58, .413); set(374, .58, .467);
    set(61, .43, .635); set(291, .57, .635); set(13, .5, .625); set(14, .5, .645);
    set(152, .5, .80); set(107, .46, .34); set(336, .54, .34); set(70, .39, .34); set(300, .61, .34);
    const canvas = document.createElement("canvas");
    canvas.style.width = "390px"; canvas.style.height = "600px";
    canvas.dataset.testid = "m8-output"; document.body.append(canvas);
    const expression = { current: null as null | Record<string, number | string> };
    let stats: { status: string; expressionApplied: unknown; deformationMs: number | null } | null = null;
    const renderer = new FaceRenderer({
      canvas,
      asset: { kind: "image", blob, fileName: "synthetic.png", mimeType: "image/png", assetId: null },
      profile: { primaryFace: { landmarks, blendshapes: {} }, referenceFrames: [], movementEnvelope: {
        translation: null, scaleMin: .9, scaleMax: 1.1, yawLeft: .35, yawRight: .35,
        pitchUp: .2, pitchDown: .2, roll: .15, basis: "single-image",
      } } as never,
      motion: { current: { tracked: true, expression: null, upperBody: null, head: {
        translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0,
      } } },
      manualExpression: expression as never,
      onStats: (value) => { stats = value; },
    });
    await renderer.initialize();
    (window as unknown as { __m8?: unknown }).__m8 = { renderer, expression, getStats: () => stats };
    return { width: canvas.width, height: canvas.height };
  });
  expect(initialized.width).toBeGreaterThan(0);
  expect(initialized.height).toBeGreaterThan(0);
  const states: [string, Record<string, number>][] = [
    ["neutral", {}], ["left-blink", { blinkLeft: 1 }], ["right-blink", { blinkRight: 1 }],
    ["jaw", { jawOpen: 1 }], ["smile", { smileLeft: .8, smileRight: .8 }],
    ["brows", { browInnerUp: .8, browOuterUpLeft: .8, browOuterUpRight: .8 }],
  ];
  const timingSamples: { renderMs: number | null; fps: number | null; expressionMs: number | null; deformationMs: number | null }[] = [];
  for (const [name, values] of states) {
    const stats = await page.evaluate(async (values) => {
      const state = (window as unknown as { __m8: {
        expression: { current: unknown }; getStats: () => {
          status: string; expressionApplied: Record<string, number>; deformationMs: number | null;
          renderMs: number | null; fps: number | null; expressionMs: number | null;
        };
      } }).__m8;
      state.expression.current = { blinkLeft: 0, blinkRight: 0, jawOpen: 0, smileLeft: 0, smileRight: 0,
        browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0, ...values, status: "manual", calculationMs: 0 };
      await new Promise((resolve) => setTimeout(resolve, 300));
      return state.getStats();
    }, values);
    expect(stats.status).toBe("ready");
    expect(stats.expressionApplied).not.toBeNull();
    expect(stats.deformationMs).toBeGreaterThanOrEqual(0);
    timingSamples.push(stats);
    await page.locator('[data-testid="m8-output"]').screenshot({ path: `test-results/m8-${name}.png` });
  }
  console.log(`[m8 software browser] render=${timingSamples.map((sample) => sample.renderMs?.toFixed(2) ?? "na").join(",")}ms ` +
    `deform=${timingSamples.map((sample) => sample.deformationMs?.toFixed(3) ?? "na").join(",")}ms ` +
    `fps=${timingSamples.map((sample) => sample.fps?.toFixed(1) ?? "na").join(",")}`);
  await page.evaluate(() => (window as unknown as { __m8: { renderer: { dispose(): void } } }).__m8.renderer.dispose());
});

test("real FaceTracker result reaches the expression contract and renderer", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { FaceTracker } = await import("/src/features/transformation/engine/faceTracker.ts");
    const { computeExpressionMotion } = await import("/src/features/transformation/engine/expressionMotion.ts");
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const blob = await (await fetch("/media/onboarding/male-participant.jpg")).blob();
    const bitmap = await createImageBitmap(blob);
    const input = document.createElement("canvas"); input.width = bitmap.width; input.height = bitmap.height;
    input.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const tracker = new FaceTracker();
    await tracker.initialize();
    const first = tracker.detect(input, 100);
    const second = tracker.detect(input, 133);
    tracker.dispose();
    if (!first.detected || !first.derived || !second.detected) return { detected: false };
    const calibration = { face: {
      neutralEyeOpenness: first.derived.eyeOpenness, neutralMouthOpenness: first.derived.mouthOpenness,
      expressionNeutral: {
        blinkLeft: first.blendshapes.eyeBlinkLeft ?? 0, blinkRight: first.blendshapes.eyeBlinkRight ?? 0,
        jawOpen: first.blendshapes.jawOpen ?? 0, smileLeft: first.blendshapes.mouthSmileLeft ?? 0,
        smileRight: first.blendshapes.mouthSmileRight ?? 0, browInnerUp: first.blendshapes.browInnerUp ?? 0,
        browOuterUpLeft: first.blendshapes.browOuterUpLeft ?? 0, browOuterUpRight: first.blendshapes.browOuterUpRight ?? 0,
      },
    } };
    const expression = computeExpressionMotion(second, calibration as never);
    const canvas = document.createElement("canvas"); canvas.style.width = "390px"; canvas.style.height = "600px";
    canvas.dataset.testid = "m8-real-output"; document.body.append(canvas);
    let applied = false;
    let liveMetric: { expressionMs: number | null; deformationMs: number | null; renderMs: number | null; fps: number | null } | null = null;
    const renderer = new FaceRenderer({
      canvas,
      asset: { kind: "image", blob, fileName: "male-participant.jpg", mimeType: "image/jpeg", assetId: null },
      profile: { primaryFace: { landmarks: first.landmarks, blendshapes: first.blendshapes }, referenceFrames: [],
        movementEnvelope: { translation: null, scaleMin: .9, scaleMax: 1.1, yawLeft: .35, yawRight: .35,
          pitchUp: .2, pitchDown: .2, roll: .15, basis: "single-image" } } as never,
      motion: { current: { tracked: true, expression: null, upperBody: null, head: {
        translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0,
      } } },
      expression: { current: expression },
      onStats: (stats) => {
        applied = !!stats.expressionApplied;
        if (stats.expressionMs !== null) liveMetric = {
          expressionMs: stats.expressionMs, deformationMs: stats.deformationMs,
          renderMs: stats.renderMs, fps: stats.fps,
        };
      },
    });
    await renderer.initialize();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const result = { detected: true, expressionStatus: expression?.status, applied, width: canvas.width, liveMetric };
    (window as unknown as { __m8Real?: unknown }).__m8Real = renderer;
    return result;
  });
  expect(report.detected).toBe(true);
  expect(report.expressionStatus).toBe("tracked");
  expect(report.applied).toBe(true);
  expect(report.width).toBeGreaterThan(0);
  console.log(`[m8 live path] expression=${report.liveMetric?.expressionMs?.toFixed(3) ?? "na"}ms ` +
    `deform=${report.liveMetric?.deformationMs?.toFixed(3) ?? "na"}ms ` +
    `render=${report.liveMetric?.renderMs?.toFixed(2) ?? "na"}ms fps=${report.liveMetric?.fps?.toFixed(1) ?? "na"}`);
  await page.locator('[data-testid="m8-real-output"]').screenshot({ path: "test-results/m8-real-source.png" });
  await page.evaluate(() => (window as unknown as { __m8Real: { dispose(): void } }).__m8Real.dispose());
});
