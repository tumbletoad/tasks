// Claude Code's own lock on `.claude.json`, which setup takes for the last step of its write. Claude
// Code's writers take `<file>.lock` (a folder, made exclusively), read the file again under it and
// write it whole: a session that saves while setup holds the lock waits, then keeps setup's entry.
// Claude Code's start-up does not wait: it writes without the lock after about 1.5 seconds. Setup
// holds the lock only to compare the file with what it read and to rename its new file into place,
// so that comparison is what protects a save made then. A folder whose time is more than ten seconds
// old was left by a process that ended, and is taken over, as Claude Code's own writers do.
import { rmdirSync, statSync, type BigIntStats } from "node:fs";
import { makeDir } from "../hub/files.ts";

/** A lock folder whose time is older than this was left behind. */
const STALE_MS = 10_000;
/** The pauses between tries while another writer holds the lock: about six seconds in all. */
const PAUSES_MS = [50, 100, 200, 400, 800, 1600, 3200];

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | null)?.code;

function stale(lock: string, now: number): boolean {
  try {
    return statSync(lock).mtimeMs < now - STALE_MS;
  } catch {
    // Gone meanwhile: the next try takes it.
    return true;
  }
}

/** The folder at `lock` as this call made it, to tell it from one another writer made since. */
function identity(lock: string): BigIntStats | undefined {
  try {
    return statSync(lock, { bigint: true });
  } catch {
    return undefined;
  }
}

const sameFolder = (a: BigIntStats | undefined, b: BigIntStats | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.ino === b.ino &&
  a.birthtimeNs === b.birthtimeNs &&
  a.mtimeNs === b.mtimeNs;

/**
 * Runs `work` while holding `<file>.lock`, or gives up (`held: false`): `busy` when another
 * writer keeps the lock through every pause, `unwritable` when the lock cannot be made where the
 * file is (a folder that takes no new entry, as a read-only home is on Linux and macOS: the file
 * could not be replaced there either). At the end the lock is removed only when it is still the
 * folder this call made: one that another writer took over after its expiry is theirs.
 */
export async function withAppLock<T>(
  file: string,
  wait: (ms: number) => Promise<void>,
  work: () => T,
): Promise<
  | { readonly held: true; readonly value: T }
  | { readonly held: false; readonly why: "busy" | "unwritable" }
> {
  const lock = `${file}.lock`;
  for (let attempt = 0; ;) {
    try {
      makeDir(lock, 0o700, { recursive: false });
      break;
    } catch (error) {
      if (codeOf(error) !== "EEXIST") return { held: false, why: "unwritable" };
    }
    if (stale(lock, Date.now())) {
      try {
        rmdirSync(lock);
        continue;
      } catch {
        // Another writer took it over first, or it is no folder: waited for like a held one.
      }
    }
    const pause = PAUSES_MS[attempt];
    if (pause === undefined) return { held: false, why: "busy" };
    attempt += 1;
    await wait(pause);
  }
  const made = identity(lock);
  try {
    return { held: true, value: work() };
  } finally {
    if (sameFolder(made, identity(lock))) {
      try {
        rmdirSync(lock);
      } catch {
        // Already gone: nothing of setup's is left.
      }
    }
  }
}
