// Old version folders go after an update (retire.ts): only what the pass can show is the
// installer's and no longer needed, the rest stays whole, a removal cut off at either side of its
// rename is finished by the next pass, and a version a process runs keeps every file.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { withVersions } from "../../packages/cli/src/doctor.ts";
import {
  checkVersionFolder,
  writeVersionManifest,
} from "../../packages/service/src/version/folder.ts";
import { UPDATE_JOURNAL } from "../../packages/service/src/version/journal.ts";
import {
  planRetirement,
  retireLocked,
  type RetireOptions,
} from "../../packages/service/src/version/retire.ts";
import {
  currentFor,
  readInstallRecord,
  writeCurrent,
  writeInstallRecord,
} from "../../packages/service/src/version/switch.ts";
import { rollbackUpdate, updateFromArchive } from "../../packages/service/src/version/update.ts";
import {
  currentOf,
  fakeSelfTest,
  FakeControl,
  fixtureFiles,
  fixtureInstall,
  fixtureRelease,
  keyLine,
  scratch,
  throwawayKey,
  tree,
  writeFolder,
} from "./fixture.ts";

const os = process.platform;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

/**
 * An install of 0.1.0 to 0.5.0, current 0.4.0 switched to from 0.3.0 (the way back), so 0.5.0 is
 * newer than current. `pinned` goes into install.json as it is.
 */
async function world(label: string, pinned?: string[]) {
  const made = scratch(label);
  cleanups.push(made.remove);
  const { root } = await fixtureInstall(made.dir, os, "0.1.0");
  const state = join(root, "state");
  const add = (version: string) => {
    writeFolder(join(root, "versions", version), version, os, fixtureFiles(version, os));
    writeInstallRecord(state, root, os, { installed: version });
  };
  for (const version of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"]) add(version);
  writeCurrent(root, currentFor("0.4.0", os), os);
  writeInstallRecord(state, root, os, {
    switched: { from: "0.3.0", to: "0.4.0" },
    seen: ["0.3.0", "0.4.0"],
  });
  if (pinned !== undefined) edit(state, (r) => ({ ...r, pinned }));
  const options: RetireOptions = { root, state, platform: os, inUse: () => false };
  return { dir: made.dir, root, state, options, add, versions: join(root, "versions") };
}

function edit(state: string, change: (r: Record<string, unknown>) => Record<string, unknown>) {
  const file = join(state, "install.json");
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as never)));
}

const listed = (state: string) => readInstallRecord(state)?.["versions"];

describe("[A2.3.12.6.update.retire] an update removes the old version folders it can show are the installer's and no longer needed", () => {
  test("after updates to 0.2.0 and 0.3.0, 0.1.0 is gone, and --rollback still goes back to 0.2.0", async () => {
    const made = scratch("flow");
    cleanups.push(made.remove);
    const { root, facts } = await fixtureInstall(made.dir, os);
    const key = throwawayKey();
    const said: string[] = [];
    const control = new FakeControl(root, os, true);
    const options = {
      facts,
      keys: [keyLine(key)],
      control,
      selfTest: fakeSelfTest(),
      say: (line: string) => said.push(line),
    };
    for (const version of ["0.2.0", "0.3.0"]) {
      const release = fixtureRelease(join(made.dir, version), version, os, key, {
        launcher: version,
      });
      await updateFromArchive(release.archive, options);
    }
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["0.2.0", "0.3.0"]);
    expect(said).toContain("Removed old versions: 0.1.0.");
    const state = join(root, "state");
    expect(listed(state)).toEqual(["0.2.0", "0.3.0"]);
    expect(await rollbackUpdate(options)).toMatchObject({ from: "0.3.0", to: "0.2.0" });
    expect(currentOf(root, os)).toBe("0.2.0");
    expect(control.version).toBe("0.2.0");
    // Rolled back, 0.3.0 is the way back, and newer: both versions stay.
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["0.2.0", "0.3.0"]);
  });

  test("current, the way back, a newer version and a pinned one stay; the others go, and install.json follows", async () => {
    const w = await world("keep", ["0.1.0"]);
    // Not install.json's, and a folder with the prefix that install.json does not name: never touched.
    mkdirSync(join(w.versions, "0.0.9"));
    const stranger = join(w.versions, ".retiring-0.2.0-0123456789abcdef");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "keep.txt"), "mine");
    expect(planRetirement(w.options)?.verdicts).toEqual([
      { version: "0.1.0", kind: "kept", why: "pinned" },
      { version: "0.2.0", kind: "retire" },
      { version: "0.3.0", kind: "kept", why: "rollback" },
      { version: "0.4.0", kind: "kept", why: "current" },
      { version: "0.5.0", kind: "kept", why: "newer" },
    ]);
    expect(retireLocked(w.options)).toEqual({ removed: ["0.2.0"] });
    expect(readdirSync(w.versions).sort()).toEqual([
      ".retiring-0.2.0-0123456789abcdef",
      "0.0.9",
      "0.1.0",
      "0.3.0",
      "0.4.0",
      "0.5.0",
    ]);
    expect(readFileSync(join(stranger, "keep.txt"), "utf8")).toBe("mine");
    const record = readInstallRecord(w.state);
    expect(listed(w.state)).toEqual(["0.1.0", "0.3.0", "0.4.0", "0.5.0"]);
    expect(record?.["pinned"]).toEqual(["0.1.0"]);
    expect(record?.["retiring"]).toBeUndefined();
    // Nothing is left to do: a second pass changes nothing.
    expect(retireLocked(w.options)).toEqual({ removed: [] });
  });

  test("a folder with anything the installer did not put there stays whole, and doctor names it", async () => {
    const w = await world("foreign");
    writeFileSync(join(w.versions, "0.1.0", "notes.txt"), "a person's file");
    // 0.2.0's manifest names another version.
    rmSync(join(w.versions, "0.2.0"), { recursive: true });
    writeFolder(join(w.versions, "0.2.0"), "0.2.1", os, fixtureFiles("0.2.1", os));
    const before = tree(w.versions);
    expect(retireLocked(w.options)).toEqual({ removed: [] });
    expect(tree(w.versions)).toEqual(before);
    const row = withVersions(
      { id: "update", status: "ok", detail: "Updated." },
      w.root,
      w.state,
      os,
    );
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(
      "versions/0.1.0 was left as it is: not in manifest.json: notes.txt.",
    );
    expect(row.detail).toContain("versions/0.2.0 was left as it is");
    expect(row.detail).toContain(
      "Kept: 0.3.0 (the way back), 0.4.0 (current), 0.5.0 (newer than current).",
    );
  });

  test.skipIf(os === "win32")(
    "a version that is a link to a folder stays, and so does the folder",
    async () => {
      const w = await world("link");
      const elsewhere = join(w.dir, "elsewhere");
      renameSync(join(w.versions, "0.2.0"), elsewhere);
      symlinkSync(elsewhere, join(w.versions, "0.2.0"));
      expect(retireLocked(w.options)).toEqual({ removed: ["0.1.0"] });
      expect(checkVersionFolder(elsewhere)).toEqual([]);
      expect(existsSync(join(w.versions, "0.2.0"))).toBe(true);
    },
  );

  test("nothing goes when install.json is another install's, a journal is there, or current names no version", async () => {
    const cases: ((w: Awaited<ReturnType<typeof world>>) => void)[] = [
      (w) => {
        edit(w.state, (r) => ({ ...r, root: join(w.dir, "other") }));
      },
      (w) => {
        edit(w.state, (r) => ({ ...r, install_id: "0000000000" }));
      },
      (w) => {
        writeFileSync(join(w.state, UPDATE_JOURNAL), "{}");
      },
      (w) => {
        writeCurrent(w.root, { kind: "none" }, os);
      },
    ];
    for (const make of cases) {
      const w = await world("owned");
      make(w);
      const before = tree(w.versions);
      expect(planRetirement(w.options)).toBeUndefined();
      expect(retireLocked(w.options)).toEqual({ removed: [] });
      expect(tree(w.versions)).toEqual(before);
    }
  });

  test("a version in use stays whole and waits; doctor says it waits", async () => {
    const w = await world("busy");
    const options = { ...w.options, inUse: (folder: string) => folder.endsWith("0.2.0") };
    expect(retireLocked(options)).toEqual({ removed: ["0.1.0"] });
    expect(checkVersionFolder(join(w.versions, "0.2.0"))).toEqual([]);
    expect(listed(w.state)).toContain("0.2.0");
    expect(planRetirement(options)?.verdicts).toContainEqual({ version: "0.2.0", kind: "in_use" });
  });

  test("a removal cut off before its rename leaves the version whole; one cut off after it is finished by the next pass", async () => {
    const w = await world("cut");
    // Cut before the rename: install.json names the removal, the folder is still at its name.
    edit(w.state, (r) => ({
      ...r,
      retiring: { version: "0.1.0", folder: ".retiring-0.1.0-00000000000000aa" },
    }));
    expect(checkVersionFolder(join(w.versions, "0.1.0"))).toEqual([]);
    expect(retireLocked({ ...w.options, inUse: () => true })).toEqual({ removed: [] });
    expect(checkVersionFolder(join(w.versions, "0.1.0"))).toEqual([]);
    expect(readInstallRecord(w.state)?.["retiring"]).toBeUndefined();
    // Cut after the rename: the folder is at the recorded name, half deleted.
    const recorded = ".retiring-0.2.0-00000000000000bb";
    edit(w.state, (r) => ({ ...r, retiring: { version: "0.2.0", folder: recorded } }));
    renameSync(join(w.versions, "0.2.0"), join(w.versions, recorded));
    writeFileSync(join(w.versions, recorded, "manifest.json"), "");
    const row = withVersions(
      { id: "update", status: "ok", detail: "Updated." },
      w.root,
      w.state,
      os,
    );
    expect(row.detail).toMatch(/ 0\.2\.0, 0\.1\.0 wait to be removed/);
    expect(retireLocked({ ...w.options, inUse: () => true })).toEqual({ removed: ["0.2.0"] });
    expect(existsSync(join(w.versions, recorded))).toBe(false);
    expect(listed(w.state)).not.toContain("0.2.0");
    expect(readInstallRecord(w.state)?.["retiring"]).toBeUndefined();
  });
});

/** Starts the program at `program`, a copy of this Node, resolving once it runs. */
async function run(program: string) {
  const child = spawn(program, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await once(child.stdout, "data");
  return child;
}

describe("[A2.3.12.6.update.retire-probe] a version that a process runs keeps every file, and goes once nothing runs it", () => {
  for (const [what, path] of [
    ["the bundled runtime", ["runtime", os === "win32" ? "node.exe" : "node"]],
    ["a native helper", ["bin", os === "win32" ? "ttasks-run.exe" : "ttasks-run"]],
  ] as const) {
    test.skipIf(os !== "win32" && os !== "linux")(
      `${what} that runs keeps its version`,
      async () => {
        const w = await world("probe");
        const folder = join(w.versions, "0.2.0");
        mkdirSync(join(folder, path[0]), { recursive: true });
        copyFileSync(process.execPath, join(folder, ...path));
        rmSync(join(folder, "manifest.json"));
        writeVersionManifest(folder, {
          version: "0.2.0",
          build: "fixture0probe",
          platform: os === "win32" ? "win-x64" : "linux-x64",
          node: process.versions.node,
          sqlite: process.versions.sqlite ?? "",
          protocol: { min: 1, max: 1 },
        });
        const options = { root: w.root, state: w.state, platform: os };
        const child = await run(join(folder, ...path));
        try {
          expect(retireLocked(options)).toEqual({ removed: ["0.1.0"] });
          expect(checkVersionFolder(folder)).toEqual([]);
        } finally {
          child.kill();
          await once(child, "exit");
        }
        // The OS lets go of a program once its process is gone, which can lag the exit event.
        const end = Date.now() + 20_000;
        while (existsSync(folder) && Date.now() < end) {
          retireLocked(options);
          if (existsSync(folder)) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(existsSync(folder)).toBe(false);
        expect(listed(w.state)).toEqual(["0.3.0", "0.4.0", "0.5.0"]);
      },
    );
  }
});
