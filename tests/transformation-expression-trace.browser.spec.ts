import { expect, test } from "@playwright/test";

/**
 * The isolation measurement the real-device failures needed.
 *
 * Part J of the milestone, done first and deliberately: drive every expression
 * to its maximum through the SAME path live input uses, and measure how far the
 * mesh actually moves. That single number separates the three possible causes
 * which all look identical on a phone:
 *
 *   no signal        → applied ≈ 0
 *   wrong vertices   → applied high, displacement 0, or displacement in the
 *                      wrong region
 *   too weak         → applied high, displacement real but a pixel or two
 *
 * Reported in SOURCE units and in CANVAS PIXELS, because a displacement of
 * 0.005 means nothing until you know the rendered face is 180px wide.
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

const EXPRESSION_KEYS = [
  "blinkLeft",
  "blinkRight",
  "jawOpen",
  "smileLeft",
  "smileRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
] as const;

interface Measurement {
  key: string;
  requested: number;
  sourceMax: number;
  applied: number;
  displacement: number;
  displacementPx: number;
  /** How many mesh vertices this expression moves at all. */
  movedVertices: number;
  /** Bounding box of the moved vertices, in source normalised space. */
  region: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

test("measures every expression from applied value to vertex displacement", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");

  const report = await page.evaluate(async ({ drawSource, keys }) => {
    const [{ SourceAnalyzer }, mesh, deformer, expression] = await Promise.all([
      import("/src/features/transformation/source/sourceAnalyzer.ts"),
      import("/src/features/transformation/engine/rendering/sourceMesh.ts"),
      import("/src/features/transformation/engine/rendering/expressionDeformer.ts"),
      import("/src/features/transformation/engine/expressionMotion.ts"),
    ]);

    const draw = eval(`(${drawSource})`) as (c: CanvasRenderingContext2D, w: number, h: number) => void;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    draw(canvas.getContext("2d")!, 640, 480);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((v) => resolve(v!), "image/png"));

    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({
      asset: { kind: "image", mimeType: "image/png", fileName: "probe.png", blob, assetId: null },
      profileId: "probe",
    });
    if (!result.ok) return { ok: false as const, failure: result.failure };

    const face = result.profile.primaryFace;
    const meshData = mesh.buildSourceFaceMesh(face.landmarks);
    const def = new deformer.ExpressionDeformer(meshData, face.landmarks);

    // The same envelope the renderer applies, from the same source profile.
    const sourceExpression = result.profile.expression ?? expression.deriveSourceExpression(face);
    const envelope = expression.deriveExpressionEnvelope(sourceExpression);

    /*
     * Pixel scale, matching the renderer exactly: the mesh is drawn at scale
     * 2.0 and the orthographic camera spans 2 world units vertically, so one
     * source unit is `heightPx` pixels at neutral scale.
     */
    const heightPx = 600;
    const pxPerSourceUnit = (2.0 * heightPx) / 2;

    const base = meshData.positions;
    const measurements = [];

    for (const key of keys) {
      const requested = 1;
      const applied = Math.min(requested, envelope[key as keyof typeof envelope] as number);
      const values = Object.fromEntries(keys.map((k) => [k, k === key ? applied : 0]));
      const live = def.update(values as never);

      let displacement = 0;
      let movedVertices = 0;
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;

      for (let vertex = 0; vertex < live.length / 3; vertex += 1) {
        const dx = live[vertex * 3]! - base[vertex * 3]!;
        const dy = live[vertex * 3 + 1]! - base[vertex * 3 + 1]!;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > displacement) displacement = magnitude;
        // A tenth of a source pixel: real movement, not floating-point dust.
        if (magnitude > 1e-5) {
          movedVertices += 1;
          const ux = meshData.uvs[vertex * 2]!;
          const uy = meshData.uvs[vertex * 2 + 1]!;
          minX = Math.min(minX, ux);
          maxX = Math.max(maxX, ux);
          minY = Math.min(minY, uy);
          maxY = Math.max(maxY, uy);
        }
      }

      measurements.push({
        key,
        requested,
        sourceMax: applied,
        applied,
        displacement,
        displacementPx: displacement * pxPerSourceUnit,
        movedVertices,
        region: movedVertices > 0 ? { minX, maxX, minY, maxY } : null,
      });
    }

    // Anatomy, so a displacement can be judged against what it must move.
    const anchors = deformer.EXPRESSION_LANDMARKS;
    const point = (index: number) => face.landmarks[index]!;
    const eyeGapLeft = Math.abs(point(anchors.leftEye.upper).y - point(anchors.leftEye.lower).y);
    const eyeGapRight = Math.abs(point(anchors.rightEye.upper).y - point(anchors.rightEye.lower).y);
    const mouthWidth = Math.hypot(
      point(anchors.mouth.left).x - point(anchors.mouth.right).x,
      point(anchors.mouth.left).y - point(anchors.mouth.right).y,
    );
    const faceWidth = Math.abs(point(454).x - point(234).x);

    return {
      ok: true as const,
      measurements,
      vertexCount: base.length / 3,
      anatomy: {
        eyeGapLeft,
        eyeGapRight,
        mouthWidth,
        faceWidth,
        eyeGapLeftPx: eyeGapLeft * pxPerSourceUnit,
        mouthWidthPx: mouthWidth * pxPerSourceUnit,
        faceWidthPx: faceWidth * pxPerSourceUnit,
      },
      envelope,
      sourceExpression,
    };
  }, { drawSource: DRAW_FACE, keys: EXPRESSION_KEYS });

  expect(report.ok, `source analysis failed: ${JSON.stringify(report)}`).toBe(true);
  if (!report.ok) return;

  const rows = (report.measurements as Measurement[])
    .map((m) => {
      const region = m.region
        ? `x ${m.region.minX.toFixed(2)}–${m.region.maxX.toFixed(2)} y ${m.region.minY.toFixed(2)}–${m.region.maxY.toFixed(2)}`
        : "—";
      return [
        m.key.padEnd(17),
        m.requested.toFixed(2).padEnd(6),
        m.sourceMax.toFixed(2).padEnd(9),
        m.applied.toFixed(2).padEnd(8),
        m.displacement.toFixed(5).padEnd(9),
        `${m.displacementPx.toFixed(1)}px`.padEnd(8),
        String(m.movedVertices).padEnd(7),
        region,
      ].join("");
    })
    .join(String.fromCharCode(10));

  console.log(
    [
      "",
      "──────── Expression trace (max request through the real path) ────────",
      `mesh vertices ${report.vertexCount} · face ${report.anatomy.faceWidthPx.toFixed(0)}px wide ` +
        `· eye gap ${report.anatomy.eyeGapLeftPx.toFixed(1)}px · mouth ${report.anatomy.mouthWidthPx.toFixed(0)}px`,
      "",
      "expression       req   srcMax   applied  sourceΔ  pixels  moved  region",
      rows,
      "",
      `source expression: ${JSON.stringify(report.sourceExpression)}`,
      "",
    ].join(String.fromCharCode(10)),
  );

  const measurements = report.measurements as Measurement[];

  // Every expression must reach the mesh at all — this is the "no signal" and
  // "wrong vertices" case, and it must fail loudly rather than being tuned.
  for (const measurement of measurements) {
    expect(measurement.applied, `${measurement.key} is clamped to nothing`).toBeGreaterThan(0.1);
    expect(measurement.movedVertices, `${measurement.key} moves no vertices`).toBeGreaterThan(0);
  }

  /*
   * And it must be VISIBLE. Three pixels on a phone is not a blink.
   *
   * Eight pixels is the floor at which a change is noticeable on a rendered
   * face this size; the eyelid and jaw ought to clear it comfortably once the
   * amplitudes are right.
   */
  for (const measurement of measurements) {
    expect(
      measurement.displacementPx,
      `${measurement.key} moves only ${measurement.displacementPx.toFixed(1)}px — invisible on a device`,
    ).toBeGreaterThan(8);
  }
});
