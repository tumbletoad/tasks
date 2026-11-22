// The integer domain and the row decoders (A1 3.4): a stored value
// outside its column's domain is refused as SPACE_INVALID, naming the column and never the value.
import { patterns } from "@ttasks/contracts";
import { describe, expect, test } from "vitest";
import { StorageError } from "./errors.ts";
import { decodeLineage, decodeSpaceRow, inRange, RANGES, RowReader } from "./rows.ts";

function invalid(fn: () => unknown, column: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("SPACE_INVALID");
    expect((error as StorageError).message).toContain(column);
    return;
  }
  throw new Error(`expected SPACE_INVALID for ${column}`);
}

const INCARNATION = "ai_5n0w8k3q7d1m9x4r2t6v0b8c3h";
const MACHINE = "m_3q7k9d2xw8f4r6t1c5v0b2n8aa";

const spaceRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  one: 1,
  space_id: "sp_7c0hq2m4w9d8k1r6t3v5x0b2nf",
  name: "Mira",
  ref_prefix: "M",
  format_major: 0,
  format_minor: 1,
  last_seq: 140,
  next_ref: 15,
  authority_machine: MACHINE,
  authority_epoch: 1,
  authority_incarnation: INCARNATION,
  authority_since: 0,
  lineage: JSON.stringify({
    forked_from: null,
    incarnations: [
      {
        incarnation: INCARNATION,
        epoch: 1,
        kind: "create",
        parent: null,
        machine_id: MACHINE,
        at: 1,
      },
    ],
  }),
  transfer: null,
  undo_floor_seq: 0,
  created_at: 1_762_800_000_000,
  ...overrides,
});

describe("[A1.5.space.row-domain] the integer domain and the row decoders", () => {
  test("the ranges match the contracts wire patterns: the largest value fits, one digit more does not", () => {
    const asOf = (epoch: number, seq: number) => `${String(epoch)}.${String(seq)}.5n0w8k3q`;
    expect(asOf(RANGES.epoch.max, RANGES.seq.max)).toMatch(patterns.asOf);
    expect(asOf(RANGES.epoch.max * 10 + 9, 0)).not.toMatch(patterns.asOf);
    expect(asOf(1, RANGES.seq.max * 10 + 9)).not.toMatch(patterns.asOf);
    expect(`M-${String(RANGES.taskRef.max)}`).toMatch(patterns.taskRef);
    expect(`M-${String(RANGES.taskRef.max + 1)}`).not.toMatch(patterns.taskRef);
    expect(`n${String(RANGES.ordinal.max)}`).toMatch(patterns.entryRef);
    expect(`n${String(RANGES.ordinal.max + 1)}`).not.toMatch(patterns.entryRef);
    // The reviewer's case: an instant past year 9999 is written with a six-digit year.
    expect(new Date(RANGES.instant.max).toISOString()).toBe("9999-12-31T23:59:59.999Z");
    expect(new Date(RANGES.instant.max).toISOString()).toMatch(patterns.instant);
    expect(new Date(RANGES.instant.max + 1).toISOString()).not.toMatch(patterns.instant);
    expect(new Date(RANGES.instant.min).toISOString()).toMatch(patterns.instant);
    for (const { max } of Object.values(RANGES)) expect(Number.isSafeInteger(max)).toBe(true);
  });

  test("an integer column refuses a bigint, a fraction, text and a value out of range", () => {
    expect(new RowReader("t", { v: 5 }).int("v", "seq")).toBe(5);
    for (const bad of [2n ** 60n, 1.5, "5", null, -1, RANGES.seq.max + 1, Number.NaN]) {
      invalid(() => new RowReader("t", { v: bad }).int("v", "seq"), "t.v");
    }
    expect(new RowReader("t", { v: null }).optInt("v", "seq")).toBeNull();
    invalid(() => new RowReader("t", { v: 0 }).int("v", "epoch"), "t.v");
    expect(inRange(RANGES.instant.max, "instant")).toBe(true);
    expect(inRange(RANGES.instant.max + 1, "instant")).toBe(false);
  });

  test("text, IDs, enumerations and JSON are checked", () => {
    const r = new RowReader("t", { s: "x", n: 1, id: INCARNATION, e: "b", j: "{", ok: "[1]" });
    expect(r.text("s")).toBe("x");
    invalid(() => r.text("n"), "t.n");
    expect(r.id("id", "ai")).toBe(INCARNATION);
    invalid(() => r.id("id", "m"), "t.id");
    expect(r.oneOf("e", ["a", "b"])).toBe("b");
    invalid(() => r.oneOf("e", ["a"]), "t.e");
    invalid(() => r.json("j"), "t.j");
    expect(r.json("ok")).toEqual([1]);
  });

  test("the space row decodes, and each broken field is refused by name", () => {
    const space = decodeSpaceRow(spaceRow());
    expect(space).toMatchObject({ lastSeq: 140, nextRef: 15, authority: { epoch: 1 } });
    // One past the largest reference: the counter is used up, which is still a valid state.
    expect(decodeSpaceRow(spaceRow({ next_ref: RANGES.taskRef.max + 1 })).nextRef).toBe(
      RANGES.taskRef.max + 1,
    );
    const broken: [Record<string, unknown>, string][] = [
      [{ last_seq: 2n ** 60n }, "last_seq"],
      [{ next_ref: 0 }, "next_ref"],
      [{ next_ref: RANGES.taskRef.max + 2 }, "next_ref"],
      [{ authority_epoch: 0 }, "authority_epoch"],
      [{ authority_since: 141 }, "authority_since"],
      [{ authority_incarnation: "ai_x" }, "authority_incarnation"],
      [{ space_id: "t_7c0hq2m4w9d8k1r6t3v5x0b2nf" }, "space_id"],
      [{ ref_prefix: "m" }, "ref_prefix"],
      [{ name: "" }, "name"],
      [{ name: "a\u0007b" }, "name"],
      [{ lineage: "{}" }, "lineage"],
      [{ lineage: JSON.stringify({ forked_from: null, incarnations: [] }) }, "lineage"],
      [{ authority_epoch: 2 }, "lineage"],
      [{ transfer: "[]" }, "transfer"],
      [{ created_at: -1 }, "created_at"],
      [{ created_at: RANGES.instant.max + 1 }, "created_at"],
    ];
    for (const [override, column] of broken) {
      invalid(() => decodeSpaceRow(spaceRow(override)), `space.${column}`);
    }
    try {
      decodeSpaceRow(undefined);
      throw new Error("a missing row was accepted");
    } catch (error) {
      expect((error as StorageError).code).toBe("SPACE_INVALID");
    }
  });

  test("a lineage entry's parent and kind are checked", () => {
    const entry = { incarnation: INCARNATION, epoch: 2, kind: "claim", machine_id: MACHINE, at: 5 };
    const parent = { incarnation: INCARNATION, through_seq: 9 };
    expect(
      decodeLineage({ forked_from: null, incarnations: [{ ...entry, parent }] }),
    ).toBeDefined();
    expect(
      decodeLineage({
        forked_from: null,
        incarnations: [{ ...entry, parent: { through_seq: 9 } }],
      }),
    ).toBeUndefined();
    expect(
      decodeLineage({ forked_from: null, incarnations: [{ ...entry, parent, kind: "stolen" }] }),
    ).toBeUndefined();
    expect(decodeLineage({ forked_from: 3, incarnations: [{ ...entry, parent }] })).toBeUndefined();
  });
});
