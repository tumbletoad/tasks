// Export bundles (A1 3.18, A6 3.5, A7 M3.07): the export and its restore, the shared BundlePolicy
// on archives, the archive rules a restore enforces, and the export's secret scan. Fixture data
// only: every archive a test needs to be refused is crafted here, byte by byte.
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
  exportBundle,
  exportBundleWith,
  exportName,
  exportPeak,
  type ExportPoint,
} from "../src/bundle/export.ts";
import { EXPORT_MARKER, EXPORT_VERSION, exportText } from "../src/bundle/export-file.ts";
import { readBundle } from "../src/bundle/read.ts";
import { ZipWriter } from "../src/bundle/zip.ts";
import { BUNDLE_POLICY, type BundlePolicy } from "../src/backup/policy.ts";
import { StorageError } from "../src/errors.ts";
import { NODE_IO } from "../src/files.ts";
import { newId, osRandom } from "../src/ids.ts";
import { backupPeak, backupSpace, backupSpaceWith } from "../src/backup/backup.ts";
import { listBackups, verifyBackup } from "../src/backup/list.ts";
import { applyRetention, planRetention } from "../src/backup/retention.ts";
import { schemaObjects } from "../src/backup/snapshot.ts";
import { openReader } from "../src/open.ts";
import { rescueSpace, restoreLatest } from "../src/restore/rescue.ts";
import { restoreBackup, restoreBackupWith, restoreInPlace } from "../src/restore/restore.ts";
import { unpackBackup } from "../src/restore/unpack.ts";
import { openSpace } from "../src/space.ts";
import { copyTree, rawWriter, readFacts, treeDigest, writeCommits } from "./backup-helpers.ts";
import { checkedDriver, createFixtureSpace, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { STEPS_0_1 } from "./revisions.ts";
import { STEPS_MARK_GUARD, STEPS_SEARCH } from "./stand-in-steps.ts";

const folders = tempFolders("bundle");

afterEach(() => {
  folders.cleanup();
});

async function expectCode(fn: () => unknown, code: string): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code, (error as Error).message).toBe(code);
    return error as StorageError;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const policyWith = (overrides: Partial<BundlePolicy>): BundlePolicy => ({
  ...BUNDLE_POLICY,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Crafted archives

interface Craft {
  name: string;
  data?: Buffer;
  method?: number;
  /** The uncompressed size the headers claim. Default: the real one. */
  size?: number;
  /** The compressed size the central record claims. Default: the real one. */
  packed?: number;
  external?: number;
  madeBy?: number;
  flags?: number;
  /** What the local header alone says, where it differs from the central record. */
  local?: { crc?: number; packed?: number; size?: number; flags?: number };
}

/** Writes a ZIP archive as the entries say, lies included. */
function craftZip(path: string, entries: readonly Craft[]): void {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name, "utf8");
    const flags = e.flags ?? 0x0800;
    const size = e.size ?? data.length;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.local?.flags ?? flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.local?.crc ?? crc, 14);
    local.writeUInt32LE(e.local?.packed ?? e.packed ?? packed.length, 18);
    local.writeUInt32LE(e.local?.size ?? size, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(e.madeBy ?? (3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(e.packed ?? packed.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(e.external ?? 0o100600 * 0x10000, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    parts.push(local, name, packed);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, directory, end]));
}

/** A valid export.json for crafted files: every file listed with its real size and SHA-256. */
function exportJson(files: Record<string, Buffer | { size: number; sha256: string }>): Buffer {
  const listed = Object.fromEntries(
    Object.entries(files).map(([path, f]) => [
      path,
      Buffer.isBuffer(f) ? { sha256: sha(f), size: f.length } : f,
    ]),
  );
  return Buffer.from(
    exportText({
      [EXPORT_MARKER]: EXPORT_VERSION,
      mode: "backup",
      space_id: newId("sp", osRandom),
      epoch: 1,
      incarnation: newId("ai", osRandom),
      seq: 0,
      user_version: 2,
      counts: {},
      created_at: Date.UTC(2026, 10, 14),
      written_by: "0.0.0",
      files: listed,
    }),
  );
}

/**
 * Plants `sql` in the database file `db` as another program could: SQLite's defensive flag off and
 * its schema writable, so even a name with SQLite's reserved prefix is taken.
 */
function plant(db: string, sql: string): void {
  const conn = new DatabaseSync(db, { defensive: false });
  try {
    conn.exec("PRAGMA writable_schema = ON");
    conn.exec(sql);
    conn.exec("PRAGMA writable_schema = OFF");
  } finally {
    conn.close();
  }
}

/** Restores `zip` into a new folder, expects `code`, and that no folder was left behind. */
async function refused(zip: string, code: string, policy?: BundlePolicy): Promise<StorageError> {
  const checked = await checkedDriver();
  const parent = folders.make();
  const error = await expectCode(
    () =>
      restoreBackupWith(
        checked,
        zip,
        join(parent, "mira"),
        {},
        policy === undefined ? {} : { policy },
      ),
    code,
  );
  expect(readdirSync(parent)).toEqual([]);
  expect(error.message).not.toContain(parent);
  return error;
}

/**
 * The bundle `file` rebuilt after `edit` changed its unpacked files (its database at
 * `<folder>/space.db`), with export.json made to agree with the result: every file's digest and
 * the database's rows per table. A crafted bundle, as another tool could write one.
 */
async function rebuildBundle(
  file: string,
  edit: (folder: string) => Promise<void> | void,
): Promise<string> {
  const unpacked = folders.make();
  const { manifest } = await readBundle(file, BUNDLE_POLICY, {
    extractTo: (name) => join(unpacked, ...name.split("/")),
  });
  await edit(unpacked);
  const { counts } = await readFacts(unpacked);
  const out = join(folders.make(), "rebuilt.zip");
  const writer = ZipWriter.create(out, 0);
  const files: typeof manifest.files = {};
  for (const name of Object.keys(manifest.files)) {
    const entry = writer.addBytes(name, readFileSync(join(unpacked, ...name.split("/"))));
    files[name] = { size: entry.size, sha256: entry.sha256 };
  }
  writer.addBytes("export.json", Buffer.from(exportText({ ...manifest, counts, files })));
  writer.finish();
  return out;
}

// ---------------------------------------------------------------------------------------------

describe("[A1.5.bundle.zip-hardening] a restore refuses an archive that breaks a rule, and leaves nothing", () => {
  test("paths: `..`, absolute, a drive, a backslash, empty and dot parts, device names, NFD", async () => {
    const src = folders.make();
    const names = [
      "../space.db",
      "view/../../outside.md",
      "/space.db",
      "C:/space.db",
      "view\\tasks.md",
      "view//tasks.md",
      "view/./tasks.md",
      "view/con.md",
      "view/notes.",
      "view/Cafe\u0301.md",
      "view/tab\there.md",
    ];
    for (const [i, name] of names.entries()) {
      const zip = join(src, `bad-${String(i)}.zip`);
      const data = Buffer.from("text");
      craftZip(zip, [
        { name, data },
        { name: "export.json", data: exportJson({}) },
      ]);
      const error = await refused(zip, "BUNDLE_INVALID");
      expect(error.message, name).not.toContain(name);
    }
  });

  test("links, devices and folders posing as files are refused by their attributes", async () => {
    const src = folders.make();
    const kinds: Craft[] = [
      // A symbolic link, as Unix zip tools store one.
      { name: "view/link.md", data: Buffer.from("../../etc"), external: 0o120777 * 0x10000 },
      // A character device and a FIFO.
      { name: "view/dev.md", external: 0o020666 * 0x10000 },
      { name: "view/fifo.md", external: 0o010666 * 0x10000 },
      // A Windows reparse point (a link or a junction) and a folder bit on a file.
      { name: "view/junction.md", madeBy: 20, external: 0x400 },
      { name: "view/folder.md", madeBy: 20, external: 0x10 },
    ];
    for (const [i, entry] of kinds.entries()) {
      const zip = join(src, `link-${String(i)}.zip`);
      craftZip(zip, [entry, { name: "export.json", data: exportJson({}) }]);
      await refused(zip, "BUNDLE_INVALID");
    }
  });

  test("too many entries, too many expanded bytes, and an oversized file are refused", async () => {
    const src = folders.make();
    const files = Array.from({ length: 6 }, (_, i) => ({
      name: `view/${String(i)}.md`,
      data: Buffer.from(`file ${String(i)}`),
    }));
    const listed = Object.fromEntries(files.map((f) => [f.name, f.data]));
    const many = join(src, "many.zip");
    craftZip(many, [...files, { name: "export.json", data: exportJson(listed) }]);
    // The count, from the end record and again record by record.
    const count = await refused(many, "BUNDLE_LIMIT_EXCEEDED", policyWith({ maxEntries: 5 }));
    expect(count.message).toContain("number of entries");

    // A bomb: a small archive that expands to much more, honestly declared.
    const bomb = join(src, "bomb.zip");
    const zeros = Buffer.alloc(4 * 1024 * 1024);
    craftZip(bomb, [
      { name: "data.jsonl", data: zeros },
      { name: "export.json", data: exportJson({ "data.jsonl": zeros }) },
    ]);
    const total = await refused(
      bomb,
      "BUNDLE_LIMIT_EXCEEDED",
      policyWith({ maxTotalBytes: 1024 * 1024 }),
    );
    expect(total.message).toContain("total expanded size");
    // The same file over its kind's limit.
    const one = await refused(bomb, "BUNDLE_LIMIT_EXCEEDED", policyWith({ maxJsonlBytes: 1024 }));
    expect(one.message).toContain("data.jsonl");

    // A bomb that lies: its headers claim 100 bytes. Extraction stops at the 101st.
    const liar = join(src, "liar.zip");
    craftZip(liar, [
      { name: "data.jsonl", data: zeros, size: 100 },
      {
        name: "export.json",
        data: exportJson({ "data.jsonl": { size: 100, sha256: sha(zeros.subarray(0, 100)) } }),
      },
    ]);
    const lie = await refused(liar, "BUNDLE_INVALID");
    expect(lie.message).toContain("more than its header says");
  });

  test("duplicates by case or form, a file where a folder is, overlaps, encryption and other methods", async () => {
    const src = folders.make();
    const data = Buffer.from("text");
    const cases: Craft[][] = [
      [
        { name: "view/Notes.md", data },
        { name: "view/notes.md", data },
      ],
      [
        { name: "view/a", data },
        { name: "view/a/b.md", data },
      ],
      [{ name: "view/locked.md", data, flags: 0x0801 }],
      [{ name: "view/other.md", data, method: 12 }],
      // A stored entry whose central record claims its data runs over the next entry's header.
      [
        { name: "view/one.md", data, method: 0, size: 200, packed: 200 },
        { name: "view/two.md", data, method: 0 },
      ],
    ];
    for (const [i, entries] of cases.entries()) {
      const zip = join(src, `case-${String(i)}.zip`);
      craftZip(zip, [...entries, { name: "export.json", data: exportJson({}) }]);
      await refused(zip, "BUNDLE_INVALID");
    }
  });

  test("a local header that does not repeat its central record: its CRC, its sizes, a ZIP64 mark without its field", async () => {
    const src = folders.make();
    const data = Buffer.from("text");
    const listed = { "view/a.md": data };
    const cases: NonNullable<Craft["local"]>[] = [
      { crc: 0x12345678 },
      { size: 5 },
      { packed: 1 },
      // ZIP64's mark, but no ZIP64 field in the local header to carry the size.
      { size: 0xffffffff },
      // A data descriptor's flag with the CRC still set but wrong.
      { flags: 0x0808, crc: 1 },
    ];
    for (const [i, local] of cases.entries()) {
      const zip = join(src, `local-${String(i)}.zip`);
      craftZip(zip, [
        { name: "view/a.md", data, local },
        { name: "export.json", data: exportJson(listed) },
      ]);
      const error = await refused(zip, "BUNDLE_INVALID");
      expect(error.message, JSON.stringify(local)).toContain("local header");
    }
    // A data descriptor's flag with zeros in the local header, as streaming tools write it, reads.
    const streamed = join(src, "streamed.zip");
    craftZip(streamed, [
      { name: "view/a.md", data, local: { flags: 0x0808, crc: 0, packed: 0, size: 0 } },
      { name: "export.json", data: exportJson(listed) },
    ]);
    await readBundle(streamed, BUNDLE_POLICY);
  });

  test("a file a bundle never holds, a missing or unlisted file, a wrong checksum, and no archive at all", async () => {
    const src = folders.make();
    const data = Buffer.from("text");
    const unknown = join(src, "unknown.zip");
    craftZip(unknown, [
      { name: "notes.txt", data },
      { name: "export.json", data: exportJson({}) },
    ]);
    await refused(unknown, "BUNDLE_INVALID");
    const unlisted = join(src, "unlisted.zip");
    craftZip(unlisted, [
      { name: "view/a.md", data },
      { name: "export.json", data: exportJson({}) },
    ]);
    await refused(unlisted, "BUNDLE_INVALID");
    const missing = join(src, "missing.zip");
    craftZip(missing, [{ name: "export.json", data: exportJson({ "view/a.md": data }) }]);
    await refused(missing, "BUNDLE_INVALID");
    const wrong = join(src, "wrong.zip");
    craftZip(wrong, [
      { name: "view/a.md", data },
      {
        name: "export.json",
        data: exportJson({ "view/a.md": { size: data.length, sha256: sha(Buffer.from("tex!")) } }),
      },
    ]);
    await refused(wrong, "BUNDLE_INVALID");
    const none = join(src, "none.zip");
    writeFileSync(none, "not an archive at all");
    await refused(none, "BUNDLE_INVALID");
    const empty = join(src, "export-less.zip");
    craftZip(empty, [{ name: "view/a.md", data }]);
    await refused(empty, "BUNDLE_INVALID");
  });

  test.skipIf(process.platform === "win32")(
    "a bundle reached through a link is refused, never followed",
    async () => {
      const checked = await checkedDriver();
      const { folder } = await createFixtureSpace(folders.make());
      const bundle = await exportBundle(checked, folder, { mode: "backup" });
      const link = join(folders.make(), "link.zip");
      symlinkSync(bundle.file, link);
      await refused(link, "BUNDLE_INVALID");
    },
  );
});

describe("[A1.5.bundle.export-restore] export bundles restore as read-only copies", () => {
  test("backup mode: the bundle holds the snapshot, space.json and export.json, and restores", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 5);
    const at = Date.UTC(2026, 10, 14, 9, 30, 0, 250);
    const bundle = await exportBundle(checked, folder, { mode: "backup", now: () => at });
    expect(bundle.name).toBe(exportName("backup", at, 1, 5));
    expect(bundle.name).toBe("backup-20261114T093000.250Z-e1-s5.zip");
    // Only the published bundle is in the exports folder: no work folder.
    expect(readdirSync(join(folder, "exports"))).toEqual([bundle.name]);
    expect(Object.keys(bundle.manifest.files).sort()).toEqual(["space.db", "space.json"]);
    expect(bundle.manifest).toMatchObject({
      tasks_export: 1,
      mode: "backup",
      space_id: space.spaceId,
      epoch: 1,
      incarnation: space.authority.incarnation,
      seq: 5,
      user_version: 2,
      created_at: at,
    });
    expect(bundle.sha256).toBe(sha(readFileSync(bundle.file)));
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(bundle.file).mode & 0o777).toBe(0o600);
      expect(statSync(join(folder, "exports")).mode & 0o777).toBe(0o700);
    }
    const restored = await restoreBackup(checked, bundle.file, join(folders.make(), "mira"));
    expect(restored.source.kind).toBe("bundle");
    expect(readdirSync(restored.folder).sort()).toEqual(["space.db", "space.json"]);
    const facts = await readFacts(restored.folder);
    expect(facts.integrity).toBe("ok");
    expect(facts.space.lastSeq).toBe(5);
    expect(facts.counts).toEqual(bundle.manifest.counts);
    const opened = openSpace(checked, restored.folder, { role: "reader" });
    expect(opened.readOnlyReasons).toEqual(["read_only_copy"]);
    opened.conn.close();
  });

  test("fork and transfer modes carry their mode and statement, and restore read-only like any bundle", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const fork = await exportBundle(checked, folder, { mode: "fork", now: () => 1 });
    expect(fork.manifest.mode).toBe("fork");
    expect(fork.manifest.space_id).toBe(space.spaceId);
    const statement = {
      transfer_id: newId("tr", osRandom),
      to: newId("m", osRandom),
      from_machine: space.authority.machineId,
      through_seq: 2,
    };
    const transfer = await exportBundle(checked, folder, {
      mode: "transfer",
      statement,
      now: () => 2,
    });
    expect(transfer.manifest.transfer_statement).toEqual(statement);
    expect((await readBundle(transfer.file, BUNDLE_POLICY)).manifest.transfer_statement).toEqual(
      statement,
    );
    for (const bundle of [fork, transfer]) {
      const restored = await restoreBackup(checked, bundle.file, join(folders.make(), "mira"));
      const opened = openSpace(checked, restored.folder, { role: "reader" });
      expect(opened.readOnlyReasons).toEqual(["read_only_copy"]);
      expect(opened.space.spaceId).toBe(space.spaceId);
      opened.conn.close();
    }
    // A statement without the transfer mode, or the mode without one, is a caller's mistake.
    await expectCode(() => exportBundle(checked, folder, { mode: "transfer" }), "STORAGE_MISUSE");
    await expectCode(
      () => exportBundle(checked, folder, { mode: "backup", statement }),
      "STORAGE_MISUSE",
    );
  });

  test("with data.jsonl: every row of every table, one per line", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 4);
    const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    expect(Object.keys(bundle.manifest.files).sort()).toEqual([
      "data.jsonl",
      "space.db",
      "space.json",
    ]);
    const kept = await readBundle(bundle.file, BUNDLE_POLICY, { keep: ["data.jsonl"] });
    const lines = (kept.kept.get("data.jsonl") ?? Buffer.alloc(0))
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { table: string; row: Record<string, unknown> });
    const total = Object.values(bundle.manifest.counts).reduce((a, b) => a + b, 0);
    expect(lines).toHaveLength(total);
    expect(lines.filter((l) => l.table === "tasks")).toHaveLength(
      bundle.manifest.counts["tasks"] ?? -1,
    );
    expect(lines.find((l) => l.table === "space")?.row["space_id"]).toBe(bundle.manifest.space_id);
  });

  test("the exporter refuses what a restore would refuse, before it writes; a compressible bundle passes", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const conn = await rawWriter(folder);
    try {
      conn.prepare("UPDATE tasks SET context = replace(hex(zeroblob(32768)), '00', 'ab')").run();
    } finally {
      conn.close();
    }
    for (const policy of [
      policyWith({ maxDatabaseBytes: 16 * 1024 }),
      policyWith({ maxTotalBytes: 16 * 1024 }),
      policyWith({ maxEntries: 2 }),
    ]) {
      await expectCode(
        () => exportBundleWith(checked, folder, { mode: "backup" }, { policy }),
        "BUNDLE_LIMIT_EXCEEDED",
      );
      expect(readdirSync(join(folder, "exports"))).toEqual([]);
    }
    // Text-heavy data compresses far beyond a "bomb" ratio: no rule refuses it (A1 3.18).
    const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    const expanded = Object.values(bundle.manifest.files).reduce((sum, f) => sum + f.size, 0);
    expect(expanded / bundle.size).toBeGreaterThan(20);
    await restoreBackup(checked, bundle.file, join(folders.make(), "mira"));
  });

  test("a bundle whose database or facts were changed after export is refused", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const bundle = await exportBundle(checked, folder, { mode: "backup" });
    const src = folders.make();
    // A rebuilt archive whose export.json claims one more task than the database holds.
    const zip = join(src, "lying.zip");
    const { manifest, kept } = await readBundle(bundle.file, BUNDLE_POLICY, {
      extractTo: (name) => (name === "space.db" ? join(src, "space.db") : undefined),
      keep: ["space.json"],
    });
    const writer = ZipWriter.create(zip, 0);
    writer.addBytes("space.json", kept.get("space.json") ?? Buffer.alloc(0));
    await writer.addFile(
      "space.db",
      join(src, "space.db"),
      manifest.files["space.db"]?.size ?? 0,
      BUNDLE_POLICY.maxDatabaseBytes,
    );
    writer.addBytes(
      "export.json",
      Buffer.from(
        exportText({
          ...manifest,
          counts: { ...manifest.counts, tasks: (manifest.counts["tasks"] ?? 0) + 1 },
        }),
      ),
    );
    writer.finish();
    const error = await refused(zip, "BUNDLE_INVALID");
    expect(error.message).toContain("differs from export.json");
    // A flipped byte inside the archive's space.db.
    const bytes = readFileSync(bundle.file);
    const flipped = join(src, "flipped.zip");
    const at = bytes.indexOf(Buffer.from("space.db")) + 200;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    writeFileSync(flipped, bytes);
    await refused(flipped, "BUNDLE_INVALID");
  });

  test("a fault before publication leaves no bundle and no work folder; after it, the bundle stays", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const points: ExportPoint[] = ["snapshot", "scanned", "written", "verified", "published"];
    for (const point of points) {
      await expectCode(
        () =>
          exportBundleWith(
            checked,
            folder,
            { mode: "backup", now: () => Date.UTC(2026, 10, 14) },
            {
              at: (p) => {
                if (p === point) throw new Error("a stand-in fault");
              },
            },
          ),
        "BACKUP_FAILED",
      );
      const left = readdirSync(join(folder, "exports"));
      if (point !== "published") {
        expect(left, point).toEqual([]);
        continue;
      }
      // Published, then the last step failed: the bundle is kept, whole, for the reader.
      expect(left).toEqual([exportName("backup", Date.UTC(2026, 10, 14), 1, 2)]);
      await readBundle(join(folder, "exports", left[0] ?? ""), BUNDLE_POLICY);
    }
  });

  test("publication never replaces: a file at the bundle's name stays, with links or without", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 1);
    const at = Date.UTC(2026, 10, 14);
    const name = exportName("backup", at, 1, 1);
    mkdirSync(join(folder, "exports"));
    writeFileSync(join(folder, "exports", name), "someone else's file");
    const noLinks = {
      ...NODE_IO,
      linkSync: () => {
        throw Object.assign(new Error("no links here"), { code: "EPERM" });
      },
    };
    for (const io of [NODE_IO, noLinks]) {
      const error = await expectCode(
        () => exportBundleWith(checked, folder, { mode: "backup", now: () => at }, { io }),
        "BACKUP_FAILED",
      );
      expect(error.message).toContain("already exists");
      expect(readFileSync(join(folder, "exports", name), "utf8")).toBe("someone else's file");
      expect(readdirSync(join(folder, "exports"))).toEqual([name]);
    }
    // Without links the bundle is a copy made by an exclusive create, and it restores.
    const copied = await exportBundleWith(
      checked,
      folder,
      { mode: "backup", now: () => at + 1 },
      { io: noLinks },
    );
    await restoreBackup(checked, copied.file, join(folders.make(), "mira"));
  });

  test("attachments: exactly the live rows' blobs go into the bundle and come back", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const blob = Buffer.from("an attached file's content\n".repeat(100));
    const hash = sha(blob);
    const stale = Buffer.from("a deleted attachment");
    await addAttachment(folder, blob, null);
    await addAttachment(folder, stale, 5);
    // A deleted attachment's blob is gone (A1 3.11.4); only the live one goes into the bundle.
    const bundle = await exportBundle(checked, folder, { mode: "backup" });
    const path = `attachments/sha256/${hash.slice(0, 2)}/${hash}`;
    expect(Object.keys(bundle.manifest.files).sort()).toEqual([path, "space.db", "space.json"]);
    const restored = await restoreBackup(checked, bundle.file, join(folders.make(), "mira"));
    expect(readFileSync(join(restored.folder, ...path.split("/")))).toEqual(blob);
    // A live row whose blob is missing: no bundle.
    const { rmSync } = await import("node:fs");
    rmSync(join(folder, ...path.split("/")));
    await expectCode(() => exportBundle(checked, folder, { mode: "backup" }), "BUNDLE_INVALID");
    expect(readdirSync(join(folder, "exports"))).toEqual([bundle.name]);
  });

  test("attachments: a blob whose content is not its name's hash, or not its row's size, is refused", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const blob = Buffer.from("an attached file's content\n");
    const hash = sha(blob);
    const path = `attachments/sha256/${hash.slice(0, 2)}/${hash}`;
    await addAttachment(folder, blob, null);
    const bundle = await exportBundle(checked, folder, { mode: "backup" });
    const unpacked = folders.make();
    const { manifest } = await readBundle(bundle.file, BUNDLE_POLICY, {
      extractTo: (name) => join(unpacked, ...name.split("/")),
    });
    /** The bundle again, with export.json's digests made to agree with each file as it is now. */
    const rebuilt = (replace: Record<string, Buffer>): string => {
      const file = join(folders.make(), "rebuilt.zip");
      const writer = ZipWriter.create(file, 0);
      const files: typeof manifest.files = {};
      for (const name of Object.keys(manifest.files)) {
        const data = replace[name] ?? readFileSync(join(unpacked, ...name.split("/")));
        const entry = writer.addBytes(name, data);
        files[name] = { size: entry.size, sha256: entry.sha256 };
      }
      writer.addBytes("export.json", Buffer.from(exportText({ ...manifest, files })));
      writer.finish();
      return file;
    };
    // Other bytes under the blob's name.
    const swapped = rebuilt({ [path]: Buffer.from("other bytes, another length\n") });
    await expectCode(
      () => restoreBackup(checked, swapped, join(folders.make(), "mira")),
      "BUNDLE_INVALID",
    );
    // The right bytes, but the row records another size.
    const conn = await rawWriter(unpacked);
    try {
      conn.prepare("UPDATE attachments SET size = size + 1").run();
    } finally {
      conn.close();
    }
    const sized = rebuilt({ "space.db": readFileSync(join(unpacked, "space.db")) });
    await expectCode(
      () => restoreBackup(checked, sized, join(folders.make(), "mira")),
      "BUNDLE_INVALID",
    );
  });
});

describe("[A1.5.backup.free-reserve] the backup writer and the exporter keep the shared free-space reserve", () => {
  test("each refuses before it writes anything when the free space less the reserve cannot hold its peak, and runs when it can", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    // Text that compresses poorly (random lower-case letters, which match no secret's shape), so
    // the compressed backup is most of the database's size.
    const noise = Buffer.from(randomBytes(4 * 1024 * 1024).map((b) => 97 + (b % 26))).toString(
      "latin1",
    );
    const raw = await rawWriter(folder);
    try {
      raw
        .prepare("UPDATE tasks SET context = $noise WHERE id = (SELECT min(id) FROM tasks)")
        .run({ noise });
    } finally {
      raw.close();
    }
    // The database's pages times their size: the file, with every page checkpointed into it.
    const size = statSync(join(folder, "space.db")).size;
    const reserve = BUNDLE_POLICY.freeSpaceReserveBytes;
    const seen: string[] = [];
    const free =
      (bytes: number) =>
      (where: string): number => {
        seen.push(where);
        return reserve + bytes;
      };

    const backupNeeds = backupPeak(size);
    await expectCode(
      () =>
        backupSpaceWith(checked, folder, { kind: "manual" }, { freeBytes: free(backupNeeds - 1) }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(existsSync(join(folder, "backups"))).toBe(false);
    // Asked of the nearest folder that exists: the backups folder is not made yet.
    expect(seen).toEqual([folder]);
    await backupSpaceWith(checked, folder, { kind: "manual" }, { freeBytes: free(backupNeeds) });
    // Where the file system makes no hard link, the publication copies the compressed file: the
    // snapshot is gone by then, so the backup's files on disk never pass its peak.
    const dir = join(folder, "backups");
    const onDisk = (): number =>
      readdirSync(dir)
        .filter((name) => !before.has(name))
        .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    const before = new Set(readdirSync(dir));
    let most = 0;
    const noLinks = {
      ...NODE_IO,
      linkSync: () => {
        throw Object.assign(new Error("no hard links here"), { code: "ENOTSUP" });
      },
      writeSync: (fd: number, data: Uint8Array, offset: number, length: number) => {
        const written = NODE_IO.writeSync(fd, data, offset, length);
        most = Math.max(most, onDisk());
        return written;
      },
    };
    await backupSpaceWith(
      checked,
      folder,
      { kind: "manual", now: () => Date.now() + 1000 },
      { io: noLinks, freeBytes: free(backupNeeds) },
    );
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(backupNeeds);

    // The export, before data.jsonl: 2D before it writes anything.
    const exportNeeds = exportPeak(size, 0, 0);
    expect(exportNeeds).toBe(2 * size);
    await expectCode(
      () =>
        exportBundleWith(checked, folder, { mode: "backup" }, { freeBytes: free(exportNeeds - 1) }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(existsSync(join(folder, "exports"))).toBe(false);
    await exportBundleWith(checked, folder, { mode: "backup" }, { freeBytes: free(exportNeeds) });
    expect(readdirSync(join(folder, "exports"))).toHaveLength(1);
  });

  test("data.jsonl is counted as it is written: past its share of the free space the export is refused, and nothing is published", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    // Control characters: JSON writes each as six bytes, so data.jsonl is many times the database.
    const raw = await rawWriter(folder);
    try {
      raw
        .prepare("UPDATE tasks SET context = $text WHERE id = (SELECT min(id) FROM tasks)")
        .run({ text: "\u0001".repeat(2 * 1024 * 1024) });
    } finally {
      raw.close();
    }
    const size = statSync(join(folder, "space.db")).size;
    const reserve = BUNDLE_POLICY.freeSpaceReserveBytes;
    const free = (bytes: number) => (): number => reserve + bytes;
    const ample = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    const jsonl = ample.manifest.files["data.jsonl"]?.size ?? 0;
    // Far past twice the database, which no estimate made before writing would have allowed for.
    expect(jsonl).toBeGreaterThan(4 * size);
    const exports = join(folder, "exports");
    await expectCode(
      () =>
        exportBundleWith(
          checked,
          folder,
          { mode: "backup", withJsonl: true, now: () => Date.now() + 1000 },
          { freeBytes: free(exportPeak(size, 0, jsonl) - 1) },
        ),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(readdirSync(exports)).toEqual([ample.name]);
    const fits = await exportBundleWith(
      checked,
      folder,
      { mode: "backup", withJsonl: true, now: () => Date.now() + 2000 },
      { freeBytes: free(exportPeak(size, 0, jsonl)) },
    );
    expect(fits.manifest.files["data.jsonl"]?.size).toBe(jsonl);
    expect(readdirSync(exports).sort()).toEqual([ample.name, fits.name].sort());
  });
});

describe("[A1.5.bundle.restore-drill] the restore drill, from a backup and from a bundle", () => {
  test("each restores into a new folder with integrity_check, last_seq and counts; a copy stays read-only; in place it is claimed", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 12);
    const live = await readFacts(folder);
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const bundle = await exportBundle(checked, folder, { mode: "backup" });
    for (const file of [backup.file, bundle.file]) {
      const restored = await restoreBackup(checked, file, join(folders.make(), "mira"));
      const facts = await readFacts(restored.folder);
      expect(facts.integrity, file).toBe("ok");
      expect(facts.space.lastSeq, file).toBe(live.space.lastSeq);
      expect(facts.counts, file).toEqual(live.counts);
      // A copy of the restored folder is a read-only copy too (A6 K2).
      const copy = join(folders.make(), "mira");
      copyTree(restored.folder, copy);
      for (const where of [restored.folder, copy]) {
        const opened = openSpace(checked, where, { role: "reader" });
        expect(opened.readOnlyReasons, file).toEqual(["read_only_copy"]);
        opened.conn.close();
        await expectCode(
          () => openSpace(checked, where, { role: "writer" }),
          "SPACE_READ_ONLY_COPY",
        );
      }
    }
    // In place from the bundle: claimed with a new epoch and incarnation, the old folder kept.
    const inPlace = await restoreInPlace(checked, bundle.file, folder, { machineId: TEST_MACHINE });
    expect(inPlace.source.kind).toBe("bundle");
    expect(inPlace.claim.epoch).toBe(2);
    expect(existsSync(inPlace.replaced)).toBe(true);
    const writer = openSpace(checked, folder, { role: "writer" });
    expect(writer.space.lastSeq).toBe(live.space.lastSeq + 1);
    writer.conn.close();
  });

  test("a database whose tables, indexes or views are not its revision's is refused before anything writes to it, and so is its export", async () => {
    const checked = await checkedDriver();
    const changes = [
      // A table, an index and a view the schema does not have.
      "CREATE TABLE notes_copy (id TEXT PRIMARY KEY, body TEXT) STRICT",
      "CREATE INDEX tasks_by_title ON tasks (title)",
      "CREATE VIEW open_tasks AS SELECT id FROM tasks",
      // A name that SQL's LIKE 'sqlite_%' takes for SQLite's own (`_` matches any character): an
      // index whose expression fails the restore's first write. Compared by the literal prefix.
      "CREATE INDEX sqlitexguard ON space " +
        "((CASE WHEN transfer IS NOT NULL THEN abs(-9223372036854775808) ELSE 0 END))",
    ];
    for (const sql of changes) {
      const { folder } = await createFixtureSpace(folders.make());
      await writeCommits(folder, 1);
      const clean = await exportBundle(checked, folder, { mode: "backup" });
      const conn = await rawWriter(folder);
      try {
        conn.exec(sql);
      } finally {
        conn.close();
      }
      // The export refuses at once, with its own code, and writes nothing.
      const refusal = await expectCode(
        () => exportBundle(checked, folder, { mode: "backup" }),
        "SPACE_SCHEMA_FOREIGN",
      );
      expect(refusal.message).not.toMatch(/notes_copy|tasks_by_title|open_tasks|sqlitexguard/);
      expect(readdirSync(join(folder, "exports")), sql).toEqual([clean.name]);
      // A backup is still taken (the writer copies what is there), and a crafted bundle holds the
      // change: a restore refuses both before its first write.
      const backup = await backupSpace(checked, folder, { kind: "manual" });
      const bundle = await rebuildBundle(clean.file, async (unpacked) => {
        const edit = await rawWriter(unpacked);
        try {
          edit.exec(sql);
        } finally {
          edit.close();
        }
      });
      const parent = folders.make();
      const unpackRefusal = await expectCode(
        () => unpackBackup(checked, backup.file, join(parent, "unpacked.db"), {}),
        "BACKUP_INVALID",
      );
      expect(unpackRefusal.message, sql).toContain("schema is not its revision's");
      await expectCode(
        () => restoreBackup(checked, backup.file, join(parent, "a")),
        "BACKUP_INVALID",
      );
      const bundleRefusal = await expectCode(
        () => restoreBackup(checked, bundle, join(parent, "b")),
        "BUNDLE_INVALID",
      );
      expect(bundleRefusal.message, sql).toContain("schema is not its revision's");
      expect(existsSync(join(parent, "a")) || existsSync(join(parent, "b")), sql).toBe(false);
      // Retention calls it unverified too: verified means what a restore accepts.
      const listed = listBackups(join(folder, "backups")).backups.find(
        (b) => b.name === backup.name,
      );
      expect(listed === undefined ? "none" : await verifyBackup(checked, listed), sql).toBe(
        undefined,
      );
    }
  });

  test("a backup at an older revision verifies, restores into a new folder and in place: the trial claim runs on the copy's own revision, as the real claim does", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make(), "mira", {}, STEPS_0_1);
    await writeCommits(folder, 2, "s", STEPS_0_1);
    const backup = await backupSpaceWith(checked, folder, { kind: "manual" }, { steps: STEPS_0_1 });
    const listed = listBackups(join(folder, "backups")).backups[0];
    if (listed === undefined) throw new Error("the backup is listed");
    expect(await verifyBackup(checked, listed)).toEqual(backup.sidecar);
    const copy = await restoreBackup(checked, backup.file, join(folders.make(), "mira"));
    expect(copy.revision).toEqual({ major: 0, minor: 1 });
    const inPlace = await restoreInPlace(checked, backup.file, folder, { machineId: TEST_MACHINE });
    expect(inPlace.claim.epoch).toBe(backup.sidecar.epoch + 1);
  });

  test("an object under SQLite's reserved prefix is compared like any other: one planted in the file is refused by the export, a verification, a restore and retention", async () => {
    const checked = await checkedDriver();
    const token = `ghp_${"a".repeat(36)}`;
    const planted = [
      // Passes the restore's first write (the mark), fails the claim of a restore in place.
      "CREATE INDEX sqlite_probe_epoch ON space " +
        "((CASE WHEN authority_epoch > 1 THEN abs(-9223372036854775808) ELSE 0 END))",
      // Named like the index SQLite makes for a key, with a definition of its own: it refuses every
      // later task whose title another task has.
      "CREATE UNIQUE INDEX sqlite_autoindex_tasks_9 ON tasks (title)",
      // A table no statement may create, holding a secret-shaped string the scan never reads.
      `CREATE TABLE sqlite_probe_secret (value TEXT); INSERT INTO sqlite_probe_secret VALUES ('${token}')`,
    ];
    for (const sql of planted) {
      const { folder } = await createFixtureSpace(folders.make());
      await writeCommits(folder, 2);
      const at = Date.now() - 60_000;
      const good = await backupSpace(checked, folder, { kind: "daily", now: () => at });
      plant(join(folder, "space.db"), sql);
      const refusal = await expectCode(
        () => exportBundle(checked, folder, { mode: "backup" }),
        "SPACE_SCHEMA_FOREIGN",
      );
      expect(refusal.message, sql).not.toMatch(/sqlite_probe|sqlite_autoindex|ghp_/);
      expect(
        existsSync(join(folder, "exports")) ? readdirSync(join(folder, "exports")) : [],
      ).toEqual([]);
      const bad = await backupSpace(checked, folder, { kind: "daily", now: () => at + 1000 });
      const listing = listBackups(join(folder, "backups"));
      const listed = listing.backups.find((b) => b.name === bad.name);
      expect(listed === undefined ? "none" : await verifyBackup(checked, listed), sql).toBe(
        undefined,
      );
      await expectCode(
        () => restoreBackup(checked, bad.file, join(folders.make(), "mira")),
        "BACKUP_INVALID",
      );
      await expectCode(
        () => restoreInPlace(checked, bad.file, folder, { machineId: TEST_MACHINE }),
        "BACKUP_INVALID",
      );
      // Retention keeps the older backup that restores, and removes nothing because of the other.
      const plan = planRetention(
        listing,
        { now: at + 2000, utcOffsetMinutes: 0 },
        { spaceId: good.sidecar.space_id },
      );
      const result = await applyRetention(checked, listing, plan);
      expect(result.verified, sql).toBe(good.name);
      expect(result.removed, sql).toEqual([]);
    }
  });

  test("triggers and SQLite's statistics tables are dropped: the export leaves them out of its bundle, a restore drops them before its first write", async () => {
    const checked = await checkedDriver();
    const token = `ghp_${"b".repeat(36)}`;
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const conn = await rawWriter(folder);
    try {
      conn.exec("ANALYZE");
      // Statistics are rows like any other: one holds a secret-shaped string the scan never reads.
      conn
        .prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('tasks', NULL, $stat)")
        .run({ stat: token });
      conn.exec(`CREATE TRIGGER keep_text AFTER INSERT ON tasks BEGIN SELECT '${token}'; END`);
    } finally {
      conn.close();
    }
    const unchecked = (db: string): number => {
      const reader = openReader(checked, db);
      try {
        return Number(
          reader
            .prepare(
              "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' " +
                "OR name IN ('sqlite_stat1', 'sqlite_stat4')",
            )
            .get()?.["n"],
        );
      } finally {
        reader.close();
      }
    };
    expect(unchecked(join(folder, "space.db"))).toBeGreaterThanOrEqual(2);
    const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    const unpacked = folders.make();
    await readBundle(bundle.file, BUNDLE_POLICY, {
      extractTo: (name) => join(unpacked, ...name.split("/")),
    });
    expect(unchecked(join(unpacked, "space.db"))).toBe(0);
    expect(readFileSync(join(unpacked, "space.db")).includes(Buffer.from(token))).toBe(false);
    expect(readFileSync(bundle.file).includes(Buffer.from(token))).toBe(false);
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    const listed = listBackups(join(folder, "backups")).backups[0];
    if (listed === undefined) throw new Error("the backup is listed");
    expect(await verifyBackup(checked, listed)).toEqual(backup.sidecar);
    for (const file of [backup.file, bundle.file]) {
      const restored = await restoreBackup(checked, file, join(folders.make(), "mira"));
      expect(unchecked(join(restored.folder, "space.db")), file).toBe(0);
    }
  });

  test("a virtual table counts by its own text, its module's shadow tables by type and name, and a table named like one in full", async () => {
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await rawWriter(folder);
    try {
      const before = schemaObjects(conn);
      conn.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(body)");
      const added = schemaObjects(conn).filter((o) => !before.includes(o));
      expect(added).toEqual([
        JSON.stringify([
          "table",
          "probe_fts",
          "probe_fts",
          "CREATE VIRTUAL TABLE probe_fts USING fts5(body)",
        ]),
        // SQLite names them shadow tables (PRAGMA table_list), not a guess from their names.
        ...["config", "content", "data", "docsize", "idx"].map((suffix) =>
          JSON.stringify(["table", `probe_fts_${suffix}`, `probe_fts_${suffix}`]),
        ),
      ]);
      conn.exec("CREATE TABLE probe_fts_extra (x)");
      expect(schemaObjects(conn)).toContain(
        JSON.stringify([
          "table",
          "probe_fts_extra",
          "probe_fts_extra",
          "CREATE TABLE probe_fts_extra (x)",
        ]),
      );
    } finally {
      conn.close();
    }
  });

  test("a space at a revision with the search tables (a stand-in for schema 0.3) backs up, exports, verifies and restores; a table under the FTS table's prefix is refused", async () => {
    const checked = await checkedDriver();
    const steps = STEPS_SEARCH;
    const { folder } = await createFixtureSpace(folders.make(), "mira", {}, steps);
    await writeCommits(folder, 3, "s", steps);
    const backup = await backupSpaceWith(checked, folder, { kind: "manual" }, { steps });
    const bundle = await exportBundleWith(checked, folder, { mode: "backup" }, { steps });
    expect(bundle.manifest.counts["search_fts_data"]).toBeGreaterThan(0);
    for (const file of [backup.file, bundle.file]) {
      const restored = await restoreBackupWith(
        checked,
        file,
        join(folders.make(), "mira"),
        {},
        { steps },
      );
      expect(restored.revision, file).toEqual({ major: 0, minor: 3 });
      expect(restored.space.lastSeq, file).toBe(3);
    }
    const listed = listBackups(join(folder, "backups")).backups[0];
    if (listed === undefined) throw new Error("the backup is listed");
    expect(await verifyBackup(checked, listed, { steps })).toEqual(backup.sidecar);

    const conn = await rawWriter(folder);
    try {
      conn.exec("CREATE TABLE search_fts_extra (x)");
    } finally {
      conn.close();
    }
    await expectCode(
      () => exportBundleWith(checked, folder, { mode: "backup" }, { steps }),
      "SPACE_SCHEMA_FOREIGN",
    );
    const foreign = await backupSpaceWith(checked, folder, { kind: "manual" }, { steps });
    await expectCode(
      () => restoreBackupWith(checked, foreign.file, join(folders.make(), "mira"), {}, { steps }),
      "BACKUP_INVALID",
    );
  });

  test("the export makes the search index again in its snapshot: neither a deleted document's words nor a row planted in a shadow table reach the bundle", async () => {
    const checked = await checkedDriver();
    const steps = STEPS_SEARCH;
    const { folder } = await createFixtureSpace(folders.make(), "mira", {}, steps);
    await writeCommits(folder, 3, "s", steps);
    // Two words no task holds, lower-case letters only so the tokenizer keeps each whole.
    const deleted = "qzxvdeletedwordqzxv";
    const planted = "qzxvplantedwordqzxv";
    const conn = await rawWriter(folder);
    try {
      conn
        .prepare("INSERT INTO search_fts (rowid, title, body, extra) VALUES (900001, $t, $t, $t)")
        .run({ t: deleted });
      conn.exec("DELETE FROM search_fts WHERE rowid = 900001");
    } finally {
      conn.close();
    }
    plant(
      join(folder, "space.db"),
      `INSERT INTO search_fts_content (id, c0, c1, c2) VALUES (900002, '${planted}', '', '')`,
    );
    const live = readFileSync(join(folder, "space.db"));
    expect(live.includes(Buffer.from(deleted)) || live.includes(Buffer.from(planted))).toBe(true);
    const bundle = await exportBundleWith(checked, folder, { mode: "backup" }, { steps });
    const unpacked = folders.make();
    await readBundle(bundle.file, BUNDLE_POLICY, {
      extractTo: (name) => join(unpacked, ...name.split("/")),
    });
    const db = readFileSync(join(unpacked, "space.db"));
    expect(db.includes(Buffer.from(deleted))).toBe(false);
    expect(db.includes(Buffer.from(planted))).toBe(false);
    // The index is whole again: one row per document, every one of them named by search_docs.
    const facts = await readFacts(unpacked);
    expect(facts.counts["search_fts_content"]).toBe(facts.counts["search_docs"]);
    expect(facts.counts["search_docs"]).toBeGreaterThan(0);
    await restoreBackupWith(checked, bundle.file, join(folders.make(), "mira"), {}, { steps });
  });

  test("an export whose bundle a restore would refuse at its first write is refused, and nothing is published", async () => {
    const checked = await checkedDriver();
    // A schema whose restore refuses its read-only mark once the space has three commits.
    const steps = STEPS_MARK_GUARD;
    const { folder } = await createFixtureSpace(folders.make(), "mira", {}, steps);
    await writeCommits(folder, 1, "s", steps);
    const first = await exportBundleWith(checked, folder, { mode: "backup" }, { steps });
    await writeCommits(folder, 2, "t", steps);
    const error = await expectCode(
      () => exportBundleWith(checked, folder, { mode: "backup" }, { steps }),
      "BUNDLE_INVALID",
    );
    expect(error.message).toContain("first write");
    expect(readdirSync(join(folder, "exports"))).toEqual([first.name]);
  });

  test("a trigger the copied database holds runs on none of the restore's writes: the copy stays read-only, the claim stands", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const addTriggers = async (where: string): Promise<void> => {
      const conn = await rawWriter(where);
      try {
        // Undoes the read-only mark and keeps the authority a claim would change.
        conn.exec(
          `CREATE TRIGGER undo_mark AFTER UPDATE ON space WHEN NEW.transfer IS NOT NULL
           BEGIN UPDATE space SET transfer = NULL WHERE one = 1; END`,
        );
        conn.exec(
          `CREATE TRIGGER keep_authority AFTER UPDATE OF authority_incarnation ON space
           BEGIN UPDATE space SET authority_incarnation = OLD.authority_incarnation,
             authority_epoch = OLD.authority_epoch WHERE one = 1; END`,
        );
      } finally {
        conn.close();
      }
    };
    await addTriggers(folder);
    const before = await readFacts(folder);
    const backup = await backupSpace(checked, folder, { kind: "manual" });
    // The export leaves triggers out of its bundle; another tool's bundle may hold them.
    const exported = await exportBundle(checked, folder, { mode: "backup" });
    const bundle = await rebuildBundle(exported.file, addTriggers);
    const triggers = (where: string): number => {
      const opened = openSpace(checked, where, { role: "reader" });
      try {
        return Number(
          opened.conn
            .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'")
            .get()?.["n"],
        );
      } finally {
        opened.conn.close();
      }
    };
    for (const file of [backup.file, bundle]) {
      const restored = await restoreBackup(checked, file, join(folders.make(), "mira"));
      expect(triggers(restored.folder), file).toBe(0);
      await expectCode(
        () => openSpace(checked, restored.folder, { role: "writer" }),
        "SPACE_READ_ONLY_COPY",
      );
    }
    const inPlace = await restoreInPlace(checked, bundle, folder, { machineId: TEST_MACHINE });
    expect(triggers(folder)).toBe(0);
    const writer = openSpace(checked, folder, { role: "writer" });
    try {
      expect(writer.space.authority.incarnation).toBe(inPlace.claim.incarnation);
      expect(writer.space.authority.incarnation).not.toBe(before.space.authority.incarnation);
    } finally {
      writer.conn.close();
    }
  });
});

describe("[A1.5.sync.check-failed-ways] restore latest restores the newest backup that restores", () => {
  test("a newer one that does not verify, or that goes away before its files are open, is skipped and the next is restored; the target is checked first", async () => {
    const checked = await checkedDriver();
    const { folder, space } = await createFixtureSpace(folders.make());
    const id = space.spaceId;
    const dir = join(folder, "backups");
    const at = Date.UTC(2026, 10, 14);
    await writeCommits(folder, 1);
    const oldest = await backupSpace(checked, folder, { kind: "daily", now: () => at - 3_000 });
    await writeCommits(folder, 1);
    const middle = await backupSpace(checked, folder, { kind: "daily", now: () => at - 2_000 });
    await writeCommits(folder, 1);
    const newest = await backupSpace(checked, folder, { kind: "manual", now: () => at - 1_000 });
    // The newest no longer verifies, though its size is right.
    const bytes = readFileSync(newest.file);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newest.file, bytes);

    // The middle one goes away after the listing, before its restore opens its files (retention,
    // say): it is skipped as a candidate.
    const { rmSync } = await import("node:fs");
    const parent = folders.make();
    const { restored, backup } = await restoreLatest(
      checked,
      dir,
      id,
      join(parent, "mira"),
      {},
      {
        held: (file) => {
          if (file !== newest.file) return;
          rmSync(middle.sidecarFile);
          rmSync(middle.file);
        },
      },
    );
    expect(backup).toBe(oldest.name);
    expect(restored.space.lastSeq).toBe(oldest.sidecar.seq);
    expect(readdirSync(parent)).toEqual(["mira"]);
    // The newer one that does not verify is kept.
    expect(existsSync(newest.file)).toBe(true);

    // The target is checked before any candidate: one already there is refused at once.
    await expectCode(() => restoreLatest(checked, dir, id, join(parent, "mira")), "SPACE_EXISTS");
    // No backup of the space restores.
    await expectCode(
      () => restoreLatest(checked, dir, newId("sp", osRandom), join(parent, "other")),
      "BACKUP_INVALID",
    );
  });
});

describe("[A1.5.rescue.damaged] rescue keeps the rows that can still be read (A1 3.2)", () => {
  test("a rescue keeps the free-space reserve: refused before it copies anything when the database's files do not fit, and its rows file stops at its share", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const db = join(folder, "space.db");
    const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
    // The copy: the files as they are, and the log once more, which SQLite may play back.
    const copying =
      sizeOf(db) + 2 * sizeOf(`${db}-wal`) + sizeOf(`${db}-shm`) + sizeOf(`${db}-journal`);
    const reserve = BUNDLE_POLICY.freeSpaceReserveBytes;
    const before = treeDigest(folder);
    await expectCode(
      () => rescueSpace(checked, folder, { freeBytes: () => reserve + copying - 1 }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    expect(existsSync(join(folder, "exchange"))).toBe(false);
    // The copy fits, the rows do not: the rescue ends, and no table is reported as unreadable.
    await expectCode(
      () => rescueSpace(checked, folder, { freeBytes: () => reserve + copying + 16 }),
      "BUNDLE_LIMIT_EXCEEDED",
    );
    const rescued = join(folder, "exchange", "rescued");
    expect(readdirSync(rescued).filter((name) => name.startsWith(".rescue.tmp-"))).toEqual([]);
    expect(withoutRescued(treeDigest(folder))).toEqual(before);
    const report = rescueSpace(checked, folder, { now: () => Date.UTC(2026, 10, 14, 1) });
    expect(report.failed).toEqual([]);
  });

  test("a damaged table stops partway and is named, the others are written whole, and the space is unchanged", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const conn = await rawWriter(folder);
    try {
      const system = String(
        conn.prepare("SELECT id FROM actors WHERE kind = 'system'").get()?.["id"],
      );
      conn
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
           INSERT INTO tasks (id, ref, title, context, position, created_at, created_by,
             created_seq, version, touched)
           SELECT 't_rescue' || i, 100 + i, 'Rescue task ' || i, hex(randomblob(400)), 'a0', 0,
             $actor, 0, 0, 0
           FROM n`,
        )
        .run({ actor: system });
    } finally {
      // The last connection's close checkpoints every page into the database file.
      conn.close();
    }
    // The last quarter of the pages, where the tasks' leaves are, is overwritten.
    const db = join(folder, "space.db");
    const bytes = readFileSync(db);
    const raw = bytes.readUInt16BE(16);
    const pageSize = raw === 1 ? 65_536 : raw;
    const pages = bytes.length / pageSize;
    bytes.fill(0xa5, Math.floor(pages * 0.75) * pageSize);
    writeFileSync(db, bytes);
    const before = treeDigest(folder);

    const report = rescueSpace(checked, folder, { now: () => Date.UTC(2026, 10, 14) });
    expect(report.file).toBe(
      join(folder, "exchange", "rescued", "rescued-20261114T000000.000Z.jsonl"),
    );
    expect(report.failed).toContain("tasks");
    const lines = readFileSync(report.file, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { table: string });
    expect(lines).toHaveLength(report.rows);
    expect(lines.filter((l) => l.table === "space")).toHaveLength(1);
    expect(lines.filter((l) => l.table === "commits")).toHaveLength(3);
    // Every file of the space is as it was, and the rescued file is the one new file.
    expect(withoutRescued(treeDigest(folder))).toEqual(before);
    expect(readdirSync(join(folder, "exchange", "rescued"))).toEqual([basename(report.file)]);
    // A second rescue writes a file of its own.
    const again = rescueSpace(checked, folder, { now: () => Date.UTC(2026, 10, 14, 0, 0, 1) });
    expect(again.file).not.toBe(report.file);
    expect(existsSync(report.file)).toBe(true);
  });

  test("rescue never opens the original: a write-ahead log beside an empty database, one with rows not yet checkpointed, and a hot journal all stay byte for byte", async () => {
    const checked = await checkedDriver();
    const at = Date.UTC(2026, 10, 14);

    // A write-ahead log beside an empty database: SQLite would delete it at the first read, so the
    // rescue refuses the copy, and the log stays as it was.
    const empty = join(folders.make(), "mira");
    mkdirSync(empty);
    writeFileSync(join(empty, "space.db"), Buffer.alloc(0));
    writeFileSync(join(empty, "space.db-wal"), Buffer.from("fixture recovery material\n"));
    const emptyBefore = treeDigest(empty);
    await expectCode(() => rescueSpace(checked, empty, { now: () => at }), "SPACE_INVALID");
    expect(treeDigest(empty)).toEqual(emptyBefore);

    // Rows only in the write-ahead log: a copy of the folder taken while a writer had it open.
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const live = await rawWriter(folder);
    const crashed = join(folders.make(), "mira");
    try {
      live.pragma("wal_autocheckpoint", 0);
      live.exec("UPDATE tasks SET title = 'Rescued from the log' WHERE ref = 1");
      copyTree(folder, crashed);
    } finally {
      live.close();
    }
    expect(statSync(join(crashed, "space.db-wal")).size).toBeGreaterThan(0);
    const walBefore = treeDigest(crashed);
    const fromLog = rescueSpace(checked, crashed, { now: () => at });
    expect(withoutRescued(treeDigest(crashed))).toEqual(walBefore);
    expect(readFileSync(fromLog.file, "utf8")).toContain("Rescued from the log");
    expect(fromLog.failed).toEqual([]);

    // A hot rollback journal: played back in the copy only.
    const journaled = join(folders.make(), "mira");
    copyTree(folder, journaled);
    await crashWithHotJournal(join(journaled, "space.db"));
    const journalBefore = treeDigest(journaled);
    const fromJournal = rescueSpace(checked, journaled, { now: () => at });
    expect(withoutRescued(treeDigest(journaled))).toEqual(journalBefore);
    expect(fromJournal.failed).toEqual([]);
    // The copy's journal was played back: the rows are the last committed state's.
    expect(fromJournal.rows).toBe(rescueSpace(checked, folder, { now: () => at }).rows);
    // No scratch folder is left.
    for (const where of [crashed, journaled]) {
      expect(readdirSync(join(where, "exchange", "rescued")).length, where).toBe(1);
    }
  });

  test("a rescue names and writes only the product's tables: a table named like a token is in neither the file nor the report", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    // Built from parts: the source holds no token.
    const token = ["gh", "p_", "a1".repeat(18)].join("");
    const conn = await rawWriter(folder);
    try {
      conn.exec(`CREATE TABLE "${token}" (body TEXT) STRICT`);
      conn.prepare(`INSERT INTO "${token}" VALUES ($body)`).run({ body: token });
    } finally {
      conn.close();
    }
    const report = rescueSpace(checked, folder, { now: () => Date.UTC(2026, 10, 14) });
    expect(report.failed).toEqual([]);
    expect(readFileSync(report.file, "utf8")).not.toContain(token);
    // Its export is refused by the schema rule before the scan, and the refusal names nothing.
    const refusal = await expectCode(
      () => exportBundle(checked, folder, { mode: "backup" }),
      "SPACE_SCHEMA_FOREIGN",
    );
    expect(refusal.message).not.toContain(token);
  });
});

/** A tree digest without the rescued rows' folder: what a rescue must leave as it was. */
const withoutRescued = (digest: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(digest).filter(([path]) => !path.startsWith("exchange/rescued/")),
  );

/** Leaves `db` as a crash in the middle of another tool's rollback-journal transaction does. */
async function crashWithHotJournal(db: string): Promise<void> {
  const checked = await checkedDriver();
  const source = join(folders.make(), "source.db");
  copyFileSync(db, source);
  const conn = checked.driver.open(source, { readOnly: false, busyTimeoutMs: 5000 });
  try {
    conn.pragma("journal_mode", "DELETE");
    conn.pragma("cache_size", 5);
    conn.exec("BEGIN IMMEDIATE");
    conn.exec(
      "CREATE TABLE crash_pad (v BLOB); WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL " +
        "SELECT i + 1 FROM n WHERE i < 200) INSERT INTO crash_pad SELECT zeroblob(8192) FROM n",
    );
    copyFileSync(source, db);
    copyFileSync(`${source}-journal`, `${db}-journal`);
  } finally {
    conn.close();
  }
  expect(readFileSync(`${db}-journal`)[0]).toBe(0xd9);
}

/** Adds an attachment row (deleted at `deletedAt` when given) and, for a live one, its blob. */
async function addAttachment(
  folder: string,
  blob: Buffer,
  deletedAt: number | null,
): Promise<void> {
  const hash = sha(blob);
  const conn = await rawWriter(folder);
  try {
    const task = String(conn.prepare("SELECT id FROM tasks LIMIT 1").get()?.["id"]);
    const actor = String(conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"]);
    conn
      .prepare(
        `INSERT INTO attachments (id, task_id, sha256, size, media_type, filename, created_by,
           created_at, deleted_at, created_seq, version)
         VALUES ($id, $task, $hash, $size, 'text/plain', 'notes.txt', $actor, 0, $deleted, 1, 1)`,
      )
      .run({
        id: newId("at", osRandom),
        task,
        hash,
        size: blob.length,
        actor,
        deleted: deletedAt,
      });
  } finally {
    conn.close();
  }
  if (deletedAt !== null) return;
  const dir = join(folder, "attachments", "sha256", hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash), blob);
}

describe("[A1.5.bundle.secret-scan] the export's secret scan", () => {
  // Built from parts: the source holds no token.
  const token = ["gh", "p_", "aB3dE5".repeat(6)].join("");

  test("an export that finds nothing writes its bundle", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 3);
    const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    expect(existsSync(bundle.file)).toBe(true);
  });

  test("a secret in a task, in its history or in an attachment refuses the export and writes nothing", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    const conn = await rawWriter(folder);
    try {
      conn.prepare("UPDATE tasks SET context = $text WHERE ref = 1").run({
        text: `Deploy with ${token} tomorrow.`,
      });
    } finally {
      conn.close();
    }
    for (const withJsonl of [false, true]) {
      const error = await expectCode(
        () => exportBundle(checked, folder, { mode: "backup", withJsonl }),
        "EXPORT_SECRET_FOUND",
      );
      expect(error.message).toContain("github_token");
      expect(error.message).toContain("tasks.context");
      expect(error.message).not.toContain(token);
      expect(readdirSync(join(folder, "exports"))).toEqual([]);
    }
    // Edited away, the token is still in the vacuumed snapshot's rows only if a row holds it:
    // here none does, and the export passes.
    const clean = await rawWriter(folder);
    try {
      clean.prepare("UPDATE tasks SET context = '' WHERE ref = 1").run();
    } finally {
      clean.close();
    }
    const bundle = await exportBundle(checked, folder, { mode: "backup" });
    // No byte of the deleted text is in the bundle's database: the snapshot was vacuumed.
    const out = folders.make();
    await readBundle(bundle.file, BUNDLE_POLICY, {
      extractTo: (name) => (name === "space.db" ? join(out, "space.db") : undefined),
    });
    expect(readFileSync(join(out, "space.db")).includes(Buffer.from(token))).toBe(false);

    // An attachment that holds a token.
    await addAttachment(folder, Buffer.from(`key file\n${token}\n`), null);
    const blobError = await expectCode(
      () => exportBundle(checked, folder, { mode: "backup" }),
      "EXPORT_SECRET_FOUND",
    );
    expect(blobError.message).toContain("attachment");
    expect(readdirSync(join(folder, "exports"))).toEqual([bundle.name]);
  });

  test("a long token across the boundary of the attachment's read chunks is found", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    // A JWT whose payload is longer than a short overlap, its head in one 1 MiB read and its
    // signature in the next. Built from parts: the source holds no token.
    const part = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = [
      part({ alg: "HS256", typ: "JWT" }),
      part({ sub: "fixture", pad: "a".repeat(8_000) }),
      "AbCdEf12".repeat(6),
    ].join(".");
    const blob = Buffer.from(`${" ".repeat(1024 * 1024 - 4_000)}${jwt}\n`);
    await addAttachment(folder, blob, null);
    const error = await expectCode(
      () => exportBundle(checked, folder, { mode: "backup" }),
      "EXPORT_SECRET_FOUND",
    );
    expect(error.message).toContain("jwt");
    expect(readdirSync(join(folder, "exports"))).toEqual([]);
  });

  test("an attachment reached through a link out of the space, into the secrets folder, is refused", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    await writeCommits(folder, 2);
    await addAttachment(folder, Buffer.from("attached"), null);
    const secrets = folders.make();
    // The space's attachments folder is a link into the secrets folder: nothing goes out.
    const moved = join(secrets, "attachments");
    copyTree(join(folder, "attachments"), moved);
    const { rmSync } = await import("node:fs");
    rmSync(join(folder, "attachments"), { recursive: true });
    try {
      symlinkSync(moved, join(folder, "attachments"), "junction");
    } catch {
      return; // No links on this file system for this user: nothing to test.
    }
    await expectCode(
      () => exportBundle(checked, folder, { mode: "backup", secretFolders: [secrets] }),
      "BUNDLE_INVALID",
    );
    expect(readdirSync(join(folder, "exports"))).toEqual([]);
  });
});

describe("[A1.5.bundle.stress] the largest stress-corpus bundle passes the shared policy", () => {
  test("10,000 open and 100,000 completed tasks export with data.jsonl and restore", async () => {
    const checked = await checkedDriver();
    const { folder } = await createFixtureSpace(folders.make());
    const conn = await rawWriter(folder);
    try {
      const system = String(
        conn.prepare("SELECT id FROM actors WHERE kind = 'system'").get()?.["id"],
      );
      conn.transaction("immediate", () => {
        conn
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 110000)
             INSERT INTO tasks (id, ref, title, context, lifecycle, completed_at, position,
               created_at, created_by, created_seq, version, touched)
             SELECT 't_stress' || i, i, 'Stress task ' || i, hex(randomblob(256)),
               CASE WHEN i <= 10000 THEN 'active' ELSE 'completed' END,
               CASE WHEN i <= 10000 THEN NULL ELSE 1 END,
               'a0', 0, $actor, 0, 0, 0
             FROM n`,
          )
          .run({ actor: system });
        conn.prepare("UPDATE space SET next_ref = 110001 WHERE one = 1").run();
      });
    } finally {
      conn.close();
    }
    const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
    expect(bundle.manifest.counts["tasks"]).toBe(110_000);
    const restored = await restoreBackup(checked, bundle.file, join(folders.make(), "mira"));
    const facts = await readFacts(restored.folder);
    expect(facts.integrity).toBe("ok");
    expect(facts.counts).toEqual(bundle.manifest.counts);
  }, 600_000);

  test("a projection-sized archive, a file per task, reads under the policy with ZIP64's count", async () => {
    const src = folders.make();
    const zip = join(src, "view.zip");
    const writer = ZipWriter.create(zip, Date.UTC(2026, 10, 14));
    const files: Record<string, { size: number; sha256: string }> = {};
    for (let i = 0; i < 110_001; i += 1) {
      const entry = writer.addBytes(
        `view/tasks/M-${String(i)}.md`,
        Buffer.from(`# M-${String(i)}\n`),
      );
      files[entry.name] = { size: entry.size, sha256: entry.sha256 };
    }
    writer.addBytes("export.json", exportJson(files));
    writer.finish();
    const read = await readBundle(zip, BUNDLE_POLICY);
    expect(Object.keys(read.manifest.files)).toHaveLength(110_001);
  }, 600_000);
});
