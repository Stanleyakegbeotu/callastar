import { defineConfig, devices } from "@playwright/test"

const WEB_PORT = 5212

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "admin-login.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm vite --port ${WEB_PORT} --strictPort`,
    port: WEB_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(WEB_PORT),
      VITE_SUPABASE_URL: `http://127.0.0.1:${WEB_PORT}`,
      VITE_SUPABASE_ANON_KEY: "admin-login-browser-test-key",
      VITE_ADMIN_DATA_MODE: "supabase",
      VITE_ADMIN_AUTH_MODE: "supabase",
      VITE_CALL_BACKEND: "local",
      VITE_SIGNALING_URL: "",
      VITE_SIGNALING_HOST_TOKEN: "",
    },
  },
})
