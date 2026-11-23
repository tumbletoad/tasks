// The environment of every TTasks process a test starts with a clean environment: a service, the
// CLI, a shim, the bridge, an install script or a program it installed. One place, so no launcher
// can forget a part: every TTasks variable and agent app variable of the shell that runs the tests
// is removed (a test run inside an agent app must not make every call an agent's), and the Agent
// Monitor named is a file that does not exist, so no service a test starts runs the `ttam` of the
// machine. A test of the monitor names the test kit's fake in `extra`.
import { ENV_PREFIX, envVar } from "@ttasks/brand";
import { isAgentMarker } from "@ttasks/bridge/protocol";
import { NO_MONITOR } from "./no-monitor.ts";

const AGENT_APP = /^(CLAUDE|CODEX_|T3CODE_)/iu;

/**
 * This process's environment without any TTasks or agent app variable, with no Agent Monitor, then
 * `extra`: an undefined value removes a name, and on Windows names compare without case.
 */
export function testEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const windows = process.platform === "win32";
  const key = (name: string) => (windows ? name.toUpperCase() : name);
  const given: Readonly<Record<string, string | undefined>> = {
    [envVar("MONITOR")]: NO_MONITOR,
    ...extra,
  };
  const replaced = new Set(Object.keys(given).map(key));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      name.toUpperCase().startsWith(ENV_PREFIX) ||
      isAgentMarker(name) ||
      AGENT_APP.test(name) ||
      replaced.has(key(name))
    ) {
      continue;
    }
    env[name] = value;
  }
  for (const [name, value] of Object.entries(given)) if (value !== undefined) env[name] = value;
  return env;
}
