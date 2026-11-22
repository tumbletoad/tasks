// The Run value through the real reg.exe, in a scratch key of this test's own under HKCU\Software
// (a random name, created here and removed by its full name afterwards). The real Run key, the
// StartupApproved keys and Explorer are never touched: the context's registry root is the scratch
// key, and Explorer and tasklist are stand-ins. Windows only.
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { system32 } from "../src/hub/identity.ts";
import { readEntry } from "../src/install/commands.ts";
import { serviceEntry } from "../src/install/entries.ts";
import { runProcess } from "../src/install/process.ts";
import { RegExe, type RegTree } from "../src/install/registry.ts";
import { runKeys } from "../src/install/render.ts";
import { captureIO, fakeContext, TEST_INSTALL_ID } from "./install-fakes.ts";

const windows = process.platform === "win32";
const SCRATCH = `HKCU\\Software\\ttasks-test-${randomBytes(6).toString("hex")}`;
const keys = runKeys(SCRATCH);
/** A second scratch key that this test never creates itself: install does, uninstall removes it. */
const FRESH = `HKCU\\Software\\ttasks-test-${randomBytes(6).toString("hex")}`;
const RUN_NAME = `TTasks (${TEST_INSTALL_ID})`;

let regExe = "reg.exe";
let dir = "";

async function reg(...args: string[]): Promise<void> {
  const result = await runProcess(regExe, args);
  if (result.code !== 0) throw new Error(`reg ${args[0] ?? ""} failed in the test's setup`);
}

/** A key-level dump of a tree: one sorted line per key, empty or not, and one per value. */
const dump = (tree: RegTree | undefined): string[] =>
  [...(tree ?? new Map<string, Map<string, { name: string; kind: string; data: string }>>())]
    .flatMap(([key, values]) => [
      `${key} |`,
      ...[...values.values()].map((v) => `${key} | ${v.name} | ${v.kind} | ${v.data}`),
    ])
    .sort();

beforeAll(async () => {
  if (!windows) return;
  const folder = system32();
  if (folder === undefined) throw new Error("System32 not found");
  regExe = join(folder, "reg.exe");
  // A name with letters outside ASCII: reg query would return it altered, reg export exactly.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-svc-Mïra 日本-")));
  // Another program's value and Task Manager's off record of it, and the daily install's value.
  await reg(
    "add",
    keys.run,
    "/v",
    "OtherApp",
    "/t",
    "REG_SZ",
    "/d",
    '"C:\\Other\\other.exe" -m',
    "/f",
  );
  await reg(
    "add",
    keys.run,
    "/v",
    "TTasks",
    "/t",
    "REG_SZ",
    "/d",
    '"C:\\Users\\m\\.local\\bin\\ttasksw.exe"',
    "/f",
  );
  await reg(
    "add",
    keys.approved,
    "/v",
    "OtherApp",
    "/t",
    "REG_BINARY",
    "/d",
    "030000000000000000000000",
    "/f",
  );
  await reg("add", SCRATCH, "/v", "Count", "/t", "REG_DWORD", "/d", "7", "/f");
});

afterAll(async () => {
  if (!windows) return;
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  // The scratch keys go on every path, a failed test included, and a removal that did not work
  // fails the run instead of passing quietly.
  for (let attempt = 1; ; attempt += 1) {
    for (const key of [SCRATCH, FRESH]) await runProcess(regExe, ["delete", key, "/f"]);
    const listing = await runProcess(regExe, ["query", "HKCU\\Software"]);
    if (listing.code === 0 && !listed(listing.stdout, SCRATCH) && !listed(listing.stdout, FRESH)) {
      return;
    }
    if (attempt >= 3) throw new Error(`the scratch keys ${SCRATCH}, ${FRESH} could not be removed`);
  }
});

/** Whether `reg query HKCU\Software` lists `key`. */
const listed = (listing: string, key: string): boolean =>
  listing
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === `hkey_current_user${key.slice(4)}`.toLowerCase());

describe.skipIf(!windows)(
  "[A2.3.3.2.service-install.no-trace-registry] the Run value through reg.exe in a scratch key",
  () => {
    const context = () => {
      const registry = new RegExe({ regExe, scratch: join(dir, "scratch"), run: runProcess });
      return {
        registry,
        ...fakeContext({ platform: "win32", dir, registry, registryRoot: SCRATCH }),
      };
    };

    test("install adds exactly its value, keeps the off choice, and install then uninstall leaves no trace", async () => {
      const { registry, ctx } = context();
      const before = dump(await registry.tree(SCRATCH));
      // Five keys (the scratch key, Run, Explorer, StartupApproved, StartupApproved\Run) and four
      // values: a key install created and uninstall left empty would show here too.
      expect(before.filter((line) => line.endsWith(" |"))).toHaveLength(5);
      expect(before).toHaveLength(9);

      const installed = captureIO();
      expect(await serviceEntry("install", { yes: true }, installed.io, () => ctx)).toBe(0);
      const afterInstall = dump(await registry.tree(SCRATCH));
      expect(afterInstall.filter((line) => !before.includes(line))).toEqual([
        `${keys.run.toLowerCase()} | ${RUN_NAME} | REG_SZ | "${ctx.program}"`,
      ]);
      expect(before.every((line) => afterInstall.includes(line))).toBe(true);
      // The path outside ASCII came back exactly, so the entry reads as ours and current.
      expect((await readEntry(ctx)).info).toMatchObject({ state: "ours", current: true });

      // The user turns the entry off in Task Manager.
      await reg(
        "add",
        keys.approved,
        "/v",
        RUN_NAME,
        "/t",
        "REG_BINARY",
        "/d",
        "030000001122334455667788",
        "/f",
      );
      const status = captureIO();
      expect(await serviceEntry("status", { json: true }, status.io, () => ctx)).toBe(0);
      expect(JSON.parse(status.text())).toMatchObject({
        entry: { state: "ours", current: true },
        autostart: { startup_apps: "off" },
      });
      // A second install changes nothing, the off choice included.
      const offState = dump(await registry.tree(SCRATCH));
      const again = captureIO();
      expect(await serviceEntry("install", { yes: true }, again.io, () => ctx)).toBe(0);
      expect(again.text()).toContain("turned off in Startup apps");
      expect(dump(await registry.tree(SCRATCH))).toEqual(offState);

      const removed = captureIO();
      expect(await serviceEntry("uninstall", { yes: true }, removed.io, () => ctx)).toBe(0);
      // The key-level diff: the scratch key holds exactly what it held before install.
      expect(dump(await registry.tree(SCRATCH))).toEqual(before);
    }, 120_000);

    test("round 3: from a root key that does not exist, install creates it and its Run key, and an uninstall in a later process removes both", async () => {
      const fresh = runKeys(FRESH);
      const ctx = () =>
        fakeContext({
          platform: "win32",
          dir: join(dir, "fresh"),
          registry: new RegExe({ regExe, scratch: join(dir, "scratch"), run: runProcess }),
          registryRoot: FRESH,
        }).ctx;
      const first = ctx();
      expect(await first.registry.tree(FRESH)).toBeUndefined();
      expect(await serviceEntry("install", { yes: true }, captureIO().io, () => first)).toBe(0);
      expect(dump(await first.registry.tree(FRESH))).toEqual([
        `${FRESH.toLowerCase()} |`,
        `${fresh.run.toLowerCase()} |`,
        `${fresh.run.toLowerCase()} | ${RUN_NAME} | REG_SZ | "${first.program}"`,
      ]);
      // Another process, with nothing but the note install left in the install's state folder.
      const later = ctx();
      const removed = captureIO();
      expect(await serviceEntry("uninstall", { yes: true }, removed.io, () => later)).toBe(0);
      expect(removed.text()).toContain(
        `Remove the key ${FRESH} if it is empty: install created it.`,
      );
      expect(await later.registry.tree(FRESH)).toBeUndefined();
      const listing = await runProcess(regExe, ["query", "HKCU\\Software"]);
      expect(listing.code).toBe(0);
      expect(listed(listing.stdout, FRESH)).toBe(false);
    }, 120_000);

    test("a key that does not exist reads as absent, decided by its parent's listing", async () => {
      const { registry } = context();
      expect(await registry.tree(`${SCRATCH}\\absent`)).toBeUndefined();
      expect(await registry.tree(`${SCRATCH}\\absent\\deeper\\still`)).toBeUndefined();
      expect(await registry.values(`${keys.approved}32`)).toBeUndefined();
      expect(await registry.values(keys.approved)).toBeDefined();
    });

    test("reads that start at the same moment each read the whole tree", async () => {
      const { registry } = context();
      const whole = dump(await registry.tree(SCRATCH));
      const reads = await Promise.all(
        Array.from(
          { length: 8 },
          (_, n) =>
            new Promise<string[][]>((resolve, reject) => {
              const results: string[][] = [];
              const worker = new Worker(new URL("./registry-reads-worker.ts", import.meta.url), {
                workerData: {
                  regExe,
                  scratch: join(dir, `reads-${String(n)}`),
                  key: SCRATCH,
                  rounds: 20,
                },
              });
              worker.on("message", (read: { tree?: RegTree; error?: string }) =>
                results.push(read.error === undefined ? dump(read.tree) : [read.error]),
              );
              worker.once("error", reject);
              worker.once("exit", () => {
                resolve(results);
              });
            }),
        ),
      );
      const all = reads.flat();
      expect(all).toHaveLength(160);
      expect(all.filter((read) => read.join("\n") !== whole.join("\n"))).toEqual([]);
    }, 120_000);

    test("a value of something else at the install's name stays as it was", async () => {
      const { registry, ctx } = context();
      await reg(
        "add",
        keys.run,
        "/v",
        RUN_NAME,
        "/t",
        "REG_SZ",
        "/d",
        "C:\\Other\\updater.exe /quiet",
        "/f",
      );
      const before = dump(await registry.tree(SCRATCH));
      for (const verb of ["install", "uninstall"] as const) {
        const out = captureIO();
        expect(await serviceEntry(verb, { yes: true }, out.io, () => ctx)).toBe(4);
      }
      expect(dump(await registry.tree(SCRATCH))).toEqual(before);
      await reg("delete", keys.run, "/v", RUN_NAME, "/f");
    }, 120_000);
  },
);
