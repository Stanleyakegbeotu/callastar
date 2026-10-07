import { defineConfig, devices } from "@playwright/test";
const port = 5215;
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "production-stability.spec.ts",
  workers: 1, timeout: 60_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  // HTTP fixtures must not be bypassed by browser-owned worker requests.
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", serviceWorkers: "block" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `pnpm build && pnpm vite preview --port ${port} --strictPort`,
    port, reuseExistingServer: false, timeout: 300_000,
    env: {
      VITE_SUPABASE_URL: `http://127.0.0.1:${port}`,
      VITE_SUPABASE_ANON_KEY: "production-stability-fixture-key",
      VITE_ADMIN_DATA_MODE: "supabase", VITE_CALL_BACKEND: "supabase",
      VITE_SIGNALING_URL: "", VITE_SIGNALING_HOST_TOKEN: "", VITE_SIGNALING_TRANSPORT: "websocket",
    },
  },
});
