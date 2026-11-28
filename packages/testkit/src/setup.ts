// Runs first in every Vitest worker (vitest.config.ts, `setupFiles`). On Linux it puts a stand-in
// `systemd-run` (packages/testkit/stand-ins/) first on PATH, which every process a test starts
// inherits, so no service a test starts reaches the person's user manager through the real one:
// the service probes for scopes when it launches a terminal and when `ttasks doctor` asks
// (`doctor/launch`). A test that wants to see those calls puts its own stand-in before this
// one, or passes a fake through the launch service's seams (`FAKE_SYSTEMD_RUN`).
//
// It also names an Agent Monitor that does not exist, so no service a test starts in its own
// process runs the `ttam` of the machine the tests run on (a child started with a clean
// environment gets the same from testEnv). A test of the monitor starts the test kit's fake.
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar } from "@ttasks/brand";
import { NO_MONITOR } from "./no-monitor.ts";

process.env[envVar("MONITOR")] = NO_MONITOR;

if (process.platform === "linux") {
  // From the string, never through the global URL: a DOM test's environment replaces that.
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "stand-ins");
  const path = process.env["PATH"] ?? "";
  if (!path.split(delimiter).includes(bin)) process.env["PATH"] = `${bin}${delimiter}${path}`;
}
