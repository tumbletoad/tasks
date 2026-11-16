// The spaces a service hosts (A2 3.1, 3.4) and their start-up sequence (A1 3.18).
//
// Each registered space has its own storage worker, which opens the space's writer through
// openSpaceWriter (A1 3.9, 3.17). Storage takes the space's writer.lock there, writes
// writer.json beside it and holds the lock for the writer's life (storage's writer-lock.ts), so one
// writer per space holds across processes, services, state folders and OS accounts (A2 3.4). The
// hub passes this start's instance and state folder for writer.json, and watches the lock.
//
// STARTUP, per space, in this order (A1 3.18):
// 1. finishInterruptedRestore: a restore in place or a recovery that a crash interrupted is
//    completed before anything opens the space. It acts only on the folder's own swap (the folders
//    named after it beside it), never on the space inside, so it runs whatever the entry's ID says.
// 2. openSpaceWriter with this machine, the entry's space ID, the machine-local backup folder
//    (space-settings.ts) and the holder facts. Storage reads the folder's space read-only first
//    (space.json and the database, which must agree): a folder that holds another space than the
//    entry names is refused (UnexpectedSpace) before anything is claimed, locked or written, so
//    no registration, migration, backup or leftovers cleanup touches it: unavailable(other_space).
//    Under the lock, phase 1 must still read the space the probe read (SPACE_CHANGED otherwise). A
//    space at an older revision is migrated on the writer's own connection, under its claim and
//    its lock, behind a verified barrier backup. The refusals become states:
//    - a failed migration (BACKUP_FAILED, BUNDLE_LIMIT_EXCEEDED, MIGRATION_FAILED, SPACE_CHANGED):
//      read_only(migration_failed), its code in status, served by a reader at its old revision.
//      The failure is recorded in the space's settings (space-settings.ts `failed_migrations`):
//      this build, and the state of the database it was tried on (revision, epoch, incarnation,
//      last_seq), as storage reports it;
//    - a backup restored into a new folder (SPACE_READ_ONLY_COPY): read_only(read_only_copy) until
//      a person claims it (claim());
//    - an older revision whose authority is another machine (SPACE_NEEDS_MIGRATION):
//      read_only(not_authority), at its revision;
//    - another process's lock: unavailable(locked_elsewhere), the holder from writer.json in
//      status (never in the log); a database file with a second name: unavailable(linked_database);
//    - an open past its bound (SPACE_OPEN_TIMEOUT_MS), a long migration's for one: its worker is
//      stopped first, within the close's bound, and only then is the space read again, in a new
//      worker. Still at an older revision, it was not changed (a migration is one transaction):
//      read_only(migration_failed), code ETIMEDOUT, with a migration's message, and its next open
//      tries again (a timeout is no failed migration and records none). At the build's revision,
//      the stopped open's migration committed: the writer opens again, once, in the new worker. A
//      worker that does not stop in time is unavailable(open_failed), and no reader is served.
//    A writer whose authority is another machine opens and refuses every write (SPACE_READ_ONLY,
//    `not_authority`), so that space is read_only(not_authority) too, never `open`. The reader a
//    read-only state opens must hold the entry's space too, or the space is unavailable(other_space).
//
//    A failed migration is not tried again by itself (A1 3.17). Before the writer, when the
//    space's settings record a failure of THIS build, a reader reads the state of the database:
//    when it is a recorded state, at an older revision, the space is read_only(migration_failed)
//    with the recorded code and a message that says so, and nothing is opened for writing,
//    backed up or written. The migration is tried again, each time behind its own new barrier
//    backup, when something changed that could change the outcome: another build, another state of
//    the database (a restore, another writer), or the person asking (`tasks space open
//    --retry-migration`, open() with `retryMigration`). A successful migration and a restore in
//    place forget the failures. So barrier backups are bounded by acts: one per build that tries,
//    per state of the database, and per retry the person asks for.
// 3. Once open as this machine's: one maintenance run (maintenance.ts): leftovers in the space's
//    own backups folder, the daily backup when due, retention. Then a check every hour whether the
//    next daily backup is due. And the projection (projection.ts, A1 3.13) in a worker of its own,
//    into the space's `view/`, until the space closes: a close stops it first, before the writer
//    it asks for its bookkeeping. `tasks view rebuild` reaches it through rebuildView.
// The highest epoch this machine has seen for a space is recorded when its writer opens as the
// authority (space-settings.ts), and a claim or a restore in place goes above it.
//
// writer.lock is watched (A2 3.4): deleted or replaced (Linux and macOS; Windows refuses both while
// it is held), another service could lock a new file and open the space while this one's writer,
// or an open in progress, still runs, and only the end of the process stops a worker for certain.
// So the manager reports the loss (`onLockLost`) and the service exits 70 at once (service.ts).
//
// One space failing never stops the service (A2 3.1). Every wait is bounded. A close waits for an
// open in progress only up to its bound; an open still running then releases what it took when it
// ends, or the process exit does. The lock lives in the space's worker, beside the writer it
// guards, so a worker that hangs keeps both until the process exits.
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_NAME } from "@tasks/brand";
import {
  DEFAULT_DRIVER,
  decodeRevision,
  encodeRevision,
  finishInterruptedRestore,
  formatRevision,
  LATEST_REVISION,
  readManifest,
  SpaceLockedElsewhere,
  StorageError,
  StorageWorker,
  UnexpectedSpace,
  type Id,
  type LockedFile,
  type MachineInfo,
  type Revision,
  type SpaceWriterHandle,
  type WorkerConnection,
  type WriterHolder,
} from "@tasks/storage";
import {
  watchOwnership,
  type OwnershipCheck,
  type OwnershipLoss,
  type OwnershipWatch,
} from "./lock.ts";
import type { Reconciled } from "@tasks/projection";
import type { Logger, SpaceReason } from "./log.ts";
import { MaintenanceFailed, type Maintenance } from "./maintenance.ts";
import { BUILD } from "./build.ts";
import { ProjectionRunner } from "./projection.ts";
import {
  clearFailedMigrations,
  failedOn,
  knownEpochs,
  projectionStateOf,
  readSpaceSettings,
  recordFailedMigration,
  recordProjectionRescue,
  recordSeen,
  recordSyncedConfirmed,
  recordWriterFolder,
  type BuildIdentity,
  type FailedMigration,
  type SpaceSettings,
} from "./space-settings.ts";
import {
  checkFolder,
  folderMessage,
  UNCHECKED,
  type FolderCheck,
  type SyncHost,
} from "./sync-folders.ts";
import { wayOutOf } from "./space-ways.ts";
import { realSyncHost } from "./sync-host.ts";
import { readOnly, type ServedSpace } from "../ops/index.ts";
import { bounded, Timeout, within } from "./wait.ts";

export { WRITER_HOLDER_FILE as WRITER_FILE, WRITER_LOCK_FILE as WRITER_LOCK } from "@tasks/storage";
export { readWriterHolder as readHolder, type WriterHolder } from "@tasks/storage";

/** A space's open, its writer and a migration included, gets this long. */
export const SPACE_OPEN_TIMEOUT_MS = 30_000;
/** A space's close gets this long. A close that does not finish keeps the worker, and its lock. */
export const SPACE_CLOSE_TIMEOUT_MS = 10_000;
/** How often an open space checks whether its next daily backup is due (A1 3.18: after 03:00). */
export const DAILY_CHECK_MS = 3_600_000;
/** A space's projection gets this long to end its batch when the space closes, then it is stopped. */
export const PROJECTION_STOP_MS = 5_000;

/** One registered space (A2 3.2.4 `[[spaces]]`): its folder opens only as the space `id` names. */
export interface SpaceEntry {
  readonly id: Id<"sp">;
  readonly path: string;
  /** False: the person closed it (`enabled = false`). It is listed, closed, until opened again. */
  readonly enabled?: boolean;
}

/**
 * A2 3.1's states, and `read_only`: the space is served, at its revision, but takes no write, for
 * the reason given (a read-only copy, another machine's space, a failed migration).
 */
export type SpaceState = "opening" | "open" | "read_only" | "unavailable" | "closing" | "closed";

export interface SpaceView {
  /** The entry's index in the registered list. */
  readonly entry: number;
  /**
   * The space the entry names, which its folder opens only as (A2 3.2.4): in described(), for
   * people and the space verbs, also before the space has been served.
   */
  readonly registered?: Id<"sp">;
  /** The space's ID as read from the folder, once it has been served. */
  readonly id?: Id<"sp">;
  /** The space's name and reference prefix, once it is served. For people, never the log. */
  readonly name?: string;
  readonly ref_prefix?: string;
  readonly state: SpaceState;
  /** `tasks space forget` took it off the list: kept only so other entries keep their index. */
  readonly forgotten?: true;
  readonly reason?: SpaceReason;
  /** The storage code behind a read-only or unavailable state, when there is one. */
  readonly code?: string;
  /** Who holds the space's writer.lock, from its writer.json. For status, never for the log. */
  readonly holder?: WriterHolder;
  /**
   * Why the space is read-only or unavailable and what to run, for people, never the log: the
   * words of its folder check or failed migration (the revisions, the cause's code, that the data
   * is unchanged, the barrier backup's name and how it is tried again), else its way out
   * (space-ways.ts). It names no path and no content.
   */
  readonly message?: string;
  /** What the folder check found (A1 3.2), when it found a sync client or a network file system. */
  readonly folder_check?: {
    readonly verdict: "synced" | "network";
    readonly provider?: string;
    readonly fs?: string;
    readonly conflicts?: readonly string[];
  };
}

export interface SpaceManagerOptions {
  readonly machine: MachineInfo;
  /** This start's instance ID, for writer.json. */
  readonly instance: string;
  /** The canonical state folder, for writer.json. */
  readonly stateDir: string;
  /** The state folder, for the machine-local space settings (space-settings.ts). */
  readonly settingsDir: string;
  readonly log: Logger;
  readonly startWorker?: () => Promise<StorageWorker>;
  readonly openTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /** How often each writer.lock's identity is checked besides change notifications. */
  readonly ownershipCheckMs?: number;
  /**
   * A space's writer.lock was deleted or replaced. The service ends the process with 70 (A2 3.4):
   * nothing short of that stops a worker that may still write.
   */
  readonly onLockLost: (entry: number, what: OwnershipLoss, via: OwnershipCheck) => void;
  /** The backup upkeep (maintenance.ts). Without it, no space is maintained. */
  readonly maintenance?: Maintenance;
  /**
   * Whether each space open as this machine's keeps its projection (A1 3.13) in a worker of its
   * own. Default false: tests that look at a space's folder.
   */
  readonly projection?: boolean;
  readonly now?: () => Date;
  /**
   * Where the synced-folder check reads its facts (A1 3.2, sync-folders.ts). Default: this machine
   * (sync-host.ts). Tests pass fixtures.
   */
  readonly syncHost?: SyncHost;
  /**
   * This build, which a failed migration's record names: another build tries the migration again
   * (A1 3.17). Default: BUILD. Tests pass others.
   */
  readonly build?: BuildIdentity;
}

/** How a person has a failed migration tried again now (A1 3.17): `space/open`'s option. */
export const RETRY_MIGRATION = `${CLI_NAME} space open <folder> --retry-migration`;

/** What a failed migration's message adds: when it is tried again, and how to ask for it now. */
const TRIED_AGAIN = `It is tried again after an update, or now with: ${RETRY_MIGRATION}`;

/**
 * A folder's canonical form, the key of a confirmation that it is excluded from sync (A1 3.2): its
 * real path, in lower case on Windows and macOS, whose file systems ignore case.
 */
export function canonicalFolder(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return platform === "win32" || platform === "darwin" ? real.toLowerCase() : real;
}

/** Why a synced space whose database fails PRAGMA quick_check is read-only (A1 3.2). */
const CHECK_FAILED =
  "This space is in a synced folder and its database does not pass its check. It is never written. Restore the latest verified backup into a new folder.";

/** The read-only state a refused writer's open leaves the space in, served by a reader. */
const READ_ONLY_REFUSALS: Readonly<Record<string, SpaceReason>> = {
  SPACE_READ_ONLY_COPY: "read_only_copy",
  SPACE_NEEDS_MIGRATION: "not_authority",
  BACKUP_FAILED: "migration_failed",
  BUNDLE_LIMIT_EXCEEDED: "migration_failed",
  MIGRATION_FAILED: "migration_failed",
  SPACE_CHANGED: "migration_failed",
};

/** The code of an open that ran past its bound (wait.ts Timeout). */
const OPEN_TIMED_OUT = "ETIMEDOUT";

/**
 * A1 3.17's message for a migration the open's bound stopped (#afterTimeout), once the stopped
 * worker has ended and the space is still at an older revision: the revisions, the cause's code
 * and that the data is unchanged. Which barrier backup the stopped open took, if any, is not known
 * here, so it names none. A timeout records no failure: the next open tries again. No path, no
 * content.
 */
const timedOutMessage = (stays: Revision): string =>
  `Migration to ${formatRevision(LATEST_REVISION)} did not finish in time (${OPEN_TIMED_OUT}). ` +
  `Your data is unchanged. The space stays at ${formatRevision(stays)}. ` +
  "It is tried again when the space next opens.";

const sentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

const revisionText = (userVersion: number): string => {
  const revision = decodeRevision(userVersion);
  return revision === undefined ? String(userVersion) : formatRevision(revision);
};

/**
 * A migration that failed at this open: storage's message (A1 3.17: the revisions, the cause's
 * code, that the data is unchanged, the barrier backup's name), and how it is tried again.
 */
const failedMessage = (storage: string): string => `${sentence(storage)} ${TRIED_AGAIN}`;

/**
 * A migration this build tried on this state of the database before, which failed, and which is
 * not tried again by itself (A1 3.17). No path, no content.
 */
const notTriedMessage = (failure: FailedMigration): string =>
  `Migration to ${revisionText(failure.to)} failed with this version (${failure.code}) and was ` +
  `not tried again. Your data is unchanged. The space stays at ${revisionText(failure.from)}.` +
  (failure.backup === undefined ? "" : ` Backup: ${failure.backup}.`) +
  ` ${TRIED_AGAIN}`;

const reasonFor = (error: unknown): SpaceReason => {
  // Before the codes: SPACE_ID_MISMATCH on its own is a space.json that names another space.
  if (error instanceof UnexpectedSpace) return "other_space";
  if (!(error instanceof StorageError)) return "open_failed";
  switch (error.code) {
    case "SPACE_NOT_FOUND":
      return "missing";
    case "SPACE_TOO_NEW":
      return "format_too_new";
    case "SPACE_LOCKED_ELSEWHERE":
    case "SPACE_WRITER_TAKEN":
      return "locked_elsewhere";
    case "SPACE_DATABASE_LINKED":
      return "linked_database";
    case "SPACE_NEEDS_RECOVERY":
      return "needs_recovery";
    default:
      return "open_failed";
  }
};

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** Whether the space closes. A function, so a check after an await reads the field again. */
const closing = (space: { readonly stopping: boolean }): boolean => space.stopping;

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

class Hosted {
  state: SpaceState = "opening";
  id: Id<"sp"> | undefined;
  /** The space's name and reference prefix, read once it is served. For people, never the log. */
  name: string | undefined;
  refPrefix: string | undefined;
  reason: SpaceReason | undefined;
  code: string | undefined;
  holder: WriterHolder | undefined;
  worker: StorageWorker | undefined;
  writer: SpaceWriterHandle | undefined;
  /** A read-only space's reader, at its revision. */
  reader: WorkerConnection | undefined;
  /** The space's machine-local backup folder, when one is set. */
  backupDir: string | undefined;
  /** The projection's worker while the space is open as this machine's. */
  projection: ProjectionRunner | undefined;
  /** The hourly check whether the next daily backup is due. */
  daily: NodeJS.Timeout | undefined;
  /** The maintenance run in progress. */
  maintaining: Promise<void> | undefined;
  /** A restore in place or a claim through the manager, in progress. */
  replacing: Promise<unknown> | undefined;
  /** A close timed out: the worker may still hold the database and its lock. */
  stuck = false;
  /** The space closes: an open in progress releases what it took at its next step. */
  stopping = false;
  /** writer.lock was found deleted or replaced, and reported. */
  lost = false;
  /**
   * `tasks space forget`: the entry stays in the list so the other entries keep their index, but no
   * one sees or names it until its folder is opened again.
   */
  forgotten = false;
  /** The open in progress: what a close waits for. */
  busy: Promise<void> | undefined;
  /** The close, once one has begun. */
  closing: Promise<void> | undefined;
  /** What the folder check found, when it is not a local folder (A1 3.2). */
  check: FolderCheck | undefined;
  /**
   * Why a read-only space is read-only, for people: in A1 3.2's words, or a failed migration's
   * message (A1 3.17). Never the log.
   */
  message: string | undefined;
  readonly index: number;
  readonly folder: string;
  /**
   * The space the entry names: the folder opens only as this space. A create or a restore that
   * makes a new space in the folder of an entry that serves nothing names that space from then on.
   */
  registered: Id<"sp">;

  constructor(index: number, folder: string, registered: Id<"sp">) {
    this.index = index;
    this.folder = folder;
    this.registered = registered;
  }

  /** Back to a new open's start, after a close (a restore in place or a claim). */
  reset(): void {
    this.state = "opening";
    this.id = undefined;
    this.name = undefined;
    this.refPrefix = undefined;
    this.reason = undefined;
    this.code = undefined;
    this.holder = undefined;
    this.stuck = false;
    this.stopping = false;
    this.lost = false;
    this.busy = undefined;
    this.closing = undefined;
    this.check = undefined;
    this.message = undefined;
  }

  /** What a person reads about the state: its own message, else its way out (space-ways.ts). */
  shown(): string | undefined {
    return this.message ?? wayOutOf(this.state, this.reason);
  }

  view(): SpaceView {
    const check = this.check;
    const message = this.shown();
    return {
      entry: this.index,
      state: this.state,
      ...(this.forgotten ? { forgotten: true } : {}),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.holder === undefined ? {} : { holder: this.holder }),
      ...(message === undefined ? {} : { message }),
      ...(check === undefined || check.verdict === "local"
        ? {}
        : {
            folder_check: {
              verdict: check.verdict,
              ...(check.provider === undefined ? {} : { provider: check.provider }),
              ...(check.fs === undefined ? {} : { fs: check.fs }),
              ...(check.conflicts.length === 0 ? {} : { conflicts: check.conflicts }),
            },
          }),
    };
  }
}

/** What a restore in place or a claim through the manager reports. Content-free. */
export interface SpaceChange {
  readonly epoch: number;
  readonly incarnation: Id<"ai">;
}

export class SpaceManager {
  readonly #options: SpaceManagerOptions;
  readonly #spaces: Hosted[] = [];
  readonly #startWorker: () => Promise<StorageWorker>;
  /** The service drains: nothing opens again. */
  #draining = false;
  /** Each worker's writer.lock watch, from its onLock until it is known to have let go. */
  readonly #watches = new Map<StorageWorker, OwnershipWatch>();
  readonly #syncHost: SyncHost;

  constructor(options: SpaceManagerOptions) {
    this.#options = options;
    this.#startWorker =
      options.startWorker ?? (() => StorageWorker.start({ driver: DEFAULT_DRIVER }));
    this.#syncHost = options.syncHost ?? realSyncHost();
  }

  /** The synced-folder check of `folder` (A1 3.2), for the space verbs' destinations too. */
  checkFolder(folder: string): Promise<FolderCheck> {
    return checkFolder(folder, this.#syncHost);
  }

  /**
   * Registers every entry and opens the enabled ones (A2 3.1). Resolves when each is open,
   * read-only or unavailable, and never rejects: an open that fails in an unforeseen way leaves its
   * space unavailable(open_failed). An entry the person closed (`enabled = false`) is listed,
   * closed, and opens again on `space open`. Spaces open in parallel; copies of one space (one ID)
   * open one after another, never the one that happens to be faster first: the copy that last
   * opened as this machine's writer (#writerFirst), then the others in the entries' order. So the
   * copy the person last wrote to keeps the writer when another could take it (an original listed
   * before a claimed copy, whose read-only reason has gone).
   */
  async openAll(entries: readonly SpaceEntry[]): Promise<void> {
    const start = this.#spaces.length;
    const hosted = entries.map((entry, i) => new Hosted(start + i, resolve(entry.path), entry.id));
    this.#spaces.push(...hosted);
    const copies = new Map<Id<"sp">, Hosted[]>();
    hosted.forEach((space, i) => {
      if (entries[i]?.enabled === false) {
        space.state = "closed";
        space.name = this.#nameInFolder(space);
        return;
      }
      const group = copies.get(space.registered);
      if (group === undefined) copies.set(space.registered, [space]);
      else group.push(space);
    });
    await Promise.all(
      [...copies.entries()].map(async ([id, group]) => {
        const first = group.length > 1 ? this.#writerFirst(id, group) : undefined;
        const ordered = first === undefined ? group : [first, ...group.filter((s) => s !== first)];
        for (const space of ordered) {
          // Closed while it waited for the copy before it, opened by a verb meanwhile, or the
          // service drains: not opened here.
          if (space.stopping || space.busy !== undefined || this.#draining) continue;
          await this.#begin(space);
        }
      }),
    );
  }

  list(): SpaceView[] {
    return this.#spaces.map((space) => space.view());
  }

  /**
   * list() with the ID each entry names and each served space's name and prefix, for people
   * (status, `tasks space`).
   */
  described(): SpaceView[] {
    return this.#spaces.map((space) => ({
      ...space.view(),
      registered: space.registered,
      ...(space.name === undefined ? {} : { name: space.name }),
      ...(space.refPrefix === undefined ? {} : { ref_prefix: space.refPrefix }),
    }));
  }

  /**
   * The spaces as the request path sees them (ops/handlers.ts): a writer while the space is open
   * as this machine's, a reader while it is served.
   */
  served(): ServedSpace[] {
    return this.#spaces
      .filter((space) => !space.forgotten)
      .map((space) => {
        const message = space.shown();
        return {
          id: space.id,
          registered: space.registered,
          name: space.name,
          state: space.state,
          ...(space.reason === undefined ? {} : { reason: space.reason }),
          ...(message === undefined ? {} : { message }),
          writer: space.state === "open" ? space.writer : undefined,
          reader: space.state === "open" || space.state === "read_only" ? space.reader : undefined,
          folder: space.folder,
        };
      });
  }

  /** The folder of a registered space, for the space verbs. */
  folderOf(entry: number): string {
    return this.#space(entry).folder;
  }

  /**
   * Serves the space at `path` (`tasks space open`, `create`, `restore --to`): a folder already
   * registered opens again when it is closed or unavailable, a new one is added. Resolves with its
   * entry once the open has settled. Like a `[[spaces]]` entry, the entry opens only as one space
   * (A2 3.2.4): `id` when the caller made the space and knows it, else the space the folder holds
   * now, which is the one the person named. The space verbs record the entry in machine.toml
   * (space-records.ts), so it opens again after a restart.
   *
   * `id` for a registered folder that serves nothing (closed or unavailable): a create or a restore
   * made a new space in that folder, which was not there before, so the entry names that space
   * from now on. An entry that serves a space is never re-pointed.
   *
   * `retryMigration` (the person's `--retry-migration`, A1 3.17): a migration that failed
   * before is tried again at this open, behind a new barrier backup, also when this build failed
   * on this very state. A space served read-only for a failed migration closes and opens again.
   */
  async open(
    path: string,
    id?: Id<"sp">,
    options: { readonly retryMigration?: boolean } = {},
  ): Promise<number> {
    if (this.#draining) throw new StorageError("STORAGE_MISUSE", "The service is stopping");
    const retry = options.retryMigration === true;
    const folder = resolve(path);
    const same = (other: string) =>
      process.platform === "win32" || process.platform === "darwin"
        ? other.toLowerCase() === folder.toLowerCase()
        : other === folder;
    const known = this.#spaces.find((space) => same(space.folder));
    if (known !== undefined) {
      // A forgotten folder opened again is listed again, as any folder opened for the first time.
      known.forgotten = false;
      const free = () => known.replacing === undefined && !known.stuck;
      // An entry its last open left unavailable (its folder was gone, its drive not mounted, its
      // lock held elsewhere) is tried again: closed first, so it opens from the start.
      if (known.state === "unavailable" && free()) await this.#close(known, this.#closeMs);
      if (id !== undefined && id !== known.registered) {
        if (known.state !== "closed" || !free()) throw new UnexpectedSpace();
        known.registered = id;
      }
      if (known.state === "closed" && free()) {
        known.reset();
        await this.#begin(known, retry);
        return known.index;
      }
      if (known.busy !== undefined) await known.busy;
      if (retry && known.state === "read_only" && known.reason === "migration_failed") {
        await this.#retryMigration(known);
      }
      // `space open` of the copy that writes: its record as the writer, which its open may not
      // have been able to write, is made again (A2 3.1).
      if (known.state === "open" && known.id !== undefined) this.#recordWriter(known, known.id);
      return known.index;
    }
    const registered = id ?? (await this.#heldBy(folder));
    // Read again: the service may have begun to drain while the folder was read.
    if (this.#isDraining()) throw new StorageError("STORAGE_MISUSE", "The service is stopping");
    const space = new Hosted(this.#spaces.length, folder, registered);
    this.#spaces.push(space);
    await this.#begin(space, retry);
    return space.index;
  }

  /**
   * A space served read-only for a failed migration closes and opens again with its migration
   * tried (A1 3.17). One change of the space at a time. A worker that did not close in time
   * keeps the migration from being tried, as it keeps every change: the space opens again as
   * before (confirmExcluded's rule), and the retry is refused.
   */
  async #retryMigration(space: Hosted): Promise<void> {
    await this.#exclusive(space, async () => {
      await this.#close(space, this.#closeMs);
      const stuck = space.stuck;
      // Read again: the service may have begun to drain while the space closed.
      if (!this.#isDraining()) {
        space.reset();
        await this.#begin(space, !stuck);
      }
      if (stuck) {
        throw new StorageError("SPACE_WRITER_TAKEN", "The space's last worker has not closed");
      }
    });
  }

  /**
   * The space a folder holds now: space.json's ID, else the database's, read-only through a worker
   * of its own (the main thread holds no SQLite connection). The writer's open then checks that
   * the database holds this space before anything is claimed (A2 3.2.4).
   */
  async #heldBy(folder: string): Promise<Id<"sp">> {
    const named = this.#settingsOf(folder).spaceId;
    if (named !== undefined) return named;
    const worker = await this.#startWorkerBounded();
    try {
      const { conn, info } = await bounded(worker.openSpaceReader(folder), this.#openMs);
      await conn.close().catch(() => undefined);
      return info.spaceId;
    } finally {
      await within(
        worker.close().catch(() => undefined),
        this.#closeMs,
      );
    }
  }

  /**
   * Recovers a space refused with a rollback journal (`tasks space recover`, A1 3.18): the
   * space closes, storage plays the journal back on a copy and swaps it in under the space's
   * writer.lock, and the space opens again, also when the recovery failed.
   */
  async recover(entry: number): Promise<{ readonly replaced: boolean }> {
    const space = this.#space(entry);
    // Never on a network file system (A1 3.2). In a synced folder a recovery is the only way out
    // of a rollback journal (such a space is not served, so it can be neither backed up nor
    // confirmed), so it runs, and the space opens read-only again afterwards.
    await this.#refuseUnwritableFolder(space, { synced: false });
    await this.#replace(space, async (worker) => {
      const recovered = await worker.recoverSpace(space.folder, { holder: this.#holderFacts });
      return { spaceId: recovered.space.spaceId };
    });
    return { replaced: true };
  }

  /**
   * Records that `space`'s copy is the space's writer now (`writer_folder`): at the next start it
   * opens before the other copies (openAll), so another copy never takes the writer from it. Best
   * effort: without it the next start picks by the newest authority, then the file's order, and the
   * next open of this copy, `space open` of it while it writes too, records it again.
   */
  #recordWriter(space: Hosted, spaceId: Id<"sp">): void {
    try {
      recordWriterFolder(this.#options.settingsDir, spaceId, canonicalFolder(space.folder));
    } catch {
      // As above.
    }
  }

  /**
   * Which copy of the space `id` among `group` (two or more, in the file's order) opens first at a
   * start: the copy that last opened as this machine's writer; when its folder is not listed (moved
   * by hand, its entry's path changed), the copy whose space.json names the newest authority this
   * machine has seen, the one a claim made; else none, and the file's order decides.
   */
  #writerFirst(id: Id<"sp">, group: readonly Hosted[]): Hosted | undefined {
    const settings = this.#settingsFor(id);
    const writes = settings.writerFolder;
    const byFolder =
      writes === undefined
        ? undefined
        : group.find((space) => canonicalFolder(space.folder) === writes);
    if (byFolder !== undefined) return byFolder;
    const newest = settings.seen?.incarnation;
    if (newest === undefined) return undefined;
    return group.find((space) => {
      try {
        const read = readManifest(space.folder);
        return read.state === "present" && read.manifest?.authority.incarnation === newest;
      } catch {
        return false;
      }
    });
  }

  /**
   * A closed space's name from its folder's space.json, for the list: undefined when the file is
   * gone, damaged or names another space than the entry.
   */
  #nameInFolder(space: Hosted): string | undefined {
    try {
      const read = readManifest(space.folder);
      return read.state === "present" && read.manifest?.space_id === space.registered
        ? read.manifest.name
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Takes a closed or unavailable space off the list (`tasks space forget`): nothing of its folder
   * is touched, and `open` of the folder brings it back.
   */
  forget(entry: number): void {
    if (!this.forgettable(entry)) {
      throw new StorageError("STORAGE_MISUSE", "Only a closed space is forgotten");
    }
    this.#space(entry).forgotten = true;
  }

  /**
   * Whether `forget` takes the entry now: closed or unavailable, and no restore in place, claim or
   * recovery running. Those leave the space closed for a while and then open it again, which would
   * serve a space that is off the list.
   */
  forgettable(entry: number): boolean {
    const space = this.#space(entry);
    return (
      (space.state === "closed" || space.state === "unavailable") && space.replacing === undefined
    );
  }

  /** Reads the served space's name and prefix through its reader, for people's output. */
  async #learnName(space: Hosted): Promise<void> {
    const row = await space.reader?.get<{ name?: unknown; ref_prefix?: unknown }>(
      "SELECT name, ref_prefix FROM space WHERE one = 1",
    );
    if (typeof row?.name === "string") space.name = row.name;
    if (typeof row?.ref_prefix === "string") space.refPrefix = row.ref_prefix;
  }

  /**
   * Closes every space (A2 3.3.1 draining): maintenance first, then the writers, readers and
   * workers. Resolves within `ms` and a little more: a space that does not close in time keeps its
   * worker, and with it its lock, until the process exits.
   */
  async closeAll(ms: number = this.#closeMs): Promise<void> {
    this.#draining = true;
    await within(this.#options.maintenance?.stop() ?? Promise.resolve(), ms);
    // A restore in place or a claim in progress gets the same bound to end. One that does not is
    // cut off by the process's exit: a crash window its next start recovers from (A1 3.18).
    await Promise.allSettled(
      this.#spaces.map((space) =>
        space.replacing === undefined ? Promise.resolve(true) : within(space.replacing, ms),
      ),
    );
    await Promise.allSettled(this.#spaces.map((space) => this.#close(space, ms)));
    // The drain ends with the process: a worker that did not close is stopped by the exit, which
    // releases its lock, so nothing is left to watch.
    for (const watch of this.#watches.values()) watch.stop();
    this.#watches.clear();
  }

  /** Closes one space, within its bound (`tasks space close`, and before a restore in place). */
  async close(entry: number): Promise<void> {
    await this.#close(this.#space(entry), this.#closeMs);
  }

  /**
   * `tasks view rebuild` (A1 3.13 rule 5): the space's projection looks at every file it placed
   * and queues every task again, removing nothing it cannot prove it wrote. Resolves with what the
   * reconciliation found, or undefined while the space has no projection running (it is not open
   * as this machine's).
   */
  rebuildView(entry: number): Promise<Reconciled> | undefined {
    return this.#space(entry).projection?.rebuild();
  }

  /**
   * Restores `backupFile` in place of the space (A1 3.18): the space closes first, the
   * restore claims the backup with an epoch above every one this machine has seen, under the
   * space's writer.lock in a worker of its own, and the space opens again, also when the restore
   * failed. The restore's errors are storage's, content-free.
   */
  async restoreInPlace(entry: number, backupFile: string): Promise<SpaceChange> {
    const space = this.#space(entry);
    // The folder held another space than the entry names when it last opened: not this entry's to
    // replace.
    if (space.reason === "other_space") throw new UnexpectedSpace();
    // A1 3.2: a new database goes into the folder only where the space may be written. Elsewhere
    // the restore goes into a new folder (`--to`).
    await this.#refuseUnwritableFolder(space, { synced: true });
    return this.#changed(space, async (worker, settings) => {
      const restored = await worker.restoreInPlace(backupFile, space.folder, {
        machineId: this.#options.machine.id,
        knownEpochs: knownEpochs(settings),
        holder: this.#holderFacts,
      });
      // Another database is in place: what failed before is forgotten (A1 3.17). Its state
      // is new anyway (a restore claims a new epoch and incarnation).
      this.#forgetFailures(restored.space.spaceId);
      return {
        spaceId: restored.space.spaceId,
        change: { epoch: restored.claim.epoch, incarnation: restored.claim.incarnation },
      };
    });
  }

  /**
   * Claims a read-only copy (A1 3.18, A6 3.5): a new epoch above every one this machine has seen
   * and a new incarnation, under the space's writer.lock, then opens it as this machine's.
   */
  async claim(entry: number): Promise<SpaceChange> {
    const space = this.#space(entry);
    if (space.state !== "read_only" || space.reason !== "read_only_copy") {
      throw new StorageError("STORAGE_MISUSE", "Only a read-only copy is claimed");
    }
    return this.#changed(space, async (worker, settings) => {
      const claim = await worker.claimSpace(space.folder, {
        machine: this.#options.machine,
        knownEpochs: knownEpochs(settings),
        holder: this.#holderFacts,
        // Watched while the claim writes, as a writer is.
        onLock: (lock) => {
          this.#watch(space, worker, lock);
        },
      });
      return {
        spaceId: claim.space.spaceId,
        change: { epoch: claim.epoch, incarnation: claim.incarnation },
      };
    });
  }

  /**
   * "It is excluded, open anyway" (A1 3.2): records that the person confirmed this space's folder is
   * excluded from sync, for this machine and this folder, then opens the space again. Only a space
   * that is read-only for its synced folder is confirmed: a network file system never is, and a
   * database that fails its check stays read-only.
   */
  async confirmExcluded(entry: number): Promise<void> {
    const space = this.#space(entry);
    if (space.state !== "read_only" || space.reason !== "synced_folder") {
      throw new StorageError("STORAGE_MISUSE", "Only a space read-only for its synced folder");
    }
    await this.#exclusive(space, async () => {
      await this.#close(space, this.#closeMs);
      try {
        if (space.stuck) {
          throw new StorageError("SPACE_WRITER_TAKEN", "The space's last worker has not closed");
        }
        recordSyncedConfirmed(
          this.#options.settingsDir,
          space.registered,
          canonicalFolder(space.folder),
        );
      } finally {
        if (!this.#isDraining()) {
          space.reset();
          await this.#begin(space);
        }
      }
    });
  }

  /**
   * A1 3.2 for a change that writes a new database into the space's folder (a restore in place, a
   * recovery): refused, with the words of the read-only state, on a network file system, and with
   * `synced`, in a synced or unchecked folder the person has not confirmed, or for a database that
   * failed its check there. The folder is checked again now.
   */
  async #refuseUnwritableFolder(space: Hosted, options: { synced: boolean }): Promise<void> {
    if (options.synced && space.reason === "check_failed") {
      throw readOnly("check_failed", space.message ?? CHECK_FAILED);
    }
    const check = await this.checkFolder(space.folder);
    if (check.verdict === "local") return;
    if (check.verdict === "network") throw readOnly("network_filesystem", folderMessage(check));
    if (!options.synced) return;
    const confirmed =
      this.#settingsFor(space.registered).syncedFolderConfirmed === canonicalFolder(space.folder);
    if (!confirmed) throw readOnly("synced_folder", folderMessage(check));
  }

  /**
   * One change of a space at a time (a confirmation, beside #replace's), none once the service
   * drains.
   */
  async #exclusive<T>(space: Hosted, work: () => Promise<T>): Promise<T> {
    if (this.#draining || space.replacing !== undefined) {
      throw new StorageError("STORAGE_MISUSE", "The service is stopping, or the space is changing");
    }
    const running = work();
    space.replacing = running;
    try {
      return await running;
    } finally {
      space.replacing = undefined;
    }
  }

  #isDraining(): boolean {
    return this.#draining;
  }

  #space(entry: number): Hosted {
    const space = this.#spaces[entry];
    if (space === undefined) throw new StorageError("STORAGE_MISUSE", "No space has this entry");
    return space;
  }

  get #holderFacts(): { machine: string; instance: string; stateDir: string } {
    return {
      machine: this.#options.machine.name,
      instance: this.#options.instance,
      stateDir: this.#options.stateDir,
    };
  }

  get #openMs(): number {
    return this.#options.openTimeoutMs ?? SPACE_OPEN_TIMEOUT_MS;
  }

  get #closeMs(): number {
    return this.#options.closeTimeoutMs ?? SPACE_CLOSE_TIMEOUT_MS;
  }

  get #build(): BuildIdentity {
    return this.#options.build ?? BUILD;
  }

  /**
   * Starts a space's open and records it as the one a close waits for. `retry`: the person asked
   * for a failed migration to be tried again (A1 3.17).
   */
  #begin(space: Hosted, retry = false): Promise<void> {
    const opening = this.#open(space, retry).catch((error: unknown) => {
      if (space.state === "opening") this.#unavailable(space, error);
    });
    space.busy = opening;
    return opening;
  }

  /** The machine-local settings of the space at `folder`, by its space.json's ID, best effort. */
  #settingsOf(folder: string): SpaceSettings & { spaceId?: Id<"sp"> } {
    try {
      const read = readManifest(folder);
      const spaceId = read.state === "present" ? read.safety.space_id : undefined;
      if (spaceId === undefined) return {};
      return { spaceId, ...readSpaceSettings(this.#options.settingsDir, spaceId) };
    } catch {
      return {};
    }
  }

  async #open(space: Hosted, retry: boolean): Promise<void> {
    const { log } = this.#options;
    const t0 = performance.now();
    log.log("space.opening", { entry: space.index });
    // STARTUP 1: a restore in place or a recovery that a crash interrupted, before anything opens.
    try {
      const report = finishInterruptedRestore(space.folder);
      if (report.completed !== undefined || report.backupsCarried.length > 0) {
        log.log("space.restore_finished", {
          entry: space.index,
          swapped: report.completed !== undefined,
          carried: report.backupsCarried.length,
        });
      }
    } catch (error) {
      this.#unavailable(space, error);
      return;
    }
    if (!isDirectory(space.folder)) {
      this.#unavailable(space, new StorageError("SPACE_NOT_FOUND", ""));
      return;
    }
    const settings = this.#settingsOf(space.folder);
    space.backupDir = settings.backupDir;

    // A1 3.2: the folder and every folder above it, at every open. A network file system is never
    // written; a synced folder is read-only until the person confirmed it is excluded from sync,
    // and its database passes PRAGMA quick_check first either way.
    let check: FolderCheck;
    try {
      check = await this.checkFolder(space.folder);
    } catch {
      // checkFolder does not throw; should it, the folder is unchecked: a check that cannot see
      // never makes a space writable (sync-folders.ts).
      check = UNCHECKED;
    }
    space.check = check.verdict === "local" ? undefined : check;
    if (check.verdict !== "local" && (await this.#servedForFolder(space, check, t0))) return;

    // STARTUP 2, first: a migration that this build tried on this state of the database, and that
    // failed, is not tried again by itself (A1 3.17), unless the person asked for it.
    if (!retry && (await this.#notTriedAgain(space, settings, t0))) return;
    await this.#openWriter(space, settings, t0, false);
  }

  /**
   * STARTUP 2: the writer, which migrates an older revision first, under the space's lock, in the
   * space's worker (a new one unless an earlier step started it). `again`: the open before this one
   * ran past its bound and its stopped worker left the space at no older revision, so its migration
   * may have committed (#afterTimeout); this open is the last.
   */
  async #openWriter(
    space: Hosted,
    settings: SpaceSettings,
    t0: number,
    again: boolean,
  ): Promise<void> {
    const { log, machine } = this.#options;
    let writer: SpaceWriterHandle;
    try {
      const worker = space.worker ?? (await this.#startWorkerBounded());
      space.worker = worker;
      if (await this.#stopped(space)) return;
      writer = await bounded(
        worker.openSpaceWriter(space.folder, {
          machine,
          // Another space in the folder is refused before anything is claimed, locked or written.
          spaceId: space.registered,
          holder: this.#holderFacts,
          ...(settings.backupDir === undefined ? {} : { backupDir: settings.backupDir }),
          onLock: (lock) => {
            this.#watch(space, worker, lock);
          },
        }),
        this.#openMs,
      );
      space.writer = writer;
      if (await this.#stopped(space)) return;
      // Reads go through a reader of their own, never the writer (A1 3.9, M1.10's request path).
      const { conn } = await bounded(worker.openSpaceReader(space.folder), this.#openMs);
      space.reader = conn;
      if (await this.#stopped(space)) return;
      await this.#learnName(space);
    } catch (error) {
      await this.#refused(
        space,
        error,
        again ? undefined : () => this.#openWriter(space, settings, t0, true),
      );
      return;
    }
    space.id = writer.spaceId;
    const ms = Math.round(performance.now() - t0);
    if (writer.migration !== undefined) {
      log.log("space.migrated", {
        entry: space.index,
        space: writer.spaceId,
        from: encodeRevision(writer.migration.from),
        to: encodeRevision(writer.migration.to),
        steps: writer.migration.seqs.length,
      });
    }
    // A migration succeeded, this open's or the stopped one's: what failed before is forgotten.
    if (writer.migration !== undefined || again) this.#forgetFailures(writer.spaceId);
    if (writer.authority.machineId !== machine.id) {
      // Another machine's space: its writer refuses every write (SPACE_READ_ONLY).
      this.#readOnly(space, "not_authority", undefined, { ms });
      return;
    }
    try {
      recordSeen(this.#options.settingsDir, writer.spaceId, writer.authority);
    } catch {
      // The record is a floor for later claims; the next open writes it again.
    }
    this.#recordWriter(space, writer.spaceId);
    space.state = "open";
    log.log("space.open", {
      entry: space.index,
      space: writer.spaceId,
      ms,
      registered: writer.machineRegistered,
      migrated: writer.migration !== undefined,
    });
    // STARTUP 3: the backup upkeep, then the hourly check for the next daily backup.
    this.#maintain(space, true);
    const timer = setInterval(() => {
      if (space.state === "open" && space.maintaining === undefined) this.#maintain(space, false);
    }, DAILY_CHECK_MS);
    timer.unref();
    space.daily = timer;
    this.#project(space);
  }

  /**
   * The space's projection (A1 3.13), into its `view/`, in a worker of its own while the space is
   * open as this machine's. Its trusted state is beside the space's machine-local settings. Its
   * outcome is logged, counts and codes only; it never fails the space.
   */
  #project(space: Hosted): void {
    const { log } = this.#options;
    const spaceId = space.id;
    const writer = space.writer;
    if (this.#options.projection !== true || spaceId === undefined || writer === undefined) return;
    const entry = space.index;
    // The record is per folder: two folders that hold one space never share one (space-settings.ts).
    const state = projectionStateOf(this.#options.settingsDir, spaceId, space.folder);
    space.projection = new ProjectionRunner({ folder: space.folder, ...state }, writer, {
      // Each batch that moved entries aside, at least once, also one that failed or was killed
      // (A1 3.13 rule 3). Saved before it returns: a failure throws, so the worker keeps the stem
      // untold and tells it again. One small file read and written on this thread, only at a start
      // and after a batch that rescued.
      rescued: ({ stem, files }) => {
        log.log("space.projection_rescued", { entry, space: spaceId, files });
        try {
          recordProjectionRescue(this.#options.settingsDir, spaceId, { stem, files });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          log.log("space.projection_failed", {
            entry,
            space: spaceId,
            ...(typeof code === "string" ? { code } : {}),
          });
          throw error;
        }
      },
      // A folder or a link a person left at the record's or the journal's path, moved aside
      // beside it under `<name>.moved-aside-<time>` (A1 3.13 rule 1): theirs to look at.
      aside: (file) => {
        log.log("space.projection_state_moved_aside", { entry, space: spaceId, file });
      },
      reconciled: (r: Reconciled) => {
        log.log("space.projection_reconciled", {
          entry,
          space: spaceId,
          full: r.full,
          checked: r.checked,
          queued: r.queued,
          forgotten: r.forgotten,
        });
      },
      started: (report) => {
        log.log("space.projection_started", {
          entry,
          space: spaceId,
          rebuild: report.rebuild,
          recovered: report.recovered,
          temps: report.temps,
        });
      },
      step: (report, ms) => {
        log.log("space.projected", {
          entry,
          space: spaceId,
          written: report.written,
          removed: report.removed,
          failed: report.failed,
          watermark: report.watermark,
          backlog: report.backlog,
          ms,
        });
        if (report.code !== undefined) {
          log.log("space.projection_failed", { entry, space: spaceId, code: report.code });
        }
      },
      failed: (code) => {
        log.log("space.projection_failed", {
          entry,
          space: spaceId,
          ...(code === undefined ? {} : { code }),
        });
      },
    });
  }

  /**
   * A space whose folder is synced or on a network file system (A1 3.2). Its reader opens first: on
   * a network file system the space is read_only(network_filesystem); in a synced folder PRAGMA
   * quick_check runs, and the space is read_only(check_failed) when it fails, read_only
   * (synced_folder) while the person has not confirmed this folder is excluded from sync, and
   * otherwise goes on to its writer in the same worker. Returns whether the open ended here.
   */
  async #servedForFolder(space: Hosted, check: FolderCheck, t0: number): Promise<boolean> {
    try {
      const worker = await this.#startWorkerBounded();
      space.worker = worker;
      if (await this.#stopped(space)) return true;
      const { conn, info } = await bounded(worker.openSpaceReader(space.folder), this.#openMs);
      space.reader = conn;
      // The entry's space only, as for every open (A2 3.2.4).
      if (info.spaceId !== space.registered) throw new UnexpectedSpace();
      if (await this.#stopped(space)) return true;
      let reason: SpaceReason | undefined = "network_filesystem";
      if (check.verdict === "synced") {
        const verdict = await bounded(conn.pragma("quick_check"), this.#openMs);
        const confirmed =
          this.#settingsFor(space.registered).syncedFolderConfirmed ===
          canonicalFolder(space.folder);
        reason = verdict !== "ok" ? "check_failed" : confirmed ? undefined : "synced_folder";
      }
      if (reason === undefined) {
        // Confirmed and sound: the writer opens as for any space, in this worker.
        space.reader = undefined;
        await conn.close();
        return false;
      }
      space.id = info.spaceId;
      await this.#learnName(space);
      space.message = reason === "check_failed" ? CHECK_FAILED : folderMessage(check);
      this.#readOnly(space, reason, undefined, { ms: Math.round(performance.now() - t0) });
      return true;
    } catch (error) {
      await this.#release(space);
      if (!closing(space)) this.#unavailable(space, error);
      return true;
    }
  }

  /**
   * STARTUP 2, first (A1 3.17). When the space's settings record a migration that THIS build
   * tried and that failed, a reader reads the state of the database, in the space's worker. When
   * that is a recorded state, at an older revision, with this machine as its authority, the space
   * is served read-only with the recorded code and a message that says it was not tried again:
   * nothing opens for writing, is backed up or is written. Returns whether the open ended here.
   * Otherwise the writer's open goes on and tries: another state, or a reader that could not tell.
   * Never skipped on a guess: the safe direction is an attempt behind a new barrier backup.
   */
  async #notTriedAgain(space: Hosted, settings: SpaceSettings, t0: number): Promise<boolean> {
    const build = this.#build;
    const failures = (settings.failedMigrations ?? []).filter(
      (failure) => failure.build.version === build.version && failure.build.build === build.build,
    );
    if (failures.length === 0) return false;
    try {
      const worker = space.worker ?? (await this.#startWorkerBounded());
      space.worker = worker;
      if (await this.#stopped(space)) return true;
      const { conn, info } = await bounded(worker.openSpaceReader(space.folder), this.#openMs);
      const tried = {
        ...info.authority,
        from: encodeRevision(info.revision),
        lastSeq: info.lastSeq,
      };
      const failure =
        info.spaceId === space.registered &&
        info.readOnlyReasons.length === 1 &&
        info.readOnlyReasons[0] === "older_revision" &&
        info.authority.machineId === this.#options.machine.id
          ? failures.find((f) => failedOn(f, build, tried))
          : undefined;
      if (failure === undefined) {
        // Not a state this build failed on: the writer's open tries, in this worker.
        await conn.close();
        return false;
      }
      space.reader = conn;
      space.id = info.spaceId;
      if (await this.#stopped(space)) return true;
      await this.#learnName(space);
      space.message = notTriedMessage(failure);
      this.#readOnly(space, "migration_failed", failure.code, {
        ms: Math.round(performance.now() - t0),
        tried: false,
      });
      return true;
    } catch (error) {
      // The state could not be read here: the writer's open decides, in a new worker. A worker
      // that does not stop keeps the space from being opened.
      const released = await this.#release(space);
      if (closing(space)) return true;
      if (released) return false;
      this.#unavailable(space, error);
      return true;
    }
  }

  /**
   * Records a migration that failed at this open, with the state storage tried it on (A1
   * 3.17): this build does not try that state again by itself. Returns whether it was recorded. A
   * record that cannot be written leaves the next open to try again, behind a new barrier backup.
   */
  #recordFailure(space: Hosted, error: StorageError): boolean {
    const { attempt } = error;
    if (attempt === undefined) return false;
    try {
      recordFailedMigration(
        this.#options.settingsDir,
        space.registered,
        this.#build,
        attempt,
        error.code,
        this.#options.now?.() ?? new Date(),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** A migration succeeded or the database was replaced: the failures recorded are forgotten. */
  #forgetFailures(spaceId: Id<"sp">): void {
    try {
      clearFailedMigrations(this.#options.settingsDir, spaceId);
    } catch {
      // Left as they are: an entry names a state at an older revision, which a migrated space no
      // longer has, so it holds nothing back.
    }
  }

  /**
   * A writer's open was refused. A refusal that leaves the space readable (a read-only copy,
   * another machine's older space, a failed migration) opens a reader at its revision. `again`:
   * the writer's open once more, for an open past its bound whose space is found at no older
   * revision (#afterTimeout).
   */
  async #refused(
    space: Hosted,
    error: unknown,
    again: (() => Promise<void>) | undefined,
  ): Promise<void> {
    // A writer the worker refused gave its writer.lock up (or never had it): this service no
    // longer owns the file, so its loss is no reason to stop. An open that only ran past its
    // bound may still hold the lock in its worker, and migrate: its watch stays until the worker
    // is known to have closed (#release).
    const worker = space.worker;
    if (!(error instanceof Timeout) && worker !== undefined) this.#unwatch(worker);
    if (error instanceof SpaceLockedElsewhere) space.holder = error.holder;
    if (error instanceof Timeout && worker !== undefined && !space.stopping) {
      const after = await this.#afterTimeout(space);
      if (after === "served") return;
      if (after === "again" && again !== undefined) {
        await again();
        return;
      }
    }
    // A read-only copy of a space this service serves has the original's space ID, which the
    // original's writer holds in this process (SPACE_WRITER_TAKEN): it is served read-only too, and
    // claimed once the original is closed (M1.10's `tasks space restore --to`).
    const taken = error instanceof StorageError && error.code === "SPACE_WRITER_TAKEN";
    const readOnly = taken
      ? "read_only_copy"
      : error instanceof StorageError
        ? READ_ONLY_REFUSALS[error.code]
        : undefined;
    // A migration that failed at this open is recorded before anything else (A1 3.17), so
    // this build does not try that state again by itself. A timeout is no failed migration.
    const recorded =
      readOnly === "migration_failed" &&
      error instanceof StorageError &&
      this.#recordFailure(space, error);
    if (readOnly !== undefined && worker !== undefined && !space.stopping) {
      try {
        const { conn, info } = await bounded(worker.openSpaceReader(space.folder), this.#openMs);
        if (taken && !info.readOnlyReasons.includes("read_only_copy")) {
          await conn.close().catch(() => undefined);
          await this.#release(space);
          if (!closing(space)) this.#unavailable(space, error);
          return;
        }
        space.reader = conn;
        // The writer's open read the entry's space; another one put there since is not served.
        if (info.spaceId !== space.registered) throw new UnexpectedSpace();
        space.id = info.spaceId;
        if (await this.#stopped(space)) return;
        await this.#learnName(space);
        // A failed migration's message tells the person what happened, where the backup is and,
        // once recorded, how it is tried again.
        if (readOnly === "migration_failed" && error instanceof StorageError) {
          space.message = recorded ? failedMessage(error.message) : error.message;
        }
        this.#readOnly(
          space,
          readOnly,
          codeOf(error),
          readOnly === "migration_failed" ? { tried: true } : {},
        );
        return;
      } catch (readerError) {
        await this.#release(space);
        // Read again: a close may have begun while the reader opened.
        if (!closing(space)) this.#unavailable(space, readerError);
        return;
      }
    }
    await this.#release(space);
    if (!space.stopping) this.#unavailable(space, error);
  }

  /**
   * An open that ran past its bound, its writer's open still running in its worker: a migration
   * perhaps, behind a barrier backup that takes long on a large space (M3.01's review). The worker
   * is stopped first (#release), within the close's bound: a migration's transaction that has not
   * committed by then goes with it, as all its steps are one transaction (A1 3.17), and one that
   * committed before has ended. Only then is the space read again, by a reader in a new worker, so
   * what it reads can no longer change behind it:
   * - `served`: still at an older revision, so not changed: served read-only with a migration's
   *   message (code ETIMEDOUT); no failure is recorded, and its next open tries again. Or the open
   *   ended here otherwise (unavailable, or the space closes).
   * - `again`: at no older revision: the stopped open's migration committed (or the space needed
   *   none). The writer's open goes on once more, in the new worker, and never reports it
   *   unchanged.
   * - `stuck`: the worker did not stop within the close's bound. It keeps its writer.lock watch, no
   *   reader is served, and the space is unavailable(open_failed) as before.
   */
  async #afterTimeout(space: Hosted): Promise<"served" | "again" | "stuck"> {
    if (!(await this.#release(space))) return "stuck";
    if (space.stopping) return "served";
    try {
      const worker = await this.#startWorkerBounded();
      space.worker = worker;
      if (await this.#stopped(space)) return "served";
      const { conn, info } = await bounded(worker.openSpaceReader(space.folder), this.#openMs);
      space.reader = conn;
      // The writer's open read the entry's space; another one put there since is not served.
      if (info.spaceId !== space.registered) throw new UnexpectedSpace();
      if (!info.readOnlyReasons.includes("older_revision")) {
        space.reader = undefined;
        await conn.close();
        return "again";
      }
      space.id = info.spaceId;
      if (await this.#stopped(space)) return "served";
      await this.#learnName(space);
      space.message = timedOutMessage(info.revision);
      this.#readOnly(space, "migration_failed", OPEN_TIMED_OUT);
      return "served";
    } catch (readerError) {
      await this.#release(space);
      if (!closing(space)) this.#unavailable(space, readerError);
      return "served";
    }
  }

  /**
   * The space is served read-only for `reason`. `tried`, for a failed migration: whether this open
   * tried it (A1 3.17). `ms`: how long the open took.
   */
  #readOnly(
    space: Hosted,
    reason: SpaceReason,
    code: string | undefined,
    extra: { readonly ms?: number; readonly tried?: boolean } = {},
  ): void {
    space.state = "read_only";
    space.reason = reason;
    space.code = code;
    this.#options.log.log("space.read_only", {
      entry: space.index,
      reason,
      ...(space.id === undefined ? {} : { space: space.id }),
      ...(code === undefined ? {} : { code }),
      ...(extra.ms === undefined ? {} : { ms: extra.ms }),
      ...(extra.tried === undefined ? {} : { tried: extra.tried }),
    });
  }

  #unavailable(space: Hosted, error: unknown): void {
    const reason = reasonFor(error);
    const code = codeOf(error);
    space.state = "unavailable";
    space.reason = reason;
    space.code = code;
    this.#options.log.log("space.unavailable", {
      entry: space.index,
      reason,
      ...(space.id === undefined ? {} : { space: space.id }),
      ...(code === undefined ? {} : { code }),
    });
  }

  /**
   * Watches the writer.lock that `worker` took for this space, from the moment it holds it, until
   * that worker is known to have let it go (#unwatch): a worker that does not close in time keeps
   * its watch, whatever else happens to the space meanwhile.
   */
  #watch(space: Hosted, worker: StorageWorker, lock: LockedFile): void {
    this.#watches.get(worker)?.stop();
    this.#watches.set(
      worker,
      watchOwnership(
        { path: lock.path, identity: { dev: lock.dev, ino: lock.ino } },
        (what, via) => {
          this.#lost(space, what, via);
        },
        this.#options.ownershipCheckMs === undefined
          ? {}
          : { intervalMs: this.#options.ownershipCheckMs },
      ),
    );
  }

  /** `worker` holds no writer.lock any more: its file is no longer this service's to watch. */
  #unwatch(worker: StorageWorker): void {
    this.#watches.get(worker)?.stop();
    this.#watches.delete(worker);
  }

  /** One maintenance run for an open space. Its outcome is logged; it never fails the space. */
  #maintain(space: Hosted, atStart: boolean): void {
    const { maintenance, log } = this.#options;
    const spaceId = space.id;
    if (maintenance === undefined || spaceId === undefined) return;
    const now = (this.#options.now?.() ?? new Date()).getTime();
    const t0 = performance.now();
    space.maintaining = maintenance
      .run({
        folder: space.folder,
        spaceId,
        ...(space.backupDir === undefined ? {} : { backupDir: space.backupDir }),
        // Only the space's own backups folder, which this service alone writes while it holds
        // the space's writer.lock (maintenance.ts).
        cleanup: space.backupDir === undefined,
        atStart,
        now,
        utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
      })
      .then(
        (report) => {
          log.log("space.maintained", {
            entry: space.index,
            space: spaceId,
            leftovers: report.leftovers,
            backup: report.backup,
            removed: report.removed,
            unverified: report.unverified,
            ms: Math.round(performance.now() - t0),
          });
        },
        (error: unknown) => {
          // A run the service's drain ended is no failure of the space.
          if (error instanceof MaintenanceFailed && error.stopped) return;
          const code = error instanceof MaintenanceFailed ? error.code : undefined;
          log.log("space.maintenance_failed", {
            entry: space.index,
            space: spaceId,
            ...(code === undefined ? {} : { code }),
          });
        },
      )
      .finally(() => {
        space.maintaining = undefined;
      });
  }

  /** A worker, or Timeout after the open's bound. A worker that starts after that is closed. */
  async #startWorkerBounded(): Promise<StorageWorker> {
    const starting = this.#startWorker();
    try {
      return await bounded(starting, this.#openMs);
    } catch (error) {
      if (error instanceof Timeout) {
        starting.then((late) => late.close()).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Whether the open must end here because the space closes. Then it releases what it took. */
  async #stopped(space: Hosted): Promise<boolean> {
    if (!space.stopping) return false;
    await this.#release(space);
    return true;
  }

  /**
   * writer.lock was deleted or replaced: another service could lock a new file and open the space
   * while this one's writer, or an open in progress, still runs. Reported once; the service ends
   * the process (A2 3.4), which is the one way to stop a worker for certain.
   */
  #lost(space: Hosted, what: OwnershipLoss, via: OwnershipCheck): void {
    if (space.lost) return;
    space.lost = true;
    this.#options.log.log("space.ownership_lost", {
      entry: space.index,
      ...(space.id === undefined ? {} : { space: space.id }),
      what,
      via,
    });
    this.#options.onLockLost(space.index, what, via);
  }

  /**
   * Closes the writer or reader, then the worker, within one bound. The worker holds the space's
   * writer.lock beside the writer, and gives it up when the writer closes or the worker stops: a
   * worker that does not close in time keeps both until the process exits. Takes what the space
   * holds now, so a second call releases what an open added since. Returns whether everything
   * closed within the bound.
   */
  async #release(space: Hosted, ms: number = this.#closeMs): Promise<boolean> {
    const { writer, reader, worker, projection } = space;
    space.writer = undefined;
    space.reader = undefined;
    space.worker = undefined;
    space.projection = undefined;
    clearInterval(space.daily);
    space.daily = undefined;
    const work = (async () => {
      // The projection first: its batch in progress asks the writer for its bookkeeping, and its
      // reader holds the database open (a restore in place swaps the folder after this).
      await projection?.stop(Math.min(PROJECTION_STOP_MS, ms));
      for (const connection of [writer, reader]) {
        if (connection === undefined) continue;
        try {
          await connection.close();
        } catch (error) {
          const code = codeOf(error);
          this.#options.log.log("space.close_failed", {
            entry: space.index,
            ...(space.id === undefined ? {} : { space: space.id }),
            ...(code === undefined ? {} : { code }),
          });
        }
      }
      // The worker's close ends its thread even when its shutdown call fails.
      if (worker !== undefined) await worker.close().catch(() => undefined);
    })();
    let timedOut = false;
    try {
      await bounded(work, ms);
    } catch (error) {
      if (error instanceof Timeout) timedOut = true;
    }
    if (worker === undefined) return !timedOut;
    // The worker held the lock beside the writer. Once it closed, the lock is gone with it and its
    // file no longer this service's. A worker that did not close may still write under the lock,
    // so its watch stays until it does: a lost writer.lock still ends the service (A2 3.4, review
    // round two). The watch belongs to the worker, so no later close of the space ends it.
    if (!timedOut) {
      this.#unwatch(worker);
      return true;
    }
    space.stuck = true;
    void work.then(() => {
      this.#unwatch(worker);
    });
    return false;
  }

  /**
   * One close per space. It waits for an open in progress up to `ms`; an open still running after
   * that releases what it took when it ends, or the process exit does. Then it releases what the
   * space still holds, within the same bound.
   */
  #close(space: Hosted, ms: number): Promise<void> {
    space.closing ??= (async () => {
      const t0 = performance.now();
      const deadline = t0 + ms;
      const wasServed = space.state === "open" || space.state === "read_only";
      space.stopping = true;
      if (wasServed) space.state = "closing";
      const busy = space.busy;
      const settled = busy === undefined || (await within(busy, ms));
      if (settled) {
        await within(
          space.maintaining ?? Promise.resolve(),
          Math.max(1, deadline - performance.now()),
        );
        await this.#release(space, Math.max(1, Math.round(deadline - performance.now())));
      } else {
        // The open still runs: it releases what it took when it ends, and until then its worker
        // may hold the space, so nothing else may change it (#replace).
        space.stuck = true;
      }
      space.state = "closed";
      if (wasServed) {
        this.#options.log.log("space.closed", {
          entry: space.index,
          ...(space.id === undefined ? {} : { space: space.id }),
          ms: Math.round(performance.now() - t0),
        });
      }
    })();
    return space.closing;
  }

  /** #replace for a change that gives the space a new authority: a claim or a restore in place. */
  async #changed(
    space: Hosted,
    change: (
      worker: StorageWorker,
      settings: SpaceSettings,
    ) => Promise<{ spaceId: Id<"sp">; change: SpaceChange }>,
  ): Promise<SpaceChange> {
    const outcome = await this.#replace(space, change);
    if (outcome === undefined) throw new StorageError("STORAGE_MISUSE", "The change made no claim");
    return outcome;
  }

  /**
   * Closes the space, runs `change` in a worker of its own (a restore in place, a claim or a
   * recovery, each under the space's writer.lock), records a new authority this machine has seen,
   * and opens the space again, also when the change failed.
   */
  async #replace(
    space: Hosted,
    change: (
      worker: StorageWorker,
      settings: SpaceSettings,
    ) => Promise<{ spaceId: Id<"sp">; change?: SpaceChange }>,
  ): Promise<SpaceChange | undefined> {
    if (this.#draining || space.replacing !== undefined) {
      throw new StorageError("STORAGE_MISUSE", "The service is stopping, or the space is changing");
    }
    const replacing = this.#replaceNow(space, change);
    space.replacing = replacing;
    try {
      return await replacing;
    } finally {
      space.replacing = undefined;
    }
  }

  async #replaceNow(
    space: Hosted,
    change: (
      worker: StorageWorker,
      settings: SpaceSettings,
    ) => Promise<{ spaceId: Id<"sp">; change?: SpaceChange }>,
  ): Promise<SpaceChange | undefined> {
    await this.#close(space, this.#closeMs);
    if (space.stuck) {
      // A worker that did not close may still hold the space: nothing else may change it.
      throw new StorageError("SPACE_WRITER_TAKEN", "The space's last worker has not closed");
    }
    // Read again: the service may have begun to drain while the space closed.
    if (this.#isDraining()) throw new StorageError("STORAGE_MISUSE", "The service is stopping");
    const settings =
      space.id === undefined ? this.#settingsOf(space.folder) : this.#settingsFor(space.id);
    let outcome: { spaceId: Id<"sp">; change?: SpaceChange } | undefined;
    try {
      const worker = await this.#startWorkerBounded();
      try {
        outcome = await change(worker, settings);
      } finally {
        // The worker ends its lock with it; a worker that does not close keeps the watch until
        // it does.
        const closingWorker = worker.close().catch(() => undefined);
        if (await within(closingWorker, this.#closeMs)) {
          this.#unwatch(worker);
        } else {
          void closingWorker.then(() => {
            this.#unwatch(worker);
          });
        }
      }
      if (outcome.change !== undefined) {
        try {
          recordSeen(this.#options.settingsDir, outcome.spaceId, outcome.change);
        } catch {
          // The open below records it again when the space opens as this machine's.
        }
      }
      return outcome.change;
    } finally {
      // Read again: the service may have begun to drain meanwhile.
      if (!this.#isDraining()) {
        space.reset();
        await this.#begin(space);
      }
    }
  }

  #settingsFor(spaceId: Id<"sp">): SpaceSettings {
    try {
      return readSpaceSettings(this.#options.settingsDir, spaceId);
    } catch {
      return {};
    }
  }
}
