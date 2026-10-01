import { expect, test, type Page } from "@playwright/test";

import { LEVEL_PORTRAIT_ROLL_DEG } from "./support/faceCamera";
import { openFaceRender, openStudioWithFaceCamera, prepareSource, startAndCalibrate } from "./support/studioFlow";

/**
 * M8.3 Phase 2, end to end: real MediaPipe tracking a real face, a real
 * calibration, the real renderer — and the rendered face measured ON SCREEN.
 *
 * The camera is a photograph moved by a known amount, so where the operator's
 * face goes on the mirrored camera preview is known exactly. Glued framing
 * means the rendered face must go to the same place: the same pixels across,
 * the same pixels down, the same growth, the same tilt. Yaw and pitch cannot be
 * made by moving a photograph; transformation-m83-roundtrip covers those.
 */

interface ScreenProbe { pivot: { x: number; y: number }; eyeSpanPx: number; eyeAngleDeg: number }

async function rendered(page: Page): Promise<ScreenProbe> {
  return page.evaluate(async () => {
    const { FaceRenderer } = await import("/src/features/transformation/engine/rendering/FaceRenderer.ts");
    const canvas = document.querySelector<HTMLCanvasElement>(".studio-face-renderer.is-visible")!;
    const owner = (FaceRenderer as unknown as { owners: Map<HTMLCanvasElement, { getProbe(): { screen: ScreenProbe | null } }> }).owners.get(canvas);
    if (!owner) throw new Error("no renderer owns the visible canvas");
    return owner.getProbe().screen!;
  });
}

async function move(page: Page, change: Record<string, number>): Promise<ScreenProbe> {
  await page.evaluate((next) => (window as unknown as { __faceCamera: { set(v: unknown): void } }).__faceCamera.set(next), change);
  // Tracking under a software rasteriser runs a few frames a second; let the
  // tracker and the renderer's smoothing settle.
  await page.waitForTimeout(3500);
  return rendered(page);
}

/** Pixels one unit of the 480x640 camera frame covers on the renderer canvas. */
async function coverScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".studio-face-renderer.is-visible")!;
    return Math.max(canvas.clientWidth / 480, canvas.clientHeight / 640);
  });
}

const angleChange = (from: number, to: number) => ((to - from + 540) % 360) - 180;

test("the rendered face goes where the operator's face goes, by as much", async ({ page }) => {
  test.setTimeout(480_000);
  await openStudioWithFaceCamera(page);
  await prepareSource(page);
  await startAndCalibrate(page);
  await openFaceRender(page);
  await page.waitForTimeout(2500);

  const cover = await coverScale(page);
  const neutral = await rendered(page);
  console.log("[rigid] neutral", JSON.stringify(neutral), "cover", cover);

  // MOVE: the photograph steps 8% of the frame towards image-right — the
  // operator's own LEFT, which a mirrored self-view shows moving screen-LEFT.
  const left = await move(page, { dx: 0.08 });
  const expectedX = 0.08 * 480 * cover;
  console.log("[rigid] move left", JSON.stringify(left), "expected dx", -expectedX);
  expect(left.pivot.x - neutral.pivot.x).toBeLessThan(-expectedX * 0.7);
  expect(left.pivot.x - neutral.pivot.x).toBeGreaterThan(-expectedX * 1.3);

  const right = await move(page, { dx: -0.08 });
  console.log("[rigid] move right", JSON.stringify(right));
  expect(right.pivot.x - neutral.pivot.x).toBeGreaterThan(expectedX * 0.7);
  expect(right.pivot.x - neutral.pivot.x).toBeLessThan(expectedX * 1.3);

  // DOWN and UP: not mirrored.
  const expectedY = 0.06 * 640 * cover;
  const down = await move(page, { dx: 0, dy: 0.06 });
  console.log("[rigid] move down", JSON.stringify(down));
  expect(down.pivot.y - neutral.pivot.y).toBeGreaterThan(expectedY * 0.7);
  expect(down.pivot.y - neutral.pivot.y).toBeLessThan(expectedY * 1.3);
  const up = await move(page, { dy: -0.06 });
  console.log("[rigid] move up", JSON.stringify(up));
  expect(up.pivot.y - neutral.pivot.y).toBeLessThan(-expectedY * 0.7);

  // CLOSER and FARTHER: the face grows and shrinks by the same ratio.
  const closer = await move(page, { dy: 0, scale: 1.25 });
  console.log("[rigid] closer", JSON.stringify(closer));
  expect(closer.eyeSpanPx / neutral.eyeSpanPx).toBeGreaterThan(1.25 * 0.9);
  expect(closer.eyeSpanPx / neutral.eyeSpanPx).toBeLessThan(1.25 * 1.1);
  const farther = await move(page, { scale: 0.8 });
  console.log("[rigid] farther", JSON.stringify(farther));
  expect(farther.eyeSpanPx / neutral.eyeSpanPx).toBeGreaterThan(0.8 * 0.9);
  expect(farther.eyeSpanPx / neutral.eyeSpanPx).toBeLessThan(0.8 * 1.1);

  // TILT: the photograph turns 12° clockwise in the camera image, which the
  // mirrored self-view shows as 12° anticlockwise. The rendered eye line must
  // turn the same way by about as much, with no rotation leaking elsewhere.
  const tilted = await move(page, { scale: 1, rollDeg: LEVEL_PORTRAIT_ROLL_DEG + 12 });
  const turn = angleChange(neutral.eyeAngleDeg, tilted.eyeAngleDeg);
  console.log("[rigid] tilt", JSON.stringify(tilted), "turned", turn);
  expect(turn).toBeLessThan(-12 * 0.7);
  expect(turn).toBeGreaterThan(-12 * 1.3);
  expect(tilted.eyeSpanPx / neutral.eyeSpanPx).toBeGreaterThan(0.9);

  // And the face returns to where it started.
  const back = await move(page, { rollDeg: LEVEL_PORTRAIT_ROLL_DEG });
  expect(Math.abs(back.pivot.x - neutral.pivot.x)).toBeLessThan(expectedX * 0.25);
  expect(Math.abs(back.pivot.y - neutral.pivot.y)).toBeLessThan(expectedY * 0.25);
  await page.locator(".studio-stage").screenshot({ path: "artifacts/m83/phase2-glued.png" });
});
