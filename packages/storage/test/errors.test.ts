// Storage's error codes and the registry's (A1 3.7 to 3.9; A3 3.5; A7 3.8 M1.05): every code the
// write path and the storage worker can raise maps to a registry code, the recovery-related SQLite
// codes say what they are (A1 3.19), and the registry's SafeText and the writer
// agree on text. Fixture data only.
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { A1_ERRORS, normaliseText } from "@ttasks/contracts";
import { afterAll, describe, expect, test } from "vitest";
import { sqliteError, STORAGE_ERROR_CODES, StorageError } from "../src/errors.ts";
import { normaliseStored, WRITE_ERROR_CODES } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";

const temp = tempFolders("errors");
afterAll(temp.cleanup);

/**
 * A database that a crash left in the middle of a rollback-journal transaction: its spilled pages
 * in the file and the originals in a hot `-journal`. Built on a copy whose two files are copied
 * while its transaction is open.
 */
async function withHotJournal(dir: string): Promise<string> {
  const { driver } = await checkedDriver();
  const source = join(dir, "source.db");
  const setup = driver.open(source, { readOnly: false, busyTimeoutMs: 0, create: true });
  setup.exec("CREATE TABLE t (v INTEGER) STRICT; INSERT INTO t VALUES (1)");
  setup.close();
  const db = join(dir, "crashed.db");
  const conn = driver.open(source, { readOnly: false, busyTimeoutMs: 0 });
  try {
    conn.pragma("journal_mode", "DELETE");
    conn.pragma("cache_size", 5);
    conn.exec("BEGIN IMMEDIATE");
    conn.exec(
      "CREATE TABLE pad (v BLOB); WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL " +
        "SELECT i + 1 FROM n WHERE i < 200) INSERT INTO pad SELECT zeroblob(8192) FROM n",
    );
    copyFileSync(source, db);
    copyFileSync(`${source}-journal`, `${db}-journal`);
  } finally {
    conn.close();
  }
  // A synced journal starts with its magic number: it is hot.
  expect(readFileSync(`${db}-journal`)[0]).toBe(0xd9);
  return db;
}

describe("[A1.5.errors.codes] storage's codes and the registry's", () => {
  test("every code the write path or the storage worker raises maps to a registry code", () => {
    for (const code of [...WRITE_ERROR_CODES, ...STORAGE_ERROR_CODES]) {
      expect(Object.hasOwn(A1_ERRORS, code), code).toBe(true);
    }
    // What storage may retry with the same request, the registry tells the caller to retry.
    for (const code of STORAGE_ERROR_CODES) {
      if (new StorageError(code, "x").retryable) {
        expect(A1_ERRORS[code], code).toMatchObject({ retryable: true });
      }
    }
  });

  test("a crash recovery's SQLite codes say what they are, and nothing else changes", () => {
    const rollback = sqliteError(776);
    expect([rollback.code, rollback.sqliteCode, rollback.retryable]).toEqual([
      "SPACE_NEEDS_RECOVERY",
      776,
      false,
    ]);
    expect(rollback.message).toMatch(/SQLITE_READONLY_ROLLBACK, code 776/);
    for (const code of [261, 264]) {
      const recovering = sqliteError(code);
      expect([recovering.code, recovering.retryable], String(code)).toEqual([
        "STORAGE_RECOVERING",
        true,
      ]);
    }
    expect(sqliteError(261).message).toMatch(/SQLITE_BUSY_RECOVERY/);
    expect(sqliteError(264).message).toMatch(/SQLITE_READONLY_RECOVERY/);
    // The other READONLY and BUSY codes keep their primary's meaning.
    expect(sqliteError(8).code).toBe("STORAGE_READ_ONLY");
    expect(sqliteError(8 | (2 << 8)).code).toBe("STORAGE_READ_ONLY");
    expect(sqliteError(5).code).toBe("STORAGE_BUSY");
    expect(sqliteError(5 | (2 << 8)).code).toBe("STORAGE_BUSY");
  });

  test("a hot journal found by a read-only connection is SPACE_NEEDS_RECOVERY, not a read-only space", async () => {
    // Open refuses a journal it sees (A1 3.1). This one appears after that check.
    const db = await withHotJournal(temp.make());
    const { driver } = await checkedDriver();
    const reader = driver.open(db, { readOnly: true, busyTimeoutMs: 0 });
    try {
      let caught: unknown;
      try {
        reader.prepare("SELECT count(*) AS n FROM t").get();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect(caught).toMatchObject({ code: "SPACE_NEEDS_RECOVERY", sqliteCode: 776 });
    } finally {
      reader.close();
    }
  });

  test("the registry's SafeText and the writer store a lone surrogate alike", () => {
    const lone = (code: number): string => String.fromCharCode(code);
    for (const text of [`a${lone(0xd800)}b`, `${lone(0xdc00)}x`, `y${lone(0xdbff)}`]) {
      expect(normaliseText(text), JSON.stringify(text)).toBe(normaliseStored(text));
      expect(normaliseText(text)).toContain(String.fromCodePoint(0xfffd));
    }
  });
});
