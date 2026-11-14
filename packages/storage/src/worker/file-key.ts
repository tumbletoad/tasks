// The claim key of a database file's identity on its volume, shared by the client, which looks at
// a file before the worker opens it, and the worker, which looks at the file SQLite opened.
import type { BigIntStats } from "node:fs";

/**
 * `file:<device>:<file number>`, which every name of a file shares, hard links included. Null on a
 * file system that reports no file numbers (Node reports 0), where only the path key applies.
 */
export function fileKey(stats: Pick<BigIntStats, "dev" | "ino">): string | null {
  return stats.ino === 0n ? null : `file:${String(stats.dev)}:${String(stats.ino)}`;
}
