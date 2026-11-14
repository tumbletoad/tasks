// `pnpm e2e` (A7 3.3, 3.18): Playwright against the real service process, in Chromium and Firefox,
// with Playwright's own browsers (`pnpm exec playwright install chromium firefox`). Each worker
// starts its own service in a temporary TASKS_HOME with fixture data (world.ts); the page is built
// once per run into a temporary folder (global-setup.ts). Not part of `pnpm verify` (A7 3.18: UI
// steps run `pnpm e2e` beside it); `pnpm verify` checks every test here against the manifest.
//
//   pnpm e2e [--project chromium|firefox]
//
// Screenshots go to tests/e2e/results/ (git-ignored), for the agent to look at (A7 3.18).
import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  outputDir: "./results",
  globalSetup: "./global-setup.ts",
  // Each worker starts a service and opens spaces: generous bounds for a loaded machine.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 2,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
  ],
});
