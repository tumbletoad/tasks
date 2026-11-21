// Two installs on one machine (A7 3.8 M1.14's Verify line, gate G2's install predicate S06, A2
// 3.2.1, review SL-03): installed by the install script into two temporary TTASKS_HOMEs, each has
// its own install ID, state and endpoint, and a test install started and stopped beside another
// leaves the other's CLI and bridge calls working, before, during and after. Real processes, a
// release built offline, fixture text only; every PID is stopped by this test.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe as suite, expect, test } from "vitest";
import { PRODUCT_NAME } from "../../packages/brand/src/index.ts";
import { canonicalStatePath, installId } from "../../packages/service/src/hub/paths.ts";
import {
  openSession,
  readServiceJson,
  removeRuntimeDir,
  Services,
  waitFor,
  within,
  READY_MS,
  type Proc,
  type ServiceJson,
} from "../../packages/service/test/harness.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import {
  installsFolder,
  mcpExchange,
  offlineVersionFolder,
  releaseOf,
  runInstaller,
  runProgram,
  runsElevated,
  stableCommand,
  throwawayKey,
} from "./test/kit.ts";

const SLOW = 900_000;
/** Both installs' services refuse an elevated token (exit 64): skipped there, builds included. */
const describe = suite.skipIf(runsElevated());

let folders: ReturnType<typeof installsFolder>;
let work: string;
let a: string;
let b: string;
const services = new Services();
const records: ServiceJson[] = [];

beforeAll(async () => {
  folders = installsFolder("side");
  work = folders.root;
  // User-only, whatever the umask: the installer refuses a root below a folder others can change.
  mkdirSync(join(work, "h"), { mode: 0o700 });
  const folder = await offlineVersionFolder(join(work, "build"), {
    version: "0.1.0-dev.1",
    build: "side0by0side",
  });
  const release = releaseOf(folder, join(work, "dist"), throwawayKey(), work);
  a = join(work, "h", "a");
  b = join(work, "h", "b");
  for (const root of [a, b]) {
    const ran = runInstaller(release, { root, within: work });
    expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  }
}, SLOW);

afterAll(async () => {
  await services.stopAll();
  for (const record of records) removeRuntimeDir(record);
  folders.remove();
}, SLOW);

/** Starts an install's service through its stable command, as a manual manager does. */
async function start(root: string): Promise<{ proc: Proc; json: ServiceJson }> {
  const proc = services.start(root, { command: [stableCommand(root), "serve"] });
  let ended: { code: number | null } | undefined;
  void proc.exit.then((exit) => {
    ended = exit;
  });
  // On Windows ttasks.exe starts Node as its child, so service.json names Node's PID.
  const json = await waitFor(
    () => {
      if (ended !== undefined) {
        throw new Error(`the installed service exited ${String(ended.code)} before it was ready`);
      }
      const record = readServiceJson(root);
      return record?.state === "ready" ? record : undefined;
    },
    READY_MS,
    "the installed service ready",
  );
  records.push(json);
  return { proc, json };
}

/** Stops it as `ttasks service stop` does on every OS: service/shutdown over its endpoint. */
async function stop(root: string, running: { proc: Proc; json: ServiceJson }): Promise<void> {
  const session = await openSession(root, running.json.endpoint?.path ?? "");
  await session.call("service/shutdown", {}, { timeoutMs: 10_000 }).catch(() => undefined);
  session.close();
  const exit = await within(running.proc.exit, 60_000, "the service's stop");
  expect(exit.code).toBe(0);
}

/** One CLI call and one bridge call of an install, through its stable command. */
async function calls(root: string, title: string): Promise<void> {
  const added = runProgram(stableCommand(root), ["add", title, "--json"]);
  expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);
  expect((JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref).toMatch(
    /^S-\d+$/,
  );
  const bridge = await mcpExchange(stableCommand(root), ["mcp"]);
  expect(bridge.code, bridge.stderr).toBe(0);
  expect(bridge.stray).toEqual([]);
  expect(bridge.initialize?.["result"]).toBeDefined();
  expect(bridge.tools?.["result"]).toBeDefined();
}

describe("[A2.3.2.2.install.side-by-side] a test install started and stopped beside another leaves the other's CLI and bridge working", () => {
  test(
    "two installs have two install IDs and endpoints, and the second's start and stop never touch the first",
    async () => {
      const first = await start(a);
      const user = await classSession(a, first.json.endpoint?.path ?? "", "cli-interactive");
      try {
        await user.call(
          "space/create",
          { name: "Side", path: join(work, "spaces", "side"), ref_prefix: "S" },
          { timeoutMs: 120_000 },
        );
      } finally {
        user.close();
      }
      await calls(a, "Fixture task before");

      const second = await start(b);
      const id = (root: string) =>
        installId(canonicalStatePath(realpathSync.native(join(root, "state")), process.platform));
      expect(id(a)).not.toBe(id(b));
      expect(first.json.install_id).toBe(id(a));
      expect(second.json.install_id).toBe(id(b));
      expect(second.json.endpoint?.path).not.toBe(first.json.endpoint?.path);
      for (const root of [a, b]) {
        const record = JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as {
          install_id: string;
        };
        expect(record.install_id).toBe(id(root));
      }
      await calls(a, "Fixture task beside");
      const version = runProgram(stableCommand(b), ["version"]);
      expect(version.stdout).toMatch(new RegExp(`^${PRODUCT_NAME} 0\\.1\\.0-dev\\.1 `));

      await stop(b, second);
      expect(readServiceJson(b)).toBeUndefined();
      // The first service is the same process, at the same endpoint, and still answers.
      expect(readServiceJson(a)).toMatchObject({
        state: "ready",
        instance: first.json.instance,
        endpoint: first.json.endpoint,
      });
      await calls(a, "Fixture task after");
      const shown = runProgram(stableCommand(a), ["show", "S-3", "--json"]);
      expect(shown.status, shown.stderr).toBe(0);

      await stop(a, first);
    },
    SLOW,
  );
});
