// `pnpm e2e [--project chromium|firefox]`: Playwright against the real service process, with
// Playwright's own browsers (`pnpm exec playwright install chromium firefox`). Each worker starts its
// own service in a temporary TTASKS_HOME with fixture data (world.ts); the page is built once per run
// (global-setup.ts). Screenshots the tests take go to tests/e2e/results/ (git-ignored).
//
// In CI a failure keeps its trace and screenshot, and the HTML report in tests/e2e/report/ shows
// them: the workflow uploads both folders when the run fails.
import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1440, height: 900 };
const ci = process.env["CI"] === "true";

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
  reporter: ci ? [["list"], ["html", { open: "never", outputFolder: "./report" }]] : [["list"]],
  use: {
    trace: ci ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
  ],
});
