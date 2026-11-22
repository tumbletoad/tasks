// A real test install for the updater's tests with real builds (installed.test.ts,
// launchers.test.ts): two versions built offline as the install scripts' tests build them (the
// real bundles and launchers, the Node that runs the tests as the runtime), both trusting a
// throwaway key made here, released and signed with it; the older one installed by its install
// script into a temporary TTASKS_HOME of the caller's own; its service run through the install's
// stable command or its supervisor; and the updater child (child.ts) run against it.
//
// Nothing here touches a real install, autostart place, PATH or shell profile, and every process
// it stops is one it started or one this install's service.json names. Tests only. Nothing is
// created when this module loads: openInstalled() does it, from a test's beforeAll.
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { PRODUCT_ID, PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { canonicalStatePath, installId } from "../../packages/service/src/hub/paths.ts";
import {
  probeService,
  processAlive,
  readServiceRecord,
  shutdownService,
} from "../../packages/service/src/install/context.ts";
import {
  checkVersionFolder,
  writeVersionManifest,
} from "../../packages/service/src/version/folder.ts";
import { currentVersion } from "../../packages/service/src/version/switch.ts";
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
  stableCommand,
  throwawayKey,
  type Release,
} from "../../scripts/install/test/kit.ts";
import { keyLine } from "./fixture.ts";
import type { ChildTask } from "./child.ts";

export const windows = process.platform === "win32";
const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

/** What a run of the updater child gave. */
export interface ChildRun {
  readonly lines: Record<string, unknown>[];
  readonly code: number | null;
  readonly armed: boolean;
}

export interface OpenOptions {
  /**
   * Windows: the second version's launchers differ from the first's, as two releases' launchers
   * do, so an update swaps both stable launchers (distinctLaunchers).
   */
  readonly distinctLaunchers?: boolean;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows: makes a version folder's launchers differ from another build's of the same source: a
 * mark appended after the image, which the loader ignores, and the manifest written again so it
 * lists the folder exactly. The launchers' code is the release build's, unchanged.
 */
function distinctLaunchers(folder: string, mark: string): void {
  for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
    appendFileSync(join(folder, "bin", exe), `\0launcher ${mark}\0`);
  }
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  rmSync(join(folder, "manifest.json"));
  writeVersionManifest(folder, {
    version: String(manifest["version"]),
    build: String(manifest["build"]),
    platform: String(manifest["platform"]),
    node: String(manifest["node"]),
    sqlite: String(manifest["sqlite"]),
    protocol: manifest["protocol"] as { min: number; max: number },
  });
}

/**
 * Builds both versions, releases them and installs the first one. Call it from a beforeAll. When
 * that fails, its folder is removed before the error is thrown: the caller then has nothing to
 * close.
 */
export async function openInstalled(label: string, options: OpenOptions = {}) {
  const folders = installsFolder(label);
  try {
    return await assemble(folders, options);
  } catch (error) {
    folders.remove();
    throw error;
  }
}

async function assemble(folders: ReturnType<typeof installsFolder>, options: OpenOptions) {
  const work = folders.root;
  const started: ChildProcess[] = [];
  let goCount = 0;
  const key = throwawayKey();
  const keys = [keyLine(key)];
  const web = await buildWeb(join(work, "ui"), repoRoot);
  const versions: [string, string] = ["0.1.0-dev.1", "0.1.0-dev.2"];
  const releases: Record<string, Release> = {};
  for (const [n, version] of versions.entries()) {
    const folder = await offlineVersionFolder(
      join(work, `build-${String(n)}`),
      { version, build: `upd0test${String(n)}` },
      { trustKeys: keys, web },
    );
    if (options.distinctLaunchers === true && windows && n === 1)
      distinctLaunchers(folder, version);
    releases[version] = releaseOf(folder, join(work, `dist-${String(n)}`), key, work);
  }
  const root = join(work, "home");
  const first = releases[versions[0]];
  if (first === undefined) throw new Error("no first release");
  const ran = runInstaller(first, { env: { [HOME_VAR]: root }, within: work });
  if (ran.status !== 0) throw new Error(`install failed:\n${ran.stdout}\n${ran.stderr}`);
  const state = join(root, "state");
  const id = installId(canonicalStatePath(realpathSync.native(state), process.platform));
  const stable = stableCommand(root);
  /** The supervisor: `<root>\bin\ttasksw.exe` (Windows). */
  const supervisor = join(root, "bin", `${PRODUCT_ID}w.exe`);
  const env = () => installEnv();

  const archiveOf = (version: string): string => {
    const release = releases[version];
    if (release === undefined) throw new Error(`no release ${version}`);
    return join(release.dist, release.archive);
  };

  /**
   * Whether a process has ended. On Linux a killed process stays a zombie until its parent reaps
   * it, and a service the updater child started has that child as its parent, which is blocked at
   * its armed step: a zombie has ended.
   */
  const ended = (pid: number): boolean => {
    if (!processAlive(pid)) return true;
    if (process.platform !== "linux") return false;
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return true;
    }
  };

  const waitGone = async (pid: number, ms = 60_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!ended(pid)) {
      if (Date.now() > end) throw new Error(`process ${String(pid)} did not end`);
      await pause(50);
    }
  };

  /** The version the service answers with, or undefined when none answers. */
  const serviceVersion = async (): Promise<string | undefined> => {
    const probe = await probeService(state, id, env(), 5_000);
    return probe.answers && probe.status.state === "ready" ? probe.status.version : undefined;
  };

  /** Stops this install's service: asked first, then killed (its PID from service.json). */
  const stopService = async (): Promise<void> => {
    const record = readServiceRecord(state);
    if (record === undefined || ended(record.pid)) return;
    await shutdownService(state, id, env(), 10_000);
    try {
      await waitGone(record.pid, 20_000);
    } catch {
      process.kill(record.pid, "SIGKILL");
      await waitGone(record.pid);
    }
  };

  /** Kills this install's service at once, as a crash or a supervisor's death would end it. */
  const killService = async (): Promise<void> => {
    const record = readServiceRecord(state);
    if (record === undefined || ended(record.pid)) return;
    process.kill(record.pid, "SIGKILL");
    await waitGone(record.pid);
  };

  /**
   * Starts the service through the stable command and waits until it is ready. A start that
   * repaired the install into another version exits 75 (its manager would start it again at
   * once): it is started once more, as the manager would.
   */
  const startService = async (): Promise<string> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const child = spawn(stable, ["serve"], {
        env: env(),
        stdio: "ignore",
        windowsHide: true,
        // eslint-disable-next-line no-restricted-syntax -- the stable launcher gives the service a hidden console of its own.
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
  };

  /** The last events of the service's log (names and fields only), for a failure's message. */
  const serviceEvents = (): string => {
    try {
      return readFileSync(join(state, "logs", "service.log"), "utf8")
        .trim()
        .split("\n")
        .slice(-15)
        .join("\n");
    } catch {
      return "(no service log)";
    }
  };

  /**
   * Windows: starts the supervisor, `<root>\bin\ttasksw.exe` with no arguments, as the Run value
   * does at sign-in, and waits until its service is ready. Returns the supervisor's process, which
   * ends when its service stops (exit 0) or when it hands over to a new supervisor (also exit 0,
   * possibly before the service is ready: the new one starts it).
   */
  const startSupervisor = async (): Promise<ChildProcess> => {
    const child = spawn(supervisor, [], {
      env: env(),
      stdio: "ignore",
      windowsHide: true,
      // eslint-disable-next-line no-restricted-syntax -- tasksw.exe gives the service a hidden console of its own.
      detached: true,
    });
    started.push(child);
    const end = Date.now() + 90_000;
    while ((await serviceVersion()) === undefined) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(
          `the supervisor exited ${String(child.exitCode)} before its service was ready:\n${serviceEvents()}`,
        );
      }
      if (Date.now() > end) throw new Error("the supervisor's service did not become ready");
      await pause(200);
    }
    return child;
  };

  /** Makes sure the service runs (the "next start"), and returns the version it names. */
  const ensureService = async (): Promise<string> =>
    (await serviceVersion()) ?? (await startService());

  /**
   * Runs the updater child with `arm`. At the armed step, `whileHeld` runs first (the child waits
   * there, holding update.lock); then `mode` `updater` kills the child there; `service` kills the
   * service and lets the child go on to its end; `hold` lets it go on. `selfTest` `pass` stands
   * in for the candidate's self-test (tests of other steps than the self-test).
   */
  const runChild = async (
    task: "update" | "repair",
    run: {
      archive?: string;
      arm?: string;
      mode?: "updater" | "service" | "hold";
      whileHeld?: () => Promise<void>;
      selfTest?: "real" | "pass";
    },
  ): Promise<ChildRun> => {
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
      ...(run.archive === undefined ? {} : { archive: run.archive }),
      keys,
      ...(run.arm === undefined ? {} : { arm: run.arm }),
      go,
      stable,
      env: Object.fromEntries(
        Object.entries(env()).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      ...(run.selfTest === undefined ? {} : { selfTest: run.selfTest }),
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
      if (run.arm !== undefined) {
        await Promise.race([onArmed, closed]);
        if (seen.armed) {
          try {
            await run.whileHeld?.();
          } finally {
            if (run.mode === "updater") {
              child.kill("SIGKILL");
            } else if (run.mode === "hold") {
              writeFileSync(go, "");
            } else {
              await killService();
              writeFileSync(go, "");
            }
          }
        }
      }
      const code = await closed;
      if (run.arm === undefined && code !== 0) {
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
  };

  /**
   * The Verify line's check: the install is one complete version, and the service runs it.
   * Returns that version.
   */
  const expectComplete = async (label: string): Promise<string> => {
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
        expect(existsSync(join(root, "bin", `${exe}.new`)), `${label}: bin/${exe}.new`).toBe(false);
      }
    }
    expect(await serviceVersion(), `${label}: the service`).toBe(version);
    const named = runProgram(stable, ["version"]);
    // `ttasks version` prints the product's name, the version and the build in parentheses.
    expect(named.stdout.trim().split(" (")[0], `${label}: the stable command`).toBe(
      `${PRODUCT_NAME} ${version}`,
    );
    return version;
  };

  const other = (version: string): string => (version === versions[0] ? versions[1] : versions[0]);

  /** Installs `version` over this install with its own install script, as a person upgrades. */
  const install = (version: string) => {
    const release = releases[version];
    if (release === undefined) throw new Error(`no release ${version}`);
    return runInstaller(release, { env: { [HOME_VAR]: root }, within: work });
  };

  /** Stops the service and every process this install's tests started, then removes the folder. */
  const close = async (): Promise<void> => {
    let failure: Error | undefined;
    try {
      await stopService();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // A supervisor that a hand-over started ends with its service's exit 0, a moment after it:
    // until then Windows keeps its program in the folder.
    for (let attempt = 1; ; attempt += 1) {
      try {
        folders.remove();
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await pause(1_000);
      }
    }
    if (failure !== undefined) throw failure;
  };

  return {
    work,
    root,
    state,
    id,
    stable,
    supervisor,
    versions,
    keys,
    env,
    started,
    archiveOf,
    ended,
    waitGone,
    serviceVersion,
    stopService,
    killService,
    startService,
    startSupervisor,
    ensureService,
    runChild,
    expectComplete,
    other,
    install,
    close,
  };
}

export type Installed = Awaited<ReturnType<typeof openInstalled>>;
