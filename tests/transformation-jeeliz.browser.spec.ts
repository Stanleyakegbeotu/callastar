import { expect, test, type Page } from '@playwright/test';

const mpMock = `
export async function loadMediaPipeVision() {
  window.__mpCounts = { face: 0, pose: 0 };
  return {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    FaceLandmarker: { createFromOptions: async () => ({ detectForVideo() { window.__mpCounts.face++; return { faceLandmarks: [] }; }, close() {} }) },
    PoseLandmarker: { createFromOptions: async () => ({ detectForVideo() { window.__mpCounts.pose++; return { landmarks: [] }; }, close() {} }) },
  };
}
export async function loadOpenCv() { throw Error('unused'); }
export async function loadThreeRenderer() { return import('three'); }
export async function loadComlink() { throw Error('unused'); }
`;
const jeelizMock = `
export async function loadJeeliz() {
  const report = window.__labJeeliz ??= { loaded: 0, initialized: 0, destroyed: 0, samples: 0, reused: false, videoLiveAfterDestroy: false, rotation: [0, 0, 0] };
  report.loaded++;
  let options, timer = null;
  const api = {
    create_new() { return api; },
    init(value) { options = value; report.initialized++; report.reused = value.videoSettings.videoElement === document.querySelector('.studio-video'); report.separateCanvas = value.canvas !== document.querySelector('.studio-face-renderer'); report.model = value.NNCPath; queueMicrotask(() => value.callbackReady(false, { videoElement: value.videoSettings.videoElement })); },
    async toggle_pause(paused, shutoff) {
      if (shutoff) throw Error('Main camera must not be shut off');
      clearInterval(timer); timer = null;
      if (!paused) timer = setInterval(() => { report.samples++; options.callbackTrack({ detected: .95, x: .1, y: .2, s: .3, rx: report.rotation[0], ry: report.rotation[1], rz: report.rotation[2], expressions: new Float32Array([.5, .6, .7, .8]) }); }, 16);
    },
    resize() { report.resizes = (report.resizes ?? 0) + 1; return true; },
    update_videoElement(video, callback) { report.updates = (report.updates ?? 0) + 1; callback?.(); },
    async destroy() { clearInterval(timer); timer = null; report.destroyed++; report.videoLiveAfterDestroy = options?.videoSettings.videoElement.srcObject?.getVideoTracks()[0]?.readyState === 'live'; },
  }; return api;
}
`;
async function setup(page: Page, mockJeeliz = true) {
  // All libraries/assets come from the local server, including the real SDK smoke test.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5201(?:\/|$))/, route => route.abort());
  await page.addInitScript(() => {
    sessionStorage.setItem('callastar.development-admin', 'active');
    const scope = window as unknown as { __gumCount: number; __streams: MediaStream[] };
    scope.__gumCount = 0; scope.__streams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      scope.__gumCount++; const stream = await original(constraints); scope.__streams.push(stream); return stream;
    };
  });
  await page.route('**/src/features/transformation/loaders.ts', route => route.fulfill({ contentType: 'text/javascript', body: mpMock }));
  if (mockJeeliz) await page.route('**/src/features/transformation/tracking/jeeliz/jeelizLoader.ts', route => route.fulfill({ contentType: 'text/javascript', body: jeelizMock }));
  await page.goto('/admin/studio');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause tracking', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Tracker Lab' }).click();
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
}
async function jeeliz(page: Page) {
  await page.getByLabel('Tracking engine', { exact: true }).selectOption('jeeliz');
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  await expect(page.locator('[data-lab-metric="Mouth open"] dd')).toHaveText('0.500');
}
const report = (page: Page) => page.evaluate(() => (window as any).__labJeeliz);

test('Jeeliz stays unloaded until selected, then reuses the existing video without a second permission request', async ({ page }) => {
  await setup(page);
  expect(await report(page)).toBeUndefined();
  await jeeliz(page);
  const r = await report(page);
  expect(r.loaded).toBe(1); expect(r.initialized).toBe(1); expect(r.reused).toBe(true); expect(r.separateCanvas).toBe(true);
  expect(await page.evaluate(() => (window as any).__gumCount)).toBe(1);
  expect(r.model).toBe('/models/jeeliz/NN_DEFAULT.json');
});
test('Jeeliz displays callback samples and unsupported metrics truthfully', async ({ page }) => {
  await setup(page); await jeeliz(page);
  for (const name of ['Smile', 'Brow frown', 'Brow raise', 'Dense landmarks', 'Iris landmarks', 'Blink left', 'Blink right', 'Gaze X', 'Gaze Y']) {
    await expect(page.locator(`[data-lab-metric="${name}"] dd`)).toHaveText('unsupported');
  }
  await expect(page.locator('[data-lab-metric="Exact inference ms"] dd')).toHaveText('unavailable');
  await expect(page.locator('[data-lab-metric="Yaw"] dd')).toContainText('unverified');
  await expect(page.locator('[data-lab-metric="Raw rx / ry / rz"] dd')).toHaveText('0.000 / 0.000 / 0.000');
});
test('only selected tracker runs, and returning to MediaPipe resumes face-only lab tracking', async ({ page }) => {
  await setup(page); await jeeliz(page);
  const before = await page.evaluate(() => ({ ...(window as any).__mpCounts }));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__mpCounts)).toEqual(before);
  await page.getByLabel('Tracking engine', { exact: true }).selectOption('mediapipe');
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  await expect.poll(async () => (await report(page)).destroyed).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__mpCounts.face)).toBeGreaterThan(before.face);
  expect(await page.evaluate(() => (window as any).__mpCounts.pose)).toBe(before.pose);
  expect(await page.evaluate(() => (window as any).__gumCount)).toBe(1);
});
test('closing Jeeliz disposes its loop and restores the original scheduler without stopping the camera', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('button', { name: 'Close Tracker Lab' }).click();
  await expect.poll(async () => (await report(page)).destroyed).toBe(1);
  expect((await report(page)).videoLiveAfterDestroy).toBe(true);
  const samples = (await report(page)).samples;
  const before = await page.evaluate(() => (window as any).__mpCounts.pose);
  await expect.poll(() => page.evaluate(() => (window as any).__mpCounts.pose)).toBeGreaterThan(before);
  expect((await report(page)).samples).toBe(samples);
});
test('four-expression model maps official channels and retains the same camera', async ({ page }) => {
  await setup(page); await jeeliz(page); await page.getByLabel('Jeeliz model', { exact: true }).selectOption('4-expression');
  for (const [name, value] of [['Smile', '0.600'], ['Brow frown', '0.700'], ['Brow raise', '0.800']]) {
    await expect(page.locator(`[data-lab-metric="${name}"] dd`)).toHaveText(value);
  }
  expect((await report(page)).model).toBe('/models/jeeliz/NN_4EXPR_3.json');
  expect(await page.evaluate(() => (window as any).__gumCount)).toBe(1);
});
test('camera flip reacquires on the same video and starts a separate benchmark session', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('button', { name: 'Start benchmark', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Flip camera', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gumCount)).toBe(2);
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  await expect(page.getByTestId('benchmark-recording')).toContainText('Stopped');
  await expect(page.locator('.studio-calibration-guide')).toHaveCount(0);
  expect((await report(page)).reused).toBe(true); expect((await report(page)).destroyed).toBeGreaterThan(0);
  await expect(page.locator('[data-lab-metric="Yaw"] dd').first()).toContainText('unverified');
});
test('stopping the main camera disposes Jeeliz and ends upstream tracks', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await report(page)).destroyed).toBe(1);
  expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
});
test('leaving the route disposes Jeeliz and ends upstream tracks', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect.poll(async () => (await report(page)).destroyed).toBe(1);
  expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
});
test('records separate numeric summaries and clears them with Reset', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('button', { name: 'Start benchmark', exact: true }).click(); await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Stop benchmark', exact: true }).click();
  await expect(page.locator('.tracker-lab-result')).toHaveCount(1);
  await expect(page.locator('.tracker-lab-result [data-lab-metric="Exact inference ms"] dd')).toHaveText('unavailable');
  await page.getByLabel('Tracking engine', { exact: true }).selectOption('mediapipe');
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  await page.getByRole('button', { name: 'Start benchmark', exact: true }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Stop benchmark', exact: true }).click();
  await expect(page.locator('.tracker-lab-result')).toHaveCount(2);
  await page.getByRole('button', { name: 'Reset benchmark' }).click(); await expect(page.locator('.tracker-lab-result')).toHaveCount(0);
});
test('measures pose conventions empirically from all physical captures', async ({ page }) => {
  await setup(page); await jeeliz(page);
  for (const [label, rotation] of [
    ['Neutral', [0, 0, 0]], ['Turn physical right', [0, 0, .5]], ['Turn physical left', [0, 0, -.5]],
    ['Look up', [.4, 0, 0]], ['Look down', [-.4, 0, 0]], ['Tilt right', [0, -.4, 0]], ['Tilt left', [0, .4, 0]],
  ] as const) {
    await page.evaluate(rotation => { (window as any).__labJeeliz.rotation = rotation; }, rotation);
    await page.waitForTimeout(1200); await page.getByRole('button', { name: `Capture ${label}`, exact: true }).click();
  }
  await expect(page.getByTestId('measured-pose-mapping')).toContainText('yaw = −rz delta');
  await expect(page.locator('[data-lab-metric="Yaw"] dd')).not.toContainText('unverified');
});
test('hidden tab disposes Jeeliz and visible tab reinitializes without another camera request', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Paused');
  await expect.poll(async () => (await report(page)).destroyed).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  expect(await page.evaluate(() => (window as any).__gumCount)).toBe(1);
});
test('missing local model shows a controlled error and leaves Studio usable', async ({ page }) => {
  await setup(page); await page.route('**/models/jeeliz/NN_DEFAULT.json', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.getByLabel('Tracking engine', { exact: true }).selectOption('jeeliz');
  await expect(page.getByTestId('tracker-lab-status')).toHaveText('Failed');
  await expect(page.getByRole('alert')).toContainText('model unavailable');
  await page.getByRole('button', { name: 'Close Tracker Lab' }).click();
  await expect(page.getByRole('button', { name: 'Pause tracking', exact: true })).toBeEnabled();
});
test('rapid provider changes never leave an orphan Jeeliz callback loop', async ({ page }) => {
  await setup(page); await jeeliz(page);
  for (let i = 0; i < 3; i++) {
    await page.getByLabel('Tracking engine', { exact: true }).selectOption('mediapipe');
    await page.getByLabel('Tracking engine', { exact: true }).selectOption('jeeliz');
  }
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
  await page.getByRole('button', { name: 'Close Tracker Lab' }).click();
  await expect.poll(async () => { const r = await report(page); return r.initialized - r.destroyed; }).toBe(0);
});
test('all requested mobile widths stay within the page while diagnostics and summaries are expanded', async ({ page }) => {
  await setup(page); await jeeliz(page);
  await page.getByRole('button', { name: 'Start benchmark', exact: true }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Stop benchmark', exact: true }).click();
  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `${width}px page overflow` }).toBeLessThanOrEqual(1);
    expect(await page.locator('.tracker-lab').evaluate(el => el.scrollWidth - el.clientWidth), `${width}px lab overflow`).toBeLessThanOrEqual(1);
  }
});
test('official installed module initializes both local models with real WebGL and preserves upstream camera on destroy', async ({ page }) => {
  await setup(page, false);
  for (const model of ['default', '4-expression']) {
    await page.getByLabel('Tracking engine', { exact: true }).selectOption('jeeliz');
    if (model === '4-expression') await page.getByLabel('Jeeliz model', { exact: true }).selectOption(model);
    await expect(page.getByTestId('tracker-lab-status')).toContainText('Running', { timeout: 60000 });
    await expect.poll(() => page.locator('[data-lab-metric="Callback FPS"] dd').innerText()).not.toBe('0');
    await page.getByLabel('Tracking engine', { exact: true }).selectOption('mediapipe');
    await expect(page.getByTestId('tracker-lab-status')).toContainText('Running');
    expect(await page.evaluate(() => (document.querySelector('.studio-video') as HTMLVideoElement).srcObject instanceof MediaStream && ((document.querySelector('.studio-video') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].readyState === 'live')).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).__gumCount)).toBe(1);
  await page.getByLabel('Tracking engine', { exact: true }).selectOption('jeeliz');
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running', { timeout: 60000 });
  await page.getByRole('button', { name: 'Flip camera', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gumCount)).toBe(2);
  await expect(page.getByTestId('tracker-lab-status')).toContainText('Running', { timeout: 60000 });
  await expect.poll(() => page.locator('[data-lab-metric="Callback FPS"] dd').innerText()).not.toBe('0');
});
