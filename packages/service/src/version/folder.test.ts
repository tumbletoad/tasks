// The version folder's manifest.json (A2 3.12.2): one format that the build writes and doctor,
// install and update check. Fixture files only, in a temporary folder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkInstallAround,
  checkVersionFolder,
  isVersionName,
  ManifestError,
  parseManifest,
  readVersionManifest,
  serializeManifest,
  sha256File,
  writeVersionManifest,
  type ManifestFields,
} from "./folder.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-manifest-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const FIELDS: ManifestFields = {
  version: "0.1.0-dev.7",
  build: "0123456789ab",
  platform: "linux-x64",
  node: "26.13.1",
  sqlite: "3.54.1",
  protocol: { min: 1, max: 1 },
};

let count = 0;
/** A small version folder with the given files, and no manifest yet. */
function folder(files: Record<string, string>): string {
  count += 1;
  const dir = join(work, `f${String(count)}`, "0.1.0-dev.7");
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, ...path.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const FILES = {
  "bin/tasks": "#!/bin/sh\n",
  "runtime/node": "fixture runtime\n",
  "lib/tasks.mjs": "// fixture entry\n",
  "lib/chunks/cli.mjs": "// fixture chunk\n",
  LICENSE: "fixture licence\n",
};

describe("[A2.3.12.2.build.version-manifest] manifest.json lists every file of a version folder", () => {
  test("the writer lists every other file with its SHA-256, sorted, one per line", () => {
    const dir = folder(FILES);
    const manifest = writeVersionManifest(dir, FIELDS);
    expect(Object.keys(manifest.files)).toEqual([
      "LICENSE",
      "bin/tasks",
      "lib/chunks/cli.mjs",
      "lib/tasks.mjs",
      "runtime/node",
    ]);
    expect(manifest.files["runtime/node"]).toBe(sha256File(join(dir, "runtime", "node")));
    expect(manifest).toMatchObject({ format: 1, name: "tasks", ...FIELDS });
    const text = serializeManifest(manifest);
    // The line form the POSIX install script reads with sed, and nothing else at that indent.
    const lines = text
      .split("\n")
      .filter((l) => /^ {4}"[A-Za-z0-9._/-]*": "[0-9a-f]{64}",?$/.test(l));
    expect(lines).toHaveLength(5);
    expect(text).toContain('\n  "version": "0.1.0-dev.7",\n');
    expect(text.endsWith("}\n")).toBe(true);
    expect(readVersionManifest(dir)).toEqual(manifest);
    expect(checkVersionFolder(dir)).toEqual([]);
  });

  test("the checker finds a changed, a missing, an extra and a linked file", () => {
    const dir = folder(FILES);
    writeVersionManifest(dir, FIELDS);
    writeFileSync(join(dir, "lib", "tasks.mjs"), "// changed\n");
    rmSync(join(dir, "LICENSE"));
    writeFileSync(join(dir, "lib", "extra.mjs"), "");
    const problems = [
      "changed: lib/tasks.mjs",
      "missing: LICENSE",
      "not in manifest.json: lib/extra.mjs",
    ];
    let linked = false;
    try {
      symlinkSync(join(dir, "runtime"), join(dir, "lib", "linked"), "junction");
      linked = true;
    } catch {
      // No right to make a link here: the other three still hold.
    }
    expect(checkVersionFolder(dir)).toEqual(
      linked ? ["linked: lib/linked", ...problems].sort() : problems,
    );
  });

  test("a file named like a property every object has is a file like any other", () => {
    // Listed: the writer keeps each, the parser reads each back, a change to one is found.
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
    const dir = folder({ ...FILES, ...Object.fromEntries(names.map((n) => [n, `${n}\n`])) });
    const manifest = writeVersionManifest(dir, FIELDS);
    for (const name of names) expect(Object.hasOwn(manifest.files, name), name).toBe(true);
    expect(Object.keys(readVersionManifest(dir).files)).toHaveLength(5 + names.length);
    expect(checkVersionFolder(dir)).toEqual([]);
    writeFileSync(join(dir, "__proto__"), "changed\n");
    expect(checkVersionFolder(dir)).toEqual(["changed: __proto__"]);

    // Not listed: an extra file of such a name is found like any other extra file.
    const plain = folder(FILES);
    writeVersionManifest(plain, FIELDS);
    for (const name of names) writeFileSync(join(plain, name), "");
    writeFileSync(join(plain, "lib", "constructor"), "");
    expect(checkVersionFolder(plain)).toEqual(
      [...names, "lib/constructor"].map((n) => `not in manifest.json: ${n}`).sort(),
    );
  });

  test("a manifest that is not exactly the format is refused", () => {
    const good = JSON.parse(
      serializeManifest({ format: 1, name: "tasks", ...FIELDS, files: {} }),
    ) as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      { ...good, format: 2 },
      { ...good, name: "other" },
      { ...good, version: "" },
      { ...good, build: "has space" },
      { ...good, protocol: { min: 1 } },
      { ...good, files: { "../escape": "0".repeat(64) } },
      { ...good, files: { "a/./b": "0".repeat(64) } },
      { ...good, files: { "/abs": "0".repeat(64) } },
      { ...good, files: { "sp ace": "0".repeat(64) } },
      { ...good, files: { "manifest.json": "0".repeat(64) } },
      { ...good, files: { ok: "not a digest" } },
    ];
    for (const value of bad) {
      expect(() => parseManifest(JSON.stringify(value)), JSON.stringify(value)).toThrow(
        ManifestError,
      );
    }
    expect(() => parseManifest("{")).toThrow(ManifestError);
    expect(checkVersionFolder(folder({ a: "x" }))).toEqual(["manifest.json cannot be read"]);
  });

  test("the writer refuses a path the manifest cannot list", () => {
    expect(() => writeVersionManifest(folder({ "has space.txt": "x" }), FIELDS)).toThrow(
      ManifestError,
    );
  });

  test("current must name an installed version, and Windows needs both stable launchers", () => {
    const root = join(work, "install");
    const v1 = join(root, "versions", "0.1.0");
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, "manifest.json"), "{}");
    // No current: a candidate in a fresh install.
    expect(checkInstallAround(v1, "linux")).toEqual([]);
    writeFileSync(join(root, "current"), "0.1.0");
    expect(checkInstallAround(v1, "win32")).toEqual([]);
    writeFileSync(join(root, "current"), "0.2.0");
    expect(checkInstallAround(v1, "linux")).toEqual([
      "current names 0.2.0, which is not installed",
    ]);
    writeFileSync(join(root, "current"), "../escape");
    expect(checkInstallAround(v1, "linux")).toEqual(["current does not name a version"]);
    writeFileSync(join(root, "current"), "0.1.0");
    // A TASKS_HOME install keeps its command folder in its root.
    writeFileSync(join(root, "home.marker"), "");
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "tasks.exe"), "");
    expect(checkInstallAround(v1, "win32")).toEqual(["missing stable launcher: bin/tasksw.exe"]);
    expect(checkInstallAround(v1, "linux")).toEqual([]);
    // A version folder outside versions/ is no install's.
    expect(checkInstallAround(join(work, "loose", "0.1.0"), "win32")).toEqual([]);
  });

  test("the daily install's stable launchers are in the command folder beside share", () => {
    // ~/.local/share/tasks with its command folder ~/.local/bin (A2 3.2.1).
    const local = join(work, "home", ".local");
    const root = join(local, "share", "tasks");
    const v1 = join(root, "versions", "0.1.0");
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, "manifest.json"), "{}");
    writeFileSync(join(root, "current"), "0.1.0");
    // No command folder yet: nothing to check.
    expect(checkInstallAround(v1, "win32")).toEqual([]);
    mkdirSync(join(local, "bin"));
    writeFileSync(join(local, "bin", "tasksw.exe"), "");
    expect(checkInstallAround(v1, "win32")).toEqual(["missing stable launcher: bin/tasks.exe"]);
    writeFileSync(join(local, "bin", "tasks.exe"), "");
    expect(checkInstallAround(v1, "win32")).toEqual([]);
    // A bin folder in the program's own root is not where the daily install's command lives.
    rmSync(join(local, "bin", "tasks.exe"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "tasks.exe"), "");
    expect(checkInstallAround(v1, "win32")).toEqual(["missing stable launcher: bin/tasks.exe"]);
  });

  test("a root with no home.marker that is not share\\tasks has no command folder to check", () => {
    // No launcher dispatches into <base>\x\y: a stable launcher finds <root>\bin's root only by
    // home.marker, and the daily root only as share\tasks beside its own folder. So an unrelated
    // <base>\bin two levels up is not this install's command folder.
    const base = join(work, "base");
    const v1 = join(base, "x", "y", "versions", "0.1.0");
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, "manifest.json"), "{}");
    writeFileSync(join(base, "x", "y", "current"), "0.1.0");
    mkdirSync(join(base, "bin"));
    expect(checkInstallAround(v1, "win32")).toEqual([]);
  });

  test.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "a current that is there but cannot be read is a problem, not a fresh install",
    () => {
      // The stable launcher cannot dispatch through it, so integrity must not pass.
      const root = join(work, "unreadable");
      const v1 = join(root, "versions", "0.1.0");
      mkdirSync(v1, { recursive: true });
      writeFileSync(join(v1, "manifest.json"), "{}");
      const current = join(root, "current");
      writeFileSync(current, "0.1.0");
      chmodSync(current, 0o000);
      try {
        expect(checkInstallAround(v1, "linux")).toEqual(["current cannot be read"]);
      } finally {
        chmodSync(current, 0o644);
      }
      expect(checkInstallAround(v1, "linux")).toEqual([]);
    },
  );

  test("a version name is what the launchers accept in current (A2 3.12.3)", () => {
    for (const ok of ["0.1.0", "0.1.0-dev.12", "0.3.0-beta.1+build.7", "a".repeat(64)]) {
      expect(isVersionName(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      ".",
      "..",
      "0..1",
      ".0.1",
      "0.1.",
      "a".repeat(65),
      "0 1",
      "CON",
      "nul.1",
      "x/y",
    ]) {
      expect(isVersionName(bad), bad).toBe(false);
    }
  });
});
