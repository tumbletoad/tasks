// The updater in-process (A2 3.12.6, A7 3.13 M6.12) on fixture installs and releases signed with
// throwaway keys: the release is verified with the installed version's keys before anything of
// it is written, the candidate is self-tested before current changes, the switch is journalled
// and ends on the complete new version, a failure rolls back to the complete old one, a repair
// finishes or rolls back whatever a cut-off update left, a second update waits for the first, and
// a person's data stays byte for byte as it was. The real processes, builds and kills are in
// installed.test.ts.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "../../packages/brand/src/index.ts";
import { ServiceCommandError } from "../../packages/service/src/install/errors.ts";
import { finishInstall } from "../../packages/service/src/version/install.ts";
import {
  readJournal,
  UPDATE_JOURNAL,
  writeJournal,
  type Journal,
} from "../../packages/service/src/version/journal.ts";
import { repairLocked } from "../../packages/service/src/version/repair.ts";
import { RELEASE_KEY_PLACEHOLDER } from "../../packages/service/src/version/release-keys.ts";
import {
  readInstallRecord,
  writeCurrent,
  currentFor,
} from "../../packages/service/src/version/switch.ts";
import {
  repairUpdate,
  rollbackUpdate,
  updateFromArchive,
  UpdateError,
  type UpdateOptions,
  type UpdatePoint,
} from "../../packages/service/src/version/update.ts";
import { SUMS_FILE } from "../../scripts/build/signing.ts";
import { craft, resign, type Crafted } from "./craft.ts";
import {
  currentOf,
  fakeSelfTest,
  FakeControl,
  FakeRuns,
  fixtureFiles,
  fixtureInstall,
  fixtureRelease,
  keyLine,
  scratch,
  throwawayKey,
  tree,
  windows,
  writeFolder,
} from "./fixture.ts";

const os = process.platform;
const RACER = fileURLToPath(new URL("../../packages/service/test/lock-racer.ts", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function folder(label: string): string {
  const made = scratch(label);
  cleanups.push(made.remove);
  return made.dir;
}

const key = throwawayKey();
const KEYS = [keyLine(key)];

async function world(label: string, running = true) {
  const dir = folder(label);
  const { root, facts } = await fixtureInstall(dir, os);
  const control = new FakeControl(root, os, running);
  const selfTest = fakeSelfTest();
  const said: string[] = [];
  const options: UpdateOptions = {
    facts,
    keys: KEYS,
    control,
    selfTest,
    say: (line) => said.push(line),
    lockWaitMs: 20_000,
  };
  return { dir, root, state: join(root, "state"), control, selfTest, said, options };
}

const refusal = async (promise: Promise<unknown>): Promise<InstanceType<typeof UpdateError>> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpdateError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

/** The install's files that a refused update must leave exactly as they were. */
const installTree = (root: string) => tree(root, (path) => path === "state/update.lock");

describe("[A2.3.12.6.update.verify] the installed version verifies the release with its own keys before anything of it is unpacked or run", () => {
  test("a release it can verify becomes current; one it cannot changes nothing and runs nothing", async () => {
    const w = await world("verify");
    const before = installTree(w.root);
    const good = fixtureRelease(join(w.dir, "good"), "0.2.0", os, key);
    const other = throwawayKey();

    const cases: { name: string; archive: string; keys?: readonly string[]; reason: RegExp }[] = [];
    // No trusted key: the placeholder, as every build has until the release key is made.
    cases.push({
      name: "placeholder",
      archive: good.archive,
      keys: [RELEASE_KEY_PLACEHOLDER],
      reason: /trusts no release key/,
    });
    // Signed by another key.
    cases.push({
      name: "other key",
      archive: fixtureRelease(join(w.dir, "other"), "0.2.0", os, other).archive,
      reason: /does not verify with this install's release keys/,
    });
    // The archive swapped after signing.
    const swapped = fixtureRelease(join(w.dir, "swapped"), "0.2.0", os, key);
    const look = fixtureRelease(join(w.dir, "look"), "0.2.0", os, other, {
      launcher: "look-alike",
    });
    cpSync(look.archive, swapped.archive);
    cases.push({ name: "archive", archive: swapped.archive, reason: /does not match SHA256SUMS/ });
    // SHA256SUMS rewritten for the look-alike under the old signature.
    const rewritten = fixtureRelease(join(w.dir, "rewritten"), "0.2.0", os, key);
    cpSync(look.archive, rewritten.archive);
    cpSync(join(look.dist, SUMS_FILE), join(rewritten.dist, SUMS_FILE));
    cases.push({ name: "sums", archive: rewritten.archive, reason: /does not verify/ });
    // No signature, no SHA256SUMS.
    const unsigned = fixtureRelease(join(w.dir, "unsigned"), "0.2.0", os, key);
    rmSync(join(unsigned.dist, `${SUMS_FILE}.sig`));
    cases.push({
      name: "unsigned",
      archive: unsigned.archive,
      reason: /SHA256SUMS\.sig is missing/,
    });
    // Not a release archive's name, or another platform's.
    const renamed = join(w.dir, "good", "something.zip");
    cpSync(good.archive, renamed);
    cases.push({ name: "name", archive: renamed, reason: /is not a tasks release archive/ });
    const foreign = join(
      w.dir,
      "good",
      `${PRODUCT_ID}-0.2.0-${windows ? "linux-x64.tar.gz" : "win-x64.zip"}`,
    );
    cpSync(good.archive, foreign);
    cases.push({ name: "platform", archive: foreign, reason: /is for/ });

    for (const c of cases) {
      const error = await refusal(
        updateFromArchive(c.archive, {
          ...w.options,
          ...(c.keys === undefined ? {} : { keys: c.keys }),
        }),
      );
      expect(error.message, c.name).toMatch(c.reason);
      expect(installTree(w.root), c.name).toEqual(before);
      expect(w.selfTest.folders, c.name).toEqual([]);
      expect(w.control.calls, c.name).toEqual([]);
    }

    const done = await updateFromArchive(good.archive, w.options);
    expect(done).toEqual({ outcome: "updated", from: "0.1.0", to: "0.2.0" });
    expect(currentOf(w.root, os)).toBe("0.2.0");
  });

  test("a signed archive whose entries leave the folder, are links, or do not match its manifest is refused before anything runs", async () => {
    const w = await world("entries");
    const before = installTree(w.root);
    const files = fixtureFiles("0.2.0", os);
    const hostile: { name: string; extra: Crafted }[] = [
      { name: "dot-dot", extra: { path: "../escape.txt", data: Buffer.from("x") } },
      { name: "absolute", extra: { path: "/abs.txt", data: Buffer.from("x") } },
      { name: "odd name", extra: { path: "lib/a b.mjs", data: Buffer.from("x") } },
      { name: "link", extra: { path: "lib/link.mjs", link: "../../outside.mjs" } },
      ...(windows
        ? [
            { name: "device", extra: { path: "lib/CON.mjs", data: Buffer.from("x") } },
            { name: "case twin", extra: { path: "LIB/chunks/cli.mjs", data: Buffer.from("x") } },
          ]
        : []),
    ];
    for (const h of hostile) {
      // The build's writer refuses these names: the archive is put together by hand, then signed
      // with the trusted key, so only the entry checks can stop it.
      const release = fixtureRelease(join(w.dir, `hostile-${h.name}`), "0.2.0", os, key);
      const manifest = readFileSync(join(w.root, "versions", "0.1.0", "manifest.json"));
      resign(
        release,
        craft(os, [
          ...files.map((f) => ({ path: f.path, data: f.data })),
          { path: "manifest.json", data: manifest },
          h.extra,
        ]),
        key,
      );
      const error = await refusal(updateFromArchive(release.archive, w.options));
      expect(error.message, h.name).toMatch(/entries a release may not hold/);
      expect(installTree(w.root), h.name).toEqual(before);
      expect(existsSync(join(w.dir, "outside.mjs")), h.name).toBe(false);
    }
    // A file the manifest does not list: unpacked into staging, refused, the staging folder gone.
    const extra = fixtureRelease(join(w.dir, "extra"), "0.2.0", os, key, {
      files: [
        ...files,
        { path: "lib/extra.mjs", data: Buffer.from("// not listed\n"), mode: 0o644 },
      ],
    });
    const unlisted = await refusal(updateFromArchive(extra.archive, w.options));
    expect(unlisted.message).toMatch(/do not match manifest\.json/);
    expect(installTree(w.root)).toEqual(before);
    expect(w.selfTest.folders).toEqual([]);
  });
});

describe("[A2.3.12.6.update.switch] the switch: self-test first, the journal before each step, the complete new version or the complete old one", () => {
  test("an update keeps both versions, records the previous one, restarts the service on the new one and leaves no journal or staging folder", async () => {
    const w = await world("switch");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const seen: { point: UpdatePoint; journal: string | undefined; current: string | undefined }[] =
      [];
    const result = await updateFromArchive(release.archive, {
      ...w.options,
      seams: {
        update: (point) => {
          const read = readJournal(w.state);
          seen.push({
            point,
            journal: read.kind === "journal" ? read.journal.phase : read.kind,
            current: currentOf(w.root, os),
          });
        },
      },
    });
    expect(result).toEqual({ outcome: "updated", from: "0.1.0", to: "0.2.0" });
    // The journal says each step before the next one needs it; current changes only after the
    // self-test and the staged journal.
    expect(seen.map((s) => `${s.point}:${String(s.journal)}:${String(s.current)}`)).toEqual([
      "locked:none:0.1.0",
      "prepared:prepare:0.1.0",
      "unpacked:prepare:0.1.0",
      "placed:prepare:0.1.0",
      "tested:prepare:0.1.0",
      "staged:staged:0.1.0",
      "current:staged:0.2.0",
      "switched:switched:0.2.0",
      ...(windows ? ["launcher:switched:0.2.0", "launcher:switched:0.2.0"] : []),
      "launchers_done:launchers_done:0.2.0",
      "recorded:launchers_done:0.2.0",
      "restarted:restarted:0.2.0",
      "done:none:0.2.0",
    ]);
    expect(w.selfTest.folders).toEqual([join(w.root, "versions", "0.2.0")]);
    // On Windows tasksw.exe changed too: the supervisor itself is stopped and started.
    expect(w.control.calls).toEqual([windows ? "restart supervisor" : "restart", "wait 0.2.0"]);
    expect(w.control.version).toBe("0.2.0");
    expect(readdirSync(join(w.root, "versions")).sort()).toEqual(["0.1.0", "0.2.0"]);
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
    const record = readInstallRecord(w.state);
    expect(record?.["versions"]).toEqual(["0.1.0", "0.2.0"]);
    expect(record?.["previous"]).toBe("0.1.0");
    expect(record?.["last_update"]).toMatchObject({
      kind: "update",
      outcome: "completed",
      from: "0.1.0",
      to: "0.2.0",
    });
    if (windows) {
      for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
        expect(readFileSync(join(w.root, "bin", exe))).toEqual(
          readFileSync(join(w.root, "versions", "0.2.0", "bin", exe)),
        );
      }
      // The launchers renamed aside are cleaned once nothing names them.
      expect(readdirSync(join(w.root, "bin")).sort()).toEqual([
        `${PRODUCT_ID}.exe`,
        `${PRODUCT_ID}w.exe`,
      ]);
    }

    // The same archive again: already current, nothing done.
    expect(await updateFromArchive(release.archive, w.options)).toEqual({
      outcome: "current",
      version: "0.2.0",
    });
    // --rollback: the previous version, self-tested, becomes current again; then forward again.
    expect(await rollbackUpdate(w.options)).toEqual({
      outcome: "updated",
      from: "0.2.0",
      to: "0.1.0",
    });
    expect(currentOf(w.root, os)).toBe("0.1.0");
    expect(w.control.version).toBe("0.1.0");
    expect(readInstallRecord(w.state)?.["previous"]).toBe("0.2.0");
    expect(await rollbackUpdate(w.options)).toMatchObject({ to: "0.2.0" });
    expect(currentOf(w.root, os)).toBe("0.2.0");
  });

  test("no service runs: none is started; a failed self-test changes nothing; a service that does not come back rolls the update back", async () => {
    const quiet = await world("quiet", false);
    const r2 = fixtureRelease(join(quiet.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(r2.archive, quiet.options);
    expect(quiet.control.calls).toEqual([]);
    expect(currentOf(quiet.root, os)).toBe("0.2.0");

    const failing = await world("selftest");
    const before = installTree(failing.root);
    const r3 = fixtureRelease(join(failing.dir, "r3"), "0.3.0", os, key, { launcher: "three" });
    const failed = await refusal(
      updateFromArchive(r3.archive, { ...failing.options, selfTest: fakeSelfTest(false) }),
    );
    expect(failed.message).toMatch(/failed its self-test/);
    expect(currentOf(failing.root, os)).toBe("0.1.0");
    // The verified version folder stays (a version folder is never removed); nothing else changed.
    expect(installTree(failing.root).filter((p) => !p.startsWith("versions/0.3.0"))).toEqual(
      before,
    );
    expect(failing.control.calls).toEqual([]);

    const down = await world("down");
    down.control.failRestarts = true;
    const r4 = fixtureRelease(join(down.dir, "r4"), "0.4.0", os, key, { launcher: "four" });
    const back = await refusal(updateFromArchive(r4.archive, down.options));
    expect(back.exitCode).toBe(6);
    expect(back.message).toMatch(/0\.1\.0 is current again/);
    expect(currentOf(down.root, os)).toBe("0.1.0");
    expect(existsSync(join(down.state, UPDATE_JOURNAL))).toBe(false);
    expect(readInstallRecord(down.state)?.["last_update"]).toMatchObject({
      outcome: "reverted",
      reason: "restart_failed",
      from: "0.1.0",
      to: "0.4.0",
    });
    if (windows) {
      expect(readFileSync(join(down.root, "bin", `${PRODUCT_ID}.exe`), "utf8")).toBe(
        "console launcher 0.1.0",
      );
    }
  });

  test("a reverted update keeps the version --rollback goes back to", async () => {
    const w = await world("keep-previous");
    const r2 = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(r2.archive, w.options);
    expect(readInstallRecord(w.state)?.["previous"]).toBe("0.1.0");
    // 0.2.0 to 0.3.0 fails after the switch (the service does not come back): 0.2.0 stays.
    w.control.failRestarts = true;
    const r3 = fixtureRelease(join(w.dir, "r3"), "0.3.0", os, key, { launcher: "three" });
    expect((await refusal(updateFromArchive(r3.archive, w.options))).exitCode).toBe(6);
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(readInstallRecord(w.state)?.["previous"]).toBe("0.1.0");
    // So --rollback still goes back to the version before the last completed switch.
    w.control.failRestarts = false;
    expect(await rollbackUpdate(w.options)).toEqual({
      outcome: "updated",
      from: "0.2.0",
      to: "0.1.0",
    });
  });

  test("a stable command that is not what an install writes stops the update before current changes, with no journal left", async () => {
    const w = await world("odd-bin");
    const stableFile = join(w.root, "bin", windows ? `${PRODUCT_ID}.exe` : PRODUCT_ID);
    rmSync(stableFile);
    mkdirSync(stableFile);
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const refused = await refusal(updateFromArchive(release.archive, w.options));
    expect(refused.exitCode).toBe(4);
    expect(refused.message).toMatch(/not what an install writes/);
    expect(currentOf(w.root, os)).toBe("0.1.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
    expect(w.control.calls).toEqual([]);
  });

  test("a person's data stays byte for byte: the spaces, config and state but the updater's own files, through an update and a rollback", async () => {
    const w = await world("data", false);
    // A space, machine.toml, and the state files a service keeps.
    const space = join(w.dir, "spaces", "demo");
    mkdirSync(join(space, "backups"), { recursive: true });
    writeFileSync(join(space, "space.sqlite"), "fixture database bytes");
    writeFileSync(join(space, "backups", "daily.kbak"), "fixture backup");
    mkdirSync(join(w.root, "config"), { recursive: true });
    writeFileSync(join(w.root, "config", "machine.toml"), `[[spaces]]\npath = "demo"\n`);
    writeFileSync(join(w.state, "machine.json"), "{}");
    mkdirSync(join(w.state, "spaces"), { recursive: true });
    writeFileSync(join(w.state, "spaces", "sp_x.json"), "{}");
    const own = new Set(["update.lock", "update.json", "install.json"]);
    const data = () => ({
      space: tree(space),
      config: tree(join(w.root, "config")),
      state: tree(w.state, (p) => own.has(p) || p === "tmp" || p.startsWith("tmp/")),
    });
    const before = data();
    const r2 = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(r2.archive, w.options);
    expect(data()).toEqual(before);
    await rollbackUpdate(w.options);
    expect(data()).toEqual(before);
  });
});

describe("[A2.3.12.6.update.runs] an update holds new runs back, waits for the running ones, then stops them or gives up as the person decides", () => {
  const running = [
    { space_name: "Work", task: "WORK-12", state: "running" },
    { space_name: "Work", task: null, state: "unknown" },
  ];

  test("runs that finish during the wait let the update go on without a question; with none it does not wait", async () => {
    const w = await world("runs-wait");
    const runs = new FakeRuns(running);
    w.control.runs = runs;
    let asked = 0;
    const options: UpdateOptions = {
      ...w.options,
      runs: {
        waitMs: 60_000,
        decide: () => {
          asked += 1;
          return Promise.resolve("give_up");
        },
      },
    };
    const r2 = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const updating = updateFromArchive(r2.archive, options);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing changed while it waits: no journal, current as it was, the service untouched.
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
    expect(currentOf(w.root, os)).toBe("0.1.0");
    expect(w.control.calls).toEqual(["hold"]);
    runs.set([running[0] ?? running[1] ?? { space_name: null, task: null, state: "running" }]);
    runs.set([]);
    expect(await updating).toMatchObject({ outcome: "updated", to: "0.2.0" });
    expect(asked).toBe(0);
    // The hold lasts until the restart, and goes after it.
    const restart = windows ? "restart supervisor" : "restart";
    expect(w.control.calls).toEqual(["hold", restart, "wait 0.2.0", "release"]);
    expect(w.said).toEqual(
      expect.arrayContaining([
        "The restart would cut short 2 runs:",
        "  WORK-12 in Work: running",
        "  A routine's run in Work: not confirmed ended",
        "The runs finished.",
      ]),
    );

    // A rollback with nothing running neither waits nor says anything about runs.
    w.control.calls.length = 0;
    w.said.length = 0;
    expect(await rollbackUpdate(options)).toMatchObject({ to: "0.1.0" });
    expect(w.control.calls).toEqual(["hold", restart, "wait 0.1.0", "release"]);
    expect(w.said.some((line) => /cut short|runs/.test(line))).toBe(false);
  });

  test("runs still running after the wait: giving up changes nothing; stopping them goes on with the update", async () => {
    const w = await world("runs-ask");
    const runs = new FakeRuns(running);
    w.control.runs = runs;
    const before = installTree(w.root);
    const r2 = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const asked: number[] = [];
    const given = await refusal(
      updateFromArchive(r2.archive, {
        ...w.options,
        runs: {
          waitMs: 30,
          decide: (blocking) => {
            asked.push(blocking.length);
            return Promise.resolve("give_up");
          },
        },
      }),
    );
    expect(given.exitCode).toBe(2);
    expect(given.message).toMatch(/given up while 2 runs still run\. Nothing was changed\./);
    expect(asked).toEqual([2]);
    expect(currentOf(w.root, os)).toBe("0.1.0");
    expect(installTree(w.root).filter((p) => !p.startsWith("versions/0.2.0"))).toEqual(before);
    expect(w.control.calls).toEqual(["hold", "release"]);

    w.control.calls.length = 0;
    runs.stubborn = [{ space_name: "Work", task: null, state: "unknown" }];
    // A unit an earlier version wrote gets Delegate=yes before the restart, and the person hears.
    w.control.delegateUnit = () => {
      w.control.calls.push("delegate");
      return Promise.resolve(true);
    };
    const result = await updateFromArchive(r2.archive, {
      ...w.options,
      runs: { waitMs: 30, decide: () => Promise.resolve("stop") },
    });
    expect(result).toMatchObject({ outcome: "updated", to: "0.2.0" });
    const restart = windows ? "restart supervisor" : "restart";
    expect(w.control.calls).toEqual([
      "hold",
      "stop runs",
      "delegate",
      restart,
      "wait 0.2.0",
      "release",
    ]);
    expect(w.said).toEqual(
      expect.arrayContaining([
        "Stopping the runs. Each keeps its answer so far.",
        "The service's systemd unit now has Delegate=yes, which background runs need.",
        "The restart ends what did not stop in time: 1 run.",
      ]),
    );
  });
});

describe("[A2.3.12.6.update.repair] a repair finishes or rolls back whatever an interrupted update left, and is safe to run again after it was cut off", () => {
  /** Runs an update and stops it at `point` by throwing there: what a kill leaves on disk. */
  async function cutAt(label: string, point: UpdatePoint) {
    const w = await world(label);
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const cut = new Error("cut");
    await expect(
      updateFromArchive(release.archive, {
        ...w.options,
        seams: {
          update: (at) => {
            if (at === point) throw cut;
          },
        },
      }),
    ).rejects.toBeDefined();
    return w;
  }

  test.each(["prepared", "unpacked", "placed", "tested", "staged"] as const)(
    "a failure at %s, before the switch, leaves the old version current and a repair with nothing to undo",
    async (point) => {
      const w = await cutAt(`pre-${point}`, point);
      expect(currentOf(w.root, os)).toBe("0.1.0");
      const repaired = await repairUpdate(w.options);
      expect(repaired).toMatchObject({ outcome: "repaired", current: "0.1.0" });
      expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
      expect(readdirSync(join(w.root, "versions")).filter((n) => n.startsWith("."))).toEqual([]);
    },
  );

  test("every state a kill can leave between the journal's steps ends on a complete version, and a repair cut off at any of its own steps is finished by the next", async () => {
    const w = await world("states");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    // Make the new version installed, then lay out each state by hand from its journal.
    await updateFromArchive(release.archive, w.options);
    await rollbackUpdate(w.options);
    const base: Journal = {
      format: 1,
      kind: "update",
      from: "0.1.0",
      to: "0.2.0",
      phase: "staged",
      pid: 1,
      started_at: new Date(0).toISOString(),
      staging: null,
      service: true,
      tested: true,
      launchers: windows
        ? [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`].map((name) => ({
            name,
            old: sha(join(w.root, "versions", "0.1.0", "bin", name)),
            new: sha(join(w.root, "versions", "0.2.0", "bin", name)),
          }))
        : [],
    };
    const states: { name: string; journal: Journal; current: string; expect: string }[] = [
      { name: "staged, current old", journal: base, current: "0.1.0", expect: "0.1.0" },
      { name: "staged, current new", journal: base, current: "0.2.0", expect: "0.2.0" },
      {
        name: "switched",
        journal: { ...base, phase: "switched" },
        current: "0.2.0",
        expect: "0.2.0",
      },
      {
        name: "restarted",
        journal: { ...base, phase: "restarted" },
        current: "0.2.0",
        expect: "0.2.0",
      },
      {
        name: "rolling back, current new",
        journal: { ...base, phase: "rolling_back" },
        current: "0.2.0",
        expect: "0.1.0",
      },
      {
        name: "prepare with a staging folder",
        journal: {
          ...base,
          phase: "prepare",
          staging: ".staging-00112233445566aa",
          tested: false,
        },
        current: "0.1.0",
        expect: "0.1.0",
      },
    ];
    const points = [
      "repair:decided",
      "repair:current",
      "repair:launchers",
      "repair:record",
    ] as const;
    for (const s of states) {
      for (const cutPoint of [undefined, ...points]) {
        const label = `${s.name} / ${cutPoint ?? "whole"}`;
        writeCurrent(w.root, currentFor(s.current, os), os);
        if (windows) halfSwap(w.root, s.current === "0.2.0" ? "0.2.0" : "0.1.0");
        if (s.journal.staging !== null) {
          mkdirSync(join(w.root, "versions", s.journal.staging, "lib"), { recursive: true });
        }
        writeJournal(w.state, s.journal);
        if (cutPoint !== undefined) {
          expect(() =>
            repairLocked({
              root: w.root,
              state: w.state,
              platform: os,
              seams: {
                at: (p) => {
                  if (p === cutPoint) throw new Error("cut");
                },
              },
            }),
          ).toThrow("cut");
        }
        const outcome = repairLocked({ root: w.root, state: w.state, platform: os });
        expect(outcome.kind, label).toBe(s.expect === "0.2.0" ? "rolled_forward" : "rolled_back");
        expect(currentOf(w.root, os), label).toBe(s.expect);
        expect(existsSync(join(w.state, UPDATE_JOURNAL)), label).toBe(false);
        expect(
          readdirSync(join(w.root, "versions")).filter((n) => n.startsWith(".")),
          label,
        ).toEqual([]);
        if (windows) {
          for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
            expect(readFileSync(join(w.root, "bin", exe)), `${label} ${exe}`).toEqual(
              readFileSync(join(w.root, "versions", s.expect, "bin", exe)),
            );
          }
        }
        // A second repair finds nothing to do.
        expect(repairLocked({ root: w.root, state: w.state, platform: os }).kind, label).toBe(
          "nothing",
        );
      }
    }
  });

  test("a repair never goes back to an old version that is not complete: it keeps the complete new one, or with neither complete it is stuck", async () => {
    const w = await world("broken-old");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(release.archive, w.options);
    const journal: Journal = {
      format: 1,
      kind: "update",
      from: "0.1.0",
      to: "0.2.0",
      phase: "rolling_back",
      pid: 1,
      started_at: new Date(0).toISOString(),
      staging: null,
      service: false,
      tested: true,
      launchers: windows
        ? [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`].map((name) => ({
            name,
            old: sha(join(w.root, "versions", "0.1.0", "bin", name)),
            new: sha(join(w.root, "versions", "0.2.0", "bin", name)),
          }))
        : [],
    };
    // The old version keeps its manifest but lost a file: going back would leave a broken install.
    rmSync(join(w.root, "versions", "0.1.0", "lib", `${PRODUCT_ID}.mjs`));
    // A new version that never passed its self-test (an update cut off after it was placed, before
    // the test) is not made current instead: nothing is complete and tested, so it is stuck.
    writeCurrent(w.root, currentFor("0.1.0", os), os);
    writeJournal(w.state, { ...journal, phase: "prepare", tested: false, launchers: [] });
    expect(repairLocked({ root: w.root, state: w.state, platform: os }).kind).toBe("stuck");
    expect(currentOf(w.root, os)).toBe("0.1.0");
    writeCurrent(w.root, currentFor("0.2.0", os), os);
    // One that passed it is kept.
    writeJournal(w.state, journal);
    const kept = repairLocked({ root: w.root, state: w.state, platform: os });
    expect(kept.kind).toBe("rolled_forward");
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
    // With the new one broken too, nothing is complete: the journal stays and current is left.
    rmSync(join(w.root, "versions", "0.2.0", "lib", `${PRODUCT_ID}.mjs`));
    writeJournal(w.state, journal);
    const stuck = repairLocked({ root: w.root, state: w.state, platform: os });
    expect(stuck.kind).toBe("stuck");
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(true);
  });

  test("a repair cut off after it reconciled the install still brings back the service the update had stopped", async () => {
    // An update cut off after its switch, which had stopped the service it found running.
    const w = await world("restart-intent");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(release.archive, w.options);
    await rollbackUpdate(w.options);
    const journal: Journal = {
      format: 1,
      kind: "update",
      from: "0.1.0",
      to: "0.2.0",
      phase: "switched",
      pid: 1,
      started_at: new Date(0).toISOString(),
      staging: null,
      service: true,
      tested: true,
      launchers: windows
        ? [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`].map((name) => ({
            name,
            old: sha(join(w.root, "versions", "0.1.0", "bin", name)),
            new: sha(join(w.root, "versions", "0.2.0", "bin", name)),
          }))
        : [],
    };
    writeCurrent(w.root, currentFor("0.2.0", os), os);
    writeJournal(w.state, journal);
    w.control.version = undefined;
    // tasks update --repair, cut off once the install is reconciled, before the service is back...
    const cut = new Error("cut");
    await expect(
      repairUpdate({
        ...w.options,
        seams: {
          at: (point) => {
            if (point === "repair:done") throw cut;
          },
        },
      }),
    ).rejects.toBe(cut);
    expect(w.control.version).toBeUndefined();
    // ...leaves what the next one needs to bring it back.
    expect(await repairUpdate(w.options)).toMatchObject({ current: "0.2.0" });
    expect(w.control.version).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);

    // The same for an update's own rollback cut off before it brought the old service back...
    w.control.failRestarts = true;
    const r3 = fixtureRelease(join(w.dir, "r3"), "0.3.0", os, key, { launcher: "three" });
    await expect(
      updateFromArchive(r3.archive, {
        ...w.options,
        seams: {
          at: (point) => {
            if (point === "repair:done") throw cut;
          },
        },
      }),
    ).rejects.toBeDefined();
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(w.control.version).toBeUndefined();
    // ...and for the next update, which finishes that first: the service runs current again.
    w.control.failRestarts = false;
    const r4 = fixtureRelease(join(w.dir, "r4"), "0.4.0", os, key, { launcher: "four" });
    await updateFromArchive(r4.archive, { ...w.options, selfTest: fakeSelfTest(false) }).catch(
      () => undefined,
    );
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(w.control.version).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
  });

  test.runIf(windows)(
    "when an update changed tasksw.exe, a rollback and a repair start the supervisor again too, not only the service under it",
    async () => {
      // The restart after the switch fails: the rollback brings back the old supervisor as well.
      const w = await world("supervisor");
      w.control.failRestarts = true;
      const r2 = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
      expect((await refusal(updateFromArchive(r2.archive, w.options))).exitCode).toBe(6);
      expect(w.control.calls).toEqual([
        "restart supervisor",
        "wait 0.2.0",
        "restart supervisor",
        "wait 0.1.0",
      ]);
      // An update cut off after its switch, whose service the old supervisor already restarted
      // on the new version: the repair still replaces the supervisor.
      w.control.failRestarts = false;
      await updateFromArchive(r2.archive, w.options);
      await rollbackUpdate(w.options);
      writeCurrent(w.root, currentFor("0.2.0", os), os);
      writeJournal(w.state, {
        format: 1,
        kind: "update",
        from: "0.1.0",
        to: "0.2.0",
        phase: "switched",
        pid: 1,
        started_at: new Date(0).toISOString(),
        staging: null,
        service: true,
        tested: true,
        launchers: [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`].map((name) => ({
          name,
          old: sha(join(w.root, "versions", "0.1.0", "bin", name)),
          new: sha(join(w.root, "versions", "0.2.0", "bin", name)),
        })),
      });
      w.control.version = "0.2.0";
      w.control.calls.length = 0;
      await repairUpdate(w.options);
      expect(w.control.calls).toEqual(["restart supervisor", "wait 0.2.0"]);
      expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
    },
  );

  test("a service that cannot be started again after a repair is an update error with exit 6, and the journal still goes", async () => {
    const w = await world("restart-throws");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await updateFromArchive(release.archive, w.options);
    await rollbackUpdate(w.options);
    writeCurrent(w.root, currentFor("0.2.0", os), os);
    writeJournal(w.state, {
      format: 1,
      kind: "update",
      from: "0.1.0",
      to: "0.2.0",
      phase: "restarted",
      pid: 1,
      started_at: new Date(0).toISOString(),
      staging: null,
      service: true,
      tested: true,
      launchers: windows
        ? [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`].map((name) => ({
            name,
            old: sha(join(w.root, "versions", "0.1.0", "bin", name)),
            new: sha(join(w.root, "versions", "0.2.0", "bin", name)),
          }))
        : [],
    });
    w.control.version = undefined;
    w.control.restartError = new ServiceCommandError(
      "service",
      "start_failed",
      "The service manager refused the start.",
    );
    const failed = await refusal(repairUpdate(w.options));
    expect(failed.exitCode).toBe(6);
    expect(failed.message).toMatch(/The service manager refused the start/);
    expect(failed.message).toMatch(/service start/);
    expect(currentOf(w.root, os)).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
  });

  test("an unreadable journal keeps current's complete version; tasks update --repair and an install's finish repair first", async () => {
    const w = await world("invalid");
    writeFileSync(join(w.state, UPDATE_JOURNAL), "{ not json");
    const repaired = await repairUpdate(w.options);
    expect(repaired).toMatchObject({
      outcome: "repaired",
      repair: { kind: "kept" },
      current: "0.1.0",
    });
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);

    // An install script's finish meets a journal of an update cut off after its switch: the
    // update is finished first, and only then does the install switch.
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    await expect(
      updateFromArchive(release.archive, {
        ...w.options,
        seams: {
          update: (at) => {
            if (at === "switched") throw new Error("cut");
          },
        },
      }),
    ).rejects.toBeDefined();
    // The updater's own rollback ran (a thrown step is a failure, not a kill): back on 0.1.0.
    expect(currentOf(w.root, os)).toBe("0.1.0");
    writeJournal(w.state, {
      format: 1,
      kind: "update",
      from: "0.1.0",
      to: "0.2.0",
      phase: "switched",
      pid: 1,
      started_at: new Date(0).toISOString(),
      staging: null,
      service: false,
      tested: true,
      launchers: [],
    });
    writeCurrent(w.root, currentFor("0.2.0", os), os);
    const third = join(w.root, "versions", "0.3.0");
    writeFolder(third, "0.3.0", os, fixtureFiles("0.3.0", os));
    await finishInstall({ versionFolder: third, facts: w.options.facts });
    expect(currentOf(w.root, os)).toBe("0.3.0");
    expect(readInstallRecord(w.state)?.["previous"]).toBe("0.2.0");
    expect(existsSync(join(w.state, UPDATE_JOURNAL))).toBe(false);
  });
});

describe("[A2.3.12.6.update.lock] a second update waits for the first and then finds it done", () => {
  test("while another process holds update.lock the update waits, changing nothing, and goes on once it is let go", async () => {
    const w = await world("lock");
    const release = fixtureRelease(join(w.dir, "r2"), "0.2.0", os, key, { launcher: "two" });
    const racer = fork(RACER, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    /** Sends `message` and resolves with the racer's first answer that has `field`. */
    const ask = (message: object, field: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const listen = (answer: Record<string, unknown>) => {
          if (!(field in answer)) return;
          racer.off("message", listen);
          resolve(answer);
        };
        racer.on("message", listen);
        racer.send(message);
      });
    const take = () => ask({ go: Date.now(), path: join(w.state, "update.lock") }, "won");
    try {
      expect((await take())["won"]).toBe(true);
      const before = installTree(w.root);
      const waiting = updateFromArchive(release.archive, w.options);
      let settled = false;
      void waiting.then(
        () => (settled = true),
        () => (settled = true),
      );
      for (let i = 0; i < 100 && w.said.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(w.said.join("\n")).toMatch(/Another update of this install is running/);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false);
      expect(installTree(w.root)).toEqual(before);
      await ask({ release: true }, "released");
      expect(await waiting).toEqual({ outcome: "updated", from: "0.1.0", to: "0.2.0" });
      // A wait has a bound: with the lock held throughout it gives up, having changed nothing.
      expect((await take())["won"]).toBe(true);
      const gaveUp = await refusal(rollbackUpdate({ ...w.options, lockWaitMs: 1_000 }));
      expect(gaveUp.exitCode).toBe(4);
      expect(currentOf(w.root, os)).toBe("0.2.0");
    } finally {
      racer.send({ exit: true });
      await new Promise((resolve) => racer.once("exit", resolve));
    }
  });
});

// ---------------------------------------------------------------------------------------------

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Windows: a bin folder halfway through a launcher swap, as a kill between the two renames of
 * tasks.exe leaves it: tasks.exe renamed aside, the other launcher still `side`'s.
 */
function halfSwap(root: string, side: string): void {
  const bin = join(root, "bin");
  for (const name of readdirSync(bin)) rmSync(join(bin, name), { force: true });
  const console = join(bin, `${PRODUCT_ID}.exe`);
  cpSync(
    join(root, "versions", side === "0.2.0" ? "0.1.0" : "0.2.0", "bin", `${PRODUCT_ID}.exe`),
    `${console}.old-1`,
  );
  cpSync(
    join(root, "versions", side, "bin", `${PRODUCT_ID}w.exe`),
    join(bin, `${PRODUCT_ID}w.exe`),
  );
}
