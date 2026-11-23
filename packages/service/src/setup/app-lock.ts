// Claude Code's own lock on `.claude.json`, which setup takes for its splice (A3 3.13.2). Claude
// Code rewrites that file while a session runs, and its writers take `<file>.lock` (a folder, made
// exclusively), read the file again under it and write it whole: a session that saves while setup
// holds the lock waits, then keeps setup's entry. The holder refreshes the folder's time while it
// holds it, so one whose time is more than ten seconds old was left by a process that ended, and
// is taken over, as Claude Code's own writers do.
import { rmdirSync, statSync } from "node:fs";
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

/**
 * Runs `work` while holding `<file>.lock`, or gives up (`held: false`) when another writer keeps it
 * through every pause. Only the folder this call made is removed.
 */
export async function withAppLock<T>(
  file: string,
  wait: (ms: number) => Promise<void>,
  work: () => T,
): Promise<{ readonly held: true; readonly value: T } | { readonly held: false }> {
  const lock = `${file}.lock`;
  for (let attempt = 0; ;) {
    try {
      makeDir(lock, 0o700, { recursive: false });
      break;
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
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
    if (pause === undefined) return { held: false };
    attempt += 1;
    await wait(pause);
  }
  try {
    return { held: true, value: work() };
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already gone: nothing of setup's is left.
    }
  }
}
