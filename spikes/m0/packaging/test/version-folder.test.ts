import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readTarGz, readZip, writeTar, writeZip } from "../src/archive.ts";
import {
  archiveName,
  assembleVersionFolder,
  folderEntries,
  type Manifest,
  packEntries,
  type Platform,
  sha256,
  verifyVersionFolder,
} from "../src/version-folder.ts";
import { removeDir, tempDir } from "./fixture.ts";

// A tiny fake runtime and fake launchers: these tests check the layout, the manifest and the
// archive formats, not that anything runs.
let work: string;
const fakes: Record<string, string> = {};

beforeAll(() => {
  work = tempDir("version-folder");
  for (const name of ["node", "license", "tasks", "ttasksw"]) {
    fakes[name] = join(work, `fake-${name}`);
    writeFileSync(fakes[name], `fake ${name}\n`);
  }
});

afterAll(() => {
  removeDir(work);
});

function assemble(platform: Platform, label: string): { dir: string; manifest: Manifest } {
  const dir = join(work, label, "0.0.0-spike");
  const manifest = assembleVersionFolder(dir, {
    version: "0.0.0-spike",
    build: "test",
    platform,
    node: {
      version: "26.13.1",
      sqlite: "3.54.1",
      binary: fakes["node"] ?? "",
      license: fakes["license"] ?? "",
    },
    launchers: { ttasks: fakes["tasks"] ?? "", ttasksw: fakes["ttasksw"] ?? "" },
  });
  return { dir, manifest };
}

describe("[A2.3.12.2.spike.version-folder] the version folder, its manifest and its archive", () => {
  test("the Linux folder holds the A2 3.12.2 layout and a manifest of every file", () => {
    const { dir, manifest } = assemble("linux-x64", "linux");
    expect(Object.keys(manifest.files)).toEqual([
      "LICENSE",
      "NOTICE",
      "bin/ttasks",
      "lib/gate.mjs",
      "lib/install.mjs",
      "lib/ttasks.mjs",
      "licenses/node.txt",
      "runtime/node",
    ]);
    expect(manifest).toMatchObject({
      version: "0.0.0-spike",
      platform: "linux-x64",
      node: "26.13.1",
      sqlite: "3.54.1",
    });
    expect(manifest.files["runtime/node"]).toBe(sha256(Buffer.from("fake node\n")));
    expect(verifyVersionFolder(dir)).toEqual([]);
  });

  test("the Windows folder holds both launchers and node.exe", () => {
    const { dir, manifest } = assemble("win-x64", "win");
    expect(Object.keys(manifest.files)).toEqual([
      "LICENSE",
      "NOTICE",
      "bin/ttasks.exe",
      "bin/ttasksw.exe",
      "lib/gate.mjs",
      "lib/install.mjs",
      "lib/ttasks.mjs",
      "licenses/node.txt",
      "runtime/node.exe",
    ]);
    expect(verifyVersionFolder(dir)).toEqual([]);
  });

  test("the manifest check finds a changed, a missing and an extra file", () => {
    const { dir } = assemble("linux-x64", "tampered");
    appendFileSync(join(dir, "lib", "ttasks.mjs"), "// changed\n");
    writeFileSync(join(dir, "lib", "extra.mjs"), "");
    removeDir(join(dir, "licenses"));
    expect(verifyVersionFolder(dir).sort()).toEqual([
      "changed: lib/ttasks.mjs",
      "missing: licenses/node.txt",
      "not in manifest: lib/extra.mjs",
    ]);
  });

  test("manifest.json lists one file per line in the form the POSIX install script reads", () => {
    const { dir, manifest } = assemble("linux-x64", "lines");
    const text = readFileSync(join(dir, "manifest.json"), "utf8");
    // The same pattern as the sed expression in install.template.sh.
    const lines = text
      .split("\n")
      .filter((l) => /^ {4}"[A-Za-z0-9._/-]*": "[0-9a-f]{64}",?$/.test(l));
    expect(lines).toHaveLength(Object.keys(manifest.files).length);
    expect(text).toContain('\n  "version": "0.0.0-spike",\n');
    expect(text).toContain('\n  "platform": "linux-x64",\n');
  });

  test("the Linux archive is a gzipped tar with exec bits on the launcher and the runtime", () => {
    const { dir } = assemble("linux-x64", "tar");
    const archive = packEntries(folderEntries(dir), "linux-x64");
    const entries = readTarGz(archive);
    const modes = Object.fromEntries(
      entries.map((e) => [e.path, `${e.type}:${e.mode.toString(8)}`]),
    );
    expect(modes).toMatchObject({
      bin: "directory:755",
      "bin/ttasks": "file:755",
      "runtime/node": "file:755",
      "lib/ttasks.mjs": "file:644",
      "manifest.json": "file:644",
    });
    const node = entries.find((e) => e.path === "runtime/node");
    expect(node?.data.toString()).toBe("fake node\n");
    expect(packEntries(folderEntries(dir), "linux-x64").equals(archive)).toBe(true);
  });

  test("the Windows archive is a zip that reads back unchanged and is reproducible", () => {
    const { dir } = assemble("win-x64", "zip");
    const entries = folderEntries(dir);
    for (const level of [0, 9]) {
      const archive = packEntries(entries, "win-x64", level);
      const back = readZip(archive);
      expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
      for (const e of entries) {
        expect(back.find((b) => b.path === e.path)?.data.equals(e.data)).toBe(true);
      }
      expect(packEntries(entries, "win-x64", level).equals(archive)).toBe(true);
    }
  });

  test("archive names follow A2 3.12.4 and the writers refuse unsafe paths", () => {
    expect(archiveName("0.3.0", "linux-x64")).toBe("ttasks-0.3.0-linux-x64.tar.gz");
    expect(archiveName("0.3.0", "win-x64")).toBe("ttasks-0.3.0-win-x64.zip");
    for (const path of ["../x", "/abs", "a/../b", "a//b", "a/", "sp ace", "back\\slash"]) {
      const entries = [{ path, data: Buffer.alloc(0), mode: 0o644 }];
      expect(() => writeTar(entries), path).toThrow(/unsafe archive path/);
      expect(() => writeZip(entries), path).toThrow(/unsafe archive path/);
    }
  });
});
