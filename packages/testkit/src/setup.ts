// Runs first in every Vitest worker (vitest.config.ts, `setupFiles`). On Linux it puts a stand-in
// `systemd-run` (packages/testkit/stand-ins/) first on PATH, which every process a test starts
// inherits, so no service a test starts reaches the person's user manager through the real one:
// the service probes for scopes when it launches a terminal and when `tasks doctor` asks
// (`doctor/launch`, A4 3.7). A test that wants to see those calls puts its own stand-in before this
// one, or passes a fake through the launch service's seams (`FAKE_SYSTEMD_RUN`).
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  // From the string, never through the global URL: a DOM test's environment replaces that.
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "stand-ins");
  const path = process.env["PATH"] ?? "";
  if (!path.split(delimiter).includes(bin)) process.env["PATH"] = `${bin}${delimiter}${path}`;
}
