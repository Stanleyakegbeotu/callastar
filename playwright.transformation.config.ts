import { defineConfig, devices } from "@playwright/test";

const port = 5201;

export default defineConfig({
  /*
   * The foundation smoke checks and every per-milestone engine proof — but NOT
   * the benchmark, which belongs to `playwright.transformation-hardware.config.ts`.
   *
   * The benchmark's whole purpose is to measure real hardware, and this config
   * forces a software rasteriser. Running it here spent minutes producing
   * numbers it then correctly labelled as meaningless.
   */
  testMatch: /transformation-(?!benchmark)[\w-]*\.browser\.spec\.ts$/,
  testDir: "./tests",
  // Model init plus ten inferences runs to roughly a minute under the
  // SwiftShader rasteriser this config forces; 120s left no margin on a loaded
  // machine. The assertions are unchanged.
  timeout: 300_000,
  workers: 1,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    /*
     * Software GL, and a synthetic camera.
     *
     * SwiftShader makes the inference timings reproducible on a machine with no
     * usable GPU — and makes them useless as device baselines, which is why no
     * test here asserts a frame rate. The fake device gives `getUserMedia` a
     * real MediaStream to return; it contains a rolling pattern, not a person,
     * so no test asserts a detection either.
     */
    launchOptions: {
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5201 --strictPort",
    port,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { PORT: String(port) },
  },
});
