// The release archives (A2 3.12.4): a gzipped ustar and a zip, deterministic and
// read back unchanged. Fixture bytes only.
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { readTarGz, readZip, writeTar, writeTarGz, writeZip, type FileEntry } from "./archive.ts";

const entries: FileEntry[] = [
  { path: "runtime/node", data: Buffer.from("fixture runtime\n"), mode: 0o755 },
  { path: "bin/ttasks", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
  { path: "lib/chunks/cli.mjs", data: Buffer.alloc(70_000, 7), mode: 0o644 },
  { path: "manifest.json", data: Buffer.from("{}\n"), mode: 0o644 },
];

describe("[A2.3.12.4.build.archives] the tar.gz and zip writers", () => {
  test("the tar.gz holds sorted entries with modes, directories, uid 0 and the fixed time", () => {
    const archive = writeTarGz(entries);
    const back = readTarGz(archive);
    expect(back.map((e) => `${e.type}:${e.path}:${e.mode.toString(8)}`)).toEqual([
      "directory:bin:755",
      "directory:lib:755",
      "directory:lib/chunks:755",
      "directory:runtime:755",
      "file:bin/ttasks:755",
      "file:lib/chunks/cli.mjs:644",
      "file:manifest.json:644",
      "file:runtime/node:755",
    ]);
    for (const e of entries)
      expect(back.find((b) => b.path === e.path)?.data.equals(e.data)).toBe(true);
    const tar = gunzipSync(archive);
    // uid, gid (offset 108, 116), and mtime 2026-01-01T00:00:00Z (offset 136) of the first header.
    expect(tar.subarray(108, 115).toString("ascii")).toBe("0000000");
    expect(tar.subarray(116, 123).toString("ascii")).toBe("0000000");
    expect(Number.parseInt(tar.subarray(136, 147).toString("ascii"), 8)).toBe(1_767_225_600);
  });

  test("the gzip header has no time and names Unix, whichever machine wrote it", () => {
    const archive = writeTarGz(entries);
    expect([...archive.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]);
    expect(archive.readUInt32LE(4)).toBe(0);
    expect(archive[9]).toBe(3);
  });

  test("both writers give the same bytes for the same entries in any order", () => {
    const reversed = [...entries].reverse();
    expect(writeTarGz(reversed).equals(writeTarGz(entries))).toBe(true);
    for (const level of [0, 9]) {
      expect(writeZip(reversed, { level }).equals(writeZip(entries, { level }))).toBe(true);
    }
  });

  test("the zip reads back every file unchanged, stored or deflated", () => {
    for (const level of [0, 9]) {
      const back = readZip(writeZip(entries, { level }));
      expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path).sort());
      for (const e of entries) {
        expect(back.find((b) => b.path === e.path)?.data.equals(e.data)).toBe(true);
      }
    }
  });

  test("unsafe paths, duplicates and odd modes are refused", () => {
    for (const path of ["../x", "/abs", "a/../b", "a//b", "a/", "sp ace", "back\\slash", "./a"]) {
      const bad = [{ path, data: Buffer.alloc(0), mode: 0o644 }];
      expect(() => writeTar(bad), path).toThrow(/unsafe archive path/);
      expect(() => writeZip(bad), path).toThrow(/unsafe archive path/);
    }
    const twice = [entries[0], entries[0]].filter((e) => e !== undefined);
    expect(() => writeTar(twice)).toThrow(/duplicate/);
    expect(() => writeZip([{ path: "a", data: Buffer.alloc(0), mode: 0o777 }])).toThrow(/mode/);
  });
});
