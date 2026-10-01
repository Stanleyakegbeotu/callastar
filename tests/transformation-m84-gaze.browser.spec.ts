import { expect, test } from "@playwright/test";

test("M8.4 source gaze moves each source eye's own texture field", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { EyeGazeWarper } = await import("/src/features/transformation/engine/rendering/eyeGazeWarper.ts");
    const source = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const set = (i: number, x: number, y: number) => { source[i] = { x, y, z: 0 }; };
    set(133, 0.4, 0.45); set(33, 0.3, 0.45);
    set(159, 0.325, 0.44); set(158, 0.35, 0.44); set(157, 0.375, 0.44);
    set(145, 0.325, 0.46); set(153, 0.35, 0.46); set(154, 0.375, 0.46);
    set(468, 0.35, 0.45); set(469, 0.35, 0.445); set(470, 0.355, 0.45); set(471, 0.35, 0.455); set(472, 0.345, 0.45);
    set(362, 0.6, 0.45); set(263, 0.7, 0.45);
    set(386, 0.625, 0.44); set(385, 0.65, 0.44); set(384, 0.675, 0.44);
    set(374, 0.625, 0.46); set(380, 0.65, 0.46); set(381, 0.675, 0.46);
    set(473, 0.65, 0.45); set(474, 0.65, 0.445); set(475, 0.655, 0.45); set(476, 0.65, 0.455); set(477, 0.645, 0.45);
    const uv = new Float32Array(468 * 2);
    for (let i = 0; i < 468; i++) uv.set([0.5, 0.5], i * 2);
    uv.set([0.35, 0.45], 0);
    uv.set([0.65, 0.45], 2);
    const warper = new EyeGazeWarper(uv, source);
    const applied = warper.update({ left: { x: 0.8, y: 0 }, right: { x: -0.8, y: 0 }, clamped: false });
    return {
      available: warper.available,
      leftMoved: applied[0] !== uv[0],
      rightMoved: applied[2] !== uv[2],
      outsideStayed: applied[4] === uv[4],
    };
  });
  expect(result.available).toEqual({ left: true, right: true });
  expect(result.leftMoved).toBe(true);
  expect(result.rightMoved).toBe(true);
  expect(result.outsideStayed).toBe(true);
});
