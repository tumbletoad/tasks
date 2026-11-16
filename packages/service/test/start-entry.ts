// A person's terminal that runs `tasks service start` on Linux (A2 3.3.3), for
// install-manual.test.ts: the real startService over the real service, with a user manager played
// by the recorder (install-fakes.ts) and no unit of this install in the test's unit folder. It
// prints the outcome as one JSON line and then waits to be ended, as a terminal's shell does, so
// the test can hang up its whole process group. Tests only.
//
// Usage: start-entry.ts <TASKS_HOME> <program> <unit folder> <home folder>
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@tasks/bridge/safe-exit";
import { isAgentMarker } from "@tasks/bridge/protocol";
import { startService } from "../src/install/commands.ts";
import { defaultServiceContext } from "../src/install/context.ts";
import { FakeService, FakeTools } from "./install-fakes.ts";

const [root = "", program = "", unitDir = "", home = ""] = process.argv.slice(2);
const env: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (!isAgentMarker(name) && !name.toUpperCase().startsWith("TASKS_")) env[name] = value;
}
const real = defaultServiceContext({ env: { ...env, TASKS_HOME: root }, program });
const tools = new FakeTools(new FakeService(), unitDir, { userManager: true });
const outcome = await startService({
  ...real,
  home,
  run: tools.run,
  roots: { ...real.roots, unitDir },
});
process.stdout.write(
  `${JSON.stringify({ outcome: outcome.outcome, via: outcome.via, unit: outcome.unit ?? null, pid: outcome.status.pid })}\n`,
);
// A terminal's shell: it stays until it is ended.
setInterval(() => undefined, 60_000);
