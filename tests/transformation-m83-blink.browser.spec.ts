import { expect, test, type Page } from "@playwright/test";

/**
 * M8.3 Phase 4: a blink must be unmistakable — judged by the tracker that
 * watches the operator, not by our own vertex arithmetic.
 *
 * The source face is rendered open, blinking, and winking each eye; MediaPipe
 * reads every image; the production expression pipeline scores it against a
 * calibration taken from the rendered open face. A rendered blink that the same
 * model cannot see as closed is not a blink anybody else will see either.
 * Close-up eye crops are saved beside it for a person to look at.
 */

type Values = Record<string, number>;
const NEUTRAL: Values = { blinkLeft: 0, blinkRight: 0, jawOpen: 0, smileLeft: 0, smileRight: 0, browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0 };

async function setup(page: Page): Promise<void> {
  await page.goto("/");
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.evaluate(async () => {
    const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const { SourceAnalysisTasks } = await import("/src/features/transformation/source/sourceTrackers.ts");
    const blob = await (await fetch("/media/onboarding/male-participant.jpg")).blob();
    const asset = { kind: "image", blob, fileName: "portrait.jpg", mimeType: "image/jpeg", assetId: null } as const;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset, profileId: "m83-blink" });
    analyzer.cancel();
    if (!result.ok) throw new Error(result.message);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:720px;height:900px;display:block";
    canvas.dataset.testid = "blink";
    document.body.replaceChildren(canvas);
    const head = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
    const expression = { current: null as unknown };
    const renderer = new FaceRenderer({
      canvas, asset, profile: result.profile, mirror: "faithful",
      motion: { current: { tracked: true, expression: null, upperBody: null, head } },
      manualExpression: expression,
    } as never);
    await renderer.initialize();
    const tasks = new SourceAnalysisTasks();
    await tasks.initialize();
    (window as unknown as Record<string, unknown>).__blink = { renderer, expression, tasks, calibration: null };
  });
}

async function show(page: Page, expression: Values): Promise<string> {
  await page.evaluate((values) => {
    (window as unknown as { __blink: { expression: { current: unknown } } }).__blink.expression.current = { ...values, status: "manual", calculationMs: 0 };
  }, { ...NEUTRAL, ...expression });
  await page.waitForTimeout(600);
  return (await page.getByTestId("blink").screenshot()).toString("base64");
}

/** Detects the face in a rendered frame; calibrates on the first call. */
async function read(page: Page, png: string, calibrate = false) {
  return page.evaluate(async ({ png, calibrate }) => {
    const state = (window as unknown as { __blink: Record<string, any> }).__blink;
    const [{ computeExpressionMotion }, { CalibrationCollector }, { eyeOpenness }] = await Promise.all([
      import("/src/features/transformation/engine/expressionMotion.ts"),
      import("/src/features/transformation/engine/calibrationCollector.ts"),
      import("/src/features/transformation/engine/faceGeometry.ts"),
    ]);
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const face = state.tasks.detectFace(bitmap);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    if (!face.detected) return null;
    const tracked = (t: number) => ({ ...face, timestampMs: t, status: "tracked", confidence: 1 });
    if (calibrate) {
      const collector = new CalibrationCollector();
      collector.start("face-only", { cameraFacing: "user", trackingWidth: size.w, trackingHeight: size.h, mirrored: false }, 0);
      for (let t = 0; t <= 3000 && collector.getState().phase !== "ready"; t += 100) collector.accept(tracked(t), null, t);
      state.calibration = collector.getState().profile;
    }
    const motion = computeExpressionMotion(tracked(0), state.calibration);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // Image-space eyes: MediaPipe "left" (33/263 pairs) is the subject's RIGHT eye.
    return {
      blinkLeft: round(motion?.blinkLeft ?? -1),
      blinkRight: round(motion?.blinkRight ?? -1),
      apertureLeft: round(eyeOpenness(face.landmarks, "left")),
      apertureRight: round(eyeOpenness(face.landmarks, "right")),
      shapeLeft: round(face.blendshapes.eyeBlinkLeft ?? -1),
      shapeRight: round(face.blendshapes.eyeBlinkRight ?? -1),
    };
  }, { png, calibrate });
}

/** Saves a close-up of both eyes, located from the renderer's own landmarks. */
async function eyeCrop(page: Page, path: string): Promise<void> {
  const box = await page.evaluate(() => {
    const renderer = (window as unknown as { __blink: { renderer: { getProbe(): { screen: { nose: { x: number; y: number }; eyeSpanPx: number } } } } }).__blink.renderer;
    const { nose, eyeSpanPx } = renderer.getProbe().screen;
    const canvas = document.querySelector("canvas")!.getBoundingClientRect();
    return { x: canvas.x + nose.x - eyeSpanPx * 0.75, y: canvas.y + nose.y - eyeSpanPx * 0.75, width: eyeSpanPx * 1.5, height: eyeSpanPx * 0.45 };
  });
  await page.screenshot({ path: test.info().outputPath(path.split('/').pop()!), clip: box });
}

test("a rendered blink, and each wink, read as closed eyes to the tracker", async ({ page }) => {
  test.setTimeout(300_000);
  await setup(page);
  const open = await read(page, await show(page, {}), true);
  await eyeCrop(page, "artifacts/m83/phase4-eyes-open.png");
  console.log("[blink] open", JSON.stringify(open));
  expect(open).not.toBeNull();
  expect(open!.blinkLeft).toBeLessThan(0.15);
  expect(open!.blinkRight).toBeLessThan(0.15);

  const both = await read(page, await show(page, { blinkLeft: 1, blinkRight: 1 }));
  await eyeCrop(page, "artifacts/m83/phase4-eyes-blink.png");
  console.log("[blink] both", JSON.stringify(both));

  const leftWink = await read(page, await show(page, { blinkLeft: 1 }));
  await eyeCrop(page, "artifacts/m83/phase4-wink-left.png");
  console.log("[blink] left wink", JSON.stringify(leftWink));

  const rightWink = await read(page, await show(page, { blinkRight: 1 }));
  await eyeCrop(page, "artifacts/m83/phase4-wink-right.png");
  console.log("[blink] right wink", JSON.stringify(rightWink));

  const half = await read(page, await show(page, { blinkLeft: 0.5, blinkRight: 0.5 }));
  console.log("[blink] half", JSON.stringify(half));

  /*
   * The criterion: if the rendered face WERE the operator, would this system
   * register the same blink? Each rendered state is fed, as tracker frames 250 ms
   * apart (too slow for the speed rule to help), through the production
   * pipeline: tracker -> fusion -> blink state machine.
   */
  const asOperator = await page.evaluate(async (readings) => {
    const { BlinkStateMachine } = await import("/src/features/transformation/engine/blinkState.ts");
    const states: Record<string, { left: string; right: string; outLeft: number; outRight: number }> = {};
    for (const [name, reading] of Object.entries(readings)) {
      const machine = new BlinkStateMachine();
      const frame = (l: number, r: number) => ({ blinkLeft: l, blinkRight: r, jawOpen: 0, smileLeft: 0, smileRight: 0, browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0, status: "tracked" as const, calculationMs: 0 });
      machine.apply(frame(readings.open!.blinkLeft, readings.open!.blinkRight), 0);
      const out = machine.apply(frame(reading.blinkLeft, reading.blinkRight), 250)!;
      states[name] = { left: out.blinkState!.left, right: out.blinkState!.right, outLeft: out.blinkLeft, outRight: out.blinkRight };
    }
    return states;
  }, { open: open!, both: both!, leftWink: leftWink!, rightWink: rightWink!, half: half! });
  console.log("[blink] as operator", JSON.stringify(asOperator));

  // A rendered blink is unmistakable to the tracker: both eyes register closed.
  expect(asOperator.both).toMatchObject({ left: "closed", right: "closed", outLeft: 1, outRight: 1 });
  // Winks are independent: one eye closed, the other untouched.
  expect(asOperator.leftWink).toMatchObject({ left: "closed", outLeft: 1, outRight: 0 });
  expect(asOperator.rightWink).toMatchObject({ right: "closed", outRight: 1, outLeft: 0 });
  // A half blink is not promoted to a full one.
  expect(asOperator.half.left).not.toBe("closed");
  // And the raw closure ordering holds: half < full.
  expect(half!.blinkLeft).toBeLessThan(both!.blinkLeft);
  expect(half!.blinkRight).toBeLessThan(both!.blinkRight);
});
