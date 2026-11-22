// service.lock (A2 3.4, S9): an empty SQLite file held by an exclusive transaction for the
// service's lifetime, and the ownership watch that service.lock and each space's writer.lock get.
// The OS releases a lock on any exit, SIGKILL and power loss included, so a crashed service never
// blocks the next one. The technique is T3 Code's ownership lock, and lab row S06 measured it on
// Windows and Linux (1 ready, 9 exits 73).
//
// The lock itself is storage's takeFileLock (only storage imports node:sqlite, A7 3.2): busy
// timeout 0, journal in memory (no `-journal` file after a crash), `BEGIN EXCLUSIVE`, and a busy
// lock tried again with jitter for 250 ms before it counts as held. The hub holds service.lock in
// its main thread, on a connection that runs nothing but that transaction and never waits. A
// space's writer.lock is storage's own (writer-lock.ts there): its storage worker takes it with the
// writer and holds it for the writer's life, and the hub watches it (spaces.ts).
//
// Two rules (A2 3.4):
// - A lock file is opened once per process. On Unix, closing any descriptor of the inode drops
//   SQLite's POSIX lock, so doctor and tests read service.json instead.
// - The holder watches the file's identity. If the file is deleted or replaced, another service
//   could lock the new file: the service stops and exits 70. Windows refuses to delete or rename a
//   file SQLite holds open (no delete sharing), so there the watch is a second line.
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  DEFAULT_DRIVER,
  fileIdentity,
  LOCK_SETTLE_MS,
  loadDriver,
  takeFileLock,
  type FileIdentity,
  type FileLock,
  type SqliteDriver,
} from "@ttasks/storage";

export { LOCK_SETTLE_MS, type FileIdentity };

/** A2 3.2.3: service.lock is 0644, set exactly when it is created. */
const SERVICE_LOCK_MODE = 0o644;

/** A2 3.4: the hub compares the lock file's identity with the one it holds every 10 s. */
export const OWNERSHIP_CHECK_MS = 10_000;

/** The lock is held by another process (SQLITE_BUSY on a busy timeout of 0). */
export class LockBusy extends Error {
  override readonly name = "LockBusy";
  constructor() {
    super("The lock is held by another process");
  }
}

export const identityOf = fileIdentity;

export type HeldLock = FileLock;

let driver: Promise<SqliteDriver> | undefined;
const lockDriver = (): Promise<SqliteDriver> => (driver ??= loadDriver(DEFAULT_DRIVER));

/**
 * Takes the lock at `path`, creating the file when missing. Throws LockBusy when another process
 * holds it (still busy after LOCK_SETTLE_MS of jittered retries), and a StorageError when the file
 * cannot be opened.
 */
export async function acquireLock(path: string): Promise<HeldLock> {
  const held = await takeFileLock(await lockDriver(), path, LOCK_SETTLE_MS, SERVICE_LOCK_MODE);
  if (held === undefined) throw new LockBusy();
  return held;
}

export type OwnershipLoss = "missing" | "replaced";
/** What found the loss: a change notification, the timer, or the check when the watch began. */
export type OwnershipCheck = "watch" | "timer" | "start";

export interface OwnershipWatch {
  stop(): void;
}

/**
 * Calls `onLost` once when the file at the lock's path is gone or is no longer the file the lock
 * holds. It checks once when it begins (a loss before the watcher existed sends no notification),
 * then every `intervalMs` and, where the OS reports changes in the folder, at once. Other errors
 * reading the file are left for the next check.
 *
 * Without change notifications (some network and FUSE folders, or Linux out of inotify watches)
 * a loss is found by the timer, up to `intervalMs` later: A2 3.4 and 3.14 set it at 10 s.
 */
export function watchOwnership(
  lock: Pick<HeldLock, "path" | "identity">,
  onLost: (what: OwnershipLoss, via: OwnershipCheck) => void,
  options: { intervalMs?: number; stat?: (path: string) => FileIdentity } = {},
): OwnershipWatch {
  const stat = options.stat ?? identityOf;
  let done = false;
  let watcher: FSWatcher | undefined;
  const stop = () => {
    done = true;
    clearInterval(timer);
    watcher?.close();
  };
  const check = (via: OwnershipCheck) => {
    if (done) return;
    let now: FileIdentity;
    try {
      now = stat(lock.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        stop();
        onLost("missing", via);
      }
      return;
    }
    if (now.dev !== lock.identity.dev || now.ino !== lock.identity.ino) {
      stop();
      onLost("replaced", via);
    }
  };
  const timer = setInterval(() => {
    check("timer");
  }, options.intervalMs ?? OWNERSHIP_CHECK_MS);
  timer.unref();
  try {
    const name = basename(lock.path);
    watcher = watch(dirname(lock.path), { persistent: false }, (_event, changed) => {
      if (changed === null || changed === name) check("watch");
    });
    watcher.on("error", () => {
      watcher?.close();
    });
  } catch {
    // No change notifications here (some network and FUSE folders): the timer still checks.
  }
  // After the caller has its watch: onLost may use what the caller sets up next.
  queueMicrotask(() => {
    check("start");
  });
  return { stop };
}
