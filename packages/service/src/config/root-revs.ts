// Each root's `root_rev` (A4 3.2 "Remote use", A6 3.8.3): a counter in machine state that rises
// whenever the root's machine-local mapping changes. It is reserved for L1, where a command from
// another machine names the revision it saw and is refused when the mapping moved since. v1 keeps
// it current and otherwise ignores it.
//
// `<state>/roots.json` holds, per root ID, the revision and a hash of the mapping (the root's
// path as machine.toml spells it), so the file repeats no path. A root that leaves machine.toml
// keeps its record: added again with another path, it continues from its old revision, so a
// revision is never handed out twice for one root ID. Only the holder of service.lock writes it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "@tasks/launch";
import { atomicWrite } from "../hub/files.ts";

export const ROOTS_FILE = "roots.json";
const FORMAT = 1;

interface RootRecord {
  readonly rev: number;
  readonly mapping: string;
}

const mappingOf = (root: Root): string =>
  createHash("sha256").update(`root\n${root.path}`, "utf8").digest("hex");

function readRecords(stateDir: string): { records: Map<string, RootRecord>; damaged: boolean } {
  let text: string;
  try {
    text = readFileSync(join(stateDir, ROOTS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: new Map(), damaged: false };
    }
    return { records: new Map(), damaged: true };
  }
  try {
    const json = JSON.parse(text) as { format?: unknown; roots?: unknown };
    if (json.format !== FORMAT || typeof json.roots !== "object" || json.roots === null) {
      return { records: new Map(), damaged: true };
    }
    const records = new Map<string, RootRecord>();
    for (const [id, value] of Object.entries(json.roots as Record<string, unknown>)) {
      const record = value as { rev?: unknown; mapping?: unknown };
      if (
        typeof record.rev !== "number" ||
        !Number.isSafeInteger(record.rev) ||
        record.rev < 1 ||
        typeof record.mapping !== "string"
      ) {
        return { records: new Map(), damaged: true };
      }
      records.set(id, { rev: record.rev, mapping: record.mapping });
    }
    return { records, damaged: false };
  } catch {
    return { records: new Map(), damaged: true };
  }
}

export interface RootRevisions {
  /** The current revision of each root in machine.toml. */
  readonly revs: ReadonlyMap<string, number>;
  /** How many roots are new or moved since the last sync. */
  readonly changed: number;
  /** The file was damaged and was started again. */
  readonly reset: boolean;
}

/**
 * Brings `<state>/roots.json` up to date with machine.toml's roots: a new root starts at 1, a root
 * whose path changed rises by one. Writes only when something changed.
 */
export function syncRootRevisions(stateDir: string, roots: readonly Root[]): RootRevisions {
  const { records, damaged } = readRecords(stateDir);
  let changed = 0;
  for (const root of roots) {
    const mapping = mappingOf(root);
    const record = records.get(root.id);
    if (record === undefined) records.set(root.id, { rev: 1, mapping });
    else if (record.mapping !== mapping) records.set(root.id, { rev: record.rev + 1, mapping });
    else continue;
    changed += 1;
  }
  if (changed > 0 || damaged) {
    const sorted = Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : 1)));
    atomicWrite(
      join(stateDir, ROOTS_FILE),
      `${JSON.stringify({ format: FORMAT, roots: sorted })}\n`,
    );
  }
  const revs = new Map(roots.map((root) => [root.id, records.get(root.id)?.rev ?? 1]));
  return { revs, changed, reset: damaged };
}
