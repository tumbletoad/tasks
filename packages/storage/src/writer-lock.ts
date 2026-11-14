// One writer per space across processes (A2 3.4): `<space>/writer.lock`, an empty SQLite file held
// by an exclusive transaction for as long as the space has a writer, and `<space>/writer.json`
// beside it naming the holder. A1 3.9's claims keep one writer per space inside a process;
// this lock keeps one across processes, services, state folders and OS accounts. The OS releases
// it on any exit, a hard kill and power loss included, so a crashed holder never blocks the next.
//
// Every way storage opens a space for writing takes it, in the storage worker that opens the
// writer, and holds it for that writer's life (worker/host.ts): openSpaceWriter, the migration it
// runs included, claimSpace, restoreInPlace and recoverSpace. A lock another process holds refuses
// with SPACE_LOCKED_ELSEWHERE, and the caller reads the holder from writer.json.
//
// The technique is the service lock's (A2 3.4, T3 Code's ownership lock, lab row S06): a busy
// timeout of 0, `journal_mode = memory` (a held lock leaves no -journal file beside it after a
// crash), `BEGIN EXCLUSIVE`. A busy lock is tried again with a jittered pause for 250 ms before it
// counts as held: opens that try at the same moment can each meet another's brief shared lock and
// all get SQLITE_BUSY (measured on Linux for the service lock: 47 of 300 rounds of 10 had no
// winner without the retry, none with it). A real holder keeps its lock for its whole life, so the
// retry only delays a refusal.
//
// Two rules come with it (A2 3.4):
// - Nothing but SQLite opens writer.lock in this process. SQLite keeps one lock per file and
//   process and defers closing a descriptor of a locked file; any other open and close of the file
//   would drop the POSIX lock on Unix. A stat does not open it.
// - The holder watches the file's identity: a deleted or replaced file means another process could
//   lock a new one. The lock reports the identity it holds, and the service watches it (M1.08).
//
// writer.lock guards a folder. A database file with a second name, a hard link or a symbolic link,
// would be guarded by two locks, and SQLite would keep a -wal beside each name, so such a space is
// refused for writing before anything opens it (refuseLinkedDatabase).
import { lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Connection, SqliteDriver } from "./driver.ts";
import { misuse, StorageError } from "./errors.ts";
import {
  createEmptyFile,
  errnoCode,
  FILE_MODE,
  fsCall,
  fsError,
  readBounded,
  writeFileAtomic,
} from "./files.ts";
import { DATABASE_FILE } from "./manifest.ts";

export const WRITER_LOCK_FILE = "writer.lock";
export const WRITER_HOLDER_FILE = "writer.json";

/** How long an open keeps trying a busy lock before it counts as held elsewhere. */
export const LOCK_SETTLE_MS = 250;
const RETRY_PAUSE_MS = { min: 5, spread: 20 } as const;
/** How often a lock file that goes away before SQLite opens it is created again. */
const GONE_TRIES = 5;

/** A file's identity on its volume (the file ID on Windows): every name of one file shares it. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export const fileIdentity = (path: string): FileIdentity => {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
};

/** An exclusive lock on a file, held until `release`. */
export interface FileLock {
  readonly path: string;
  /** The identity of the locked file, taken right after the lock was acquired. */
  readonly identity: FileIdentity;
  /** Ends the transaction and closes the connection. Safe to call twice. */
  release(): void;
}

/** The identity of the file at `path`, or undefined when there is none. */
function identityIfAny(path: string): FileIdentity | undefined {
  const stat = fsCall(() => statSync(path, { bigint: true, throwIfNoEntry: false }));
  return stat === undefined ? undefined : { dev: stat.dev, ino: stat.ino };
}

const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * One try: the lock; "busy" when another connection holds it or the file changed during the try;
 * "gone" when the file went away before SQLite opened it. Other failures throw.
 *
 * The drivers give no handle to the file they opened, so the identity comes from a stat by the
 * same path after the lock (A1 3.9 takes a claim's identity the same way). On Linux and
 * macOS a file renamed over the path between SQLite's open and that stat would give the
 * replacement's identity, which a watch would then never see change. So the path's identity is also
 * read before the open, and a try whose two readings differ counts as busy and is tried again.
 *
 * SQLite never creates the file: it would give it its own default mode masked by the umask
 * (A2 3.2.2 rule 5). The file is created here, exclusively and with exactly `mode`, when it is
 * missing, and its identity is required before SQLite opens it without `create`. A file removed in
 * between is "gone", and the next try starts again from the exclusive creation.
 */
function tryLock(driver: SqliteDriver, path: string, mode: number): FileLock | "busy" | "gone" {
  // One that is there keeps its mode.
  try {
    createEmptyFile(path, mode);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw fsError(error, "STORAGE_CANT_OPEN");
  }
  const before = identityIfAny(path);
  if (before === undefined) return "gone";
  let conn: Connection;
  try {
    conn = driver.open(path, { readOnly: false, busyTimeoutMs: 0, create: false });
  } catch (error) {
    // Without `create` a missing file fails the open (SQLITE_CANTOPEN): it went away meanwhile.
    if (identityIfAny(path) === undefined) return "gone";
    throw error;
  }
  let identity: FileIdentity;
  try {
    // Reading the journal mode needs a shared lock, so a held lock can refuse either statement.
    conn.pragma("journal_mode", "memory");
    conn.exec("BEGIN EXCLUSIVE");
    identity = fsCall(() => fileIdentity(path));
  } catch (error) {
    conn.close();
    if (error instanceof StorageError && error.code === "STORAGE_BUSY") return "busy";
    throw error;
  }
  if (!sameFile(before, identity)) {
    conn.close();
    return "busy";
  }
  let released = false;
  return {
    path,
    identity,
    release: () => {
      if (released) return;
      released = true;
      conn.close();
    },
  };
}

/**
 * Takes an exclusive lock on the file at `path`, creating it when missing, through `driver`. Its
 * connection runs nothing but that transaction and never waits. Undefined when another process
 * still holds the lock after `settleMs` of jittered tries; each try closes its connection, so a
 * waiting opener holds nothing that could block another. The service lock (M1.08) uses it too.
 * A missing file is created with exactly `mode`, whatever the umask: 0600 for a space's
 * writer.lock (A1: the space's files are owner-only), 0644 for service.lock (A2 3.2.3).
 */
export async function takeFileLock(
  driver: SqliteDriver,
  path: string,
  settleMs: number = LOCK_SETTLE_MS,
  mode: number = FILE_MODE,
): Promise<FileLock | undefined> {
  const deadline = performance.now() + settleMs;
  let gone = 0;
  for (;;) {
    const held = tryLock(driver, path, mode);
    if (held === "gone") {
      // Removed between its creation and SQLite's open: created again at once. A file that keeps
      // going away is a failure, not a lock someone holds.
      gone += 1;
      if (gone >= GONE_TRIES) {
        throw new StorageError("STORAGE_CANT_OPEN", "The lock file keeps going away");
      }
      continue;
    }
    if (held !== "busy") return held;
    if (performance.now() >= deadline) return undefined;
    const pause = RETRY_PAUSE_MS.min + Math.random() * RETRY_PAUSE_MS.spread;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

/** Who holds a space's writer.lock, as its writer.json names it (A2 3.4). Never for a log. */
export interface WriterHolder {
  readonly machine?: string;
  readonly host?: string;
  readonly pid?: number;
  readonly instance?: string;
  readonly state_dir?: string;
  readonly since?: string;
}

/** What the opener tells writer.json about itself, besides its PID and the time. */
export interface HolderFacts {
  /** This machine's name. */
  readonly machine?: string;
  /** The service's instance ID, when a service opens the space. */
  readonly instance?: string;
  /** The service's canonical state folder, when a service opens the space. */
  readonly stateDir?: string;
}

const HOLDER_MAX_BYTES = 16 * 1024;
const LIMITS = { machine: 100, host: 64, instance: 128, state_dir: 4096, since: 40 } as const;

/** Holder facts from another thread, checked at run time: strings of a bounded length or nothing. */
export function checkHolderFacts(value: unknown): HolderFacts {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) throw misuse("Holder facts are an object");
  const fields = value as Record<string, unknown>;
  const pick = (name: keyof HolderFacts, max: number): Record<string, string> => {
    const field = fields[name];
    if (field === undefined) return {};
    if (typeof field !== "string" || field.length > max) {
      throw misuse("A holder fact is a short string");
    }
    return { [name]: field };
  };
  return {
    ...pick("machine", LIMITS.machine),
    ...pick("instance", LIMITS.instance),
    ...pick("stateDir", LIMITS.state_dir),
  };
}

/** The holder a space's writer.json names, each field checked, or undefined. */
export function readWriterHolder(folder: string): WriterHolder | undefined {
  let record: unknown;
  try {
    const read = readBounded(join(folder, WRITER_HOLDER_FILE), HOLDER_MAX_BYTES);
    if (read.state !== "ok") return undefined;
    record = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const fields = record as Record<string, unknown>;
  const text = (name: keyof typeof LIMITS): Record<string, string> => {
    const value = fields[name];
    return typeof value === "string" && value.length <= LIMITS[name] ? { [name]: value } : {};
  };
  const pid = fields["pid"];
  return {
    ...text("machine"),
    ...text("host"),
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...text("instance"),
    ...text("state_dir"),
    ...text("since"),
  };
}

/**
 * Refuses a space whose database file has a second name: a symbolic link, or more than one hard
 * link (SPACE_DATABASE_LINKED). A missing file is left to the open, which reports it. Where the
 * file system reports one link for every file (some network file systems), a hard link is not seen.
 */
export function refuseLinkedDatabase(folder: string): void {
  const stat = fsCall(() => lstatSync(join(folder, DATABASE_FILE), { throwIfNoEntry: false }));
  if (stat !== undefined && (stat.isSymbolicLink() || stat.nlink > 1)) {
    throw new StorageError(
      "SPACE_DATABASE_LINKED",
      "The space's database file has another name (a hard or symbolic link), so it is not opened for writing",
    );
  }
}

/**
 * SPACE_LOCKED_ELSEWHERE with the holder its writer.json named when the refusal came (A2 3.4: the
 * second service names the holder). The holder is for a person's status, never for a log: it holds
 * a machine's name and a state folder's path.
 */
export class SpaceLockedElsewhere extends StorageError {
  readonly holder: WriterHolder | undefined;

  constructor(message: string, holder: WriterHolder | undefined) {
    super("SPACE_LOCKED_ELSEWHERE", message);
    this.holder = holder;
  }
}

/**
 * A restore in place's or a recovery's watch over its swap (restore/folders.ts), which renames the
 * live folder away and the new one into its place.
 *
 * - Right before the swap, the lock must still be the file this holder took: a deleted or replaced
 *   writer.lock means another process may hold the space now, so nothing is renamed
 *   (SPACE_CHANGED). writer.json goes then, so the folder moved aside keeps no holder record.
 * - Windows refuses to rename a folder while any file in it is open, writer.lock included, so there
 *   the lock ends right before the swap, and Windows's own rule guards the first rename: a process
 *   that has the space open makes it fail. One that opened, wrote and closed it in between would
 *   not, so the database files' sizes and times are noted before the lock ends and compared once
 *   the live folder is moved aside; a change moves it back and fails the swap (SPACE_CHANGED).
 *   Elsewhere the lock is held through the swap.
 */
export interface SwapGuard {
  beforeSwap(): void;
  /** `replaced`: the live folder's new name. Throws to undo the first rename. */
  afterMoveAside(replaced: string): void;
}

/**
 * What a writer of the space changes in its folder: the database, its -wal and its journal, each
 * as `<identity>:<size>:<modified ns>` (or `-` when absent).
 */
function writtenFiles(folder: string): string {
  return ["", "-wal", "-journal"]
    .map((suffix) => {
      const stat = fsCall(() =>
        statSync(join(folder, `${DATABASE_FILE}${suffix}`), {
          bigint: true,
          throwIfNoEntry: false,
        }),
      );
      return stat === undefined
        ? "-"
        : `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeNs)}`;
    })
    .join("|");
}

export function swapGuard(
  lock: WriterLock,
  folder: string,
  options: { releaseBeforeSwap?: boolean } = {},
): SwapGuard {
  const release = options.releaseBeforeSwap ?? process.platform === "win32";
  let noted: string | undefined;
  return {
    beforeSwap: () => {
      const now = identityIfAny(lock.path);
      if (now === undefined || !sameFile(now, lock.identity)) {
        throw new StorageError("SPACE_CHANGED", "The space's writer lock was lost before the swap");
      }
      lock.removeHolder();
      if (release) {
        noted = writtenFiles(folder);
        lock.release();
      }
    },
    afterMoveAside: (replaced) => {
      if (noted !== undefined && writtenFiles(replaced) !== noted) {
        throw new StorageError("SPACE_CHANGED", "The space was written while it was swapped");
      }
    },
  };
}

/** A space's writer.lock, held with writer.json naming this holder. */
export interface WriterLock extends FileLock {
  /**
   * Removes writer.json while it still names this holder. A restore or a recovery calls it before
   * the swap moves the folder, so the moved-aside folder keeps no holder record.
   */
  removeHolder(): void;
}

/**
 * Takes the writer lock of the space folder `folder` (already checked as a space path), then
 * writes writer.json naming this holder. SPACE_LOCKED_ELSEWHERE when another process holds it.
 */
export async function takeWriterLock(
  driver: SqliteDriver,
  folder: string,
  facts: HolderFacts,
  now: () => number = Date.now,
): Promise<WriterLock> {
  const lock = await takeFileLock(driver, join(folder, WRITER_LOCK_FILE));
  if (lock === undefined) {
    throw new StorageError(
      "SPACE_LOCKED_ELSEWHERE",
      "Another process holds this space's writer lock",
    );
  }
  // The exact text this holder wrote: it removes writer.json only while it still reads so.
  const text = `${JSON.stringify({
    machine: facts.machine ?? null,
    // A6 3.4's host fingerprint arrives with the machine keys.
    host: null,
    pid: process.pid,
    instance: facts.instance ?? null,
    state_dir: facts.stateDir ?? null,
    since: new Date(now()).toISOString(),
  })}\n`;
  try {
    writeFileAtomic(folder, WRITER_HOLDER_FILE, text);
  } catch (error) {
    lock.release();
    throw fsError(error);
  }
  let holderRemoved = false;
  const removeHolder = (): void => {
    if (holderRemoved) return;
    holderRemoved = true;
    try {
      const path = join(folder, WRITER_HOLDER_FILE);
      const read = readBounded(path, HOLDER_MAX_BYTES);
      if (read.state === "ok" && Buffer.from(read.bytes).toString("utf8") === text) {
        rmSync(path, { force: true });
      }
    } catch {
      // A stale writer.json names a holder whose lock is free: the next holder replaces it.
    }
  };
  return {
    path: lock.path,
    identity: lock.identity,
    removeHolder,
    release: () => {
      removeHolder();
      lock.release();
    },
  };
}
