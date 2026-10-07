import { defineConfig, devices } from "@playwright/test";

const port = 5210;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "support-automation.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(port),
      VITE_ADMIN_DATA_MODE: "local",
      VITE_ADMIN_AUTH_MODE: "development",
      VITE_CALL_BACKEND: "local",
    },
  },
});
