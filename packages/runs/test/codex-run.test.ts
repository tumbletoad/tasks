// Codex runs end to end in the run host, with real processes: the fake app server
// (codex-server.ts) installed as npm installs Codex, behind a `.cmd` shim on Windows and a link on
// Linux and macOS, resolved before it starts, in a job object on Windows and without a process
// group everywhere. What is alive is counted from the operating system (the stand-in census).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDurable, MemoryExecutionStore } from "@tasks/launch/memory-store";
import { nodeDetectHost, resolveProgram } from "@tasks/launch";
import { afterAll, beforeAll, describe, expect, test, type TestContext } from "vitest";
import {
  CODEX_ARGS,
  codexDriver,
  RunHost,
  RunMachine,
  sameFolder,
  UngroupedContainers,
  WindowsContainers,
  type Containers,
  type RunFolders,
  type SavedAnswer,
} from "../src/index.ts";
import type { FakeScenario } from "./codex-server.ts";
import { MODEL_LIMITS } from "./host-world.ts";
import { buildNatives, type Natives } from "./stand-ins/native.ts";
import { census, newToken, waitForCensus } from "./stand-ins/stand-ins.ts";

const windows = process.platform === "win32";
const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8a7";
const SERVER = join(import.meta.dirname, "codex-server.ts");

let work = "";
let natives: Natives | undefined;
/** The fake's program as a run starts it, resolved from its shim. */
let program: { command: string; args: readonly string[] } | undefined;

/**
 * The npm layout of Codex with the fake in place of its entry: `codex.cmd` beside
 * `node_modules/@openai/codex/bin/codex.js` on Windows, a link `codex` to it elsewhere. The entry,
 * as Codex's own does on Windows, starts the server as its child with the same stdio.
 */
function installFake(prefix: string): string {
  const entry = join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      'import { spawn } from "node:child_process";',
      "const scenario = JSON.parse(process.env.FAKE_CODEX_SCENARIO ?? '{}');",
      `const child = spawn(process.execPath, [${JSON.stringify(SERVER)}, "--token=" + (scenario.token ?? "none")], { stdio: "inherit" });`,
      'for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));',
      'child.on("exit", (code) => process.exit(code ?? 1));',
      "",
    ].join("\n"),
  );
  // npm installs a package's bin script executable: a run's program is looked for as one.
  chmodSync(entry, 0o755);
  writeFileSync(
    join(prefix, "node_modules", "@openai", "codex", "package.json"),
    '{"type":"module"}',
  );
  if (windows) {
    const shim = join(prefix, "codex.cmd");
    writeFileSync(shim, "@echo This shim is never run.\r\n");
    return shim;
  }
  const link = join(prefix, "codex");
  symlinkSync(entry, link);
  return link;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-codex-run-"));
  if (windows) natives = buildNatives(join(work, "bin"));
  const prefix = join(work, "npm");
  mkdirSync(prefix);
  const shim = installFake(prefix);
  const path = [prefix, dirname(process.execPath)].join(windows ? ";" : ":");
  const host = nodeDetectHost({ env: { PATH: path }, home: work });
  const resolved = resolveProgram(host, shim, [], "codex-cli");
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

/** Queues and starts one Codex run of `scenario`; resolves with its ID once it started. */
async function startRun(
  b: ReturnType<typeof bench>,
  scenario: FakeScenario,
  label: string,
): Promise<string> {
  const queued = await b.machine.queue(
    {
      task: "t_0000000000000000000000000a",
      routine: null,
      instance: "codex",
      adapter: "codex",
      place: null,
      request: "Look into the export.",
      briefHash: "0a1b2c3d".repeat(8),
      permission: "full-access",
      limits: MODEL_LIMITS,
    },
    `codex-run-${label}`,
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env["FAKE_CODEX_SCENARIO"] = JSON.stringify(scenario);
  await b.host.start(queued.id, () => ({
    command: program?.command ?? "",
    args: [...(program?.args ?? []), ...CODEX_ARGS],
    cwd: work,
    env,
    open: codexDriver({
      request: "Look into the export.",
      permission: "full-access",
      inFolder: sameFolder(work),
    }),
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

describe("[A4.3.11.codex.run] a Codex run in the run host: the program resolved from its shim gets its stdin, its interrupt and its process group, and both results are kept", () => {
  for (const [kind, make] of kinds) {
    const grouped = kind === "in a job object";
    test(`${kind}: start to answer, and nothing of it is left`, async () => {
      const token = newToken();
      const b = bench(make());
      const id = await startRun(
        b,
        { fixture: "windows-plain", token, answer: "Done." },
        `a-${token}`,
      );
      const after = await b.host.ended(id);
      expect(after).toMatchObject({
        state: "succeeded",
        result: {
          text: "Done.",
          textFinal: true,
          nativeId: "00000000-0000-4000-8000-000000000002",
          cleanup: grouped ? "confirmed" : "ended_found",
        },
      });
      expect(census(token)).toEqual([]);
    });

    test(`${kind}: Stop during a turn interrupts it over the protocol, and the run is cancelled`, async () => {
      const token = newToken();
      const b = bench(make());
      const id = await startRun(b, { fixture: "windows-interrupt", token }, `s-${token}`);
      await waitForCensus(token, (pids) => pids.length === 1);
      expect((await b.host.stop(id))?.state).toBe("cancelling");
      const after = await b.host.ended(id);
      expect(after).toMatchObject({ state: "cancelled", result: { outcome: "interrupted" } });
      expect(census(token)).toEqual([]);
    });

    test(`${kind}: Stop while the app server will not end after its work waits for nothing`, async () => {
      const token = newToken();
      const b = bench(make(), { closeMs: 60_000 });
      const id = await startRun(
        b,
        { fixture: "windows-plain", token, ignoreEnd: true },
        `c-${token}`,
      );
      // Settled and closed, the server stays: the host waits for it to end by itself.
      await waitForCensus(token, (pids) => pids.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const t0 = performance.now();
      await b.host.stop(id);
      const after = await b.host.ended(id);
      expect(performance.now() - t0).toBeLessThan(30_000);
      expect(after?.state).toBe("cancelled");
      expect(after?.result).toMatchObject({ ok: true, outcome: "success" });
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

    test(`${kind}: a process the agent left in its own group after it exited is ended`, async (ctx: TestContext) => {
      // On Windows a process tree of Node ends with its parent, so nothing would be left to end.
      if (windows) ctx.skip("Linux and macOS: what is left in the agent's process group");
      const token = newToken();
      const b = bench(make());
      const id = await startRun(
        b,
        { fixture: "windows-command", token, leave: "in-group", answer: "Left one running." },
        `g-${token}`,
      );
      const after = await b.host.ended(id);
      expect(after).toMatchObject({ state: "succeeded", result: { text: "Left one running." } });
      await waitForCensus(token, (pids) => pids.length === 0);
    });
  }

  test("Windows: Ctrl+C reaches the app server behind the shim, through Node's own wrapper", async (ctx) => {
    if (!windows) ctx.skip("a console's Ctrl+C is Windows'");
    const token = newToken();
    const box = new WindowsContainers({ helper: natives?.helper ?? "" });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    env["FAKE_CODEX_SCENARIO"] = JSON.stringify({
      fixture: "windows-plain",
      token,
      ignoreEnd: true,
    });
    const name = `codex-${token}`;
    const contained = await box.start({
      name,
      command: program?.command ?? "",
      args: [...(program?.args ?? []), ...CODEX_ARGS],
      cwd: work,
      env,
    });
    contained.stdout.resume();
    contained.stderr.resume();
    await waitForCensus(token, (pids) => pids.length === 1);
    expect(await box.interrupt(name)).toBe(true);
    await waitForCensus(token, (pids) => pids.length === 0);
    await contained.exited;
    expect(await box.confirmEmpty(name, { waitMs: 10_000 })).toEqual({ state: "empty" });
  });
});
