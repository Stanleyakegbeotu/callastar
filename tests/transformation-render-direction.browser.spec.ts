import { expect, test } from "@playwright/test";

/**
 * Direction, through the real renderer.
 *
 * The unit tests pin the sign contract; this proves the contract survives the
 * whole path — source analysis, mesh build, clamping, smoothing, and Three.js
 * composing an actual Euler on an actual mesh. That distinction matters here
 * because the milestone's failures were reported from a device where every unit
 * test was green.
 *
 * Named in physical language, and asserted on where the rendered face is
 * POINTING rather than on any intermediate number.
 */

const DRAW_FACE = `(context, width, height) => {
  context.fillStyle = "#c8c8c8";
  context.fillRect(0, 0, width, height);
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
}`;

/** Drives the real renderer through a list of head movements and probes each one. */
const HARNESS = `async (drawSource, moves) => {
  const [{ SourceAnalyzer }, { FaceRenderer }] = await Promise.all([
    import("/src/features/transformation/source/sourceAnalyzer.ts"),
    import("/src/features/transformation/engine/rendering/FaceRenderer.ts"),
  ]);

  const draw = eval("(" + drawSource + ")");
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  draw(canvas.getContext("2d"), 640, 480);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

  const analyzer = new SourceAnalyzer();
  const analysis = await analyzer.analyze({
    asset: { kind: "image", mimeType: "image/png", fileName: "probe.png", blob, assetId: null },
    profileId: "probe",
  });
  if (!analysis.ok) return { ok: false, failure: analysis.failure };

  const target = document.createElement("canvas");
  target.width = 600;
  target.height = 600;
  target.style.width = "600px";
  target.style.height = "600px";
  document.body.appendChild(target);

  const motion = { current: { head: null, expression: null, upperBody: null, tracked: false } };
  const renderer = new FaceRenderer({
    canvas: target,
    asset: { kind: "image", mimeType: "image/png", fileName: "probe.png", blob, assetId: null },
    profile: analysis.profile,
    motion,
    mirror: "selfie",
  });

  await renderer.initialize();

  const head = (overrides) => ({
    head: { translationX: 0, translationY: 0, scaleDelta: 1, yawDelta: 0, pitchDelta: 0, rollDelta: 0, ...overrides },
    expression: null,
    upperBody: null,
    tracked: true,
  });

  const results = {};
  for (const move of moves) {
    motion.current = head(move.motion);
    // The renderer smooths towards a target, so let it settle before probing.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const probe = renderer.getProbe();
    results[move.name] = {
      nose: probe.nose,
      up: probe.up,
      rotation: probe.motion,
      mirror: probe.mirror,
      faceWidthPx: probe.faceWidthPx,
    };
  }

  renderer.dispose();
  target.remove();
  return { ok: true, results, envelope: analysis.profile.movementEnvelope };
}`;

const MOVES = [
  { name: "turn_right", motion: { yawDelta: -0.35 } },
  { name: "turn_left", motion: { yawDelta: 0.35 } },
  { name: "look_up", motion: { pitchDelta: 0.25 } },
  { name: "look_down", motion: { pitchDelta: -0.25 } },
  { name: "tilt_right", motion: { rollDelta: 0.2 } },
  { name: "tilt_left", motion: { rollDelta: -0.2 } },
];

interface Probe {
  nose: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  rotation: { rotationX: number; rotationY: number; rotationZ: number } | null;
  mirror: string;
  faceWidthPx: number;
}

test("physical head movement renders in the matching direction", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");

  const report = await page.evaluate(
    ({ harness, drawSource, moves }) =>
      (eval(`(${harness})`) as (d: string, m: typeof moves) => Promise<Record<string, unknown>>)(drawSource, moves),
    { harness: HARNESS, drawSource: DRAW_FACE, moves: MOVES },
  );

  expect(report.ok, `harness failed: ${JSON.stringify(report)}`).toBe(true);
  const results = report.results as Record<string, Probe>;

  const lines = Object.entries(results).map(([name, probe]) =>
    [
      name.padEnd(12),
      `nose x ${probe.nose.x.toFixed(3).padStart(7)} y ${probe.nose.y.toFixed(3).padStart(7)}`,
      `  up x ${probe.up.x.toFixed(3).padStart(7)}`,
      `  euler ${probe.rotation ? `${probe.rotation.rotationX.toFixed(3)}/${probe.rotation.rotationY.toFixed(3)}/${probe.rotation.rotationZ.toFixed(3)}` : "—"}`,
    ].join(""),
  );

  console.log(
    [
      "",
      "──────── Render direction, as seen on a mirrored self-view ────────",
      `face ${results.turn_right!.faceWidthPx.toFixed(0)}px wide · mirror ${results.turn_right!.mirror}`,
      "",
      ...lines,
      "",
    ].join(String.fromCharCode(10)),
  );

  // Movement actually reached the renderer, rather than being clamped away.
  for (const [name, probe] of Object.entries(results)) {
    expect(probe.rotation, `${name} produced no rotation`).not.toBeNull();
  }

  // physical_right_turn_renders_right_turn
  expect(results.turn_right!.nose.x).toBeGreaterThan(0.05);
  // physical_left_turn_renders_left_turn
  expect(results.turn_left!.nose.x).toBeLessThan(-0.05);

  // physical_look_up_renders_up
  expect(results.look_up!.nose.y).toBeGreaterThan(0.05);
  // physical_look_down_renders_down
  expect(results.look_down!.nose.y).toBeLessThan(-0.05);

  // physical_tilt_right_renders_right / physical_tilt_left_renders_left
  expect(results.tilt_right!.up.x).toBeGreaterThan(0.05);
  expect(results.tilt_left!.up.x).toBeLessThan(-0.05);

  // And one axis at a time stays one axis, through the whole path.
  expect(Math.abs(results.turn_right!.nose.y)).toBeLessThan(0.05);
  expect(Math.abs(results.look_up!.nose.x)).toBeLessThan(0.05);
});
