// Reading an export bundle (A1 3.18 "Restore and import of a bundle", steps 1 and 2), the one way
// for every side: the exporter reads its own archive back with it before publishing it, and a
// restore or an import unpacks with it. So Tasks never publishes a bundle it would refuse.
//
// 1. The archive passes the ZIP rules (zip.ts: paths, links, overlaps, the entry count).
// 2. Every file has a path of A1 3.18's layout (bundleEntryKind) and claims at most its kind's
//    limit; a folder entry is one a bundle's files sit in.
// 3. `export.json` is there, within the limit of any other file, and decodes. It lists every other
//    file with the size its header claims, and every file it lists is there.
// 4. What is unpacked fits the free disk space, less the reserve.
// 5. Each file streams through its kind's limit and the archive's ExpansionBudget, into a new
//    owner-only file or nowhere, and its size and SHA-256 must be export.json's.
// Nothing is used before every file has passed. The caller removes what it unpacked on failure.
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { StorageError } from "../errors.ts";
import { FOLDER_MODE, fsCall, makeDirExact } from "../files.ts";
import {
  bundleEntryKind,
  checkFreeSpace,
  entryLabel,
  entryLimit,
  ExpansionBudget,
  freeBytes,
  isBundleFolder,
  limitExceeded,
  newPrivateFile,
  type BundleEntryKind,
  type BundlePolicy,
} from "../backup/policy.ts";
import { decodeExport, EXPORT_FILE, type ExportManifest } from "./export-file.ts";
import { invalidArchive, ZipReader, type ZipEntry } from "./zip.ts";

export interface ReadBundleOptions {
  /** Where a file's content goes: a new file's path, or undefined to verify it only. */
  extractTo?: (name: string, kind: BundleEntryKind) => string | undefined;
  /** Small files whose content the caller wants back, at most the "any other file" limit. */
  keep?: readonly string[];
  /** The folder the unpacked files go to, for the free disk space. */
  freeFolder?: string;
  freeBytes?: (folder: string) => number;
}

export interface ReadBundle {
  manifest: ExportManifest;
  kept: Map<string, Buffer>;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads, checks and (as asked) unpacks the bundle at `path`. See the header for the order. */
export async function readBundle(
  path: string,
  policy: BundlePolicy,
  options: ReadBundleOptions = {},
): Promise<ReadBundle> {
  const reader = ZipReader.open(path, policy);
  try {
    const files = new Map<string, { entry: ZipEntry; kind: BundleEntryKind }>();
    for (const entry of reader.entries) {
      if (entry.directory) {
        if (!isBundleFolder(entry.name)) invalid("it holds a folder a bundle never has");
        continue;
      }
      const kind = bundleEntryKind(entry.name);
      if (kind === undefined) invalid("it holds a file a bundle never has");
      if (entry.size > entryLimit(kind, policy)) throw limitExceeded(entryLabel(kind));
      files.set(entry.name, { entry, kind });
    }
    const budget = new ExpansionBudget(policy);
    const exportEntry = files.get(EXPORT_FILE)?.entry;
    if (exportEntry === undefined) invalid("it has no export.json");
    const text = await reader.bytes(exportEntry, policy.maxOtherFileBytes, "a file", budget);
    let manifest: ExportManifest | undefined;
    try {
      manifest = decodeExport(JSON.parse(UTF8.decode(text)));
    } catch {
      manifest = undefined;
    }
    if (manifest === undefined) invalid("its export.json is not valid");
    const listed = Object.entries(manifest.files);
    if (listed.length !== files.size - 1) invalid("its files differ from what export.json lists");
    for (const [name, digest] of listed) {
      if (files.get(name)?.entry.size !== digest.size) {
        invalid("its files differ from what export.json lists");
      }
    }

    const targets = new Map<string, string>();
    let unpacked = 0;
    for (const [name, { entry, kind }] of files) {
      const target = name === EXPORT_FILE ? undefined : options.extractTo?.(name, kind);
      if (target !== undefined) {
        targets.set(name, target);
        unpacked += entry.size;
      }
    }
    if (options.freeFolder !== undefined) {
      checkFreeSpace(unpacked, (options.freeBytes ?? freeBytes)(options.freeFolder), policy);
    }

    const keep = new Set(options.keep ?? []);
    const kept = new Map<string, Buffer>();
    // In file order, so the archive is read front to back.
    const order = [...files.values()].sort((a, b) => a.entry.dataStart - b.entry.dataStart);
    for (const { entry, kind } of order) {
      if (entry.name === EXPORT_FILE) continue;
      const digest = manifest.files[entry.name];
      if (digest === undefined) invalid("its files differ from what export.json lists");
      const limit = entryLimit(kind, policy);
      let got: { size: number; sha256: string };
      if (keep.has(entry.name)) {
        const max = Math.min(limit, policy.maxOtherFileBytes);
        const bytes = await reader.bytes(entry, max, entryLabel(kind), budget);
        kept.set(entry.name, bytes);
        got = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      } else {
        const target = targets.get(entry.name);
        if (target !== undefined) {
          fsCall(() => {
            makeDirExact(dirname(target), FOLDER_MODE, { recursive: true });
          });
        }
        const sink = target === undefined ? undefined : fsCall(() => newPrivateFile(target));
        got = await reader.read(entry, sink, limit, entryLabel(kind), budget);
      }
      if (got.size !== digest.size || got.sha256 !== digest.sha256) {
        invalid("a file differs from export.json");
      }
    }
    return { manifest, kept };
  } finally {
    reader.close();
  }
}

function invalid(why: string): never {
  throw invalidArchive(why);
}

/** A refusal of a bundle's content after it unpacked: the database or a fact does not agree. */
export const bundleInvalid = (why: string): StorageError =>
  new StorageError("BUNDLE_INVALID", `The bundle does not verify: ${why}`);
