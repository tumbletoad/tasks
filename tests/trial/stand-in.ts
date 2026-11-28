// The trial's stand-in agent: the run tests' fake Claude Code (packages/runs/test/claude-fake.ts),
// replaying a recorded exchange whose tool call becomes the calls the trial scripted for this run.
// The calls go to TTasks's tools for real, through the server the run's `--mcp-config` names. The
// trial writes the script just before it starts the run, in the file TRIAL_STAND_IN names, under
// the slot TRIAL_STAND_IN_SLOT gives this instance (two runs at once take two slots).
import { readFileSync } from "node:fs";
import type { ToolCall } from "../../packages/runs/test/codex-server.ts";
import { serveClaude } from "../../packages/runs/test/claude-fake.ts";

type Json = Record<string, unknown>;

interface Slot {
  readonly calls: readonly ToolCall[];
  /** The trial's TTasks home, where the run's tools find the service. */
  readonly home: string;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** TTasks's server as the `--mcp-config` file among `args` names it. */
function tasksServer(args: readonly string[]): Json | undefined {
  const at = args.indexOf("--mcp-config");
  const file = at === -1 ? undefined : args[at + 1];
  if (file === undefined) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const servers = isObject(parsed) ? parsed["mcpServers"] : undefined;
  const tasks = isObject(servers) ? servers["ttasks"] : undefined;
  return isObject(tasks) ? tasks : undefined;
}

const plan = JSON.parse(readFileSync(process.env["TRIAL_STAND_IN"] ?? "", "utf8")) as Record<
  string,
  Slot
>;
const slot = plan[process.env["TRIAL_STAND_IN_SLOT"] ?? "a"];
if (slot === undefined) throw new Error("the trial left no script for this stand-in");
// Never outlives five minutes, whatever happens to its input.
setTimeout(() => process.exit(124), 300_000).unref();
const fake = serveClaude(
  process.stdin,
  process.stdout,
  { fixture: "windows-tool", answer: "Done.", callTool: { calls: slot.calls, home: slot.home } },
  tasksServer(process.argv.slice(2)),
);
process.exit(await fake.done);
