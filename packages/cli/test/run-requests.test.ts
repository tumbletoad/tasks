// What `ttasks run` sends: the person's words from --input as from an argument, and the space they
// chose on every request of the verb, also while --wait looks at the run and the default changes.
// Two fixture spaces hold a task with the same reference, so a run sent to the wrong one shows.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "@ttasks/brand";
import { startService, type RunningService } from "@ttasks/service/hub";
import {
  instanceToml,
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
} from "@ttasks/service/test/harness";
import { classSession } from "@ttasks/service/test/ops-helpers";
import { newId, type Id } from "@ttasks/storage";
import { seedMira } from "@ttasks/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Session } from "../src/connect.ts";
import { described } from "../src/runs.ts";
import { BIN, runMain } from "./cli-harness.ts";

const windows = process.platform === "win32";
const SERVER = fileURLToPath(new URL("../../runs/test/codex-server.ts", import.meta.url));
const REQUEST = "Check the export against MARKINP5T2.";

let root = "";
let home = "";
let cleanup = (): void => undefined;
let service: RunningService | undefined;
/** The two spaces: `first` is the machine's default, `second` the one a person names. */
let first = "";
let second = "";
/** The folder of `second`. */
let secondFolder = "";
/** A task reference both spaces hold. */
let task = "";

beforeAll(async () => {
  ({ root, cleanup } = tempRoot("run-requests"));
  home = join(root, "h");
  const machine = newId("m");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "fixture-machine",
      created_at: "2026-11-17T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const os = windows ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const folders: string[] = [];
  for (const seed of ["first", "second"]) {
    mkdirSync(join(root, seed));
    const seeded = await seedMira(join(root, seed), { seed, tasks: 1, machineId: machine, os });
    folders.push(seeded.folder);
  }
  const idOf = (folder: string) =>
    (JSON.parse(readFileSync(join(folder, "space.json"), "utf8")) as { space_id: Id<"sp"> })
      .space_id;
  [first, second] = folders.map(idOf) as [string, string];
  secondFolder = folders[1] ?? "";
  const scenario = { fixture: "windows-tool", answer: "Done.", pace: 0.3 };
  registerSpaces(
    home,
    folders,
    instanceToml({
      id: "codex",
      target: "codex-cli",
      label: "Codex",
      exec: process.execPath,
      args_prefix: [SERVER],
      env: { FAKE_CODEX_SCENARIO: JSON.stringify(scenario) },
    }),
  );
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    launch: { shimCommand: [process.execPath, BIN], baseEnv: () => process.env },
    runs: { times: { stopGraceMs: 2_000, closeMs: 5_000 } },
  });
  await service.spacesSettled;
  const s = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const refs = [];
    for (const space of [first, second]) {
      const out = (await s.call(
        "op/call",
        {
          op: "task.add",
          space,
          input: {
            tasks: [{ title: "Look into the export" }],
            request_id: `run-requests-${space.slice(-10)}`,
          },
        },
        { timeoutMs: 30_000 },
      )) as { tasks?: { ref?: string }[] };
      refs.push(out.tasks?.[0]?.ref ?? "");
    }
    expect(refs[0]).toBe(refs[1]);
    task = refs[0] ?? "";
  } finally {
    s.close();
  }
  const made = await runMain(["space", "use", first], { home, tty: true });
  expect(made.code, made.stdout + made.stderr).toBe(0);
}, 300_000);

afterAll(async () => {
  if (service !== undefined) {
    await service.stop();
    removeRuntimeDir(service);
  }
  cleanup();
}, 120_000);

type Call = { method: string; params: Record<string, unknown> };

/** `ttasks <argv>` as a person types it, with every call it makes to the service recorded. */
async function user(
  argv: string[],
  options: {
    env?: Record<string, string>;
    stdin?: string;
    /** Runs before each call is sent. */
    before?: (call: Call) => Promise<void>;
    /** The folder the command runs in. */
    cwd?: string;
  } = {},
) {
  const calls: Call[] = [];
  const wrap = (session: Session): Session => ({
    bound: session.bound,
    close: () => {
      session.close();
    },
    call: async (method, params, opts) => {
      const call = { method, params: params as Record<string, unknown> };
      calls.push(call);
      await options.before?.(call);
      return session.call(method, params, opts);
    },
  });
  const ran = await runMain(argv, {
    home,
    tty: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    main: { wrap },
  });
  return { ...ran, calls };
}

const runsIn = async (space: string): Promise<{ id: string; request?: string }[]> =>
  (
    JSON.parse((await user(["run", "list", task, "--json", "--space", space])).stdout) as {
      runs: { id: string; request?: string }[];
    }
  ).runs;

describe("[A4.3.11.run.requests] ttasks run sends the person's words from --input, to the space they chose, on every request", () => {
  test("--input <file> and --input - carry the request, the task and the instance to the run", async () => {
    const hold = service?.runs.hold();
    try {
      const file = join(root, "run-input.json");
      writeFileSync(file, JSON.stringify({ task, request: REQUEST, instance: "codex" }));
      const fromFile = await user(["run", "--input", file, "--json", "--space", second]);
      expect(fromFile.code, fromFile.stdout + fromFile.stderr).toBe(0);
      expect(JSON.parse(fromFile.stdout)).toMatchObject({ task, request: REQUEST });

      // An argument sets its field over the JSON's, as with every other verb.
      const fromStdin = await user(["run", task, "--input", "-", "--json", "--space", second], {
        stdin: JSON.stringify({ task: "M-999", request: REQUEST }),
      });
      expect(fromStdin.code, fromStdin.stdout + fromStdin.stderr).toBe(0);
      expect(JSON.parse(fromStdin.stdout)).toMatchObject({ task, request: REQUEST });
      for (const ran of [fromFile, fromStdin]) {
        const id = (JSON.parse(ran.stdout) as { id: string }).id;
        expect((await user(["run", "stop", id, "--space", second])).code).toBe(0);
      }
    } finally {
      hold?.release();
    }
  });

  test("an --input that cannot be read, or holds what the run does not take, starts nothing", async () => {
    const before = (await runsIn(second)).length;
    const missing = await user(["run", task, "--input", join(root, "none.json"), "--json"], {
      env: { TTASKS_SPACE: second },
    });
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ error: { class: "usage" } });
    const unknown = await user(["run", "--input", "-", "--json"], {
      env: { TTASKS_SPACE: second },
      stdin: JSON.stringify({ task, request: REQUEST, limits: { wall: 60 } }),
    });
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("limits");
    // `run show` takes one run: it has no input to read, so --input is refused, not dropped.
    const show = await user(["run", "show", "ru_00r5mfcw5rfzxb9enb2vg50z3g", "--input", "-"], {
      stdin: "{}",
    });
    expect(show.code).toBe(2);
    for (const ran of [missing, unknown, show]) {
      expect(ran.calls.filter((c) => c.method.startsWith("runs/"))).toEqual([]);
    }
    expect((await runsIn(second)).length).toBe(before);
  });

  test("a command that reads no --input refuses it before it does anything", async () => {
    for (const argv of [["space", "list"], ["view", "today"], ["doctor"], ["roots"]]) {
      const ran = await user([...argv, "--input", "-", "--json"], { stdin: "{}" });
      expect(ran.code, argv.join(" ")).toBe(2);
      expect(JSON.parse(ran.stdout), argv.join(" ")).toMatchObject({
        error: { class: "usage" },
      });
      expect(ran.stdout).toContain("--input");
      expect(ran.calls, argv.join(" ")).toEqual([]);
    }
  });

  test("TTASKS_SPACE sends the run to that space, and every look of --wait asks that space", async () => {
    const before = (await runsIn(first)).length;
    const ran = await user(["run", task, "--wait", "--json", REQUEST], {
      env: { TTASKS_SPACE: second },
    });
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const id = (JSON.parse(ran.stdout) as { id: string }).id;
    expect((await runsIn(second)).map((r) => r.id)).toContain(id);
    expect((await runsIn(first)).length).toBe(before);
    const runCalls = ran.calls.filter((c) => c.method.startsWith("runs/"));
    expect(runCalls.length).toBeGreaterThan(1);
    for (const call of runCalls) expect(call.params["space"]).toBe(second);
  });

  test("a space named as a folder is that folder from where the person stands; a name that is no folder there stays a name", async () => {
    const sent = async (space: string, cwd: string) => {
      const ran = await user(["run", "list", task, "--json", "--space", space], { cwd });
      return {
        code: ran.code,
        space: ran.calls.find((c) => c.method === "runs/list")?.params["space"],
      };
    };
    const here = resolve(secondFolder);
    expect(await sent(".", here)).toEqual({ code: 0, space: here });
    mkdirSync(join(here, "notes-of-mine"), { recursive: true });
    expect(await sent("..", join(here, "notes-of-mine"))).toEqual({ code: 0, space: here });
    expect(await sent(`./${basename(here)}`, dirname(here))).toEqual({ code: 0, space: here });
    // A name may hold a slash: with no folder of that name here, it is asked for as a name.
    expect((await sent("team/mira", root)).space).toBe("team/mira");
  });

  test("the command a start prints to look at its run names the space the person chose", async () => {
    const ran = await user(["run", task, "--space", second, REQUEST]);
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const id = /run show (\S+)/u.exec(ran.stderr)?.[1];
    const shown = /See it with: (.+)\n/u.exec(ran.stderr)?.[1]?.split(" ").slice(1) ?? [];
    expect(shown).toContain("--space");
    // Run as printed, with another space as the default, it finds the run.
    const looked = await user([...shown, "--json"]);
    expect(looked.code, looked.stdout + looked.stderr).toBe(0);
    expect((JSON.parse(looked.stdout) as { id: string }).id).toBe(id);
    expect((await user(["run", "stop", String(id), "--space", second])).code).toBe(0);
  });

  test("a default that changes while --wait looks at the run does not lose it", async () => {
    let moved = false;
    try {
      const ran = await user(["run", task, "--wait", "--json"], {
        before: async (call) => {
          if (call.method !== "runs/show" || moved) return;
          moved = true;
          const used = await runMain(["space", "use", second], { home, tty: true });
          expect(used.code, used.stdout + used.stderr).toBe(0);
        },
      });
      expect(moved).toBe(true);
      expect(ran.code, ran.stdout + ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ state: "succeeded" });
      const id = (JSON.parse(ran.stdout) as { id: string }).id;
      expect((await runsIn(first)).map((r) => r.id)).toContain(id);
    } finally {
      await runMain(["space", "use", first], { home, tty: true });
    }
  });
});

describe("[A4.3.11.run.answer-cut] ttasks run show says in its heading when only the answer's start is kept", () => {
  test("a cut answer's heading says so; a whole one's does not", () => {
    const run = {
      id: "ru_00r5mfcw5rfzxb9enb2vg50z3g",
      task: "M-14",
      instance: "codex",
      state: "succeeded",
      reason: null,
      answer: "The report starts here",
      answer_final: true,
    };
    expect(described({ ...run, answer_cut: true })).toContain(
      `\nAnswer (only its start: it was longer than ${PRODUCT_NAME} keeps):\nThe report starts here`,
    );
    expect(described({ ...run, answer_cut: false })).toContain("\nAnswer:\nThe report starts here");
    expect(described({ ...run, answer_final: false, answer_cut: true })).toContain(
      "\nIts last message (only its start",
    );
  });
});
