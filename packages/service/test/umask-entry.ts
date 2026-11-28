// The product's own creation paths in one process, for the umask guard (umask.test.ts), which
// starts this under a chosen umask. Linux and macOS only. Tests only.
//
// argv: <root>, a fresh private folder. Under it the product makes, by its own code:
// - the state folder with everything a start writes, the UI listener's service.sqlite and
//   machine.toml with the port it persists (a first start with the HTTP listener, which also makes
//   the config folder);
// - a space and the folder for spaces (the space admin worker), machine.toml's space entry (the
//   config editor), a manual backup (the space admin worker), a start that opens the space (its
//   writer.lock and writer.json, the database's sidecars), the per-user runtime folder and socket
//   (under `<root>/run/<uid>`, which the test made), a crash file (the crash writer);
// - a pairing with a fake T3 server, whose token goes to `<state>/t3/pairing.json` (M2.11);
// - a terminal launch of a task without a place through `ttasks shim` with a fake agent (M2.08):
//   the launch root and the launch's folder with launch.json, the space's work folder; with the
//   service stopped at the agent's end, the shim's exit.json;
// - an install's own writes into `<root>/inst` (M1.14), on a fixture version folder the test makes
//   (the install scripts' part needs a signed build): the candidate's temporary space in
//   `<state>/tmp`, then `install --finish`'s update.lock, current, bin and its stable command, and
//   install.json.
// Then a client connects with ipc.key, and the service is started again: it must read and open
// everything it made, collect the shim's exit.json and still be paired with T3.
//
// Prints one JSON line: every file and folder under the product's own folders with its type and
// mode, and what the second start could do. A first start the service refuses (a umask that takes
// away the person's own bits) prints the refusal and whether anything was made.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@ttasks/bridge/safe-exit";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PRODUCT_ID } from "@ttasks/brand";
import type { LaunchIntent, SpawnPlan } from "@ttasks/launch";
import { fakeAgentCommand } from "@ttasks/runs/fake-agents";
import { listBackups, type Id } from "@ttasks/storage";
import { FakeT3 } from "@ttasks/testkit/fake-t3";
import { editMachineToml } from "../src/config/edit.ts";
import { writeCrashFile } from "../src/hub/crash.ts";
import { ServiceExit } from "../src/hub/exit.ts";
import type { HostFacts } from "../src/hub/paths.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import { runAdmin } from "../src/hub/space-admin.ts";
import type { LaunchOptions } from "../src/launch/index.ts";
import { spaceCheck } from "../src/version/candidate.ts";
import { writeVersionManifest } from "../src/version/folder.ts";
import {
  finishInstall,
  installTarget,
  refuseBeforeFinish,
  scriptCreations,
} from "../src/version/install.ts";
import { openSession, serviceEnv, within } from "./harness.ts";
import { classSession } from "./ops-helpers.ts";
import { CLI_BIN, shimEnv, SUCCESS_FIXTURE, track, type Child } from "./shim-harness.ts";
import { backupsBeside } from "../../storage/test/backup-helpers.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("usage: umask-entry.ts <root>");
const home = join(root, "h");
const spaces = join(root, "sp");
const folder = join(spaces, "work");
const t3home = join(root, "t3");
const inst = join(root, "inst");
const identity = () => ({ root: false, elevated: false, package: null });
const LONG_MS = 90_000;

interface Entry {
  readonly path: string;
  readonly type: "folder" | "file" | "socket" | "link" | "other";
  readonly mode: number;
}

/** Every file and folder under `top` (and `top`), by its path below the root. */
function walk(top: string, into: Map<string, Entry>): void {
  // One lstat: the projection renames its temporary files away while the walk runs.
  const stat = lstatSync(top, { throwIfNoEntry: false });
  if (stat === undefined) return;
  const type = stat.isDirectory()
    ? "folder"
    : stat.isFile()
      ? "file"
      : stat.isSocket()
        ? "socket"
        : stat.isSymbolicLink()
          ? "link"
          : "other";
  const path = relative(root ?? "", top);
  into.set(path, { path, type, mode: stat.mode & 0o7777 });
  if (type === "folder") for (const name of readdirSync(top)) walk(join(top, name), into);
}

// Every shim this run started, stopped by PID when the run ends early.
const shims: Child[] = [];
const terminal: NonNullable<LaunchOptions["terminal"]> = ({ ticket, folder: cwd }) => {
  // As a terminal starts it (A4 3.3): `ttasks shim <ticket>` in the folder the service
  // resolved, with this run's umask.
  const child = spawn(process.execPath, [CLI_BIN, "shim", ticket], {
    cwd,
    env: shimEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  shims.push(track(child));
  return Promise.resolve({ kind: "accepted" });
};

const start = () =>
  startService({
    env: serviceEnv(home, { T3CODE_HOME: t3home }),
    identity,
    say: (line) => process.stderr.write(`${line}\n`),
    runUserBase: join(root, "run"),
    // The UI listener (M2.12) on a port the OS chooses, persisted to machine.toml as a first start
    // does; no other user's sightings are looked for.
    http: { ports: [0], persist: true, holders: () => [] },
    launch: { terminal },
  });

/** The launch's intent once `ready` holds for it. */
async function intentOf(
  service: RunningService,
  space: string,
  id: string,
  ready: (intent: LaunchIntent) => boolean,
  what: string,
): Promise<LaunchIntent> {
  const deadline = Date.now() + LONG_MS;
  for (;;) {
    const intent = await service.launches.read(space, id);
    if (intent !== undefined && ready(intent)) return intent;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A first start with no machine.toml makes the install (the state folder, machine.json,
// service.sqlite) and writes the port it chose to a new machine.toml: the space is created as
// this machine's, so the service opens it for writing.
let install;
try {
  install = await start();
} catch (error) {
  if (!(error instanceof ServiceExit)) throw error;
  process.stdout.write(
    `${JSON.stringify({ refused: error.refusal ?? null, code: error.code, made: existsSync(home) })}\n`,
  );
  process.exit(0);
}
const machineId = install.ops.machine.id as Id<"m">;
const port = install.http?.status().persisted ?? null;
await install.stop();

let fake: FakeT3 | undefined;
try {
  const created = await runAdmin({
    kind: "create",
    folder,
    name: "Work",
    takenPrefixes: [],
    machineId,
    ownerLabel: "Me",
  });
  if (created.kind !== "create") throw new Error("not created");
  const spaceId = created.spaceId;
  const edited = editMachineToml(join(home, "config"), [
    { op: "append", array: "spaces", entries: { id: spaceId, path: folder } },
  ]);
  if (!edited.ok) throw new Error(`machine.toml not written: ${edited.reason}`);
  await runAdmin({ kind: "backup", folder, backupDir: backupsBeside(folder) });

  const first = await start();
  await first.spacesSettled;
  writeCrashFile(first.layout.crash, { format: 1, event: "umask.test" }, new Date());
  const session = await openSession(home, first.endpoint.path);
  const status = (await session.call("service/status", {}, { timeoutMs: 10_000 })) as {
    state?: string;
  };
  session.close();
  const user = await classSession(home, first.endpoint.path, "cli-interactive");

  // A pairing with T3 (M2.11): its token goes to `<state>/t3/pairing.json`.
  fake = await FakeT3.start(t3home);
  const pair = (await user.call("t3/pair", {}, { timeoutMs: 30_000 })) as {
    attempt: string;
    url: string;
  };
  if ((await fake.approveInBrowser(pair.url)) !== 200) throw new Error("T3 did not approve");
  const paired = (await user.call(
    "t3/pair_wait",
    { attempt: pair.attempt },
    { timeoutMs: 60_000 },
  )) as { paired?: boolean };

  // A terminal launch of a task without a place (M2.08): its work folder, launch folder and
  // launch.json; the shim claims and starts the fake agent there.
  const added = (await user.call(
    "op/call",
    {
      op: "task.add",
      input: {
        tasks: [{ title: "Fixture task for the umask guard" }],
        request_id: "umask-guard-request-000001",
      },
    },
    { timeoutMs: 60_000 },
  )) as { tasks: { id: string }[] };
  user.close();
  const { command, args } = fakeAgentCommand(SUCCESS_FIXTURE, { maxMs: 600_000 });
  const plan: SpawnPlan = {
    argv: [command, ...args],
    folder: null,
    env: {},
    title: "Fixture launch",
    afterExit: "close",
  };
  const opened = await first.launches.open(
    spaceId,
    {
      task: added.tasks[0]?.id ?? "",
      instance: "fixture-agent",
      route: "terminal",
      place: null,
      taskVersion: 1,
      briefHash: "b".repeat(64),
    },
    "umask-guard-request-000002",
    plan,
  );
  await first.launches.dispatch(spaceId, opened.id);
  await intentOf(first, spaceId, opened.id, (i) => i.state === "confirmed", "the launch confirmed");

  // What the running service made, its socket included.
  const entries = new Map<string, Entry>();
  const runtime = first.runtime.endpoint.kind === "unix" ? first.runtime.endpoint.dir : undefined;
  const tops = [home, spaces, ...(runtime === undefined ? [] : [runtime])];
  for (const top of tops) walk(top, entries);
  const firstSpaces = first.spaces().map((s) => s.state);
  await first.stop();

  // The service is gone at the agent's end: the shim writes exit.json into the launch folder.
  const shim = shims[0];
  if (shim === undefined) throw new Error("no shim was started");
  shim.endInput();
  const shimExit = await within(shim.exit, LONG_MS, "the shim's exit");
  for (const top of tops) walk(top, entries);

  // An install's own writes (M1.14), on a fixture version folder: the candidate's temporary space,
  // then install --finish.
  const version = "0.1.0";
  const versionFolder = join(inst, "versions", version);
  mkdirSync(join(versionFolder, "bin"), { recursive: true });
  writeFileSync(join(versionFolder, "bin", PRODUCT_ID), "#!/bin/sh\n");
  writeVersionManifest(versionFolder, {
    version,
    build: "fixture0umask",
    platform: "linux-x64",
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? "",
    protocol: { min: 1, max: 1 },
  });
  writeFileSync(join(inst, "home.marker"), "");
  const facts: HostFacts = {
    platform: process.platform,
    env: { TTASKS_HOME: inst },
    accountHome: root,
    uid: process.getuid?.(),
  };
  const target = installTarget(versionFolder, facts);
  refuseBeforeFinish(target, process.platform);
  const candidate = await spaceCheck({
    state: target.layout.state,
    build: { version, build: "fixture0umask" },
    facts,
  });
  await finishInstall({ versionFolder, facts, created: scriptCreations(version) });
  // The root, versions/ and home.marker are the test's here (the install script's in the product).
  for (const name of ["state", "bin", "current"]) walk(join(inst, name), entries);

  // The second start reads what the first made: machine.toml, machine.json, ipc.key, the space,
  // the launch folder with the shim's exit.json, and the pairing with T3.
  const second = await start();
  await second.spacesSettled;
  const again = await openSession(home, second.endpoint.path);
  const statusAgain = (await again.call("service/status", {}, { timeoutMs: 10_000 })) as {
    state?: string;
  };
  again.close();
  const settled = await intentOf(
    second,
    spaceId,
    opened.id,
    (i) => i.evidence.exit_code !== undefined,
    "exit.json collected",
  );
  const asker = await classSession(home, second.endpoint.path, "cli-interactive");
  const t3Again = (await asker.call("t3/status", {}, { timeoutMs: 30_000 })) as { state?: string };
  asker.close();
  const secondSpaces = second.spaces().map((s) => s.state);
  const portAgain = second.http?.status().port ?? null;
  await second.stop();
  const backups = listBackups(backupsBeside(folder)).backups.length;

  process.stdout.write(
    `${JSON.stringify({
      entries: [...entries.values()],
      runtime: runtime === undefined ? null : relative(root, runtime),
      launch: opened.id,
      space: spaceId,
      status: status.state ?? null,
      statusAgain: statusAgain.state ?? null,
      firstSpaces,
      secondSpaces,
      backups,
      port,
      portAgain,
      paired: paired.paired === true,
      t3Again: t3Again.state ?? null,
      shimExit: shimExit.code,
      exitCode: settled.evidence.exit_code ?? null,
      candidate: candidate.status,
    })}\n`,
  );
} finally {
  for (const shim of shims) {
    if (shim.child.exitCode === null && shim.child.signalCode === null) shim.child.kill("SIGKILL");
  }
  await fake?.stop();
}
process.exit(0);
