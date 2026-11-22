// The T3 CLI fallback route against a fake T3 server and a fake `t3` command line (A4 3.4.1
// "Fallback route", 3.9.2, 3.9.3; A7 3.13 M6.10). The Verify line: the CLI route serves exact roots
// only. A folder that is a project root opens there; a nested folder asks Register and never opens
// the project that contains it; a worktree needs the paired route; `thread start` is only ever given
// the ID of a project whose root is the folder (the fake, like T3, would resolve a path to the
// containing project). The launch states follow the state machine's `t3-cli` rows (A4 3.9.2). The
// command line is an argument array: hostile folder names reach the fake CLI byte for byte (on
// Windows through a `.cmd` shim the route reads and never runs) or are refused before anything
// starts. The fake CLI is `node <testkit fake>`; nothing here reaches a real T3. Fixture text and
// temporary folders only.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { FAKE_T3_CLI, FakeT3, type FakeT3CliRecord } from "@ttasks/testkit/fake-t3";
import { LaunchMachine } from "../src/machine.ts";
import { identityOf, resolvePlace, type RootFolder } from "../src/places.ts";
import type { LaunchIntent } from "../src/store.ts";
import {
  chooseT3Route,
  parseT3Shim,
  runT3Cli,
  T3_CLI_ROUTE,
  T3CliRoute,
  t3CliCommand,
  type T3CliInstance,
  type T3CliResult,
  type T3CliRun,
} from "../src/t3-cli.ts";
import { T3_TEXT, T3Route } from "../src/t3-route.ts";
import { MemoryT3Files } from "../src/t3-state.ts";
import { MemoryDurable, MemoryExecutionStore, randomId } from "./memory-store.ts";
import { MACHINE } from "./stores.ts";

/** Generous: every CLI run starts a Node process, and a loaded runner must not fail a slow test. */
const SLOW = 120_000;
const WINDOWS = process.platform === "win32";

const BRIEF =
  'M-14 "Fixture task". Read the task with the task tools (launch L7KQ2M).\nThen wait for my instructions.';

let base: string;
let fake: FakeT3;
let files: MemoryT3Files;
let log: string;
let roots: RootFolder[];
let durable: MemoryDurable;
let runs: { args: readonly string[]; stdin: string | undefined }[];
let opened: string[];

/** The fake CLI as an instance's `exec`: Node and the fake's entry. */
function instance(over: Partial<T3CliInstance> = {}): T3CliInstance {
  return {
    exec: process.execPath,
    argsPrefix: [FAKE_T3_CLI],
    env: {},
    openPermission: "full-access",
    t3: { environment: "local", providerInstance: "codex", model: "fixture-model" },
    ...over,
  };
}

/** Every run the route asked for, recorded, then run by the OS's runner. */
const recorded: T3CliRun = (request) => {
  runs.push({ args: request.args, stdin: request.stdin });
  return runT3Cli(request);
};

function cliRoute(options: { run?: T3CliRun; timeoutMs?: number } = {}): T3CliRoute {
  return new T3CliRoute({
    home: fake.home,
    files,
    // The person's environment, as the claim takes it, with agent-session leftovers the scrub
    // must take out, and the fake's log.
    environment: {
      base: () =>
        Promise.resolve({
          kind: "user",
          env: {
            ...process.env,
            T3CODE_THREAD_ID: "thread-of-the-session",
            T3CODE_HOME: join(base, "another-t3-home"),
            ELECTRON_RUN_AS_NODE: "0",
            TTASKS_TICKET: "TICKETTICKETTICKET",
            FAKE_T3_CLI_LOG: log,
          },
        }),
    },
    run: options.run ?? recorded,
    open: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function machine(cli: T3CliRoute): LaunchMachine {
  return new LaunchMachine({
    store: new MemoryExecutionStore(durable),
    machine: MACHINE,
    steps: { dispatch: (intent) => cli.dispatch(intent) },
    recovery: {
      observe: () => Promise.resolve({ kind: "pending" }),
      grant: () => Promise.resolve(undefined),
      replay: () => Promise.resolve({ kind: "refused" }),
    },
  });
}

function folder(...parts: string[]): string {
  const path = join(base, "work", ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

async function bindFolderOf(path: string) {
  const resolution = await resolvePlace({ root: "work", path }, roots);
  if (resolution.status !== "ok") throw new Error(`fixture place: ${resolution.reason}`);
  return { path: resolution.folder, identity: resolution.identity };
}

const placeOf = (path: string) => `pl-${path.replaceAll(/[^A-Za-z0-9]/gu, "-")}`;

async function prepare(cli: T3CliRoute, path: string, inst = instance()) {
  return cli.prepare({
    place: placeOf(path),
    folder: await bindFolderOf(path),
    name: path,
    instance: inst,
  });
}

let clicks = 0;

/** Open through the CLI route: the Prepared step, the click, the stage, the dispatch. */
async function launch(
  cli: T3CliRoute,
  m: LaunchMachine,
  path: string,
): Promise<{ intent: LaunchIntent; dispatched: LaunchIntent | undefined; projectId: string }> {
  const prepared = await prepare(cli, path);
  if (prepared.kind !== "bound") throw new Error(`not bound: ${JSON.stringify(prepared)}`);
  clicks += 1;
  const intent = await m.open(
    {
      task: randomId("t"),
      instance: "t3-codex",
      route: "t3-cli",
      place: randomId("pl"),
      taskVersion: 1,
      briefHash: "a".repeat(64),
    },
    `t3-cli-click-${String(clicks).padStart(8, "0")}`,
  );
  const staged = await cli.stage(intent.id, {
    projectId: prepared.projectId,
    folder: await bindFolderOf(path),
    reference: "M-14",
    instance: instance(),
    brief: BRIEF,
  });
  if (staged.kind !== "ready") throw new Error(`not staged: ${staged.reason}`);
  const dispatched = await m.dispatch(intent.id);
  return { intent, dispatched, projectId: prepared.projectId };
}

const records = (): FakeT3CliRecord[] => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as FakeT3CliRecord);
  } catch {
    return [];
  }
};

/** Every `thread start` named a project ID, never a path, and one whose root is the folder. */
function expectOnlyProjectIds(): void {
  for (const call of fake.cliCallsOf("thread start")) {
    expect(fake.projects.has(call.argv[2] ?? ""), call.argv[2]).toBe(true);
  }
}

beforeEach(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-t3cli-")));
  fake = await FakeT3.start(join(base, "t3home"));
  files = new MemoryT3Files();
  log = join(base, "cli.log");
  roots = [{ id: "work", path: join(base, "work") }];
  durable = new MemoryDurable();
  runs = [];
  opened = [];
  folder();
}, SLOW);

afterEach(async () => {
  await fake.stop();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("[A4.5.t3.cli-route] the T3 CLI route serves exact roots only (fake T3)", () => {
  test(
    "an exact root: the thread starts in that project with the brief on stdin, Dispatched, never confirmed by the CLI",
    async () => {
      const lumen = fake.addProject(folder("lumen"), "lumen");
      // A project that contains it does not compete with the exact root.
      fake.addProject(join(base, "work"), "work");
      const cli = cliRoute();
      const m = machine(cli);
      const { intent, dispatched, projectId } = await launch(cli, m, "lumen");
      expect(projectId).toBe(lumen);
      expect(dispatched?.state).toBe("dispatched");
      const thread = dispatched?.evidence.thread ?? "";
      expect(fake.threads.get(thread)).toMatchObject({
        projectId: lumen,
        worktreePath: null,
        message: true,
        sent: BRIEF,
        title: "M-14",
        modelSelection: { instanceId: "codex", model: "fixture-model" },
      });
      // The command line is A4's, as an array; the brief only on stdin.
      const start = records().find((r) => r.argv[0] === "thread");
      expect(start?.argv).toEqual([
        "thread",
        "start",
        lumen,
        "-",
        "--json",
        "--title",
        "M-14",
        "--provider",
        "codex",
        "--model",
        "fixture-model",
      ]);
      expect(start?.stdin).toBe(BRIEF);
      // The scrub took the session's leftovers; the home is the one the route reads.
      expect(start?.home).toBe(fake.home);
      expect(start?.electron).toBeNull();
      expect(start?.envNames).not.toContain("T3CODE_THREAD_ID");
      expect(start?.envNames).not.toContain("TTASKS_TICKET");
      expect(start?.cwd).toBe(realpathSync.native(fake.home));
      for (const run of runs) {
        for (const arg of run.args) expect(arg.includes("Fixture task"), arg).toBe(false);
      }
      expectOnlyProjectIds();

      // Nothing the CLI prints checks the folder: the launch stays Dispatched.
      expect(cli.observe(dispatched as LaunchIntent)).toEqual({ kind: "pending" });
      // The link opens without a prompt where an environment ID is known; here none is.
      expect(await cli.openThread(dispatched as LaunchIntent)).toBe(false);
      expect(opened).toEqual([]);
      // The live sweep keeps it Dispatched; recovery after a restart makes it Unknown `lost`,
      // and the CLI is never run again for it.
      expect(await m.sweep()).toEqual([]);
      expect((await machine(cli).recover()).map((i) => [i.id, i.state, i.reason])).toEqual([
        [intent.id, "unknown", "lost"],
      ]);
      expect(fake.cliCallsOf("thread start")).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a nested folder asks Register and never opens the project that contains it",
    async () => {
      const lumen = fake.addProject(folder("lumen"), "lumen");
      folder("lumen", "docs");
      folder("lumen", "api");
      const cli = cliRoute();
      expect(await prepare(cli, "lumen/docs")).toEqual({
        kind: "ask",
        question: "register",
        text: T3_TEXT.register("lumen/docs"),
      });
      cli.notNow(placeOf("lumen/docs"));
      expect(await prepare(cli, "lumen/docs")).toEqual({
        kind: "unavailable",
        reason: "not_registered",
      });

      // Register: `t3 project add <P>` with exactly the folder, then the exact root binds.
      const api = await bindFolderOf("lumen/api");
      const registered = await cli.register({
        place: placeOf("lumen/api"),
        folder: api,
        name: "lumen › api",
        instance: instance(),
      });
      expect(registered.kind).toBe("bound");
      const added = records().find((r) => r.argv[1] === "add");
      expect(added?.argv).toEqual(["project", "add", api.path]);
      const made = [...fake.projects.values()].find((p) => p.workspaceRoot === api.path);
      expect(registered).toEqual({
        kind: "bound",
        projectId: made?.id,
        strategy: { type: "root" },
      });

      const m = machine(cli);
      const { dispatched } = await launch(cli, m, "lumen/api");
      const thread = fake.threads.get(dispatched?.evidence.thread ?? "");
      expect(thread?.projectId).toBe(made?.id);
      expect(thread?.projectId).not.toBe(lumen);
      // No thread ever started in the containing project.
      expect([...fake.threads.values()].filter((t) => t.projectId === lumen)).toEqual([]);
      expectOnlyProjectIds();
    },
    SLOW,
  );

  test(
    "a Register that T3 refuses, an existing worktree and an archived root stay unavailable: no thread starts",
    async () => {
      fake.addProject(folder("lumen"), "lumen");
      folder("lumen", "docs");
      const cli = cliRoute();
      fake.cliNext("project add", { exit: 1, stderr: "T3 refused the project\n" });
      expect(
        await cli.register({
          place: placeOf("lumen/docs"),
          folder: await bindFolderOf("lumen/docs"),
          name: "lumen › docs",
          instance: instance(),
        }),
      ).toEqual({ kind: "unavailable", reason: "not_registered" });

      // A linked git worktree of a registered repository, laid out as git lays it out.
      const repo = folder("repo");
      const worktree = folder("repo-wt");
      const gitDir = join(repo, ".git", "worktrees", "wt");
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "commondir"), "../..\n");
      writeFileSync(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
      writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      fake.addProject(repo, "repo");
      expect(await prepare(cli, "repo-wt")).toEqual({
        kind: "unavailable",
        reason: "worktree_needs_pairing",
      });

      // An archived project is no root: the folder asks, as an unregistered one.
      const old = fake.addProject(folder("old"), "old");
      const project = fake.projects.get(old);
      if (project !== undefined) project.archivedAt = "2026-11-01T00:00:00Z";
      expect((await prepare(cli, "old")).kind).toBe("ask");

      expect(fake.cliCallsOf("thread start")).toEqual([]);
      expect(fake.threads.size).toBe(0);
    },
    SLOW,
  );

  test(
    "the t3-cli launch states (A4 3.9.2): an exit without a thread is Unknown, never Failed, never repeated",
    async () => {
      fake.addProject(folder("lumen"), "lumen");
      const cli = cliRoute();
      const m = machine(cli);

      // A non-zero exit with a message and no thread does not tell whether T3 made one: the CLI
      // may have created the thread and lost its reply (a transport error after the create). It
      // is Unknown `no_answer`, so no one is told to try again over a thread that runs.
      fake.cliNext("thread start", {
        run: true,
        exit: 1,
        stdout: "",
        stderr: "T3 Code did not answer.\n",
      });
      const lost = await launch(cli, m, "lumen");
      expect([lost.dispatched?.state, lost.dispatched?.reason]).toEqual(["unknown", "no_answer"]);
      expect(fake.threads.size).toBe(1);
      // A refusal before anything was made reads the same from outside: Unknown too.
      fake.cliNext("thread start", { exit: 1, stderr: "Project not found\n" });
      const refused = await launch(cli, m, "lumen");
      expect([refused.dispatched?.state, refused.dispatched?.reason]).toEqual([
        "unknown",
        "no_answer",
      ]);
      expect(fake.threads.size).toBe(1);

      // It sent the message, then died without a word: Unknown `no_answer`, and never repeated.
      fake.cliNext("thread start", { run: true, exit: 1, stdout: "", stderr: "" });
      const silent = await launch(cli, m, "lumen");
      expect([silent.dispatched?.state, silent.dispatched?.reason]).toEqual([
        "unknown",
        "no_answer",
      ]);
      expect(fake.threads.size).toBe(2);
      await m.sweep();
      await machine(cli).recover();
      expect(fake.cliCallsOf("thread start")).toHaveLength(3);

      // It printed the thread and then failed: the thread is the answer (Dispatched).
      fake.cliNext("thread start", { run: true, exit: 3, stderr: "late failure\n" });
      const late = await launch(cli, m, "lumen");
      expect(late.dispatched?.state).toBe("dispatched");
      expect(fake.threads.has(late.dispatched?.evidence.thread ?? "")).toBe(true);

      // The CLI says the thread went to another project: Failed `folder_mismatch`, thread kept.
      fake.cliNext("thread start", {
        run: true,
        stdout: `${JSON.stringify({ threadId: "thread-elsewhere", projectId: "proj-other" })}\n`,
      });
      const other = await launch(cli, m, "lumen");
      expect(other.dispatched?.state).toBe("dispatched");
      const failed = await m.report(other.intent.id, cli.observe(other.dispatched as LaunchIntent));
      expect([failed?.state, failed?.reason, failed?.evidence.thread]).toEqual([
        "failed",
        "folder_mismatch",
        "thread-elsewhere",
      ]);
    },
    SLOW,
  );

  test(
    "a CLI that hangs is killed at its bound and the launch is Unknown",
    async () => {
      fake.addProject(folder("lumen"), "lumen");
      const cli = cliRoute({ timeoutMs: 3_000 });
      fake.cliNext("thread start", { run: true, hang: true });
      const hung = await launch(cli, machine(cli), "lumen");
      expect([hung.dispatched?.state, hung.dispatched?.reason]).toEqual(["unknown", "no_answer"]);
    },
    SLOW,
  );

  test(
    "a project root replaced after the binding starts nothing: at the stage, and at the dispatch",
    async () => {
      const lumenPath = folder("lumen");
      const lumen = fake.addProject(lumenPath, "lumen");
      const cli = cliRoute();
      const m = machine(cli);
      // Another folder takes the path. The old one is moved aside, not deleted: Linux reuses a
      // freed inode number at once, which would give the new folder the old identity.
      let moved = 0;
      const replace = () => {
        moved += 1;
        renameSync(lumenPath, `${lumenPath}-old-${String(moved)}`);
        mkdirSync(lumenPath);
      };
      const open = (key: string) =>
        m.open(
          {
            task: randomId("t"),
            instance: "t3-codex",
            route: "t3-cli",
            place: randomId("pl"),
            taskVersion: 1,
            briefHash: "a".repeat(64),
          },
          key,
        );

      // Replaced between the Prepared step and the stage: the stage refuses.
      const bound = await bindFolderOf("lumen");
      expect(await prepare(cli, "lumen")).toMatchObject({ kind: "bound", projectId: lumen });
      replace();
      const first = await open("t3-cli-replaced-at-stage-0001");
      expect(
        await cli.stage(first.id, {
          projectId: lumen,
          folder: bound,
          reference: "M-14",
          instance: instance(),
          brief: BRIEF,
        }),
      ).toEqual({ kind: "unavailable", reason: "folder_changed" });

      // Replaced between the stage and the dispatch (the path now names another folder, as a
      // junction retargeted to the containing folder would): Failed `folder_mismatch`, no CLI run.
      const again = await bindFolderOf("lumen");
      expect(await prepare(cli, "lumen")).toMatchObject({ kind: "bound", projectId: lumen });
      const second = await open("t3-cli-replaced-at-dispatch-01");
      expect(
        await cli.stage(second.id, {
          projectId: lumen,
          folder: again,
          reference: "M-14",
          instance: instance(),
          brief: BRIEF,
        }),
      ).toEqual({ kind: "ready" });
      replace();
      const dispatched = await m.dispatch(second.id);
      expect([dispatched?.state, dispatched?.reason]).toEqual(["failed", "folder_mismatch"]);

      // T3's own record changed after the stage: the project now has the containing folder as
      // its root (or was archived). The dispatch reads T3's list again: Failed, no thread.
      const steps: [string, (p: { workspaceRoot: string; archivedAt: string | null }) => void][] = [
        ["t3-cli-root-moved-in-t3-00001", (p) => (p.workspaceRoot = join(base, "work"))],
        ["t3-cli-root-archived-in-t3-01", (p) => (p.archivedAt = "2026-11-01T00:00:00Z")],
      ];
      for (const [key, change] of steps) {
        const now = await bindFolderOf("lumen");
        const project = fake.projects.get(lumen);
        if (project === undefined) throw new Error("fixture project");
        project.workspaceRoot = lumenPath;
        project.archivedAt = null;
        expect(await prepare(cli, "lumen")).toMatchObject({ kind: "bound", projectId: lumen });
        const third = await open(key);
        expect(
          await cli.stage(third.id, {
            projectId: lumen,
            folder: now,
            reference: "M-14",
            instance: instance(),
            brief: BRIEF,
          }),
        ).toEqual({ kind: "ready" });
        change(project);
        const moved = await m.dispatch(third.id);
        expect([moved?.state, moved?.reason], key).toEqual(["failed", "folder_mismatch"]);
      }
      expect(fake.cliCallsOf("thread start")).toEqual([]);
      expect(fake.threads.size).toBe(0);
    },
    SLOW,
  );

  test(
    "availability: the CLI when not paired, Start T3 Code when T3 is not running, the paired route first",
    async () => {
      const paired = new T3Route({ home: fake.home, files });
      const cli = cliRoute();
      // The route's own rules, with the route turned on (T3_CLI_ROUTE is off for T3 as it is).
      const on = { cliRoute: true };
      const choose = (inst = instance(), pick?: "t3-cli") =>
        chooseT3Route(paired, cli, inst, pick, on);

      expect(await choose()).toEqual({ kind: "route", route: "t3-cli" });
      expect(await choose(instance({ exec: undefined }))).toEqual({
        kind: "unavailable",
        reason: "not_paired",
      });
      expect(await choose(instance({ openPermission: "read-only" }))).toEqual({
        kind: "unavailable",
        reason: "mode_needs_pairing",
      });
      expect(await choose(instance({ openPermission: "inherit" }))).toEqual({
        kind: "route",
        route: "t3-cli",
      });
      expect(
        await choose(
          instance({ t3: { environment: "local", providerInstance: "codex", model: "" } }),
        ),
      ).toEqual({ kind: "unavailable", reason: "model_required" });
      expect(
        await choose(
          instance({ t3: { environment: "local", providerInstance: undefined, model: "m-1" } }),
        ),
      ).toEqual({ kind: "unavailable", reason: "provider_required" });
      expect(
        await choose(
          instance({ t3: { environment: "local", providerInstance: "--evil", model: "m-1" } }),
        ),
      ).toEqual({ kind: "unavailable", reason: "invalid_instance" });
      expect(
        await choose(
          instance({ t3: { environment: "local", providerInstance: undefined, model: "" } }),
        ),
      ).toEqual({ kind: "route", route: "t3-cli" });

      // Paired: the primary route, unless the person picks the CLI.
      const attempt = await paired.beginPairing();
      expect(await fake.approveInBrowser(attempt.url)).toBe(200);
      await paired.finishPairing(attempt);
      expect(await choose()).toEqual({ kind: "route", route: "t3-mcp" });
      expect(await choose(instance(), "t3-cli")).toEqual({ kind: "route", route: "t3-cli" });

      // T3 not running: "Start T3 Code", paired or not, from the runtime file alone.
      await fake.stop();
      const before = runs.length;
      expect(await choose()).toEqual({ kind: "unavailable", reason: "not_running" });
      expect(await choose(instance(), "t3-cli")).toEqual({
        kind: "unavailable",
        reason: "not_running",
      });
      expect(T3_TEXT.not_running).toBe("Start T3 Code");
      const unpaired = new T3Route({ home: fake.home, files: new MemoryT3Files() });
      expect(await chooseT3Route(unpaired, cli, instance(), undefined, on)).toEqual({
        kind: "unavailable",
        reason: "not_running",
      });
      expect(
        await chooseT3Route(unpaired, cli, instance({ exec: undefined }), undefined, on),
      ).toEqual({
        kind: "unavailable",
        reason: "not_paired",
      });
      // Availability starts no process.
      expect(runs.length).toBe(before);
      expect(fake.threads.size).toBe(0);
    },
    SLOW,
  );

  test(
    "T3's command line as it is has no project list: only the paired route opens a task, and an unpaired instance says how to pair",
    async () => {
      expect(T3_CLI_ROUTE).toBe(false);
      const unpaired = new T3Route({ home: fake.home, files: new MemoryT3Files() });
      const cli = cliRoute();
      const before = runs.length;
      // Not paired: never the CLI, though it could be run; the person is told to pair.
      expect(await chooseT3Route(unpaired, cli, instance())).toEqual({
        kind: "unavailable",
        reason: "not_paired",
      });
      expect(await chooseT3Route(unpaired, cli, instance(), "t3-cli")).toEqual({
        kind: "unavailable",
        reason: "not_paired",
      });
      expect(T3_TEXT.not_paired).toContain(`${CLI_NAME} setup t3`);
      // Paired: the paired route.
      const paired = new T3Route({ home: fake.home, files: new MemoryT3Files() });
      const attempt = await paired.beginPairing();
      expect(await fake.approveInBrowser(attempt.url)).toBe(200);
      await paired.finishPairing(attempt);
      expect(await chooseT3Route(paired, cli, instance(), "t3-cli")).toEqual({
        kind: "route",
        route: "t3-mcp",
      });
      // T3 not running: "Start T3 Code" when paired, still "pair" when not.
      await fake.stop();
      expect(await chooseT3Route(paired, cli, instance())).toEqual({
        kind: "unavailable",
        reason: "not_running",
      });
      expect(await chooseT3Route(unpaired, cli, instance())).toEqual({
        kind: "unavailable",
        reason: "not_paired",
      });
      expect(runs.length).toBe(before);
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------------------------

const HOSTILE = [
  "with space",
  "it's",
  "100%PATH%",
  "caret^up",
  "amp&and",
  "semi;colon",
  "bang!",
  "dollar$HOME",
  "back`tick",
  "paren(1)",
  "-dash first",
  "Grüße ñ 東京 🙂",
  ...(WINDOWS ? [] : ['dq"uote', "star*", "less<more>", "pipe|bar", "colon:"]),
];

/** A `.cmd` shim as T3 writes one (assumed): the executable, its entry, T3's two variables. */
function writeShim(dir: string, home: string): string {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "t3.cmd");
  writeFileSync(
    shim,
    [
      "@echo off",
      "setlocal",
      `set "T3CODE_HOME=${home}"`,
      "set ELECTRON_RUN_AS_NODE=1",
      `"${process.execPath}" "${FAKE_T3_CLI}" %*`,
      "exit /b %errorlevel%",
      "",
    ].join("\r\n"),
  );
  return shim;
}

describe("[A4.3.4.1.t3.cli-command] the T3 CLI's command line, its shim and its answers", () => {
  test("a `.cmd` shim is read exactly or not at all", () => {
    const shim = "C:\\Users\\mira\\.t3\\bin\\t3.cmd";
    const good = [
      "@echo off",
      "@setlocal",
      "rem T3 Code command line",
      ":: generated",
      'set "T3CODE_HOME=C:\\Users\\mira\\.t3"',
      "set ELECTRON_RUN_AS_NODE=1",
      '"%~dp0..\\app\\T3 Code.exe" "%~dp0..\\app\\resources\\cli.js" %*',
      "exit /b %errorlevel%",
    ].join("\r\n");
    expect(parseT3Shim(good, shim)).toEqual({
      file: "C:\\Users\\mira\\.t3\\bin\\..\\app\\T3 Code.exe",
      prefix: ["C:\\Users\\mira\\.t3\\bin\\..\\app\\resources\\cli.js"],
      env: { T3CODE_HOME: "C:\\Users\\mira\\.t3", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(parseT3Shim('"C:\\T3\\t3.exe" %*\n', shim)).toEqual({
      file: "C:\\T3\\t3.exe",
      prefix: [],
      env: {},
    });
    // npm's form: Node and the package's entry.
    expect(
      parseT3Shim(
        '"C:\\Program Files\\nodejs\\node.exe" "%~dp0node_modules\\t3\\cli.mjs" %*',
        shim,
      ),
    ).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      prefix: ["C:\\Users\\mira\\.t3\\bin\\node_modules\\t3\\cli.mjs"],
      env: {},
    });
    const bad = [
      // Another variable, a variable expanded from the environment, delayed expansion.
      'set "NODE_OPTIONS=--require x"\r\n"C:\\T3\\t3.exe" %*',
      '"%LOCALAPPDATA%\\T3\\t3.exe" %*',
      '"C:\\T3\\t3.exe" "%PATH%" %*',
      '"C:\\T3\\t3!x!.exe" %*',
      // cmd's operators, a second command, words after it, no %*.
      '"C:\\T3\\t3.exe" %* & calc',
      '"C:\\T3\\t3.exe" %* | more',
      '"C:\\T3\\t3.exe" %*\r\n"C:\\other.exe" %*',
      '"C:\\T3\\t3.exe" "x"',
      '"C:\\T3\\t3.exe" %* extra',
      // A relative or script executable, another script, nothing.
      '"t3.exe" %*',
      '"C:\\T3\\t3.cmd" %*',
      'call "C:\\T3\\t3.exe" %*',
      "@echo off",
      // A blank at a line's end (part of an unquoted value to cmd), a code page question.
      'set ELECTRON_RUN_AS_NODE=1 \r\n"C:\\T3\\t3.exe" %*',
      '"C:\\Usérs\\t3.exe" %*',
      'set ELECTRON_RUN_AS_NODE=0\r\n"C:\\T3\\t3.exe" %*',
      'set\r\n"C:\\T3\\t3.exe" %*',
      // A command processor or script host, which would parse the arguments (or stdin) as
      // commands even when started directly: only T3's own forms are accepted.
      '"C:\\Windows\\System32\\cmd.exe" "/d" "/c" "echo" %*',
      '"C:\\Tools\\cmd.exe" "/c" %*',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" "-File" "C:\\T3\\t3.ps1" %*',
      'set ELECTRON_RUN_AS_NODE=1\r\n"C:\\Windows\\System32\\cmd.exe" "C:\\T3\\cli.js" %*',
      'set ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\..\\..\\Windows\\System32\\wsl.exe" "C:\\T3\\cli.js" %*',
      // Not one of T3's forms: another program, an entry without a JavaScript runtime, a script
      // entry, more than the entry, an executable without its extension.
      '"C:\\T3\\other.exe" %*',
      '"C:\\T3\\t3.exe" "C:\\T3\\cli.js" %*',
      '"C:\\node\\node.exe" "C:\\T3\\cli.cmd" %*',
      '"C:\\node\\node.exe" "C:\\T3\\cli.js" "--extra" %*',
      '"C:\\node\\node.exe" "cli.js" %*',
      '"C:\\node\\node.exe" %*',
      '"C:\\T3\\t3" %*',
    ];
    for (const text of bad) expect(parseT3Shim(text, shim), text).toBeUndefined();

    // The instance's exec: a shim on Windows is read; elsewhere a script is run as it is.
    const read = (text: string | undefined) => () => text;
    expect(t3CliCommand({ exec: undefined, argsPrefix: [] }, "win32")).toEqual({
      ok: false,
      reason: "no_cli",
    });
    expect(t3CliCommand({ exec: shim, argsPrefix: ["--x"] }, "win32", read(good))).toMatchObject({
      ok: true,
      command: { prefix: ["C:\\Users\\mira\\.t3\\bin\\..\\app\\resources\\cli.js", "--x"] },
    });
    expect(t3CliCommand({ exec: shim, argsPrefix: [] }, "win32", read(bad[0]))).toEqual({
      ok: false,
      reason: "cli_unusable",
    });
    expect(t3CliCommand({ exec: shim, argsPrefix: [] }, "win32", read(undefined))).toEqual({
      ok: false,
      reason: "cli_unusable",
    });
    expect(t3CliCommand({ exec: "C:\\T3\\t3.ps1", argsPrefix: [] }, "win32")).toEqual({
      ok: false,
      reason: "cli_unusable",
    });
    // A command processor as the instance's own exec is refused on Windows too, and so is any
    // exec Windows would complete or trim to another name (`cmd` runs `cmd.exe`).
    for (const exec of [
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Tools\\PowerShell.EXE",
      "C:\\Tools\\cmd",
      "C:\\Tools\\t3",
      "C:\\Tools\\cmd.exe.",
      "C:\\Tools\\cmd.com",
    ]) {
      expect(t3CliCommand({ exec, argsPrefix: ["/c", "t3"] }, "win32"), exec).toEqual({
        ok: false,
        reason: "cli_unusable",
      });
    }
    expect(t3CliCommand({ exec: "/home/mira/.local/bin/t3", argsPrefix: [] }, "linux")).toEqual({
      ok: true,
      command: { file: "/home/mira/.local/bin/t3", prefix: [], env: {} },
    });
  });

  test(
    "hostile folder names reach the fake CLI byte for byte, through the shim on Windows",
    async () => {
      const shim = WINDOWS ? writeShim(join(base, "t3bin"), fake.home) : undefined;
      const cli = cliRoute();
      const inst = shim === undefined ? instance() : instance({ exec: shim, argsPrefix: [] });
      for (const name of HOSTILE) {
        folder(name);
        const target = await bindFolderOf(name);
        const registered = await cli.register({
          place: placeOf(name),
          folder: target,
          name,
          instance: inst,
        });
        expect(registered.kind, name).toBe("bound");
        const added = records()
          .filter((r) => r.argv[1] === "add")
          .at(-1);
        expect(added?.argv, name).toEqual(["project", "add", target.path]);
        expect(added?.hex[2], name).toBe(Buffer.from(target.path, "utf8").toString("hex"));
        if (shim !== undefined) {
          // The shim's variables reach the child, and only for it; cmd.exe never ran.
          expect(added?.electron).toBe("1");
          expect(added?.home).toBe(fake.home);
        }
      }
      expect(fake.threads.size).toBe(0);
    },
    SLOW,
  );

  test(
    "a folder that cannot reach the CLI exactly, and a shim that names another T3 home, start nothing",
    async () => {
      const cli = cliRoute();
      const identity = identityOf(statSync(folder("plain"), { bigint: true }));
      if (identity === undefined) throw new Error("fixture identity");
      for (const path of [
        join(base, "work", "lone\uD800surrogate"),
        join(base, "work", "new\nline"),
      ]) {
        expect(
          await cli.register({
            place: "pl-x",
            folder: { path, identity },
            name: "x",
            instance: instance(),
          }),
        ).toEqual({ kind: "unavailable", reason: "not_registered" });
      }
      expect(runs).toEqual([]);
      expect(records()).toEqual([]);

      if (WINDOWS) {
        const shim = writeShim(join(base, "other-bin"), join(base, "another-t3"));
        expect(await cli.availability(instance({ exec: shim, argsPrefix: [] }))).toEqual({
          state: "cli_unusable",
        });
        expect(runs).toEqual([]);
      }
    },
    SLOW,
  );

  test(
    "each answer of `thread start` maps to its launch state",
    async () => {
      fake.addProject(folder("lumen"), "lumen");
      const answers: T3CliResult[] = [
        { kind: "not_started" },
        { kind: "timeout" },
        { kind: "too_large" },
        { kind: "exited", code: 0, signal: null, stdout: "not json\n", stderr: "" },
        { kind: "exited", code: 0, signal: null, stdout: '{"threadId":"bad id"}', stderr: "" },
        { kind: "exited", code: 1, signal: null, stdout: "", stderr: "" },
        { kind: "exited", code: 1, signal: null, stdout: "", stderr: "Project not found\n" },
        { kind: "exited", code: null, signal: "SIGKILL", stdout: "", stderr: "killed\n" },
        {
          kind: "exited",
          code: 2,
          signal: null,
          stdout: 'starting\n{"threadId":"thread-1","projectId":"x","runId":"r"}\n',
          stderr: "warning\n",
        },
      ];
      const outcomes: unknown[] = [];
      for (const answer of answers) {
        const cli = cliRoute({
          run: (request) =>
            request.args.includes("thread") ? Promise.resolve(answer) : runT3Cli(request),
        });
        const prepared = await prepare(cli, "lumen");
        if (prepared.kind !== "bound") throw new Error("fixture binding");
        const id = randomId("la");
        expect(
          await cli.stage(id, {
            projectId: prepared.projectId,
            folder: await bindFolderOf("lumen"),
            reference: "M-14",
            instance: instance(),
            brief: BRIEF,
          }),
        ).toEqual({ kind: "ready" });
        const intent = { id, route: "t3-cli", evidence: {} } as unknown as LaunchIntent;
        outcomes.push(await cli.dispatch(intent));
        // Once only: the staged launch is gone after its dispatch.
        expect(await cli.dispatch(intent)).toEqual({ kind: "refused" });
      }
      expect(outcomes).toEqual([
        { kind: "refused" },
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "unknown" },
        // A message and a non-zero exit do not show that nothing was made (a lost reply).
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "accepted", evidence: { thread: "thread-1" } },
      ]);
    },
    SLOW,
  );

  test("a stage refuses what the CLI cannot be given, before anything starts", async () => {
    const cli = cliRoute();
    folder("plain");
    const plain = await bindFolderOf("plain");
    const stage = (over: { projectId?: string; reference?: string; brief?: string }) =>
      cli.stage(randomId("la"), {
        projectId: "proj-1",
        folder: plain,
        reference: "M-14",
        instance: instance(),
        brief: BRIEF,
        ...over,
      });
    expect(await stage({ projectId: "--json" })).toEqual({
      kind: "unavailable",
      reason: "invalid_instance",
    });
    expect(await stage({ projectId: "/home/mira/oss" })).toEqual({
      kind: "unavailable",
      reason: "invalid_instance",
    });
    expect(await stage({ reference: "M-14 Fixture task" })).toEqual({
      kind: "unavailable",
      reason: "invalid_instance",
    });
    expect(await stage({ brief: "" })).toEqual({ kind: "unavailable", reason: "too_long" });
    expect(await stage({ brief: "x".repeat(120_001) })).toEqual({
      kind: "unavailable",
      reason: "too_long",
    });
    // Another route's intent, or one with nothing staged, starts nothing.
    expect(
      await cli.dispatch({ id: "la-x", route: "t3-mcp", evidence: {} } as unknown as LaunchIntent),
    ).toEqual({ kind: "refused" });
    expect(runs).toEqual([]);
  });
});
