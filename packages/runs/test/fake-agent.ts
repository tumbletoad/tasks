// The fake agent program. How it behaves, and how to start it: fake-agents.ts.
import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FAKE_AGENT_GUARD_EXIT, replayPlan, type FakeAgentReport } from "./fake-agents.ts";
import { fixtureBytes, fixtureEntry } from "./fixtures.ts";

// Where it started, read through `.` before anything else: the directory it was started in.
const startedIn = statSync(".", { bigint: true });

const split = process.argv.indexOf("--", 2);
const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
const agentArgv = split === -1 ? [] : process.argv.slice(split + 1);
const fail = (why: string): never => {
  process.stderr.write(`fake-agent: ${why}\n`);
  process.exit(2);
};
const parse = () => {
  try {
    return parseArgs({
      args: own,
      options: {
        fixture: { type: "string" },
        "line-delay-ms": { type: "string", default: "0" },
        "max-ms": { type: "string", default: "60000" },
        report: { type: "string" },
      },
      strict: true,
    });
  } catch {
    return fail("bad options");
  }
};
const { values } = parse();
const fixture = values.fixture ?? fail("--fixture is required");
const delay = Number(values["line-delay-ms"]);
const maxMs = Number(values["max-ms"]);
if (!Number.isInteger(delay) || delay < 0) fail("--line-delay-ms must be a whole number");
if (!Number.isInteger(maxMs) || maxMs <= 0) fail("--max-ms must be a positive whole number");

const load = () => {
  try {
    const entry = fixtureEntry(fixture);
    return { entry, plan: replayPlan(entry, fixtureBytes(fixture)) };
  } catch {
    return fail("unknown fixture");
  }
};
const { entry, plan } = load();
// A reader that went away is not the fake's problem: the exit still follows the recording.
process.stdout.on("error", () => undefined);

// No fake outlives its test.
const guard = setTimeout(() => process.exit(FAKE_AGENT_GUARD_EXIT), maxMs);

let cancelled = false;
let wake: (() => void) | undefined;
if (plan.graceful !== null && (plan.graceful !== "SIGBREAK" || process.platform === "win32")) {
  process.on(plan.graceful, () => {
    if (cancelled) return;
    cancelled = true;
    wake?.();
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms === 0) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

const write = (chunk: Uint8Array): Promise<void> =>
  new Promise((resolve) => {
    process.stdout.write(chunk, () => {
      resolve();
    });
  });

async function writeLines(from: number, to: number, stopOnCancel: boolean): Promise<void> {
  for (let i = from; i < to; i += 1) {
    if (stopOnCancel && cancelled) return;
    if (i > from) await sleep(delay);
    if (stopOnCancel && cancelled) return;
    const line = plan.lines[i];
    if (line !== undefined) await write(line);
  }
}

/** Exits with `code` once stdout is flushed. */
function finish(code: number): void {
  clearTimeout(guard);
  process.exitCode = code;
  process.stdin.destroy();
}

async function main(): Promise<void> {
  // 1. The brief: read to its end, kept only as a size and a hash.
  const hash = createHash("sha256");
  let stdinBytes = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    hash.update(chunk);
    stdinBytes += chunk.length;
  }
  if (values.report !== undefined) {
    const report: FakeAgentReport = {
      argv: agentArgv,
      cwd: process.cwd(),
      cwdId: `${startedIn.dev.toString()}:${startedIn.ino.toString()}`,
      envNames: Object.keys(process.env).sort(),
      stdinBytes,
      stdinSha256: hash.digest("hex"),
    };
    writeFileSync(values.report, JSON.stringify(report));
  }
  // 2. A fixed stderr line: the recordings keep only a class for stderr.
  if (entry.stderr_class !== "none") process.stderr.write(`fake-agent: ${entry.stderr_class}\n`);

  // 3. The replay.
  if (plan.holdAt === null) {
    await writeLines(0, plan.lines.length, false);
    finish(plan.exitCode ?? 1);
    return;
  }
  await writeLines(0, plan.holdAt, true);
  if (!cancelled) {
    // 4. Hold where the run was cancelled or killed, until the signal or the kill.
    if (plan.graceful === null) return;
    await new Promise<void>((resolve) => {
      if (cancelled) resolve();
      else wake = resolve;
    });
  }
  await writeLines(plan.holdAt, plan.lines.length, false);
  finish(plan.exitCode ?? 1);
}

void main();
