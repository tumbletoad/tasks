// The switch of `ttasks install --finish` (A2 3.12.4, 3.12.6; A7 3.8 M1.14) on fixture version
// folders in temporary install roots: it belongs to a separate install the launcher named, takes
// update.lock, points current at the version, puts the stable command in place and writes
// install.json with what the installer created. Refusals change nothing.
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRODUCT_ID } from "@ttasks/brand";
import { canonicalStatePath, installId, type HostFacts } from "../hub/paths.ts";
import { writeVersionManifest } from "./folder.ts";
import { finishInstall, InstallError, installTarget, type InstallRecord } from "./install.ts";
import { noteWorking } from "./repair.ts";
import { currentFor, writeCurrent } from "./switch.ts";
import { repairUpdate, rollbackUpdate } from "./update.ts";

const windows = process.platform === "win32";
const RACER = fileURLToPath(new URL("../../test/lock-racer.ts", import.meta.url));

let work: string;
beforeAll(() => {
  work = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-finish-")));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let count = 0;
/** A root with home.marker and one fixture version folder in it (no runtime: nothing runs it). */
function install(version = "0.1.0", launcher = "launcher one"): { root: string; folder: string } {
  count += 1;
  const root = join(work, `root-${String(count)}`);
  const folder = addVersion(root, version, launcher);
  writeFileSync(join(root, "home.marker"), "");
  return { root, folder };
}

/** A fixture version folder. With `program`, its ttasks.exe is a copy of that real program. */
function addVersion(
  root: string,
  version: string,
  launcher = "launcher one",
  program?: string,
): string {
  const folder = join(root, "versions", version);
  mkdirSync(join(folder, "bin"), { recursive: true });
  mkdirSync(join(folder, "lib"), { recursive: true });
  if (windows) {
    if (program === undefined) {
      writeFileSync(join(folder, "bin", `${PRODUCT_ID}.exe`), `${launcher} console`);
    } else {
      copyFileSync(program, join(folder, "bin", `${PRODUCT_ID}.exe`));
    }
    writeFileSync(join(folder, "bin", `${PRODUCT_ID}w.exe`), `${launcher} gui`);
  } else {
    writeFileSync(join(folder, "bin", PRODUCT_ID), "#!/bin/sh\n");
  }
  writeFileSync(join(folder, "lib", `${PRODUCT_ID}.mjs`), "// fixture entry\n");
  writeVersionManifest(folder, {
    version,
    build: "fixture0finish",
    platform: windows ? "win-x64" : "linux-x64",
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? "",
    protocol: { min: 1, max: 1 },
  });
  return folder;
}

const facts = (home: string | undefined): HostFacts => ({
  platform: process.platform,
  env: home === undefined ? {} : { TTASKS_HOME: home },
  accountHome: work,
  uid: process.getuid?.(),
});

const record = (root: string): InstallRecord =>
  JSON.parse(readFileSync(join(root, "state", "install.json"), "utf8")) as InstallRecord;

const currentOf = (root: string): string =>
  windows ? readFileSync(join(root, "current"), "utf8") : readlinkSync(join(root, "current"));

const refusal = async (promise: Promise<unknown>): Promise<InstallError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InstallError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("[A2.3.12.6.install.finish] ttasks install --finish switches current only for its own separate install", () => {
  test("a fresh install: update.lock, current, the stable command and install.json with what was created", async () => {
    const { root, folder } = install();
    const done = await finishInstall({
      versionFolder: folder,
      facts: facts(root),
      created: [".", "versions", "versions/0.1.0", "home.marker"],
    });
    expect(currentOf(root)).toBe(windows ? "0.1.0" : "versions/0.1.0");
    if (windows) {
      for (const exe of [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`]) {
        expect(readFileSync(join(root, "bin", exe))).toEqual(
          readFileSync(join(folder, "bin", exe)),
        );
      }
    } else {
      expect(readlinkSync(join(root, "bin", PRODUCT_ID))).toBe(`../current/bin/${PRODUCT_ID}`);
      expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "state", "install.json")).mode & 0o777).toBe(0o600);
    }
    const state = realpathSync.native(join(root, "state"));
    const id = installId(canonicalStatePath(state, process.platform));
    expect(done).toMatchObject({ root, version: "0.1.0", build: "fixture0finish", installId: id });
    expect(record(root)).toEqual({
      format: 1,
      method: "script",
      channel: "local",
      root,
      install_id: id,
      versions: ["0.1.0"],
      created: [
        ".",
        "bin",
        ...(windows ? [`bin/${PRODUCT_ID}.exe`, `bin/${PRODUCT_ID}w.exe`] : [`bin/${PRODUCT_ID}`]),
        "current",
        "home.marker",
        "state",
        "versions",
        "versions/0.1.0",
      ].sort(),
    });
  });

  test("a second version becomes current; what the first install created stays on record; changed launchers are swapped aside", async () => {
    const { root, folder } = install();
    await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
    const next = addVersion(root, "0.2.0", "launcher two");
    await finishInstall({ versionFolder: next, facts: facts(root), created: ["versions/0.2.0"] });
    expect(currentOf(root)).toBe(windows ? "0.2.0" : "versions/0.2.0");
    const second = record(root);
    expect(second.versions).toEqual(["0.1.0", "0.2.0"]);
    expect(second.created).toContain(".");
    expect(second.created).toContain("versions/0.2.0");
    if (windows) {
      // The running launcher may not be replaced in place: the old one is renamed aside.
      expect(readFileSync(join(root, "bin", `${PRODUCT_ID}.exe`), "utf8")).toBe(
        "launcher two console",
      );
      expect(readFileSync(join(root, "bin", `${PRODUCT_ID}.exe.old-1`), "utf8")).toBe(
        "launcher one console",
      );
    }
    // The same version again changes nothing it need not change.
    await finishInstall({ versionFolder: next, facts: facts(root) });
    expect(currentOf(root)).toBe(windows ? "0.2.0" : "versions/0.2.0");
    if (windows) expect(existsSync(join(root, "bin", `${PRODUCT_ID}.exe.old-2`))).toBe(false);
  });

  test("it runs only for the install its launcher named: a separate install with home.marker, the version in its own folder", () => {
    const { root, folder } = install();
    expect(() => installTarget(folder, facts(undefined))).toThrow(/separate installs only/);
    expect(() => installTarget(folder, facts(join(work, "elsewhere")))).toThrow(
      /not this version's install root/,
    );
    rmSync(join(root, "home.marker"));
    expect(() => installTarget(folder, facts(root))).toThrow(/separate installs only/);
    writeFileSync(join(root, "home.marker"), "");
    const misnamed = join(root, "versions", "0.9.9");
    mkdirSync(misnamed);
    writeFileSync(join(misnamed, "manifest.json"), readFileSync(join(folder, "manifest.json")));
    expect(() => installTarget(misnamed, facts(root))).toThrow(/name is not its version/);
    expect(() => installTarget(join(root, "loose"), facts(root))).toThrow(
      /not in a versions folder/,
    );
    expect(installTarget(folder, facts(root)).version).toBe("0.1.0");
  });

  test("a current or a stable command that is not an install's, or a --created it cannot have made, stops before current, the stable command or install.json change", async () => {
    const { root, folder } = install();
    expect(
      (
        await refusal(
          finishInstall({ versionFolder: folder, facts: facts(root), created: ["state"] }),
        )
      ).exitCode,
    ).toBe(2);
    mkdirSync(join(root, "current"));
    const odd = await refusal(finishInstall({ versionFolder: folder, facts: facts(root) }));
    expect(odd.exitCode).toBe(4);
    expect(lstatSync(join(root, "current")).isDirectory()).toBe(true);
    expect(existsSync(join(root, "bin"))).toBe(false);
    expect(existsSync(join(root, "state", "install.json"))).toBe(false);
    rmSync(join(root, "current"), { recursive: true });
    mkdirSync(join(root, "bin"));
    if (windows) mkdirSync(join(root, "bin", `${PRODUCT_ID}.exe`));
    else writeFileSync(join(root, "bin", PRODUCT_ID), "someone else's\n");
    const stable = await refusal(finishInstall({ versionFolder: folder, facts: facts(root) }));
    expect(stable.message).toMatch(/not what an install writes/);
    expect(existsSync(join(root, "current"))).toBe(false);
  });

  test("a failure after current switched puts current and the stable command back as they were", async () => {
    // The install receipt cannot be written (its name is taken by a folder): that happens after
    // current and the stable command changed, so both must go back.
    const { root, folder } = install();
    await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
    const stable = join(root, "bin", windows ? `${PRODUCT_ID}.exe` : PRODUCT_ID);
    const stableBefore = windows ? readFileSync(stable, "utf8") : readlinkSync(stable);
    const receipt = join(root, "state", "install.json");
    const recordBefore = readFileSync(receipt, "utf8");
    rmSync(receipt);
    mkdirSync(join(receipt, "taken"), { recursive: true });
    const next = addVersion(root, "0.2.0", "launcher two");
    const failed = await refusal(finishInstall({ versionFolder: next, facts: facts(root) }));
    expect(failed.message).toMatch(/current and the stable command were put back as they were/);
    expect(currentOf(root)).toBe(windows ? "0.1.0" : "versions/0.1.0");
    expect(windows ? readFileSync(stable, "utf8") : readlinkSync(stable)).toBe(stableBefore);
    if (windows) {
      expect(readFileSync(join(root, "bin", `${PRODUCT_ID}w.exe`), "utf8")).toBe(
        "launcher one gui",
      );
    }
    // Nothing of the failed switch is left in bin: no aside copy, no temporary file.
    expect(readdirSync(join(root, "bin")).sort(), "bin holds only the stable command").toEqual(
      windows ? [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`] : [PRODUCT_ID],
    );
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
    rmSync(receipt, { recursive: true });
    writeFileSync(receipt, recordBefore);

    // A first install that fails there leaves no current and no stable command.
    const fresh = install();
    // The state folder 0700, as the product makes it, whatever the umask (A2 3.2.2 rule 5).
    mkdirSync(join(fresh.root, "state", "install.json", "taken"), { recursive: true, mode: 0o700 });
    const first = await refusal(
      finishInstall({ versionFolder: fresh.folder, facts: facts(fresh.root) }),
    );
    expect(first.message).toMatch(/were put back as they were/);
    expect(existsSync(join(fresh.root, "current"))).toBe(false);
    expect(existsSync(join(fresh.root, "bin"))).toBe(false);
  });

  test.runIf(windows)(
    "a new launcher that a client started before the failure goes aside, and the old one comes back",
    async () => {
      const { root, folder } = install();
      await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
      // The new version's ttasks.exe is a real program, so it can run from bin, where Windows
      // lets it be renamed but not deleted.
      const next = addVersion(root, "0.2.0", "launcher two", process.execPath);
      rmSync(join(root, "state", "install.json"));
      mkdirSync(join(root, "state", "install.json", "taken"), { recursive: true, mode: 0o700 });
      const stable = join(root, "bin", `${PRODUCT_ID}.exe`);
      let client: ReturnType<typeof spawn> | undefined;
      try {
        const failed = await refusal(
          finishInstall({
            versionFolder: next,
            facts: facts(root),
            afterSwitch: async () => {
              client = spawn(stable, ["-e", "setTimeout(() => {}, 60000)"], {
                stdio: "ignore",
                windowsHide: true,
              });
              await once(client, "spawn");
            },
          }),
        );
        expect(failed.message).toMatch(/current and the stable command were put back as they were/);
        expect(currentOf(root)).toBe("0.1.0");
        expect(readFileSync(stable, "utf8")).toBe("launcher one console");
        // The running new launcher went aside, beside the old one's own aside name while that
        // was in use; nothing else is left.
        expect(readdirSync(join(root, "bin")).sort()).toEqual([
          `${PRODUCT_ID}.exe`,
          `${PRODUCT_ID}.exe.old-2`,
          `${PRODUCT_ID}w.exe`,
        ]);
      } finally {
        if (client !== undefined) {
          client.kill();
          await once(client, "exit");
        }
      }
    },
    60_000,
  );

  test.runIf(windows)(
    "a launcher that a sibling repair puts back during the finish is this install's: recorded as created, and undone with current first, so no repair brings it back",
    async () => {
      const launchers = [`${PRODUCT_ID}.exe`, `${PRODUCT_ID}w.exe`];
      /**
       * What a stable launcher started at this moment does first (launcher.c repair_sibling) while
       * an update's journal is there, as a stuck update's journal is through the finish: a missing
       * sibling is put back from the version current names. Its own tests are in
       * packages/launcher-win/test/sibling.test.ts.
       */
      const siblingRepair = (root: string) => () => {
        if (!existsSync(join(root, "current"))) return;
        const version = readFileSync(join(root, "current"), "utf8");
        const present = launchers.filter((name) => existsSync(join(root, "bin", name)));
        if (present.length !== 1) return;
        for (const name of launchers.filter((n) => !present.includes(n))) {
          copyFileSync(join(root, "versions", version, "bin", name), join(root, "bin", name));
        }
      };

      // A fresh install: ttasksw.exe appears from the repair while ttasks.exe is in place.
      const fresh = install();
      await finishInstall({
        versionFolder: fresh.folder,
        facts: facts(fresh.root),
        created: ["."],
        afterStep: siblingRepair(fresh.root),
      });
      expect(record(fresh.root).created).toEqual(
        expect.arrayContaining(launchers.map((name) => `bin/${name}`)),
      );

      // One that fails after the switch leaves nothing: no launcher, no bin, no current, also
      // with a launcher started after every step of the undo.
      const failing = install();
      mkdirSync(join(failing.root, "state", "install.json", "taken"), {
        recursive: true,
        mode: 0o700,
      });
      const failed = await refusal(
        finishInstall({
          versionFolder: failing.folder,
          facts: facts(failing.root),
          afterStep: siblingRepair(failing.root),
        }),
      );
      expect(failed.message).toMatch(/current and the stable command were put back as they were/);
      expect(existsSync(join(failing.root, "current"))).toBe(false);
      expect(existsSync(join(failing.root, "bin"))).toBe(false);

      // One whose check of the launcher that appeared fails (its source cannot be read): that
      // launcher is undone too.
      const broken = install();
      let steps = 0;
      const unread = await refusal(
        finishInstall({
          versionFolder: broken.folder,
          facts: facts(broken.root),
          afterStep: () => {
            steps += 1;
            if (steps !== 1) return;
            siblingRepair(broken.root)();
            rmSync(join(broken.folder, "bin", launchers[1] ?? ""));
          },
        }),
      );
      expect(unread.message).toMatch(/current and the stable command were put back as they were/);
      expect(existsSync(join(broken.root, "current"))).toBe(false);
      expect(existsSync(join(broken.root, "bin"))).toBe(false);

      // A second version that fails: the first one's launchers and current come back.
      const { root, folder } = install();
      await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
      rmSync(join(root, "state", "install.json"));
      mkdirSync(join(root, "state", "install.json", "taken"), { recursive: true, mode: 0o700 });
      const next = addVersion(root, "0.2.0", "launcher two");
      await refusal(
        finishInstall({ versionFolder: next, facts: facts(root), afterStep: siblingRepair(root) }),
      );
      expect(currentOf(root)).toBe("0.1.0");
      expect(readdirSync(join(root, "bin")).sort()).toEqual(launchers);
      expect(readFileSync(join(root, "bin", launchers[0] ?? ""), "utf8")).toBe(
        "launcher one console",
      );
      expect(readFileSync(join(root, "bin", launchers[1] ?? ""), "utf8")).toBe("launcher one gui");
    },
  );

  test("while another install or update holds update.lock, it stops with nothing changed", async () => {
    const { root, folder } = install();
    mkdirSync(join(root, "state"), { recursive: true, mode: 0o700 });
    const racer = fork(RACER, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    try {
      const won = await new Promise<{ won: boolean }>((resolve) => {
        racer.once("message", (message: { won: boolean }) => {
          resolve(message);
        });
        racer.send({ go: Date.now(), path: join(root, "state", "update.lock") });
      });
      expect(won.won).toBe(true);
      const busy = await refusal(finishInstall({ versionFolder: folder, facts: facts(root) }));
      expect(busy.exitCode).toBe(4);
      expect(busy.message).toMatch(/Another install or update/);
      expect(existsSync(join(root, "current"))).toBe(false);
    } finally {
      racer.send({ exit: true });
      await new Promise((resolve) => racer.once("exit", resolve));
    }
    await finishInstall({ versionFolder: folder, facts: facts(root) });
    expect(currentOf(root)).toBe(windows ? "0.1.0" : "versions/0.1.0");
  });
});

const CUT = fileURLToPath(new URL("../../test/finish-cut.ts", import.meta.url));

/** Runs the switch in a child that ends at `cut`, as a closed terminal ends an install there. */
async function cutFinish(root: string, versionFolder: string, cut: "switch" | number) {
  const child = fork(CUT, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.send({ versionFolder, facts: facts(root), cut });
  });
  expect(code, "the child ended at its cut").toBe(9);
}

describe("[A2.3.12.6.update.way-back] an install cut off and run again keeps the way back", () => {
  // Windows: also after the first of its two launchers.
  const cuts: ("switch" | number)[] = windows ? [1, "switch"] : ["switch"];

  test.each(cuts)(
    "cut off at %s, then run again twice, the version before it stays the one --rollback goes back to",
    async (cut) => {
      const { root, folder } = install();
      await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
      const next = addVersion(root, "0.2.0", "launcher two");
      await cutFinish(root, next, cut);
      expect(currentOf(root)).toBe(windows ? "0.2.0" : "versions/0.2.0");
      // update.json is what a service of a version from before the install's journal reads, and
      // restarts after: an install cut off leaves nothing there.
      expect(existsSync(join(root, "state", "update.json"))).toBe(false);
      for (const run of [1, 2]) {
        await finishInstall({ versionFolder: next, facts: facts(root) });
        expect(record(root).previous, `run ${String(run)}`).toBe("0.1.0");
      }
      expect(record(root).versions).toEqual(["0.1.0", "0.2.0"]);
      const back = await rollbackUpdate({
        facts: facts(root),
        keys: [],
        selfTest: () => Promise.resolve({ ok: true, failed: [] }),
      });
      expect(back).toMatchObject({ outcome: "updated", from: "0.2.0", to: "0.1.0" });
      expect(currentOf(root)).toBe(windows ? "0.1.0" : "versions/0.1.0");
    },
  );

  test("the version a service was seen working on stays the way back through an install cut off and another installed over it", async () => {
    const { root, folder } = install();
    await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
    // A's service, once ready, notes that A works.
    const state = join(root, "state");
    expect(await noteWorking({ root, state, platform: process.platform, version: "0.1.0" })).toBe(
      true,
    );
    // B's finish is cut off after its first launcher, or its switch; B never runs.
    const b = addVersion(root, "0.2.0", "launcher two");
    await cutFinish(root, b, windows ? 1 : "switch");
    // C is installed over it: the repair finishes B, then C switches.
    const c = addVersion(root, "0.3.0", "launcher three");
    await finishInstall({ versionFolder: c, facts: facts(root) });
    expect(currentOf(root)).toBe(windows ? "0.3.0" : "versions/0.3.0");
    expect(record(root).previous).toBe("0.1.0");
    const back = await rollbackUpdate({
      facts: facts(root),
      keys: [],
      selfTest: () => Promise.resolve({ ok: true, failed: [] }),
    });
    expect(back).toMatchObject({ outcome: "updated", from: "0.3.0", to: "0.1.0" });
    // And an install that found the service running notes that version too.
    const d = addVersion(root, "0.4.0", "launcher four");
    await finishInstall({ versionFolder: d, facts: facts(root), seen: "0.1.0" });
    expect(record(root).seen_working).toEqual(["0.1.0"]);
    expect(record(root).previous).toBe("0.1.0");
  });

  test("a version that can note it was seen working and never did is passed over; one from before that note is the way back", async () => {
    // A is from before the note: it served, but cannot say so.
    const { root, folder } = install();
    fromBeforeTheNote(folder);
    await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
    // A's own switch to B: A is the way back, and nothing is noted as seen.
    const b = addVersion(root, "0.2.0", "launcher two");
    await finishInstall({ versionFolder: b, facts: facts(root) });
    expect(record(root).previous).toBe("0.1.0");
    expect(record(root).seen_working).toBeUndefined();
    // B's service exits at every start, so B never notes itself. C is installed over it.
    const c = addVersion(root, "0.3.0", "launcher three");
    await finishInstall({ versionFolder: c, facts: facts(root) });
    expect(record(root).previous).toBe("0.1.0");

    // C works and is noted; the person goes back to A, which serves again and cannot note it.
    const state = join(root, "state");
    await noteWorking({ root, state, platform: process.platform, version: "0.3.0" });
    await rollbackUpdate({
      facts: facts(root),
      keys: [],
      selfTest: () => Promise.resolve({ ok: true, failed: [] }),
    });
    expect(record(root).previous).toBe("0.3.0");
    // D is installed over A: A, which the person used, is the way back.
    const d = addVersion(root, "0.4.0", "launcher four");
    await finishInstall({ versionFolder: d, facts: facts(root) });
    expect(record(root).previous).toBe("0.1.0");
  });
});

describe("[A2.3.12.6.update.repair] an install's journal is finished by the next install, and never undoes what an older version did since", () => {
  test("an install cut off and then switched past by an older version's own update is left as that update left it", async () => {
    const { root, folder } = install();
    await finishInstall({ versionFolder: folder, facts: facts(root), created: ["."] });
    // C's install is cut off after its switch; the person then updates with A's own command,
    // which knows nothing of an install's journal, to D.
    const c = addVersion(root, "0.3.0", "launcher three");
    await cutFinish(root, c, windows ? 1 : "switch");
    addVersion(root, "0.4.0", "launcher four");
    writeCurrent(root, currentFor("0.4.0", process.platform), process.platform);
    // D's repair, at its start or in its first update, changes nothing of that.
    const repaired = await repairUpdate({
      facts: facts(root),
      keys: [],
      selfTest: () => Promise.resolve({ ok: true, failed: [] }),
    });
    expect(repaired).toMatchObject({ repair: { kind: "nothing" }, current: "0.4.0" });
    expect(currentOf(root)).toBe(windows ? "0.4.0" : "versions/0.4.0");
    expect(readdirSync(join(root, "state")).filter((name) => name.endsWith(".json"))).toEqual([
      "install.json",
    ]);
  });
});

/** The manifest of `folder` as a build from before `notes_seen_working` writes it. */
function fromBeforeTheNote(folder: string): void {
  const file = join(folder, "manifest.json");
  const text = readFileSync(file, "utf8");
  const before = text.replace('  "notes_seen_working": true,\n', "");
  expect(before).not.toBe(text);
  rmSync(file);
  writeFileSync(file, before);
}
