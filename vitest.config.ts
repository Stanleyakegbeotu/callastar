import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Test configuration, deliberately separate from `vite.config.ts`.
 *
 * The app's Vite config carries the Figma Make plugins — a site-configuration
 * transform, an error-overlay replay, a stories harness — none of which a test
 * run needs, and one of which serves HTML. Reusing it would drag all of that
 * into every test process. This file declares only what tests actually require:
 * the `@` alias, and where the test files are.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Node by default. The suites that need a DOM say so per-file with a
    // `@vitest-environment` docblock, so a pure reducer test does not pay for
    // one. `services/**` and the signalling protocol are plain TypeScript.
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Playwright owns the browser-level suites and has its own runner.
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    // The signalling integration suite spawns a real server and drives real
    // sockets, so it is allowed longer than a unit test.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
