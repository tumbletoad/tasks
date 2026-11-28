// `pnpm e2e [--project chromium|firefox]`: Playwright against the real service process, with
// Playwright's own browsers (`pnpm exec playwright install chromium firefox`). Each test file gets
// its own service in a temporary TTASKS_HOME with fixture data (world.ts, fixture.ts); the page is
// built once per run (global-setup.ts). Screenshots the tests take go to tests/e2e/results/ (git-ignored).
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
  // Each file starts a service and opens spaces: generous bounds for a loaded machine.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // Every file has its own service, home, port, pipe and fakes, and every worker its own browser:
  // files share nothing but the built page. CI's runners have 4 processors.
  workers: ci ? 4 : 8,
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
    // A test tagged @one-browser is about the service, a process or the fake terminal, not the
    // engine. What a second engine could do differently (keys, input methods, focus, layout,
    // storage, the CSP, the width checks) has tests of its own in both. The screens tests take
    // their pictures, axe scans and second theme in Chromium only (page.ts, `pictures`).
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport },
      grepInvert: /@one-browser/,
    },
  ],
});
