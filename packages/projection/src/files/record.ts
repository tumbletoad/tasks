// The record of the readable files: for each path, the bytes the projector placed there and, while
// a pass acts, the bytes it means to place. It lives in the product's machine state, never in the
// tree, so nothing a person or an agent can edit there makes a file ours.
//
// A pass writes its pending hashes before it acts and keeps only what it placed after, so a kill
// leaves at most two hashes for a path, both the projector's. A record that is missing or does not
// read back whole is an empty one: every file the tree holds is then a person's until its bytes
// match what a pass places, and a file of ours at a path no longer used stays.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite, makeDir } from "@ttasks/files";
import type { Owned } from "./disk.ts";

/** The record's own format: another is read as no record. */
const FORMAT = 1;

export interface Entry {
  placed?: Owned;
  pending?: Owned;
}

/** A path of the tree: relative, with `/`, and no part that leaves it. */
export function isTreePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\\:\0]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const isOwned = (value: unknown): value is Owned =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Owned).sha256 === "string" &&
  /^[0-9a-f]{64}$/.test((value as Owned).sha256) &&
  Number.isSafeInteger((value as Owned).size) &&
  (value as Owned).size >= 0;

/** What a path's file may hold and still be ours. */
export const allowedOf = (entry: Entry | undefined): Owned[] =>
  [entry?.placed, entry?.pending].filter((own): own is Owned => own !== undefined);

export class FilesRecord {
  readonly files = new Map<string, Entry>();

  /** The record at `path`; an empty one when it is not there or does not read back whole. */
  static load(path: string): FilesRecord {
    const record = new FilesRecord();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return record;
    }
    const value = parsed as { format?: unknown; files?: unknown };
    if (value.format !== FORMAT || typeof value.files !== "object" || value.files === null) {
      return record;
    }
    for (const [file, raw] of Object.entries(value.files as Record<string, unknown>)) {
      if (!isTreePath(file) || typeof raw !== "object" || raw === null) return new FilesRecord();
      const { placed, pending } = raw as { placed?: unknown; pending?: unknown };
      if (
        (placed !== undefined && !isOwned(placed)) ||
        (pending !== undefined && !isOwned(pending))
      ) {
        return new FilesRecord();
      }
      record.files.set(file, {
        ...(placed === undefined ? {} : { placed }),
        ...(pending === undefined ? {} : { pending }),
      });
    }
    return record;
  }

  /** Writes the record whole, atomically, user-only. */
  save(path: string): void {
    makeDir(dirname(path), 0o700);
    const files = Object.fromEntries([...this.files].sort(([a], [b]) => (a < b ? -1 : 1)));
    atomicWrite(path, `${JSON.stringify({ format: FORMAT, files })}\n`, 0o600);
  }
}
