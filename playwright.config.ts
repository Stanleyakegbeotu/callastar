import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests for real-time calling.
 *
 * These exist because the guest and the host are two separate browsers, and no
 * amount of unit testing proves that two browsers actually negotiate with each
 * other. Each test drives two isolated contexts through the real signalling
 * service and real `RTCPeerConnection`s.
 *
 * Deliberately on its own port. A CallaStar dev server is usually already
 * running on 8443 without the live-calling environment set, and `strictPort`
 * means a second instance there would simply fail.
 */

/** Both servers this suite starts, kept together so nothing drifts apart. */
const WEB_PORT = 5199;
const SIGNALING_PORT = 8793;

/** Test-only secrets, long enough for the service's own refusal-to-start check. */
const TOKEN_SECRET = "playwright-token-secret-".padEnd(64, "0");
const HOST_SECRET = "playwright-host-secret-".padEnd(64, "0");

export const E2E = {
  baseURL: `http://127.0.0.1:${WEB_PORT}`,
  signalingUrl: `ws://127.0.0.1:${SIGNALING_PORT}`,
  hostToken: HOST_SECRET,
} as const;

export default defineConfig({
  testDir: "./tests/e2e",
  // A two-party call test coordinates two browsers over a real socket; that is
  // slower than a page assertion and should not be mistaken for a hang.
  timeout: 240_000,
  expect: { timeout: 60_000 },
  // Two contexts per test already saturate the media stack; running files in
  // parallel on top of that produces flake, not speed.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],

  use: {
    baseURL: E2E.baseURL,
    trace: "retain-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // Synthetic camera and microphone, and no permission dialog to
            // click. Without these there is no media to negotiate in CI.
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // Lets the two contexts reach each other without a STUN server.
            "--allow-loopback-in-peer-connection",
            // Deliberately NOT passing
            // --unsafely-treat-insecure-origin-as-secure: 127.0.0.1 is already a
            // secure context in Chrome, and that flag puts the origin in an
            // isolated context where IndexedDB is denied — which breaks the very
            // Call ID lookup these tests depend on.
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],

  webServer: [
    {
      command: "node src/index.ts",
      cwd: "./server/signaling",
      port: SIGNALING_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        SIGNALING_PORT: String(SIGNALING_PORT),
        SIGNALING_HOST: "127.0.0.1",
        SIGNALING_TOKEN_SECRET: TOKEN_SECRET,
        SIGNALING_HOST_SECRET: HOST_SECRET,
        /*
         * The web app and the service are different origins, so the guest's
         * authorize request is cross-origin and needs this. Without it the
         * browser blocks the POST and the caller is told CallaStar was
         * unreachable — correctly, but for a reason that is a misconfiguration
         * rather than an absent host. Every real deployment needs this set too.
         */
        SIGNALING_ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`,
        SIGNALING_PRESENCE_TIMEOUT_MS: "300000",
        SIGNALING_RING_TIMEOUT_MS: "180000",
        SIGNALING_AUTHORIZE_PER_MINUTE: "500",
        SIGNALING_CONNECTIONS_PER_MINUTE: "500",
      },
    },
    {
      command: "pnpm vite",
      port: WEB_PORT,
      // Vite can take well over a minute to boot on a loaded machine; the
      // default 60s turns that into a confusing "server never started".
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PORT: String(WEB_PORT),
        VITE_ADMIN_DATA_MODE: "local",
        VITE_ADMIN_AUTH_MODE: "development",
        VITE_CALL_BACKEND: "local",
        VITE_SIGNALING_URL: `ws://127.0.0.1:${SIGNALING_PORT}`,
        VITE_SIGNALING_HOST_TOKEN: HOST_SECRET,
        // The subscription checkpoint would otherwise end the call partway
        // through. Long enough that these tests finish before it fires.
        VITE_SUBSCRIPTION_PREVIEW_MS: "600000",
        VITE_SUBSCRIPTION_CHECK_MS: "600000",
        /*
         * Generous product deadlines, so a slow machine walking the UI is never
         * racing a timer that exists for real operators. The behaviour under a
         * short deadline is covered by the service integration suite, which can
         * drive it precisely without a browser in the way.
         */
        VITE_SOURCE_SELECTION_MS: "180000",
        VITE_RING_TIMEOUT_MS: "180000",
      },
    },
  ],
});
