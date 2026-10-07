import { expect, test } from "@playwright/test";

test("canonical live mouth keeps measured width and opening, pairs pixels, and clears on SOURCE", async ({ page }) => {
  await page.goto("/");
  const report = await page.evaluate(async () => {
    const [{ SourceAnalyzer }, { FaceRenderer }, { INNER_LIP_RING, OUTER_LIP_RING }, { drawPerioralPatch }] = await Promise.all([
      import("/src/features/transformation/source/sourceAnalyzer.ts"),
      import("/src/features/transformation/engine/rendering/FaceRenderer.ts"),
      import("/src/features/transformation/engine/rendering/sourceMesh.ts"),
      import("/src/features/transformation/engine/rendering/liveMouthCompositor.ts"),
    ]);
    const blob = await (await fetch("/media/onboarding/male-participant.jpg")).blob();
    const asset = { kind: "image", blob, fileName: "portrait.jpg", mimeType: "image/jpeg", assetId: null } as const;
    const analyzer = new SourceAnalyzer();
    const analyzed = await analyzer.analyze({ asset, profileId: "phase1b-mouth" });
    analyzer.cancel();
    if (!analyzed.ok) throw new Error(analyzed.message);
    const snapshot = document.createElement("canvas");
    snapshot.width = 320; snapshot.height = 240;
    const context = snapshot.getContext("2d")!;
    context.fillStyle = "rgb(190,135,110)"; context.fillRect(0, 0, 320, 240);
    context.fillStyle = "rgb(35,10,20)";
    context.beginPath(); context.ellipse(160, 132, 32, 12, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = "white"; context.fillRect(146, 124, 28, 5);
    const stream = snapshot.captureStream(30);
    const video = document.createElement("video");
    video.muted = true; video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:480px;height:600px";
    document.body.replaceChildren(canvas);
    const landmarks = analyzed.profile.primaryFace.landmarks.map(point => ({ ...point }));
    landmarks[234] = { x: .2, y: .5, z: 0 };
    landmarks[454] = { x: .8, y: .5, z: 0 };
    OUTER_LIP_RING.forEach((index, i) => {
      const angle = Math.PI - i * Math.PI * 2 / 20;
      landmarks[index] = { x: .5 + .1 * Math.cos(angle), y: .55 + .04 * Math.sin(angle), z: 0 };
    });
    INNER_LIP_RING.forEach((index, i) => {
      const angle = Math.PI - i * Math.PI * 2 / 20;
      landmarks[index] = { x: .5 + .078 * Math.cos(angle), y: .55 + .024 * Math.sin(angle), z: 0 };
    });
    const head = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
    const mode = { current: "live" as "live" | "source" };
    const enabled = { current: true };
    const faceFrame = { current: null as any };
    const stats = { current: null as any };
    const renderer = new FaceRenderer({
      canvas, asset, profile: analyzed.profile, mirror: "faithful",
      motion: { current: { tracked: true, expression: null, upperBody: null, head } },
      faceFrame, liveMouthVideoRef: { current: video }, liveMouthEnabled: enabled,
      oralInteriorMode: mode, onStats: value => { stats.current = value; },
    } as never);
    await renderer.initialize();
    let stamp = 100;
    const publish = () => {
      stamp += 33;
      const expression = { updatedAtMs: performance.now(), liveMouth: {
        timestampMs: stamp,
        ring: OUTER_LIP_RING.map(index => ({ x: landmarks[index]!.x, y: landmarks[index]!.y })),
        innerRing: INNER_LIP_RING.map(index => ({ x: landmarks[index]!.x, y: landmarks[index]!.y })),
        faceWidthRatio: .6, sourceFrame: snapshot,
      } };
      faceFrame.current = {
        frameId: stamp, timestampMs: stamp, trackingTimestampMs: performance.now(),
        landmarks, stabilizedLandmarks: landmarks, globalTransform: head,
        expressionState: expression, trackingAspect: 320 / 240, rawScaleRatio: 1,
        livePlacement: { center: { x: .5, y: .5, z: 0 }, width: .6, viewport: null },
      };
      return expression;
    };
    const expression = publish();
    (renderer as any).updateLiveMouth(16, false, expression);
    for (let i = 0; i < 20; i++) {
      expression.updatedAtMs = performance.now();
      (renderer as any).updateLiveMouth(16, false, expression);
    }
    const geometry = (renderer as any).liveMouthGeometry;
    const root = (renderer as any).faceRoot;
    const vertex = geometry.getAttribute("position");
    const localX = vertex.getX(20);
    root.updateMatrixWorld(true);
    const point = new (renderer as any).three.Vector3(vertex.getX(20), vertex.getY(20), vertex.getZ(20));
    const worldBefore = root.localToWorld(point.clone()).x;
    root.position.x += .1;
    root.updateMatrixWorld(true);
    const worldAfter = root.localToWorld(point.clone()).x;
    const sameLocalX = vertex.getX(20);
    root.position.x -= .1;
    const outerRing = OUTER_LIP_RING.map(index => ({ x: landmarks[index]!.x, y: landmarks[index]!.y }));
    const innerRing = INNER_LIP_RING.map(index => ({ x: landmarks[index]!.x, y: landmarks[index]!.y }));
    const benchmark = document.createElement("canvas");
    benchmark.width = 256; benchmark.height = 192;
    const benchmarkContext = benchmark.getContext("2d")!;
    const benchmarkMask = (withInner: boolean) => {
      const start = performance.now();
      for (let i = 0; i < 40; i++) drawPerioralPatch(benchmarkContext, snapshot,
        outerRing, 320, 240, 192, withInner ? innerRing : undefined);
      return (performance.now() - start) / 40;
    };
    const legacyMaskMs = benchmarkMask(false);
    const threeZoneMaskMs = benchmarkMask(true);
    const texture = (renderer as any).liveMouthCanvas as HTMLCanvasElement;
    const pixels = texture.getContext("2d")!.getImageData(0, 0, texture.width, texture.height).data;
    const alpha = (x: number, y: number) => pixels[(y * texture.width + x) * 4 + 3]!;
    const live = {
      canonical: (renderer as any).liveMouthCanonical,
      vertices: geometry.getAttribute("position").count,
      diagnostics: (renderer as any).canonicalMouthDiagnostics,
      opacity: (renderer as any).liveMouthOpacity,
      status: (renderer as any).mouthMaskStatus,
      oral: { ...(renderer as any).oralDiagnostics },
      videoState: video.readyState,
      centerAlpha: alpha(128, 96),
      edgeAlpha: alpha(0, 0),
      sampleTimestamp: (renderer as any).liveMouthLastTimestamp,
      processingMs: (renderer as any).mouthCompositorMs,
      fps: stats.current?.fps,
      rootShift: worldAfter - worldBefore,
      localShift: sameLocalX - localX,
      legacyMaskMs, threeZoneMaskMs,
    };
    mode.current = "source";
    (renderer as any).updateLiveMouth(16, false, expression);
    const cleared = { opacity: (renderer as any).liveMouthOpacity,
      frame: (renderer as any).liveMouthHasFrame, status: (renderer as any).mouthMaskStatus };
    renderer.dispose();
    stream.getTracks().forEach(track => track.stop());
    return { live, cleared };
  });
  console.log("[Phase 1B renderer]", JSON.stringify(report));
  expect(report.live.canonical).toBe(true);
  expect(report.live.vertices).toBe(61);
  expect(report.live.diagnostics.widthRatio).toBeGreaterThan(.94);
  expect(report.live.diagnostics.widthRatio).toBeLessThan(1.06);
  expect(report.live.diagnostics.openingRatio).toBeGreaterThan(.8);
  expect(report.live.diagnostics.openingRatio).toBeLessThan(1.2);
  expect(report.live.opacity).toBeGreaterThan(.95);
  expect(report.live.centerAlpha).toBeGreaterThan(245);
  expect(report.live.edgeAlpha).toBeLessThan(10);
  expect(report.live.sampleTimestamp).toBeGreaterThan(100);
  expect(report.live.rootShift).toBeCloseTo(.1, 4);
  expect(report.live.localShift).toBe(0);
  expect(report.cleared.frame).toBe(false);
  expect(report.cleared.status).toBe("disabled");
  expect(report.cleared.opacity).toBeLessThan(.02);
});
