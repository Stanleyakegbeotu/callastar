import { expect, test } from "@playwright/test";

/**
 * M8.3 Phase 2: closing the loop through MediaPipe itself.
 *
 * The renderer draws the textured face at a commanded pose, UNMIRRORED; the
 * same MediaPipe face model the Studio tracks with then reads that image. If
 * the renderer turned the face the way the motion contract says, the tracker
 * reads back the same physical direction. Nothing here asserts a sign the code
 * merely agrees with itself about: the only judge is the tracker that measured
 * the operator in the first place.
 *
 * Independent landmark geometry is reported beside the tracker's own numbers,
 * so a disagreement between the matrix and the image is visible too.
 */

test("the tracker reads back the direction the renderer was asked to show", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.setViewportSize({ width: 600, height: 700 });
  await page.evaluate(async () => {
    const { SourceAnalyzer } = await import("/src/features/transformation/source/sourceAnalyzer.ts");
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const { SourceAnalysisTasks } = await import("/src/features/transformation/source/sourceTrackers.ts");
    const blob = await (await fetch("/media/onboarding/male-participant.jpg")).blob();
    const asset = { kind: "image", blob, fileName: "portrait.jpg", mimeType: "image/jpeg", assetId: null } as const;
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset, profileId: "m83-roundtrip" });
    analyzer.cancel();
    if (!result.ok) throw new Error(result.message);
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:480px;height:600px;display:block";
    canvas.dataset.testid = "roundtrip";
    document.body.replaceChildren(canvas);
    const head = { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 };
    const manualPose = { current: null };
    const renderer = new FaceRenderer({
      canvas, asset, profile: result.profile, mirror: "faithful", manualPose,
      motion: { current: { tracked: true, expression: null, upperBody: null, head } },
      manualExpression: { current: null },
    } as never);
    await renderer.initialize();
    const tasks = new SourceAnalysisTasks();
    await tasks.initialize();
    (window as unknown as Record<string, unknown>).__loop = { renderer, manualPose, tasks, head };
  });

  /**
   * Drives the renderer through its REAL input — calibration-relative motion in
   * MediaPipe's own convention, exactly what the tracker produces for the
   * operator — and has the same tracker read the result back.
   */
  const read = async (head: Record<string, number>) => {
    await page.evaluate((next) => {
      const loop = (window as unknown as { __loop: { manualPose: { current: unknown }; head: Record<string, number> } }).__loop;
      loop.manualPose.current = null;
      Object.assign(loop.head, { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0 }, next);
    }, head);
    await page.waitForTimeout(700);
    const shot = await page.getByTestId("roundtrip").screenshot();
    return page.evaluate(async (png) => {
      const loop = (window as unknown as { __loop: { renderer: { getProbe(): { nose: { x: number; y: number } } }; tasks: { detectFace(i: CanvasImageSource): { detected: boolean; landmarks: { x: number; y: number }[]; derived: { yaw: number; pitch: number; roll: number } } } } }).__loop;
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const face = loop.tasks.detectFace(bitmap);
      bitmap.close();
      const probe = loop.renderer.getProbe();
      if (!face.detected) return { detected: false, probeNose: probe.nose };
      const p = face.landmarks;
      // Image-space geometry, independent of the matrix: where the nose tip
      // sits between the eye line and the chin, and across the cheeks.
      const eyeY = (p[33]!.y + p[263]!.y) / 2;
      const noseDown = (p[1]!.y - eyeY) / (p[152]!.y - eyeY);
      const noseAcross = (p[1]!.x - p[234]!.x) / (p[454]!.x - p[234]!.x);
      const deg = (r: number) => Math.round((r * 1800) / Math.PI) / 10;
      return {
        detected: true,
        yaw: deg(face.derived.yaw), pitch: deg(face.derived.pitch), roll: deg(face.derived.roll),
        noseDown: Math.round(noseDown * 1000) / 1000, noseAcross: Math.round(noseAcross * 1000) / 1000,
        probeNose: probe.nose,
      };
    }, shot.toString("base64"));
  };

  const neutral = await read({});
  console.log("[roundtrip] neutral", JSON.stringify(neutral));
  expect(neutral.detected).toBe(true);
  // A source analysed at roll -14°, pitch -7.5° renders level: the source's own
  // pose is removed, not baked in (and pitch is no longer doubled).
  expect(Math.abs(neutral.yaw!), "neutral yaw").toBeLessThan(4);
  expect(Math.abs(neutral.pitch!), "neutral pitch").toBeLessThan(4);
  expect(Math.abs(neutral.roll!), "neutral roll").toBeLessThan(4);

  // Input deltas are MediaPipe's, as the tracker reports the OPERATOR: looking
  // up is negative pitch, turning to their left is positive yaw, tipping
  // towards their right shoulder is positive roll.
  const cases: [string, Record<string, number>, "yaw" | "pitch" | "roll", 1 | -1][] = [
    ["look up", { pitchDelta: -0.2 }, "pitch", -1], ["look down", { pitchDelta: 0.2 }, "pitch", 1],
    ["turn left", { yawDelta: 0.3 }, "yaw", 1], ["turn right", { yawDelta: -0.3 }, "yaw", -1],
    ["tilt right", { rollDelta: 0.25 }, "roll", 1], ["tilt left", { rollDelta: -0.25 }, "roll", -1],
  ];
  for (const [label, head, axis, sign] of cases) {
    const reading = await read(head);
    console.log("[roundtrip]", label, JSON.stringify(reading));
    expect(reading.detected, label).toBe(true);
    const delta = { yaw: reading.yaw! - neutral.yaw!, pitch: reading.pitch! - neutral.pitch!, roll: reading.roll! - neutral.roll! };
    // The tracker reads the rendered face moving the way the operator moved...
    expect(delta[axis] * sign, `${label}: ${axis} read back ${delta[axis]}°`).toBeGreaterThan(5);
    // ...and not some other way.
    for (const other of (["yaw", "pitch", "roll"] as const).filter((key) => key !== axis)) {
      expect(Math.abs(delta[other]), `${label} leaked into ${other}`).toBeLessThan(4);
    }
  }
});
