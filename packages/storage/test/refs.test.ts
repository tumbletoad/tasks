// Short references (A1 3.3): `M-14` from the space's prefix and counter, `n2` and `l1` from per-task
// ordinals, in the same form as the wire patterns of packages/contracts.
import { patterns } from "@tasks/contracts";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import { newId } from "../src/ids.ts";
import {
  defaultRefPrefix,
  formatEntryRef,
  formatTaskRef,
  nextEntryOrdinal,
  parseEntryRef,
  parseTaskRef,
  takeTaskRef,
} from "../src/refs.ts";
import { RANGES } from "../src/rows.ts";
import { openSpace } from "../src/space.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("refs");
const open: Connection[] = [];

afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
  folders.cleanup();
});

async function writer(): Promise<{ conn: Connection; human: string }> {
  const created = await createFixtureSpace(folders.make());
  const { conn } = openSpace(await checkedDriver(), created.folder, { role: "writer" });
  open.push(conn);
  return { conn, human: created.actors.human };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

const prefix = fc.stringMatching(/^[A-Z]{1,6}$/);

describe("[A1.5.refs.short] task references and entry ordinals", () => {
  test("a task reference formats and parses back, and the contracts pattern accepts it", () => {
    fc.assert(
      fc.property(prefix, fc.integer({ min: 1, max: RANGES.taskRef.max }), (p, n) => {
        const ref = formatTaskRef(p, n);
        expect(ref).toMatch(patterns.taskRef);
        expect(parseTaskRef(ref)).toEqual({ prefix: p, ref: n });
      }),
      { numRuns: 200 },
    );
    expect(formatTaskRef("M", 14)).toBe("M-14");
    expect(formatTaskRef("M", RANGES.taskRef.max)).toMatch(patterns.taskRef);
  });

  test("an entry ordinal formats and parses back, and the contracts pattern accepts it", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("note" as const, "log" as const),
        fc.integer({ min: 1, max: RANGES.ordinal.max }),
        (kind, n) => {
          const ref = formatEntryRef(kind, n);
          expect(ref).toMatch(patterns.entryRef);
          expect(parseEntryRef(ref)).toEqual({ kind, ordinal: n });
        },
      ),
      { numRuns: 200 },
    );
    expect(formatEntryRef("note", 2)).toBe("n2");
    expect(formatEntryRef("log", 1)).toBe("l1");
  });

  test("malformed references are refused", () => {
    for (const bad of ["m-14", "M-0", "M-014", "M14", "MMMMMMM-1", "M-10000000000", "M-1 ", 14]) {
      expect(parseTaskRef(bad), String(bad)).toBeUndefined();
    }
    for (const bad of ["n0", "x2", "N2", "n1000000", "n02"]) {
      expect(parseEntryRef(bad), bad).toBeUndefined();
    }
    expectCode(() => formatTaskRef("M1", 1), "STORAGE_MISUSE");
    expectCode(() => formatTaskRef("M", 0), "STORAGE_MISUSE");
    expectCode(() => formatTaskRef("M", RANGES.taskRef.max + 1), "STORAGE_MISUSE");
    expectCode(() => formatTaskRef("M", 1.5), "STORAGE_MISUSE");
    expectCode(() => formatEntryRef("note", 0), "STORAGE_MISUSE");
    expectCode(() => formatEntryRef("other" as "note", 1), "STORAGE_MISUSE");
  });

  test("the default prefix: the name's first letter, then a second when it is taken", () => {
    expect(defaultRefPrefix("Mira")).toBe("M");
    expect(defaultRefPrefix("Mira", ["M"])).toBe("MI");
    expect(defaultRefPrefix("Mira", ["M", "MI"])).toBe("MR");
    expect(defaultRefPrefix("Åsa")).toBe("A");
    expect(defaultRefPrefix("2026 plans")).toBe("P");
    expect(defaultRefPrefix("2026")).toBe("S");
    expect(defaultRefPrefix("M", ["M"])).toBe("MA");
    const taken = ["M", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `M${c}`)];
    expect(defaultRefPrefix("Mm", taken)).toBe("MAA");
    fc.assert(
      fc.property(fc.string(), fc.array(prefix, { maxLength: 30 }), (name, used) => {
        const chosen = defaultRefPrefix(name, used);
        expect(chosen).toMatch(/^[A-Z]{1,3}$/);
        expect(used).not.toContain(chosen);
      }),
      { numRuns: 200 },
    );
  });

  test("task references are taken in the creating transaction, in order, never reused", async () => {
    const { conn } = await writer();
    expectCode(() => takeTaskRef(conn), "STORAGE_MISUSE");
    expect(conn.transaction("immediate", () => [takeTaskRef(conn), takeTaskRef(conn)])).toEqual([
      1, 2,
    ]);
    // A rolled-back transaction gives its reference back, because nothing used it.
    expect(() =>
      conn.transaction("immediate", () => {
        takeTaskRef(conn);
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    expect(conn.transaction("immediate", () => takeTaskRef(conn))).toBe(3);
  });

  test("the counter stops at the largest reference the wire carries", async () => {
    const { conn } = await writer();
    conn.exec(`UPDATE space SET next_ref = ${String(RANGES.taskRef.max)}`);
    expect(conn.transaction("immediate", () => takeTaskRef(conn))).toBe(RANGES.taskRef.max);
    expectCode(() => conn.transaction("immediate", () => takeTaskRef(conn)), "STORAGE_CONSTRAINT");
    conn.exec("UPDATE space SET next_ref = 0");
    expectCode(() => conn.transaction("immediate", () => takeTaskRef(conn)), "SPACE_INVALID");
    // The reviewer's case: above "used up" is a value Tasks never wrote, so the space is invalid.
    conn.exec(`UPDATE space SET next_ref = ${String(RANGES.taskRef.max + 2)}`);
    expectCode(() => conn.transaction("immediate", () => takeTaskRef(conn)), "SPACE_INVALID");
    conn.exec("UPDATE space SET next_ref = 1152921504606846976");
    expectCode(() => conn.transaction("immediate", () => takeTaskRef(conn)), "SPACE_INVALID");
  });

  test("entry ordinals count per task and kind", async () => {
    const { conn, human } = await writer();
    const task = newId("t");
    conn.transaction("immediate", () => {
      conn
        .prepare(
          "INSERT INTO tasks (id, ref, title, position, created_at, created_by, created_seq, " +
            "version, touched) VALUES ($id, 1, 'Fixture task', 'a0', 0, $by, 0, 0, 0)",
        )
        .run({ id: task, by: human });
      expect(nextEntryOrdinal(conn, "note", task)).toBe(1);
      const note = conn.prepare(
        "INSERT INTO notes (id, task_id, ordinal, author_id, body, created_at, created_seq, " +
          "version) VALUES ($id, $task, $n, $by, 'Fixture note', 0, 0, 0)",
      );
      note.run({ id: newId("n"), task, n: 1, by: human });
      note.run({ id: newId("n"), task, n: 2, by: human });
      expect(nextEntryOrdinal(conn, "note", task)).toBe(3);
      expect(nextEntryOrdinal(conn, "log", task)).toBe(1);
      note.run({ id: newId("n"), task, n: RANGES.ordinal.max, by: human });
      expectCode(() => nextEntryOrdinal(conn, "note", task), "STORAGE_CONSTRAINT");
    });
    expectCode(() => nextEntryOrdinal(conn, "note", task), "STORAGE_MISUSE");
  });
});
