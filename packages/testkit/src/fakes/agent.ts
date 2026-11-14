// A fake interactive agent (A4 3.6.3 step 6; M2.09): what a launch's shim starts in place of
// Claude Code or Codex. At its start it writes a report: its argv after `--` exactly as it got it,
// the working folder it started in (as a path, and as the identity of the directory it holds,
// read through `.`), and its environment's names. Then it runs until FAKE_AGENT_RELEASE (a file
// path in its options) exists, or for `--hold-ms`, and exits with `--exit` (default 0). Its stdin
// is never read, so it runs the same in a terminal, under a fake one or with stdin closed.
// No fake outlives its test: `--max-ms` ends it.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** What the fake agent writes to its report file. */
export interface InteractiveAgentReport {
  readonly argv: string[];
  readonly cwd: string;
  /** `<dev>:<ino>` of the directory it started in, read through `.`. */
  readonly cwdId: string;
  readonly envNames: string[];
}

const startedIn = statSync(".", { bigint: true });
const split = process.argv.indexOf("--", 2);
const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
const agentArgv = split === -1 ? [] : process.argv.slice(split + 1);
const { values } = parseArgs({
  args: own,
  options: {
    report: { type: "string" },
    release: { type: "string" },
    "hold-ms": { type: "string", default: "0" },
    "max-ms": { type: "string", default: "120000" },
    exit: { type: "string", default: "0" },
  },
  strict: true,
});
if (values.report !== undefined) {
  const report: InteractiveAgentReport = {
    argv: agentArgv,
    cwd: process.cwd(),
    cwdId: `${startedIn.dev.toString()}:${startedIn.ino.toString()}`,
    envNames: Object.keys(process.env).sort(),
  };
  writeFileSync(values.report, JSON.stringify(report));
}
const code = Number(values.exit);
const started = Date.now();
const hold = Number(values["hold-ms"]);
const max = Number(values["max-ms"]);
const timer = setInterval(() => {
  const ran = Date.now() - started;
  const released = values.release !== undefined && existsSync(values.release);
  if (ran >= max || (values.release === undefined && ran >= hold) || released) {
    clearInterval(timer);
    process.exit(code);
  }
}, 25);
