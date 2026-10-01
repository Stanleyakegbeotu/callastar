import { expect, test } from "@playwright/test";

test("live mouth warp copies interior pixels only inside the inner-lip mask", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const { drawWarpedMouth, mouthFanTriangles } = await import("/src/features/transformation/engine/rendering/liveMouthCompositor.ts");
    const width = 192, height = 96;
    const source = document.createElement("canvas");
    source.width = 256; source.height = 192;
    const sourceContext = source.getContext("2d")!;
    // This is deliberately skin-colored outside the operator's inner lips.
    sourceContext.fillStyle = "rgb(210, 150, 130)";
    sourceContext.fillRect(0, 0, source.width, source.height);
    sourceContext.fillStyle = "rgb(25, 15, 20)";
    sourceContext.beginPath(); sourceContext.ellipse(128, 100, 62, 34, 0, 0, Math.PI * 2); sourceContext.fill();
    sourceContext.fillStyle = "white";
    sourceContext.fillRect(104, 78, 48, 11); // visible teeth
    sourceContext.fillStyle = "rgb(190, 45, 65)";
    sourceContext.beginPath(); sourceContext.ellipse(128, 120, 24, 8, 0, 0, Math.PI * 2); sourceContext.fill(); // tongue

    const ring = (cx: number, cy: number, rx: number, ry: number) => Array.from({ length: 20 }, (_, i) => {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / 20;
      return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
    });
    const live = ring(0.5, 100 / source.height, 62 / source.width, 34 / source.height);
    const target = ring(0.5, 0.5, 0.42, 0.34);
    const output = document.createElement("canvas");
    output.width = width; output.height = height;
    const context = output.getContext("2d", { willReadFrequently: true })!;
    const drawn = drawWarpedMouth(context, source, live, target, width, height, source.width, source.height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const inside = (x: number, y: number) => {
      let hit = false;
      for (let i = 0, j = target.length - 1; i < target.length; j = i++) {
        const a = target[i]!, b = target[j]!;
        const ax = a.x * width, ay = a.y * height, bx = b.x * width, by = b.y * height;
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) hit = !hit;
      }
      return hit;
    };
    let leaked = 0, copied = 0, dark = 0, teeth = 0, tongue = 0;
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3]!;
      if (!inside(x + .5, y + .5)) {
        if (alpha > 0) leaked++;
      } else if (alpha > 0) {
        copied++;
        if (pixels[offset]! < 50 && pixels[offset + 1]! < 50) dark++;
        if (pixels[offset]! > 220 && pixels[offset + 1]! > 220 && pixels[offset + 2]! > 220) teeth++;
        if (pixels[offset]! > 120 && pixels[offset]! < 230 && pixels[offset + 1]! < 90) tongue++;
      }
    }
    return { drawn, triangles: mouthFanTriangles(live.length).length, leaked, copied, dark, teeth, tongue };
  });

  expect(report.drawn).toBe(true);
  expect(report.triangles).toBe(20);
  expect(report.copied).toBeGreaterThan(1000);
  expect(report.dark).toBeGreaterThan(100);
  expect(report.teeth).toBeGreaterThan(10);
  expect(report.tongue).toBeGreaterThan(10);
  expect(report.leaked).toBe(0);
});

test("FaceRenderer fades the transient mouth layer on and off", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const [{ SourceAnalyzer }, { FaceRenderer }] = await Promise.all([
      import("/src/features/transformation/source/sourceAnalyzer.ts"),
      import("/src/features/transformation/engine/rendering/FaceRenderer.ts"),
    ]);
    const blob = await (await fetch("/media/onboarding/male-participant.jpg")).blob();
    const asset = { kind: "image", blob, fileName: "portrait.jpg", mimeType: "image/jpeg", assetId: null } as const;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset, profileId: "m83-live-mouth" });
    analyzer.cancel();
    if (!result.ok) throw new Error(result.message);
    const camera = document.createElement("canvas");
    camera.width = 160; camera.height = 120;
    const ctx = camera.getContext("2d")!;
    ctx.fillStyle = "rgb(210,150,130)"; ctx.fillRect(0, 0, 160, 120);
    ctx.fillStyle = "rgb(20,10,15)"; ctx.beginPath(); ctx.ellipse(80, 62, 34, 20, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "white"; ctx.fillRect(65, 48, 30, 7);
    const stream = camera.captureStream(30);
    const video = document.createElement("video");
    video.muted = true; video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:480px;height:600px;display:block";
    document.body.replaceChildren(canvas);
    const ring = Array.from({ length: 20 }, (_, i) => {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / 20;
      return { x: 0.5 + Math.cos(angle) * 0.11, y: 0.52 + Math.sin(angle) * 0.055 };
    });
    const expression = { current: {
      blinkLeft: 0, blinkRight: 0, jawOpen: 0, smileLeft: 0, smileRight: 0,
      browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0,
      status: "tracked", calculationMs: 0, liveMouth: { timestampMs: 1, ring },
    } as any };
    const enabled = { current: true };
    const stats = { current: null as any };
    const head = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
    const renderer = new FaceRenderer({
      canvas, asset, profile: result.profile, mirror: "faithful",
      motion: { current: { tracked: true, expression: null, upperBody: null, head } },
      expression, liveMouthVideoRef: { current: video }, liveMouthEnabled: enabled,
      onStats: (value) => { stats.current = value; },
    } as never);
    await renderer.initialize();
    await new Promise(resolve => setTimeout(resolve, 400));
    const closed = stats.current?.mouthFeedOpacity ?? 0;
    expression.current.jawOpen = 0.9;
    expression.current.liveMouth.timestampMs = 2;
    await new Promise(resolve => setTimeout(resolve, 800));
    const on = stats.current?.mouthFeedOpacity ?? 0;
    enabled.current = false;
    await new Promise(resolve => setTimeout(resolve, 800));
    const off = stats.current?.mouthFeedOpacity ?? 1;
    renderer.dispose();
    stream.getTracks().forEach(track => track.stop());
    return {
      closed, on, off,
      fps: stats.current?.fps ?? null,
      renderMs: stats.current?.renderMs ?? null,
      deformationMs: stats.current?.deformationMs ?? null,
      compositorMs: stats.current?.mouthCompositorMs ?? null,
      dpr: stats.current?.dpr ?? null,
    };
  });
  console.log("[live mouth performance]", JSON.stringify(report));
  expect(report.closed).toBeLessThan(0.02);
  expect(report.on).toBeGreaterThan(0.5);
  expect(report.off).toBeLessThan(0.02);
  expect(report.compositorMs).not.toBeNull();
  expect(report.compositorMs).toBeGreaterThanOrEqual(0);
});
