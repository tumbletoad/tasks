// The updater with real builds, a real install and real processes (A7 3.8 M6.12's Verify line):
// two versions built offline as the install scripts' tests build them (the real bundles and
// launchers, the Node that runs the tests as the runtime), both trusting a throwaway key made
// here, released and signed with it; the older one installed by its install script into a
// temporary TASKS_HOME of this file's own; its service run through the install's stable command.
//
//   kill      An updater child (tests/update/child.ts, the updater from source with one step armed)
//             is stopped at every journal step; then either it is killed, or the service is killed
//             and the updater goes on. Then the service starts again through the stable command,
//             and the install must be the complete old or the complete new version: current names
//             one, its folder matches its manifest, no journal or staging folder is left, the
//             Windows launchers are that version's, and the service names that version. A repair
//             killed at each of its own steps is finished by the next start; a running service
//             finishes an update whose updater died within its 10 s check. A bridge (an agent's
//             session) started before an update keeps running through it and answers after it.
//   command   `tasks update --from`, `--rollback` and `--repair` through the installed stable
//             command, with no service running (a restart through the OS is the injected seam's,
//             exercised above with its stand-in): a second update waits for the first, and the
//             data folders are byte-identical before and after an update and after a rollback.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started: the services this install's service.json names, the children.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { canonicalStatePath, installId } from "../../packages/service/src/hub/paths.ts";
import {
  probeService,
  processAlive,
  readServiceRecord,
  shutdownService,
} from "../../packages/service/src/install/context.ts";
import { checkVersionFolder } from "../../packages/service/src/version/folder.ts";
import { currentVersion, readInstallRecord } from "../../packages/service/src/version/switch.ts";
import { createSpace, newId } from "../../packages/storage/src/index.ts";
import { checkedDriver } from "../../packages/testkit/src/index.ts";
import { buildWeb } from "../../packages/web/build.ts";
import { repoRoot } from "../../scripts/run.ts";
import {
  HOME_VAR,
  installEnv,
  installsFolder,
  offlineVersionFolder,
  releaseOf,
  runInstaller,
  runProgram,
  snapshot,
  stableCommand,
  throwawayKey,
  type Release,
} from "../../scripts/install/test/kit.ts";
import { keyLine } from "./fixture.ts";
import type { ChildTask } from "./child.ts";

const windows = process.platform === "win32";
/** Builds, an install script run and many service starts: a slow runner gets room. */
const SLOW = 900_000;
const ROUNDS = 2_400_000;
const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

let folders: ReturnType<typeof installsFolder>;
let work: string;
let root: string;
let state: string;
let id: string;
let stable: string;
let releases: Record<string, Release>;
let versions: [string, string];
let keys: string[];
const started: ChildProcess[] = [];
let goCount = 0;

const env = () => installEnv();
const archiveOf = (version: string): string => {
  const release = releases[version];
  if (release === undefined) throw new Error(`no release ${version}`);
  return join(release.dist, release.archive);
};

beforeAll(async () => {
  folders = installsFolder("update");
  work = folders.root;
  const key = throwawayKey();
  keys = [keyLine(key)];
  const web = await buildWeb(join(work, "ui"), repoRoot);
  versions = ["0.1.0-dev.1", "0.1.0-dev.2"];
  releases = {};
  for (const [n, version] of versions.entries()) {
    const folder = await offlineVersionFolder(
      join(work, `build-${String(n)}`),
      { version, build: `upd0test${String(n)}` },
      { trustKeys: keys, web },
    );
    releases[version] = releaseOf(folder, join(work, `dist-${String(n)}`), key, work);
  }
  root = join(work, "home");
  const first = releases[versions[0]];
  if (first === undefined) throw new Error("no first release");
  const ran = runInstaller(first, { env: { [HOME_VAR]: root }, within: work });
  if (ran.status !== 0) throw new Error(`install failed:\n${ran.stdout}\n${ran.stderr}`);
  state = join(root, "state");
  id = installId(canonicalStatePath(realpathSync.native(state), process.platform));
  stable = stableCommand(root);
}, SLOW);

afterAll(async () => {
  try {
    await stopService();
  } finally {
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    folders.remove();
  }
}, SLOW);

// ---------------------------------------------------------------------------------------------
// The service of the test install

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a process has ended. On Linux a killed process stays a zombie until its parent reaps it,
 * and a service the updater child started has that child as its parent, which is blocked at its
 * armed step: a zombie has ended.
 */
function ended(pid: number): boolean {
  if (!processAlive(pid)) return true;
  if (process.platform !== "linux") return false;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

async function waitGone(pid: number, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ended(pid)) {
    if (Date.now() > end) throw new Error(`process ${String(pid)} did not end`);
    await pause(50);
  }
}

/** The version the service answers with, or undefined when none answers. */
async function serviceVersion(): Promise<string | undefined> {
  const probe = await probeService(state, id, env(), 5_000);
  return probe.answers && probe.status.state === "ready" ? probe.status.version : undefined;
}

/** Stops this install's service: asked first, then killed (its PID from service.json). */
async function stopService(): Promise<void> {
  const record = readServiceRecord(state);
  if (record === undefined || ended(record.pid)) return;
  await shutdownService(state, id, env(), 10_000);
  try {
    await waitGone(record.pid, 20_000);
  } catch {
    process.kill(record.pid, "SIGKILL");
    await waitGone(record.pid);
  }
}

/** Kills this install's service at once, as a crash or a supervisor's death would end it. */
async function killService(): Promise<void> {
  const record = readServiceRecord(state);
  if (record === undefined || ended(record.pid)) return;
  process.kill(record.pid, "SIGKILL");
  await waitGone(record.pid);
}

/**
 * Starts the service through the stable command and waits until it is ready. A start that
 * repaired the install into another version exits 75 (its manager would start it again at once):
 * it is started once more, as the manager would.
 */
async function startService(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const child = spawn(stable, ["serve"], {
      env: env(),
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    started.push(child);
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const end = Date.now() + 90_000;
    for (;;) {
      const version = await serviceVersion();
      if (version !== undefined) return version;
      const code = await Promise.race([exited, pause(200).then(() => "running" as const)]);
      if (code === 75) break;
      if (code !== "running") {
        // Another start of this install got there first: wait for that one.
        if (code === 73) continue;
        throw new Error(`the service exited ${String(code)}`);
      }
      if (Date.now() > end) throw new Error("the service did not become ready");
    }
  }
  throw new Error("the service kept restarting");
}

/** Makes sure the service runs (the "next start"), and returns the version it names. */
async function ensureService(): Promise<string> {
  return (await serviceVersion()) ?? (await startService());
}

// ---------------------------------------------------------------------------------------------
// The updater child

interface ChildRun {
  readonly lines: Record<string, unknown>[];
  readonly code: number | null;
  readonly armed: boolean;
}

/**
 * Runs the updater child with `arm`. At the armed step, `mode` `updater` kills the child there;
 * `service` kills the service and lets the child go on to its end; `hold` runs `whileHeld` while
 * the child waits there, holding update.lock, then lets it go on.
 */
async function runChild(
  task: "update" | "repair",
  options: {
    archive?: string;
    arm?: string;
    mode?: "updater" | "service" | "hold";
    whileHeld?: () => Promise<void>;
  },
): Promise<ChildRun> {
  goCount += 1;
  const go = join(work, `go-${String(goCount)}`);
  const child = spawn(process.execPath, [CHILD], {
    env: installEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  started.push(child);
  const description: ChildTask = {
    task,
    root,
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    keys,
    ...(options.arm === undefined ? {} : { arm: options.arm }),
    go,
    stable,
    env: Object.fromEntries(
      Object.entries(env()).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
  child.stdin.write(`${JSON.stringify(description)}\n`);
  const lines: Record<string, unknown>[] = [];
  let stderr = "";
  // Set by the stdout handler: an object, so the reads below see the handler's write.
  const seen = { armed: false };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let pending = "";
  const onArmed = new Promise<void>((resolve) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
        const text = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (text === "") continue;
        const parsed = JSON.parse(text) as Record<string, unknown>;
        lines.push(parsed);
        if (parsed["armed"] !== undefined) {
          seen.armed = true;
          resolve();
        }
      }
    });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
  try {
    if (options.arm !== undefined) {
      await Promise.race([onArmed, closed]);
      if (seen.armed && options.mode === "updater") {
        child.kill("SIGKILL");
      } else if (seen.armed && options.mode === "hold") {
        try {
          await options.whileHeld?.();
        } finally {
          writeFileSync(go, "");
        }
      } else if (seen.armed) {
        await killService();
        writeFileSync(go, "");
      }
    }
    const code = await closed;
    if (options.arm === undefined && code !== 0) {
      throw new Error(
        `the updater child failed (${String(code)}):\n${stderr}\n${JSON.stringify(lines)}`,
      );
    }
    return { lines, code, armed: seen.armed };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    // A round that failed must not leave its updater holding update.lock for the next one.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/**
 * The Verify line's check: the install is one complete version, and the service runs it.
 * Returns that version.
 */
async function expectComplete(label: string): Promise<string> {
  const current = currentVersion(root, process.platform);
  expect(versions, `${label}: current`).toContain(current);
  const version = current ?? "";
  expect(checkVersionFolder(join(root, "versions", version)), `${label}: its folder`).toEqual([]);
  expect(existsSync(join(state, "update.json")), `${label}: journal left`).toBe(false);
  expect(
    readdirSync(join(root, "versions")).filter((name) => name.startsWith(".")),
    `${label}: staging left`,
  ).toEqual([]);
  if (windows) {
    for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
      expect(
        readFileSync(join(root, "bin", exe)).equals(
          readFileSync(join(root, "versions", version, "bin", exe)),
        ),
        `${label}: bin/${exe}`,
      ).toBe(true);
    }
  }
  expect(await serviceVersion(), `${label}: the service`).toBe(version);
  const named = runProgram(stable, ["version"]);
  // `tasks version` prints the product's name, the version and the build in parentheses.
  expect(named.stdout.trim().split(" (")[0], `${label}: the stable command`).toBe(
    `${PRODUCT_NAME} ${version}`,
  );
  return version;
}

const other = (version: string): string => (version === versions[0] ? versions[1] : versions[0]);

/** The update's journal steps a kill is tested at (the launcher swap only when launchers change). */
const POINTS = [
  "locked",
  "prepared",
  "unpacked",
  "placed",
  "tested",
  "staged",
  "current",
  "switched",
  "launchers_done",
  "recorded",
  "restarted",
  "done",
] as const;

describe("[A2.3.12.6.update.kill] a kill at each journal step, of the updater or of the service, ends on the complete old or new version after the next start", () => {
  test(
    "the updater killed at each step, then the service started again",
    async () => {
      await ensureService();
      const outcomes: string[] = [];
      for (const point of POINTS) {
        const from = await expectComplete(`before ${point}`);
        const run = await runChild("update", {
          archive: archiveOf(other(from)),
          arm: point,
          mode: "updater",
        });
        expect(run.armed, `${point}: reached`).toBe(true);
        // The next start: the service is stopped (if the kill left it running) and started again,
        // and its start-up repair finishes or rolls back what the updater left.
        await stopService();
        await startService();
        const ended = await expectComplete(`updater killed at ${point}`);
        outcomes.push(`${point}: ${from === ended ? "old" : "new"}`);
      }
      // Before the switch nothing is done; from it on, the new version is complete.
      expect(outcomes).toEqual(
        POINTS.map((p) => `${p}: ${POINTS.indexOf(p) < POINTS.indexOf("current") ? "old" : "new"}`),
      );
    },
    ROUNDS,
  );

  test(
    "the service killed at each step while the updater goes on",
    async () => {
      await ensureService();
      for (const point of POINTS) {
        const from = await expectComplete(`before ${point}`);
        const run = await runChild("update", {
          archive: archiveOf(other(from)),
          arm: point,
          mode: "service",
        });
        expect(run.armed, `${point}: reached`).toBe(true);
        await ensureService();
        const ended = await expectComplete(`service killed at ${point}`);
        // The updater lived and finished, bringing back the service it found running; except when
        // the service it had just restarted on the new version died before its handshake: then it
        // waited its 30 s and rolled back (A2 3.12.6 step 13). A supervisor would have restarted it.
        expect(ended, `${point}: ${JSON.stringify(run.lines.at(-1))}`).toBe(
          point === "restarted" ? from : other(from),
        );
      }
    },
    ROUNDS,
  );

  test(
    "a repair killed at each of its steps is finished by the next start; a running service finishes an update whose updater died",
    async () => {
      await ensureService();
      for (const point of [
        "repair:decided",
        "repair:current",
        "repair:launchers",
        "repair:record",
      ]) {
        const from = await expectComplete(`before ${point}`);
        // An update cut off after its switch, with no service to repair it...
        await stopService();
        await runChild("update", {
          archive: archiveOf(other(from)),
          arm: "switched",
          mode: "updater",
        });
        // ...a repair killed at `point`...
        const run = await runChild("repair", { arm: point, mode: "updater" });
        expect(run.armed, `${point}: reached`).toBe(true);
        // ...and the next start.
        await startService();
        expect(await expectComplete(`repair killed at ${point}`)).toBe(other(from));
      }
      // The updater dies after the switch while the old service runs: within its 10 s check the
      // service finishes the update, then exits 75 for its manager to start the new version.
      const from = await expectComplete("before the running service's repair");
      const before = readServiceRecord(state)?.pid ?? 0;
      await runChild("update", {
        archive: archiveOf(other(from)),
        arm: "switched",
        mode: "updater",
      });
      await waitGone(before, 30_000);
      expect(existsSync(join(state, "update.json"))).toBe(false);
      expect(currentVersion(root, process.platform)).toBe(other(from));
      const log = readFileSync(join(state, "logs", "service.log"), "utf8");
      expect(log).toMatch(/"update\.repaired"/);
      await startService();
      expect(await expectComplete("after the running service's repair")).toBe(other(from));
    },
    ROUNDS,
  );

  test(
    "a session's bridge started before an update keeps running through the restart and answers after it",
    async () => {
      await ensureService();
      const from = await expectComplete("before the session");
      const bridge = spawn(stable, ["mcp"], {
        env: env(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      started.push(bridge);
      const replies: Record<string, unknown>[] = [];
      let pending = "";
      bridge.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        pending += chunk;
        for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
          replies.push(JSON.parse(pending.slice(0, end)) as Record<string, unknown>);
          pending = pending.slice(end + 1);
        }
      });
      const ask = async (message: Record<string, unknown>) => {
        const count = replies.length;
        bridge.stdin.write(`${JSON.stringify(message)}\n`);
        for (let i = 0; i < 300 && replies.length === count; i += 1) await pause(50);
        return replies.at(-1);
      };
      // A tool call the service answers: the bridge's offline answer (tools/list, and a call
      // while it has no connection) starts with `error service_unavailable`. Retried while the
      // bridge reconnects; returns whether the service answered.
      let callId = 100;
      const reachesService = async (): Promise<boolean> => {
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
          callId += 1;
          const reply = await ask({
            jsonrpc: "2.0",
            id: callId,
            method: "tools/call",
            params: { name: "status", arguments: {} },
          });
          const result = reply?.["result"] as { content?: { text?: unknown }[] } | undefined;
          const text = result?.content?.[0]?.text;
          if (typeof text === "string" && !text.startsWith("error service_unavailable")) {
            return true;
          }
          await pause(250);
        }
        return false;
      };
      try {
        await ask({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "fixture-client", version: "1.0.0" },
          },
        });
        bridge.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        expect(
          (await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" }))?.["result"],
        ).toBeDefined();
        expect(await reachesService(), "the bridge reaches the service before").toBe(true);
        const run = await runChild("update", { archive: archiveOf(other(from)) });
        expect(run.lines.at(-1)).toEqual({ done: "updated" });
        expect(await expectComplete("after the update with a session")).toBe(other(from));
        expect(bridge.exitCode, "the bridge kept running").toBeNull();
        expect(
          (await ask({ jsonrpc: "2.0", id: 3, method: "tools/list" }))?.["result"],
        ).toBeDefined();
        // The same session reconnected to the restarted service, now the new version.
        expect(await reachesService(), "the bridge reaches the service after").toBe(true);
      } finally {
        bridge.stdin.end();
        bridge.kill("SIGKILL");
      }
    },
    SLOW,
  );
});

describe("[A2.3.12.6.update.installed] tasks update through the installed stable command", () => {
  test(
    "--from, a second update that waits, --rollback and --repair, with the data folders byte-identical",
    async () => {
      // A fixture space (creating one through the CLI needs a person at a terminal), and the
      // service's own files in state from a run; then the service stops, so the update restarts
      // nothing through the OS.
      await ensureService();
      await stopService();
      const spaceDir = join(work, "spaces", "demo");
      mkdirSync(join(work, "spaces"), { recursive: true });
      createSpace(await checkedDriver(), spaceDir, {
        name: "Demo",
        ownerLabel: "Fixture Owner",
        machineId: newId("m"),
      });
      const own = new Set(["update.lock", "update.json", "install.json"]);
      const data = () => ({
        space: snapshot(spaceDir),
        config: snapshot(join(root, "config")),
        state: Object.fromEntries(
          Object.entries(snapshot(state)).filter(
            ([path]) => !own.has(path) && path !== "tmp/" && !path.startsWith("tmp/"),
          ),
        ),
      });
      const before = data();
      const from = currentVersion(root, process.platform) ?? "";
      const to = other(from);

      // A second update waits for the first: a real updater holds update.lock at its self-test
      // while the installed command starts the same update. Once the first is done, the second
      // (which runs the version that was current when it started) finds that version current.
      let out = "";
      let exited: Promise<number | null> | undefined;
      const first = await runChild("update", {
        archive: archiveOf(to),
        arm: "tested",
        mode: "hold",
        whileHeld: async () => {
          const second = spawn(stable, ["update", "--from", archiveOf(to), "--yes"], {
            env: env(),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          started.push(second);
          second.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
          second.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
          exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
          for (let i = 0; i < 600 && !/waits for it to finish/.test(out); i += 1) await pause(50);
          expect(out).toMatch(/Another update of this install is running \(PID \d+\)/);
          expect(currentVersion(root, process.platform)).toBe(from);
        },
      });
      expect(first.lines.at(-1)).toEqual({ done: "updated" });
      expect(await exited, out).toBe(0);
      expect(out).toMatch(
        new RegExp(`${to.replaceAll(".", "\\.")} is installed and current already`),
      );
      expect(currentVersion(root, process.platform)).toBe(to);
      expect(data()).toEqual(before);
      const doctor = runProgram(stable, ["doctor", "--json"]);
      const rows = (
        JSON.parse(doctor.stdout) as { checks: { id: string; status: string; detail: string }[] }
      ).checks;
      expect(rows.find((row) => row.id === "update")).toMatchObject({ status: "ok" });
      expect(rows.find((row) => row.id === "integrity")?.status).toBe("ok");

      // The same archive again: nothing to do. --rollback: the previous version is current again.
      const again = runProgram(stable, ["update", "--from", archiveOf(to), "--yes"]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/current already/);
      const back = runProgram(stable, ["update", "--rollback", "--yes"]);
      expect(back.status, back.stdout + back.stderr).toBe(0);
      expect(currentVersion(root, process.platform)).toBe(from);
      expect(readInstallRecord(state)?.["previous"]).toBe(to);
      expect(data()).toEqual(before);
      const repair = runProgram(stable, ["update", "--repair"]);
      expect(repair.status, repair.stderr).toBe(0);
      expect(repair.stdout).toMatch(/No update was interrupted/);

      // Without a terminal and without --yes, an update that would restart a running service
      // changes nothing (exit 2); an agent's shell may not update at all (exit 5).
      await startService();
      const asked = runProgram(stable, ["update", "--from", archiveOf(to)]);
      expect(asked.status).toBe(2);
      expect(currentVersion(root, process.platform)).toBe(from);
      const agent = runProgram(stable, ["update", "--repair"], { CODEX_THREAD_ID: "fixture" });
      expect(agent.status).toBe(5);
      // Both versions are still there: an update never removes a version folder.
      expect(
        readdirSync(join(root, "versions"))
          .filter((n) => !n.startsWith("."))
          .sort(),
      ).toEqual([...versions].sort());
      rmSync(spaceDir, { recursive: true, force: true });
    },
    SLOW,
  );
});
