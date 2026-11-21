// What setup runs and how it keeps one change at a time: the app's own command, and the lock.
import { join } from "node:path";
import { startHelper, type Env } from "@ttasks/launch";
import { ensurePrivateDir } from "../hub/files.ts";
import { acquireLock } from "../hub/lock.ts";
import { SETUP_LOCK, SetupStateUnsafe, setupDir } from "./state.ts";

export { LockBusy } from "../hub/lock.ts";

/** How long one of the app's own commands (`mcp add`, `mcp remove`) may run. */
export const COMMAND_MS = 60_000;

/**
 * Runs an app's own command as a helper of the runner (@ttasks/launch helpers.ts, A3 3.14): an argv
 * array, no shell, no stdin, only `env`, in `cwd`, ended with what it started at its bound or when
 * this process exits. A `.cmd` shim is never run. True when it exits 0. Its output is not read: an
 * app's own words can hold paths and accounts.
 */
export async function runCommand(
  argv: readonly string[],
  env: Env,
  cwd: string,
  timeoutMs: number = COMMAND_MS,
): Promise<boolean> {
  try {
    return (await startHelper(argv, { env, cwd, deadlineMs: timeoutMs }).ended) === 0;
  } catch {
    return false;
  }
}

/**
 * Runs `work` while holding `<state>/setup/agents.lock`, so two setups never change the homes or
 * the record at once. The OS releases the lock when the process ends, a crash included. Throws
 * LockBusy when another setup holds it.
 */
export async function withSetupLock<T>(stateDir: string, work: () => Promise<T>): Promise<T> {
  const dir = setupDir(stateDir);
  if (ensurePrivateDir(dir) !== undefined) throw new SetupStateUnsafe();
  const lock = await acquireLock(join(dir, SETUP_LOCK));
  try {
    return await work();
  } finally {
    lock.release();
  }
}
