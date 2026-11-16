// space.json's reader (A1 3.1, 3.17): each safety field read on its own, the damaged
// state, the bounded read, and SemVer precedence for min_reader and min_writer.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { StorageError } from "../src/errors.ts";
import {
  compareAppVersions,
  isAppVersion,
  MANIFEST_FILE,
  MANIFEST_MAX_BYTES,
  manifestText,
  readManifest,
  writeManifest,
  type SpaceManifest,
} from "../src/manifest.ts";
import { LATEST_REVISION } from "../src/space.ts";
import { createFixtureSpace, tempFolders } from "./space-helpers.ts";

const folders = tempFolders("manifest");

afterEach(() => {
  folders.cleanup();
});

let written: Promise<Record<string, unknown>> | undefined;

/**
 * The space.json a new space gets. One space is created for the whole file: readManifest reads
 * only the file, and building a space per case made these tests slow on a loaded CI runner.
 */
async function newSpaceManifest(): Promise<Record<string, unknown>> {
  written ??= createFixtureSpace(folders.make()).then(
    ({ folder }) =>
      JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8")) as Record<string, unknown>,
  );
  return structuredClone(await written);
}

/** A fresh folder whose space.json is a new space's manifest after `edit`. */
async function withManifest(
  edit: (json: Record<string, unknown>) => unknown,
): Promise<{ folder: string; original: Record<string, unknown> }> {
  const original = await newSpaceManifest();
  const folder = folders.make();
  const json = structuredClone(original);
  const replaced = edit(json);
  writeFileSync(
    join(folder, MANIFEST_FILE),
    JSON.stringify(replaced === undefined ? json : replaced),
  );
  return { folder, original };
}

describe("[A1.5.space.manifest] reading space.json", () => {
  test("a manifest Tasks wrote is whole: every safety field, not damaged", async () => {
    const { folder, original } = await withManifest(() => undefined);
    const read = readManifest(folder);
    expect(read).toMatchObject({
      state: "present",
      damaged: false,
      safety: {
        space_id: original["space_id"],
        format: LATEST_REVISION,
        min_reader: "0.0.0",
        min_writer: "0.0.0",
      },
    });
    expect(read.state === "present" && read.manifest).toEqual(original);
  });

  test("a damaged description keeps every safety field and is not damage", async () => {
    for (const [field, value] of [
      ["name", ""],
      ["lineage", {}],
      ["authority", null],
      ["transfer", 3],
      ["written_by", "x"],
    ] as const) {
      const { folder, original } = await withManifest((json) => {
        json[field] = value;
        json["min_writer"] = "99.0.0";
      });
      const read = readManifest(folder);
      expect(read, field).toMatchObject({
        state: "present",
        damaged: false,
        manifest: undefined,
        safety: { space_id: original["space_id"], min_writer: "99.0.0" },
      });
    }
  });

  test("each safety field is read on its own: one invalid field keeps the others", async () => {
    for (const [field, value] of [
      ["space_id", "sp_short"],
      ["format", { major: -1, minor: 0 }],
      ["min_reader", "1.0"],
      ["min_writer", "01.0.0"],
    ] as const) {
      const { folder, original } = await withManifest((json) => {
        json["min_reader"] = "0.0.1";
        json["min_writer"] = "7.0.0";
        json[field] = value;
      });
      const read = readManifest(folder);
      expect(read.state === "present" && read.damaged, field).toBe(true);
      const safety = read.state === "present" ? read.safety : {};
      expect(safety[field], field).toBeUndefined();
      const expected = {
        space_id: original["space_id"],
        format: LATEST_REVISION,
        min_reader: "0.0.1",
        min_writer: "7.0.0",
      };
      for (const other of ["space_id", "format", "min_reader", "min_writer"] as const) {
        if (other !== field)
          expect(safety[other], `${field} keeps ${other}`).toEqual(expected[other]);
      }
    }
  });

  test("damaged: not JSON, not an object, no marker, a missing safety field, too large", async () => {
    const cases: [string, (json: Record<string, unknown>) => unknown][] = [
      ["array", (json) => [json]],
      ["no marker", (json) => ({ ...json, tasks_space: undefined })],
      ["marker 0", (json) => ({ ...json, tasks_space: 0 })],
      ["marker text", (json) => ({ ...json, tasks_space: "1" })],
      ["no space_id", (json) => ({ ...json, space_id: undefined })],
      ["no min_writer", (json) => ({ ...json, min_writer: undefined })],
    ];
    for (const [label, edit] of cases) {
      const { folder } = await withManifest(edit);
      expect(readManifest(folder), label).toMatchObject({ state: "present", damaged: true });
    }
    const { folder } = await withManifest(() => undefined);
    const path = join(folder, MANIFEST_FILE);
    for (const text of ["{ not json", "", "﻿{}", "null"]) {
      writeFileSync(path, text);
      expect(readManifest(folder), text).toMatchObject({ state: "present", damaged: true });
    }
    writeFileSync(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: true });
  });

  test("a manifest over 64 KiB is damaged and read no further; one at the limit is read", async () => {
    expect(MANIFEST_MAX_BYTES).toBe(65_536);
    const { folder, original } = await withManifest(() => undefined);
    const path = join(folder, MANIFEST_FILE);
    const padded = (size: number): string => {
      const base = JSON.stringify({ ...original, padding: "" });
      return JSON.stringify({ ...original, padding: "x".repeat(size - base.length) });
    };
    writeFileSync(path, padded(MANIFEST_MAX_BYTES));
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: false });
    writeFileSync(path, padded(MANIFEST_MAX_BYTES + 1));
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: true, safety: {} });
    // The reviewer's case: 8 MiB of padding.
    writeFileSync(path, padded(8 * 1024 * 1024));
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: true });
  });

  test("writeManifest refuses a manifest over 64 KiB and leaves space.json as it was", async () => {
    const { folder, manifest } = await createFixtureSpace(folders.make());
    const path = join(folder, MANIFEST_FILE);
    const before = readFileSync(path, "utf8");
    const bytes = (m: SpaceManifest): number => Buffer.byteLength(manifestText(m), "utf8");
    /** The manifest padded through `transfer` to exactly `size` bytes of text. */
    const sized = (size: number): SpaceManifest => {
      const base = bytes({ ...manifest, transfer: { pad: "" } });
      const padded = { ...manifest, transfer: { pad: "x".repeat(size - base) } };
      expect(bytes(padded)).toBe(size);
      return padded;
    };
    // A lineage that grew past the bound: some 300 claims and transfers.
    const entry = manifest.lineage.incarnations[0];
    if (entry === undefined) throw new Error("the fixture space has a lineage entry");
    const grown = {
      ...manifest,
      lineage: { ...manifest.lineage, incarnations: Array.from({ length: 300 }, () => entry) },
    };
    expect(bytes(grown)).toBeGreaterThan(MANIFEST_MAX_BYTES);
    for (const [label, over] of [
      ["one byte over", sized(MANIFEST_MAX_BYTES + 1)],
      ["a grown lineage", grown],
    ] as const) {
      let caught: unknown;
      try {
        writeManifest(folder, over);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code, label).toBe("SPACE_INVALID");
      expect(JSON.stringify(caught), label).not.toContain(folder);
      // Refused before the temporary file: nothing new in the folder, space.json unchanged.
      expect(readdirSync(folder).sort(), label).toEqual(["space.db", MANIFEST_FILE]);
      expect(readFileSync(path, "utf8"), label).toBe(before);
    }
    // At the bound it is written, and read back whole.
    writeManifest(folder, sized(MANIFEST_MAX_BYTES));
    expect(readFileSync(path).length).toBe(MANIFEST_MAX_BYTES);
    expect(readManifest(folder)).toMatchObject({ state: "present", damaged: false });
  });

  test("a newer marker is newer, a missing file is missing", async () => {
    const { folder } = await withManifest((json) => {
      json["tasks_space"] = 2;
    });
    expect(readManifest(folder)).toEqual({ state: "newer" });
    expect(readManifest(folders.make())).toEqual({ state: "missing" });
  });
});

/** SemVer 2.0.0's own example of precedence (item 11), lowest first. */
const SEMVER_CHAIN = [
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-alpha.beta",
  "1.0.0-beta",
  "1.0.0-beta.2",
  "1.0.0-beta.11",
  "1.0.0-rc.1",
  "1.0.0",
  "1.0.1",
  "1.1.0",
  "2.0.0",
];

const numericId = fc.nat({ max: 1_000_000 }).map(String);
const alphaId = fc.stringMatching(/^[0-9A-Za-z-]{0,6}[A-Za-z-][0-9A-Za-z-]{0,6}$/);
const identifier = fc.oneof(numericId, alphaId);
const version = fc
  .tuple(
    fc.nat({ max: 20 }),
    fc.nat({ max: 20 }),
    fc.nat({ max: 20 }),
    fc.option(fc.array(identifier, { minLength: 1, maxLength: 4 }), { nil: undefined }),
  )
  .map(([a, b, c, pre]) => {
    const core = `${String(a)}.${String(b)}.${String(c)}`;
    return pre === undefined ? core : `${core}-${pre.join(".")}`;
  })
  .filter((v) => v.length <= 94 && (v.split("-", 2)[1] ?? "").length <= 64);

describe("[A1.5.space.manifest] app versions compare by SemVer precedence", () => {
  test("SemVer's own example chain is in order", () => {
    for (let i = 0; i < SEMVER_CHAIN.length; i += 1) {
      for (let j = 0; j < SEMVER_CHAIN.length; j += 1) {
        const a = SEMVER_CHAIN[i] ?? "";
        const b = SEMVER_CHAIN[j] ?? "";
        expect(compareAppVersions(a, b), `${a} vs ${b}`).toBe(Math.sign(i - j));
      }
    }
  });

  test("the reviewer's case: rc.2 is below rc.10, so it does not meet min_writer rc.10", () => {
    expect(compareAppVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareAppVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareAppVersions("1.0.0-2", "1.0.0-rc")).toBe(-1);
    expect(compareAppVersions("1.0.0-99999999999999999999", "1.0.0-100000000000000000000")).toBe(
      -1,
    );
    expect(compareAppVersions("10.0.0", "9.0.0")).toBe(1);
  });

  test("the accepted syntax: SemVer's, without build metadata", () => {
    for (const ok of ["0.0.0", "1.2.3", "1.0.0-rc.1", "1.0.0-0a", "1.0.0-x-y", "1.0.0--"]) {
      expect(isAppVersion(ok), ok).toBe(true);
    }
    for (const bad of [
      "1",
      "1.0",
      "01.0.0",
      "1.00.0",
      "1.0.0-",
      "1.0.0-rc..1",
      "1.0.0-rc.",
      "1.0.0-.rc",
      "1.0.0-rc.01",
      "1.0.0-r_c",
      "1.0.0+build",
      "v1.0.0",
      ` 1.0.0`,
      `1.0.0-${"a".repeat(65)}`,
      "1234567890.0.0",
      42,
    ]) {
      expect(isAppVersion(bad), String(bad)).toBe(false);
    }
    expect(() => compareAppVersions("1.0", "1.0.0")).toThrow(RangeError);
  });

  test("property: a total order, consistent with equality, releases above their pre-releases", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(isAppVersion(a)).toBe(true);
        expect(compareAppVersions(a, a)).toBe(0);
        expect(compareAppVersions(a, b) === 0).toBe(a === b);
        expect(compareAppVersions(a, b)).toBe(-compareAppVersions(b, a));
        // Transitive: after sorting, every pair is in order, not only the neighbours.
        const [x = "", y = "", z = ""] = [a, b, c].sort(compareAppVersions);
        expect(compareAppVersions(x, y)).toBeLessThanOrEqual(0);
        expect(compareAppVersions(y, z)).toBeLessThanOrEqual(0);
        expect(compareAppVersions(x, z)).toBeLessThanOrEqual(0);
        const core = a.split("-")[0] ?? "";
        if (core !== a) expect(compareAppVersions(a, core)).toBe(-1);
      }),
      { numRuns: 500 },
    );
  });

  test("property: numeric identifiers compare as numbers and rank below alphanumeric ones", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), alphaId, (m, n, word) => {
        const at = (id: string) => `1.0.0-rc.${id}`;
        expect(compareAppVersions(at(String(m)), at(String(n)))).toBe(Math.sign(m - n));
        expect(compareAppVersions(at(String(m)), at(word))).toBe(-1);
        expect(compareAppVersions(`1.0.0-rc`, at(String(m)))).toBe(-1);
      }),
      { numRuns: 300 },
    );
  });
});
