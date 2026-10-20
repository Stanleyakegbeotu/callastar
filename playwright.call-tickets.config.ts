import { defineConfig, devices } from "@playwright/test"
const port = 5222
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "call-tickets.spec.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `pnpm.cmd exec vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      VITE_SUPABASE_URL: `http://127.0.0.1:${port}`,
      VITE_SUPABASE_ANON_KEY: "ticket-test-fixture",
      VITE_ADMIN_DATA_MODE: "supabase",
      VITE_CALL_BACKEND: "supabase",
      VITE_ADMIN_AUTH_MODE: "development",
      VITE_SIGNALING_URL: "ws://127.0.0.1:1",
      VITE_DEV_SIGNALING_PROXY: "false",
      VITE_SIGNALING_HOST_TOKEN: "",
    },
  },
})
