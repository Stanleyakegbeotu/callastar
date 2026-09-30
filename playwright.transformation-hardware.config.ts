import { defineConfig, devices } from "@playwright/test";

const port = 5202;

/**
 * The hardware benchmark.
 *
 * Deliberately separate from `playwright.transformation.config.ts`, which
 * forces `--use-angle=swiftshader` so the engine proofs are reproducible on a
 * machine with no usable GPU. Numbers measured under a software rasteriser say
 * more about the CI box than about a phone, so they are not baselines and the
 * milestone reports say so.
 *
 * This config forces nothing and lets the browser choose. That is not the same
 * as guaranteeing hardware acceleration — headless Chromium often falls back to
 * SwiftShader anyway — so the benchmark reads `UNMASKED_RENDERER_WEBGL` and
 * prints it beside every timing. A number without the renderer that produced it
 * is not a measurement.
 *
 * Run headed for a real GPU:
 *   pnpm test:transformation:benchmark -- --headed
 */
export default defineConfig({
  testMatch: "transformation-benchmark.browser.spec.ts",
  testDir: "./tests",
  timeout: 300_000,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    // No GL flags. The fake camera is still needed: the benchmark measures the
    // pipeline, and waiting for somebody to sit in front of a webcam is not a
    // benchmark.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5202 --strictPort",
    port,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { PORT: String(port) },
  },
});
