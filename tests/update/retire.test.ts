// Old version folders go after an update (retire.ts): only what the pass can show is the
// installer's and no longer needed, the rest stays whole, a removal cut off at either side of its
// rename is finished by the next pass, and a version a process runs keeps every file.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
    expect(await retireLocked(w.options)).toEqual({ removed: ["0.2.0"] });
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
    expect(await retireLocked(w.options)).toEqual({ removed: [] });
  });

  test("a folder with anything the installer did not put there stays whole, and doctor names it", async () => {
    const w = await world("foreign");
    writeFileSync(join(w.versions, "0.1.0", "notes.txt"), "a person's file");
    // 0.2.0's manifest names another version.
    rmSync(join(w.versions, "0.2.0"), { recursive: true });
    writeFolder(join(w.versions, "0.2.0"), "0.2.1", os, fixtureFiles("0.2.1", os));
    const before = tree(w.versions);
    expect(await retireLocked(w.options)).toEqual({ removed: [] });
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
      expect(await retireLocked(w.options)).toEqual({ removed: ["0.1.0"] });
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
      expect(await retireLocked(w.options)).toEqual({ removed: [] });
      expect(tree(w.versions)).toEqual(before);
    }
  });

  test("a version in use stays whole and waits; doctor says it waits", async () => {
    const w = await world("busy");
    const options = { ...w.options, inUse: (folder: string) => folder.endsWith("0.2.0") };
    expect(await retireLocked(options)).toEqual({ removed: ["0.1.0"] });
    expect(checkVersionFolder(join(w.versions, "0.2.0"))).toEqual([]);
    expect(listed(w.state)).toContain("0.2.0");
    expect(planRetirement(options)?.verdicts).toContainEqual({ version: "0.2.0", kind: "in_use" });
  });

  test("a removal cut off before its rename leaves the version whole; one cut off after it is finished by the next pass", async () => {
    const w = await world("cut");
    // Cut before the rename: install.json names the removal, the version is still at its name,
    // and a folder of someone else's has the recorded name: it is not the removal's.
    const stranger = join(w.versions, ".retiring-0.1.0-00000000000000aa");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "keep.txt"), "mine");
    edit(w.state, (r) => ({
      ...r,
      retiring: { version: "0.1.0", folder: ".retiring-0.1.0-00000000000000aa" },
    }));
    expect(await retireLocked({ ...w.options, inUse: () => true })).toEqual({ removed: [] });
    expect(checkVersionFolder(join(w.versions, "0.1.0"))).toEqual([]);
    expect(readFileSync(join(stranger, "keep.txt"), "utf8")).toBe("mine");
    expect(readInstallRecord(w.state)?.["retiring"]).toBeUndefined();
    // Cut after the rename: the folder is at the recorded name, half deleted, its manifest last.
    const recorded = ".retiring-0.2.0-00000000000000bb";
    edit(w.state, (r) => ({ ...r, retiring: { version: "0.2.0", folder: recorded } }));
    renameSync(join(w.versions, "0.2.0"), join(w.versions, recorded));
    rmSync(join(w.versions, recorded, "lib"), { recursive: true });
    const row = withVersions(
      { id: "update", status: "ok", detail: "Updated." },
      w.root,
      w.state,
      os,
    );
    expect(row.detail).toMatch(/ 0\.2\.0, 0\.1\.0 wait to be removed/);
    expect(await retireLocked({ ...w.options, inUse: () => true })).toEqual({ removed: ["0.2.0"] });
    expect(existsSync(join(w.versions, recorded))).toBe(false);
    expect(listed(w.state)).not.toContain("0.2.0");
    expect(readInstallRecord(w.state)?.["retiring"]).toBeUndefined();
  });

  test("a removal cut off in a folder that now holds anything else is left whole, and doctor names it", async () => {
    const w = await world("cut-foreign");
    const recorded = ".retiring-0.2.0-00000000000000cc";
    edit(w.state, (r) => ({ ...r, retiring: { version: "0.2.0", folder: recorded } }));
    renameSync(join(w.versions, "0.2.0"), join(w.versions, recorded));
    writeFileSync(join(w.versions, recorded, "notes.txt"), "a person's file");
    const before = tree(w.versions);
    expect(await retireLocked(w.options)).toEqual({ removed: [] });
    expect(tree(w.versions)).toEqual(before);
    expect(readInstallRecord(w.state)?.["retiring"]).toEqual({
      version: "0.2.0",
      folder: recorded,
    });
    const row = withVersions(
      { id: "update", status: "ok", detail: "Updated." },
      w.root,
      w.state,
      os,
    );
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(
      `versions/${recorded} was left as it is: not in manifest.json: notes.txt.`,
    );
  });

  test("a removal cut off where a lookup fails with anything but ENOENT deletes nothing, and doctor says the way out", async () => {
    const eio = (path: string) => (seen: string) => {
      if (seen === path) throw Object.assign(new Error("i/o"), { code: "EIO" });
      return lstatSync(seen);
    };
    // Both folders there, the original cannot be looked at: a stranger's folder at the name.
    const both = await world("cut-eio-both");
    const name = ".retiring-0.1.0-00000000000000ee";
    mkdirSync(join(both.versions, name));
    writeFileSync(join(both.versions, name, "keep.txt"), "mine");
    edit(both.state, (r) => ({ ...r, retiring: { version: "0.1.0", folder: name } }));
    const bothBefore = tree(both.versions);
    const lookBoth = { ...both.options, lookAt: eio(join(both.versions, "0.1.0")) };
    expect(await retireLocked(lookBoth)).toEqual({ removed: [] });
    expect(tree(both.versions)).toEqual(bothBefore);
    expect(readFileSync(join(both.versions, name, "keep.txt"), "utf8")).toBe("mine");
    expect(planRetirement(lookBoth)?.pending).toEqual({
      version: "0.1.0",
      folder: name,
      problem: "it cannot be looked at (EIO)",
    });
    // Only the renamed folder there, with a person's file, and it cannot be looked at.
    const only = await world("cut-eio-only");
    const renamed = ".retiring-0.2.0-00000000000000ff";
    edit(only.state, (r) => ({ ...r, retiring: { version: "0.2.0", folder: renamed } }));
    renameSync(join(only.versions, "0.2.0"), join(only.versions, renamed));
    writeFileSync(join(only.versions, renamed, "keep.txt"), "mine");
    const onlyBefore = tree(only.versions);
    const lookOnly = { ...only.options, lookAt: eio(join(only.versions, renamed)) };
    expect(await retireLocked(lookOnly)).toEqual({ removed: [] });
    expect(tree(only.versions)).toEqual(onlyBefore);
    expect(readFileSync(join(only.versions, renamed, "keep.txt"), "utf8")).toBe("mine");
    // Doctor names the folder, why, and what to do; moved out, the next pass goes on.
    const row = withVersions(
      { id: "update", status: "ok", detail: "Updated." },
      only.root,
      only.state,
      os,
    );
    expect(row.detail).toContain(
      `versions/${renamed} was left as it is: not in manifest.json: keep.txt. No old version is removed until it is gone: move that folder out of versions, then run ttasks update --repair.`,
    );
    renameSync(join(only.versions, renamed), join(only.dir, "moved-aside"));
    expect(await retireLocked(only.options)).toEqual({ removed: ["0.2.0", "0.1.0"] });
    expect(readFileSync(join(only.dir, "moved-aside", "keep.txt"), "utf8")).toBe("mine");
  });

  test("a receipt of another root or install lends this one none of its versions, removal or pins", async () => {
    const w = await world("foreign-receipt", ["0.1.0"]);
    edit(w.state, (r) => ({
      ...r,
      root: join(w.dir, "other"),
      retiring: { version: "0.2.0", folder: ".retiring-0.2.0-00000000000000dd" },
    }));
    const record = writeInstallRecord(w.state, w.root, os, { installed: "0.4.0" });
    expect(record.versions).toEqual(["0.4.0"]);
    expect(record.retiring).toBeUndefined();
    expect(record.pinned).toBeUndefined();
  });

  test("a folder that cannot be read stays and is named, and the others still go", async () => {
    const w = await world("unreadable");
    const options = {
      ...w.options,
      inUse: (folder: string) => {
        if (folder.endsWith("0.2.0")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return false;
      },
    };
    expect(planRetirement(options)?.verdicts).toContainEqual({
      version: "0.2.0",
      kind: "foreign",
      problem: "it cannot be read (EACCES)",
    });
    expect(await retireLocked(options)).toEqual({ removed: ["0.1.0"] });
    expect(checkVersionFolder(join(w.versions, "0.2.0"))).toEqual([]);
  });

  test.skipIf(os === "win32" || process.getuid?.() === 0)(
    "a file in an old version that cannot be read does not break doctor, and that version stays",
    async () => {
      const w = await world("unreadable-file");
      const file = join(w.versions, "0.2.0", "lib", "chunks", "cli.mjs");
      chmodSync(file, 0o000);
      try {
        const row = withVersions(
          { id: "update", status: "ok", detail: "Updated." },
          w.root,
          w.state,
          os,
        );
        expect(row.detail).toContain(
          "versions/0.2.0 was left as it is: it cannot be read (EACCES).",
        );
        expect(await retireLocked(w.options)).toEqual({ removed: ["0.1.0"] });
        expect(existsSync(file)).toBe(true);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  test("each version's use is checked right before its own rename", async () => {
    const w = await world("order");
    // 0.2.0 starts while 0.1.0 is being removed.
    const options = {
      ...w.options,
      inUse: (folder: string) => folder.endsWith("0.2.0") && !existsSync(join(w.versions, "0.1.0")),
    };
    expect(await retireLocked(options)).toEqual({ removed: ["0.1.0"] });
    expect(checkVersionFolder(join(w.versions, "0.2.0"))).toEqual([]);
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
          expect(await retireLocked(options)).toEqual({ removed: ["0.1.0"] });
          expect(checkVersionFolder(folder)).toEqual([]);
        } finally {
          child.kill();
          await once(child, "exit");
        }
        // The OS lets go of a program once its process is gone, which can lag the exit event.
        const end = Date.now() + 20_000;
        while (existsSync(folder) && Date.now() < end) {
          await retireLocked(options);
          if (existsSync(folder)) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(existsSync(folder)).toBe(false);
        expect(listed(w.state)).toEqual(["0.3.0", "0.4.0", "0.5.0"]);
      },
    );
  }

  test.skipIf(os !== "win32" && os !== "linux")(
    "a program that runs from outside the versions does not keep any of them",
    async () => {
      const w = await world("unrelated");
      const program = join(w.dir, os === "win32" ? "other.exe" : "other");
      copyFileSync(process.execPath, program);
      const child = await run(program);
      try {
        expect(await retireLocked({ root: w.root, state: w.state, platform: os })).toEqual({
          removed: ["0.1.0", "0.2.0"],
        });
      } finally {
        child.kill();
        await once(child, "exit");
      }
    },
  );
});
