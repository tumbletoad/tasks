// Claude Code runs end to end in the run host, with real processes: the fake Claude Code
// (claude-fake.ts) installed as npm installs Claude Code, behind a `.cmd` shim on Windows and a
// link on Linux and macOS, resolved before it starts, in a job object on Windows and without a
// process group everywhere. What is alive is counted from the operating system (the stand-in
// census).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { nodeDetectHost, resolveProgram } from "@tasks/launch";
import { afterAll, beforeAll, describe, expect, test, type TestContext } from "vitest";
import {
  claudeArgs,
  claudeDriver,
  RunHost,
  RunMachine,
  UngroupedContainers,
  WindowsContainers,
  type Containers,
  type RunFolders,
  type SavedAnswer,
} from "../src/index.ts";
import type { FakeClaudeScenario } from "./claude-fake.ts";
import { MODEL_LIMITS } from "./host-world.ts";
import { buildNatives, type Natives } from "./stand-ins/native.ts";
import { census, newToken, waitForCensus } from "./stand-ins/stand-ins.ts";

const windows = process.platform === "win32";
const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const FAKE = join(import.meta.dirname, "claude-fake.ts");
const REQUEST = "Look at MARKREQ5C1 first.";

let work = "";
let natives: Natives | undefined;
/** The fake's program as a run starts it, resolved from its shim. */
let program: { command: string; args: readonly string[] } | undefined;

/**
 * The npm layout of Claude Code with the fake in place of its entry: `claude.cmd` beside
 * `node_modules/@anthropic-ai/claude-code/cli.js` on Windows, a link `claude` to it elsewhere. The
 * entry starts the fake as its child with the same stdio and its own arguments.
 */
function installFake(prefix: string): string {
  const entry = join(prefix, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      'import { spawn } from "node:child_process";',
      "const scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO ?? '{}');",
      `const child = spawn(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2), "--token=" + (scenario.token ?? "none")], { stdio: "inherit" });`,
      'for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));',
      'child.on("exit", (code) => process.exit(code ?? 1));',
      "",
    ].join("\n"),
  );
  chmodSync(entry, 0o755);
  writeFileSync(
    join(prefix, "node_modules", "@anthropic-ai", "claude-code", "package.json"),
    '{"type":"module"}',
  );
  if (windows) {
    const shim = join(prefix, "claude.cmd");
    writeFileSync(shim, "@echo This shim is never run.\r\n");
    return shim;
  }
  const link = join(prefix, "claude");
  symlinkSync(entry, link);
  return link;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-claude-run-"));
  if (windows) natives = buildNatives(join(work, "bin"));
  const prefix = join(work, "npm");
  mkdirSync(prefix);
  const shim = installFake(prefix);
  const path = [prefix, dirname(process.execPath)].join(windows ? ";" : ":");
  const host = nodeDetectHost({ env: { PATH: path }, home: work });
  const resolved = resolveProgram(host, shim, [], "claude-cli");
  if (!resolved.ok) throw new Error(`the fake was not resolved: ${resolved.reason}`);
  program = { command: resolved.command, args: resolved.args };
}, 300_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

function bench(containers: Containers, times: Record<string, number> = {}) {
  const store = new MemoryExecutionStore(new MemoryDurable(() => Date.UTC(2026, 10, 17)));
  const machine = new RunMachine({ store, machine: MACHINE });
  const saved = new Map<string, SavedAnswer>();
  const files: RunFolders = {
    prepare: () => undefined,
    saveAnswer: (id, answer) => saved.set(id, answer),
    readAnswer: (id) => saved.get(id),
    logs: () => ({ stdout: () => undefined, stderr: () => undefined, close: () => undefined }),
    removeTemps: () => undefined,
  };
  const host = new RunHost({ machine, containers, files, times: { stopGraceMs: 3_000, ...times } });
  return { host, machine };
}

/** Queues and starts one Claude Code run of `scenario`; resolves with its ID once it started. */
async function startRun(
  b: ReturnType<typeof bench>,
  scenario: FakeClaudeScenario,
  label: string,
): Promise<string> {
  const queued = await b.machine.queue(
    {
      task: "t_0000000000000000000000000a",
      routine: null,
      instance: "claude",
      adapter: "claude-print",
      place: null,
      request: REQUEST,
      briefHash: "0a1b2c3d".repeat(8),
      permission: "full-access",
      limits: MODEL_LIMITS,
    },
    `claude-run-${label}`,
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env["FAKE_CLAUDE_SCENARIO"] = JSON.stringify(scenario);
  await b.host.start(queued.id, () => ({
    command: program?.command ?? "",
    args: [...(program?.args ?? []), ...claudeArgs("full-access")],
    cwd: work,
    env,
    open: claudeDriver({ request: REQUEST }),
  }));
  return queued.id;
}

const kinds: [string, () => Containers][] = [
  ...(windows
    ? [
        ["in a job object", () => new WindowsContainers({ helper: natives?.helper ?? "" })] as [
          string,
          () => Containers,
        ],
      ]
    : []),
  ["without a process group", () => new UngroupedContainers()],
];

describe("[A4.3.11.claude.run] a Claude Code run in the run host: the program resolved from its shim gets its stdin, its interrupt over it and its process group, and both results are kept", () => {
  for (const [kind, make] of kinds) {
    const grouped = kind === "in a job object";
    test(`${kind}: start to answer, the request on the program's input and on no command line, and nothing of it is left`, async () => {
      const token = newToken();
      const log = join(work, `log-${token}.jsonl`);
      const b = bench(make());
      const id = await startRun(
        b,
        { fixture: "windows-plain", token, answer: "Done.", log },
        `a-${token}`,
      );
      const after = await b.host.ended(id);
      expect(after).toMatchObject({
        state: "succeeded",
        result: {
          text: "Done.",
          textFinal: true,
          nativeId: "00000000-0000-4000-8000-000000000001",
          cleanup: grouped ? "confirmed" : "ended_found",
        },
      });
      const said = readFileSync(log, "utf8");
      const [started] = said.split("\n").map((l) => (l === "" ? {} : (JSON.parse(l) as object)));
      expect(JSON.stringify(started)).not.toContain("MARKREQ5C1");
      expect(said).toContain("MARKREQ5C1");
      expect(census(token)).toEqual([]);
    });

    test(`${kind}: Stop during a turn interrupts it over the program's input, and the run is cancelled`, async () => {
      const token = newToken();
      const b = bench(make());
      const id = await startRun(b, { fixture: "windows-interrupt", token, pace: 1 }, `s-${token}`);
      await waitForCensus(token, (pids) => pids.length === 1);
      expect((await b.host.stop(id))?.state).toBe("cancelling");
      const after = await b.host.ended(id);
      expect(after).toMatchObject({ state: "cancelled", result: { outcome: "interrupted" } });
      expect(census(token)).toEqual([]);
    });

    test(`${kind}: Stop during start-up, before the program said anything, ends the run at once`, async () => {
      const token = newToken();
      const b = bench(make());
      const id = await startRun(b, { fixture: "windows-plain", token, pace: 3 }, `u-${token}`);
      expect((await b.host.stop(id))?.state).toBe("cancelling");
      const after = await b.host.ended(id);
      expect(after).toMatchObject({ state: "cancelled", result: { outcome: "interrupted" } });
      await waitForCensus(token, (pids) => pids.length === 0);
    });

    test(`${kind}: a program that does not exit after its work is ended, and the work keeps its answer`, async () => {
      const token = newToken();
      const b = bench(make(), { closeMs: 1_000 });
      const id = await startRun(
        b,
        { fixture: "windows-plain", token, ignoreEnd: true, answer: "Done." },
        `c-${token}`,
      );
      const after = await b.host.ended(id);
      expect(after).toMatchObject({
        state: "succeeded",
        result: { ok: true, outcome: "success", text: "Done." },
      });
      if (grouped) expect(after?.result?.cleanup).toBe("ended_leftovers");
      await waitForCensus(token, (pids) => pids.length === 0);
    });

    test(`${kind}: a process the agent left behind is ended, and the cleanup says so beside the work's answer`, async (ctx: TestContext) => {
      if (!grouped) ctx.skip("a detached process is beyond what Tasks can find without a group");
      const token = newToken();
      const b = bench(make());
      const id = await startRun(
        b,
        { fixture: "windows-command", token, leave: "detached", answer: "Left one running." },
        `l-${token}`,
      );
      const after = await b.host.ended(id);
      expect(after).toMatchObject({
        state: "succeeded",
        result: { text: "Left one running.", cleanup: "ended_leftovers" },
      });
      expect(census(token)).toEqual([]);
    });
  }
});
