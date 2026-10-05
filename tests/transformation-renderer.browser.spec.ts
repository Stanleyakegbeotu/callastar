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
    const { DEFAULT_TRANSFORMATION_CONTROLS } = await import("/src/features/transformation/engine/transformationControls.ts");
    const { analyzeSourceAppearance } = await import("/src/features/transformation/source/sourceAppearanceAnalysis.ts");
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
    const appearance = analyzeSourceAppearance(source, source.width, source.height, landmarks);
    const profile = {
      primaryFace: { landmarks },
      appearance,
      dimensions: { width: source.width, height: source.height, aspectRatio: source.width / source.height },
      referenceFrames: [],
      movementEnvelope: {
        translation: null, scaleMin: 0.9, scaleMax: 1.1,
        yawLeft: 0.35, yawRight: 0.35, pitchUp: 0.2, pitchDown: 0.2,
        roll: 0.15, basis: "single-image",
      },
    };
    const reports: { status: string; message: string | null }[] = [];
    const faceFrame = { current: {
      frameId: 7, timestampMs: 125, trackingTimestampMs: 210, landmarks,
      rawGlobalTransform: { translationX: 0.12, translationY: -0.05, scaleDelta: 1.05, yawDelta: 0.12, pitchDelta: 0.03, rollDelta: -0.02 },
      globalTransform: { translationX: 0.12, translationY: -0.05, scaleDelta: 1.05, yawDelta: 0.12, pitchDelta: 0.03, rollDelta: -0.02 },
      globalCenter: { x: 0.62, y: 0.45, z: 0 }, referenceCenter: { x: 0.5, y: 0.5, z: 0 },
      referenceScale: 0.1, rawFaceScale: 0.105, trackingAspect: 0.75, rawScaleRatio: 1.05, expressionState: null,
      stableAnchors: [], referenceAnchors: [], projectedReferenceAnchors: [],
    } };
    const rootMotionDebug = { current: { mode: "tracking" as const, x: 0, y: 0, scale: 1, rollDeg: 0 } };
    const controls = { current: structuredClone(DEFAULT_TRANSFORMATION_CONTROLS) };
    const renderer = new FaceRenderer({
      canvas,
      asset: { kind: "image", blob, fileName: "fixture.png", mimeType: "image/png", assetId: null },
      profile: profile as never,
      framing: { current: { neutralCenter: { x: 0.5, y: 0.5 }, neutralEyeSpan: 0.2, trackingWidth: 480, trackingHeight: 640 } },
      motion: { current: { tracked: true, expression: null, upperBody: null, head: {
        translationX: 0.12, translationY: -0.05, scaleDelta: 1.05, yawDelta: 0.12, pitchDelta: 0.03, rollDelta: -0.02,
      } } },
      faceFrame,
      rootMotionDebug,
      controls,
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
    renderer.setDiagnostics({ showMesh: false, wireframe: false, showBoundaries: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.setDiagnostics({ showMesh: false, wireframe: false, showWeights: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.setDiagnostics({ showMesh: false, wireframe: false, showFaceLockDebug: true });
    const attachment = renderer.getAttachmentProbe();
    const fitBase = renderer.getAttachmentProbe();
    controls.current = { ...controls.current, faceFit: { ...controls.current.faceFit, width: 115 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const widthFit = renderer.getAttachmentProbe();
    controls.current = { ...controls.current, faceFit: { ...controls.current.faceFit, height: 115 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const heightFit = renderer.getAttachmentProbe();
    controls.current = { ...controls.current, faceFit: { ...controls.current.faceFit, scale: 110 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scaleFit = renderer.getAttachmentProbe();
    controls.current = { ...controls.current, faceFit: { ...controls.current.faceFit, x: 50, y: -40, rotation: 6 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const offsetRotationFit = renderer.getAttachmentProbe();
    controls.current = { ...controls.current, faceFit: { width: 100, height: 100, scale: 100, x: 0, y: 0, rotation: 0 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    faceFrame.current = {
      ...faceFrame.current!,
      frameId: 8,
      rawGlobalTransform: { translationX: -0.15, translationY: 0.15, scaleDelta: 1.5, yawDelta: 0, pitchDelta: 0, rollDelta: 0 },
      globalTransform: { translationX: -0.15, translationY: 0.15, scaleDelta: 1.5, yawDelta: 0, pitchDelta: 0, rollDelta: 0 },
      globalCenter: { x: 0.35, y: 0.65, z: 0 },
      rawFaceScale: 0.15,
      rawScaleRatio: 1.5,
    };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const movedAttachment = renderer.getAttachmentProbe();
    const internals = renderer as unknown as {
      coverageBoundaryVertices: number[];
      coverageExtensionVertices: number[];
      coverageExtensionRegions: Uint8Array;
      boundaryAlpha: Float32Array;
      deformer: { positions: Float32Array; basePositions: Float32Array };
      geometry: { getAttribute(name: string): { array: Float32Array } };
      material: { map: unknown };
      coveragePreviewLines: { line: { visible: boolean } }[];
      boundarySourceSamples: ({ r: number; g: number; b: number } | null)[];
      boundaryCurrentCorrection: readonly { r: number; g: number; b: number }[];
    };
    const boundaryCorrectionStrength = () => Math.max(0, ...internals.boundaryCurrentCorrection.flatMap(correction => [
      Math.abs(correction.r - 1), Math.abs(correction.g - 1), Math.abs(correction.b - 1),
    ]));
    controls.current = { ...controls.current, blending: { ...controls.current.blending, skinMatch: 0 } };
    faceFrame.current = {
      ...faceFrame.current!,
      boundarySkinSamples: Array.from({ length: 6 }, () => ({ r: 250, g: 250, b: 250 })),
      boundarySkinSampleTimestampMs: 1000,
    };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const skinMatchLowCorrection = boundaryCorrectionStrength();
    await new Promise(resolve => setTimeout(resolve, 150));
    controls.current = { ...controls.current, blending: { ...controls.current.blending, skinMatch: 100 } };
    faceFrame.current = { ...faceFrame.current!, boundarySkinSampleTimestampMs: 1125 };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const skinMatchHighCorrection = boundaryCorrectionStrength();
    const regionIndex = internals.coverageExtensionRegions.findIndex(region => region === 0);
    const boundaryVertex = internals.coverageBoundaryVertices[regionIndex]!;
    const extensionVertex = internals.coverageExtensionVertices[regionIndex]!;
    const extensionDistance = () => Math.hypot(
      internals.deformer.positions[extensionVertex * 3]! - internals.deformer.positions[boundaryVertex * 3]!,
      internals.deformer.positions[extensionVertex * 3 + 1]! - internals.deformer.positions[boundaryVertex * 3 + 1]!,
      internals.deformer.positions[extensionVertex * 3 + 2]! - internals.deformer.positions[boundaryVertex * 3 + 2]!,
    );
    const extensionDistanceBefore = extensionDistance();
    const coverageVertex = Array.from(internals.boundaryAlpha).findIndex(alpha => alpha > 0.95);
    const sourceAlphaBefore = internals.geometry.getAttribute("color").array[coverageVertex * 4 + 3]!;
    controls.current = {
      ...controls.current,
      coverage: { ...controls.current.coverage, overall: 100 },
      blending: { ...controls.current.blending, feather: 24, sourceOpacity: 100 },
    };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const extensionDistanceAfterOverallCoverage = extensionDistance();
    controls.current = { ...controls.current, coverage: { ...controls.current.coverage, forehead: 100 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const extensionDistanceAfterForeheadCoverage = extensionDistance();
    controls.current = { ...controls.current, blending: { ...controls.current.blending, feather: 100, sourceOpacity: 40 } };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const extensionDistanceAfterFeather = extensionDistance();
    const sourceAlphaAfter = internals.geometry.getAttribute("color").array[coverageVertex * 4 + 3]!;
    renderer.setDiagnostics({ showMesh: false, wireframe: false, showMask: true, showBoundaries: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const maskPreviewUsesActualMask = internals.material.map === null && internals.geometry.getAttribute("color").array[coverageVertex * 4 + 3]! > 0;
    const boundaryPreviewLineCount = internals.coveragePreviewLines.length;
    renderer.setDiagnostics({ showMesh: false, wireframe: false, showMask: false, showBoundaries: true });
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("The face renderer WebGL context is unavailable.");
    const trackedPixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, trackedPixels);
    rootMotionDebug.current = { mode: "manual", x: -0.22, y: 0.18, scale: 1.3, rollDeg: 8 };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const manualAttachment = renderer.getAttachmentProbe();
    const manualPixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, manualPixels);
    const manualPixelChanges = trackedPixels.reduce((count, value, index) => count + (value !== manualPixels[index] ? 1 : 0), 0);
    rootMotionDebug.current = { ...rootMotionDebug.current, mode: "oscillator" };
    await new Promise((resolve) => setTimeout(resolve, 350));
    const oscillatorAttachment = renderer.getAttachmentProbe();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.setDiagnostics({ showMesh: false, wireframe: false });
    const threeAfterInitialize = hasThreeResource();
    const dimensions = { width: canvas.width, height: canvas.height };
    const untouchedPixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, untouchedPixel);
    (window as unknown as { __faceRenderer?: InstanceType<typeof FaceRenderer> }).__faceRenderer = renderer;
    return {
      threeBefore,
      threeAfterRendererModule,
      threeAfterInitialize,
      dimensions,
      contextHasAlpha: gl.getContextAttributes()?.alpha ?? false,
      contextPremultipliedAlpha: gl.getContextAttributes()?.premultipliedAlpha ?? false,
      shaderPremultipliedAlpha: (renderer as unknown as { material?: { premultipliedAlpha: boolean } }).material?.premultipliedAlpha ?? null,
      texturePremultipliedAlpha: (renderer as unknown as { texture?: { premultiplyAlpha: boolean } }).texture?.premultiplyAlpha ?? null,
      untouchedPixelAlpha: untouchedPixel[3],
      attachment,
      fitBase,
      widthFit,
      heightFit,
      scaleFit,
      offsetRotationFit,
      movedAttachment,
      extensionDistanceBefore,
      extensionDistanceAfterOverallCoverage,
      extensionDistanceAfterForeheadCoverage,
      extensionDistanceAfterFeather,
      skinMatchLowCorrection,
      skinMatchHighCorrection,
      sourceBoundarySampleCount: internals.boundarySourceSamples.filter(sample => sample !== null).length,
      sourceAlphaBefore,
      sourceAlphaAfter,
      maskPreviewUsesActualMask,
      boundaryPreviewLineCount,
      sourceAppearanceHasHairline: Number.isFinite(appearance?.hairline.foreheadTop),
      sourceAppearanceHairMaskCount: appearance?.facialHair.mask.length ?? 0,
      manualAttachment,
      oscillatorAttachment,
      manualPixelChanges,
      status: reports[reports.length - 1],
    };
  });

  expect(report.threeBefore).toBe(false);
  expect(report.threeAfterRendererModule).toBe(false);
  expect(report.threeAfterInitialize).toBe(true);
  expect(report.dimensions.width).toBeGreaterThan(0);
  expect(report.dimensions.height).toBeGreaterThan(0);
  expect(report.contextHasAlpha).toBe(true);
  expect(report.contextPremultipliedAlpha).toBe(true);
  expect(report.shaderPremultipliedAlpha).toBe(false);
  expect(report.texturePremultipliedAlpha).toBe(false);
  expect(report.untouchedPixelAlpha).toBe(0);
  expect(report.attachment?.frameId).toBe(7);
  expect(report.attachment?.rootMatrix).toHaveLength(16);
  expect(report.attachment?.rootLocal?.matrixAutoUpdate).toBe(true);
  expect(report.attachment?.skinIsRootChild).toBe(true);
  expect(report.attachment?.eyePixelsShareRoot).toBe(true);
  expect(report.attachment?.noseSharesRoot).toBe(true);
  expect(report.attachment?.mouthSharesRoot).toBe(true);
  expect(report.attachment?.maskSharesFaceGeometry).toBe(true);
  expect(report.attachment?.featureLayersShareRoot).toBe(true);
  expect(report.attachment?.debugContoursShareRoot).toBe(true);
  expect(report.attachment?.rootPosition?.x).toBeGreaterThan(0);
  expect(report.attachment?.rootPosition?.y).toBeGreaterThan(0);
  expect(report.movedAttachment?.frameId).toBe(8);
  expect(report.widthFit?.rootLocal?.scaleX).toBeGreaterThan((report.fitBase?.rootLocal?.scaleX ?? 0) * 1.14);
  expect(report.heightFit?.rootLocal?.scaleY).toBeGreaterThan((report.widthFit?.rootLocal?.scaleY ?? 0) * 1.14);
  expect(report.scaleFit?.rootLocal?.scaleX).toBeGreaterThan((report.heightFit?.rootLocal?.scaleX ?? 0) * 1.09);
  expect(report.offsetRotationFit?.rootPosition?.x).toBeGreaterThan(report.scaleFit?.rootPosition?.x ?? 0);
  expect(report.offsetRotationFit?.rootPosition?.y).toBeLessThan(report.scaleFit?.rootPosition?.y ?? 0);
  expect(report.offsetRotationFit?.rootLocal?.roll).toBeGreaterThan((report.scaleFit?.rootLocal?.roll ?? 0) + 0.09);
  expect(report.movedAttachment?.rootPosition?.x).toBeLessThan(report.attachment?.rootPosition?.x ?? 0);
  expect(report.movedAttachment?.rootPosition?.y).toBeLessThan(report.attachment?.rootPosition?.y ?? 0);
  expect(report.movedAttachment?.rootScale).toBeGreaterThan((report.attachment?.rootScale ?? 0) * 1.4);
  expect(report.movedAttachment?.rootMatrix).not.toEqual(report.attachment?.rootMatrix);
  expect(report.movedAttachment?.eyeWorldCenter?.x).not.toBeCloseTo(report.attachment?.eyeWorldCenter?.x ?? 0, 2);
  expect(report.movedAttachment?.childWorldPosition?.x).not.toBeCloseTo(report.attachment?.childWorldPosition?.x ?? 0, 2);
  expect(report.extensionDistanceAfterOverallCoverage).toBeGreaterThan(report.extensionDistanceBefore);
  expect(report.extensionDistanceAfterForeheadCoverage).toBeGreaterThan(report.extensionDistanceAfterOverallCoverage);
  expect(report.extensionDistanceAfterFeather).toBeGreaterThan(report.extensionDistanceAfterForeheadCoverage);
  expect(report.sourceBoundarySampleCount).toBeGreaterThan(0);
  expect(report.skinMatchLowCorrection).toBeCloseTo(0, 5);
  expect(report.skinMatchHighCorrection).toBeGreaterThan(report.skinMatchLowCorrection ?? 0);
  expect(report.sourceAlphaBefore).toBeGreaterThan(report.sourceAlphaAfter);
  expect(report.sourceAlphaAfter).toBeCloseTo((report.sourceAlphaBefore ?? 1) * 0.4, 2);
  expect(report.maskPreviewUsesActualMask).toBe(true);
  expect(report.boundaryPreviewLineCount).toBeGreaterThanOrEqual(2);
  expect(report.sourceAppearanceHasHairline).toBe(true);
  expect(report.sourceAppearanceHairMaskCount).toBe(468);
  expect(report.manualAttachment?.rootPosition?.x).toBeCloseTo(-0.22, 4);
  expect(report.manualAttachment?.rootPosition?.y).toBeCloseTo(0.18, 4);
  expect(report.manualAttachment?.rootScale).toBeGreaterThan((report.attachment?.rootScale ?? 0) * 1.2);
  expect(report.manualAttachment?.rootLocal?.roll).toBeCloseTo(8 * Math.PI / 180, 4);
  expect(report.manualPixelChanges).toBeGreaterThan(1000);
  expect(report.oscillatorAttachment?.rootMatrix).not.toEqual(report.manualAttachment?.rootMatrix);
  expect(report.status?.status, report.status?.message ?? "renderer did not report a status").toBe("ready");
  await page.locator('[data-testid="face-renderer-output"]').screenshot({ path: "test-results/transformation-face-renderer.png" });
  const finalStatus = await page.evaluate(() => {
    const renderer = (window as unknown as { __faceRenderer?: { dispose(): void } }).__faceRenderer;
    renderer?.dispose();
    return (window as unknown as { __faceRendererStatus?: string }).__faceRendererStatus;
  });
  expect(finalStatus).toBe("disposed");
});
