// Whole writes (A2 3.2.2 rule 5): a write of durable state through @tasks/files writes every byte
// or throws. One write call may take fewer bytes than it was given (a full volume, a signal, a
// network file system); the helpers follow the count it returns, and a write that takes none
// throws instead of leaving a cut file in place of a whole one, or spinning.
//
// node:fs's own writeSync is wrapped (module's syncBuiltinESMExports carries the change to every
// importer), so the product code runs as it is.
import fs, { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendPrivate, atomicWrite, createFile, writeAll } from "../src/hub/files.ts";
import { tempRoot } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function temp(label: string): string {
  const { root, cleanup } = tempRoot(label);
  cleanups.push(cleanup);
  return root;
}

type WriteSync = (fd: number, data: unknown, ...rest: unknown[]) => number;

/**
 * Replaces node:fs's writeSync for every importer until the test ends: each call writes at most
 * `most` bytes of what it was given, through the real call, and returns that count (0: none).
 */
function shortWrites(most: number): { calls: () => number } {
  const table = fs as unknown as Record<string, unknown>;
  const real = table["writeSync"] as WriteSync;
  let calls = 0;
  table["writeSync"] = (fd: number, data: unknown, ...rest: unknown[]): number => {
    calls += 1;
    if (most === 0) return 0;
    // A string is written as its UTF-8 bytes; a buffer from its offset for its length.
    const bytes =
      typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(
            (data as Uint8Array).subarray(
              typeof rest[0] === "number" ? rest[0] : 0,
              typeof rest[0] === "number" && typeof rest[1] === "number"
                ? rest[0] + rest[1]
                : undefined,
            ),
          );
    return real(fd, bytes, 0, Math.min(most, bytes.length));
  };
  syncBuiltinESMExports();
  cleanups.push(() => {
    table["writeSync"] = real;
    syncBuiltinESMExports();
  });
  return { calls: () => calls };
}

/** Text of more than one write's worth of bytes, with characters of more than one byte. */
const TEXT = `${"Fixture line with a multi-byte character: é中.\n".repeat(40)}`;

describe("[A2.3.2.2.files.whole-write] a write of durable state writes every byte or throws", () => {
  test("atomicWrite: writes that each take a few bytes still leave the whole text", () => {
    const root = temp("ww");
    const file = join(root, "record.json");
    writeFileSync(file, "old\n");
    const writes = shortWrites(7);
    atomicWrite(file, TEXT);
    expect(writes.calls()).toBeGreaterThan(Buffer.byteLength(TEXT) / 7 - 1);
    expect(readFileSync(file, "utf8")).toBe(TEXT);
  });

  test("atomicWrite: a write that takes nothing throws, the old file stays whole and no temporary file is left", () => {
    const root = temp("wz");
    const file = join(root, "record.json");
    writeFileSync(file, "old\n");
    shortWrites(0);
    expect(() => {
      atomicWrite(file, TEXT);
    }).toThrow(expect.objectContaining({ code: "EIO" }));
    expect(readFileSync(file, "utf8")).toBe("old\n");
    expect(readdirSync(root)).toEqual(["record.json"]);
  });

  test("appendPrivate and writeAll: short writes are followed to the end, and no progress throws", () => {
    const root = temp("wa");
    const log = join(root, "service.log");
    shortWrites(5);
    appendPrivate(log, TEXT);
    appendPrivate(log, TEXT);
    expect(readFileSync(log, "utf8")).toBe(TEXT + TEXT);
    const other = join(root, "entry");
    const fd = createFile(other, 0o600);
    try {
      writeAll(fd, Buffer.from(TEXT, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    expect(readFileSync(other, "utf8")).toBe(TEXT);
    cleanups.pop()?.();
    shortWrites(0);
    expect(() => {
      appendPrivate(log, "more\n");
    }).toThrow(expect.objectContaining({ code: "EIO" }));
    expect(existsSync(log)).toBe(true);
  });
});
