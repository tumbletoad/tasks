// The start-up check's gate (A1 3.19): a space connection opens only through a CheckedDriver that
// CheckedDriver.check() produced. Neither the type system nor JavaScript may forge one.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqliteDriver } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import { nodeSqliteDriver } from "../src/node-sqlite.ts";
import { openReader, openSpaceConnection, openWriter } from "../src/open.ts";
import { CheckedDriver } from "../src/startup-check.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectMisuse(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("STORAGE_MISUSE");
    return;
  }
  throw new Error("expected STORAGE_MISUSE, but nothing was thrown");
}

describe("[A1.5.driver.startup-check] only a driver that passed the start-up check opens a space", () => {
  test("a forged CheckedDriver is a type error and is refused before any file is opened", async () => {
    const opened: string[] = [];
    const driver: SqliteDriver = {
      name: "node:sqlite",
      open: (path, opts) => {
        opened.push(path);
        return nodeSqliteDriver.open(path, opts);
      },
      backup: (src, dest, opts) => nodeSqliteDriver.backup(src, dest, opts),
    };
    const real = await CheckedDriver.check(driver);
    opened.length = 0; // the check's own in-memory probe
    const file = join(dir, "space.db");

    const plain = { driver, report: real.report };
    // @ts-expect-error -- a plain object with the same fields is not a CheckedDriver
    expectMisuse(() => openWriter(plain, file, { create: true }));
    // @ts-expect-error -- the same for a reader
    expectMisuse(() => openReader(plain, file));

    // JavaScript can call the private constructor, and can build an object on the prototype.
    const constructed = Reflect.construct(CheckedDriver, [driver, real.report]) as CheckedDriver;
    const fromPrototype = Object.create(CheckedDriver.prototype) as CheckedDriver;
    for (const forged of [constructed, fromPrototype]) {
      expectMisuse(() => openWriter(forged, file, { create: true }));
      expectMisuse(() => openReader(forged, file));
      expectMisuse(() => openSpaceConnection(forged, file, "writer", { create: true }));
    }
    expect(opened).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);

    // The checked driver itself opens.
    openWriter(real, file, { create: true }).close();
    expect(opened).toEqual([file]);
    expect(CheckedDriver.isChecked(real)).toBe(true);
    expect(CheckedDriver.isChecked(constructed)).toBe(false);
  });
});
