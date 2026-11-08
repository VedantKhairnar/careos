import { defineConfig } from "@playwright/test";

/**
 * Browser tests drive the real app in real Chrome. They expect a server already running at E2E_BASE_URL, started
 * against a database you are happy to add demo data to (we use a Tiger Data fork, never the real service).
 *   E2E_BASE_URL=http://localhost:3100 E2E_SHOTS=/some/dir pnpm exec playwright test
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 240_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
