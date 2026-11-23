// The caller's side of the storage protocol. The main thread holds no SQLite connection (A1 3.9):
// it starts storage workers and reaches their connections through handles.
//
// One writer per space. The rule: a writable connection is configured and used only once its
// claim set is complete, and the claim set always holds the identity of the file SQLite opened.
// Every writer this process opens through a StorageWorker (a space's writer, a plain writer
// connection, or a backup's destination) claims, before the worker opens anything for writing, its
// database file by its real path and, when the file exists, by its identity on its volume (device
// and file number), which every name of the file shares, hard links included. Both come from the
// one literal path SQLite will open (sqlite-uri.ts), which this thread computes and sends to the
// worker, so the claim and SQLite name the same file whatever the caller's spelling. A space's
// writer also claims its space ID, read through a read-only open. Then the worker opens the file,
// takes the identity of the file SQLite opened and holds the connection, on which nothing has run.
// The claim adds that identity when it lacks it (the file did not exist, or was replaced), and only
// then does the worker configure the connection. A backup's destination is a new file: this thread
// creates it and claims its identity before the backup writes it. Any claim that another writer
// holds is refused with SPACE_WRITER_TAKEN, and a held connection is closed unused. A claim ends
// when its handle closes or its worker stops.
//
// Across processes, A2's writer.lock does the same (writer-lock.ts): the worker takes it before it
// opens a space for writing and holds it for the writer's life, so another process's writer,
// claim, restore or recovery of the space is refused with SPACE_LOCKED_ELSEWHERE, which this side
// gives the holder from writer.json. A database file with a second name is refused for writing
// (SPACE_DATABASE_LINKED) before anything opens it. Code that opens a space without a
// StorageWorker (tests, the sample generator: A1 3.9) takes neither.
//
// Everything that writes a live space or moves its folder runs under that claim (M1.06): the
// migration of an older space, which openSpaceWriter runs on the writer's own connection before
// the write path attaches; the claim of a read-only copy (claimSpace); and restore in place and
// recovery, which claim the space's database file for their whole length, so a writer of this
// process that has the space open refuses them, and none opens while they run.
import { open as openFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  checkBackupOptions,
  MEMORY,
  type DriverName,
  type Params,
  type Row,
  type RunResult,
  type TransactionMode,
} from "../driver.ts";
import { misuse, StorageError, UnexpectedSpace } from "../errors.ts";
import { FILE_MODE } from "../files.ts";
import type { Id } from "../ids.ts";
import { DATABASE_FILE } from "../manifest.ts";
import type { Role } from "../open.ts";
import type { Claim as RestoreClaim } from "../restore/claim.ts";
import type { RecoveredSpace } from "../restore/recover.ts";
import type { RestoredInPlace } from "../restore/restore.ts";
import type { Revision } from "../schema.ts";
import { checkSpacePath } from "../space-path.ts";
import type { ReadOnlyReason } from "../space.ts";
import { destinationExists, destinationNotCreated, literalPath } from "../sqlite-uri.ts";
import type { DriverReport } from "../startup-check.ts";
import type { LaunchRecord } from "../write/launches.ts";
import type { ProjectedBatch } from "../write/outbox.ts";
import type { RunRow } from "../write/runs.ts";
import type { Receipt, ReceiptLookup } from "../write/receipts.ts";
import type { WriteResult } from "../write/request.ts";
import type { MachineInfo } from "../write/writer.ts";
import {
  readWriterHolder,
  refuseLinkedDatabase,
  SpaceLockedElsewhere,
  type HolderFacts,
} from "../writer-lock.ts";
import { fileKey } from "./file-key.ts";
import type {
  Calls,
  Kind,
  LockedFile,
  OpenedFile,
  OpenedSpaceInfo,
  Query,
  QueryResult,
  MigrationReport,
  Reply,
  StartupMessage,
  WorkerConfig,
  WriterPurpose,
} from "./protocol.ts";

const DEFAULT_ENTRY = new URL("./entry.ts", import.meta.url);

/** A1 3.9: a request to a space's writer gets an answer within 10 s, or STORAGE_TIMEOUT. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** How long a repair of the search index may take before its caller stops waiting. */
const REPAIR_TIMEOUT_MS = 300_000;

/** A1 3.9: at most 1,000 requests wait for a space's writer, or STORAGE_OVERLOADED. */
export const WRITER_QUEUE_LIMIT = 1_000;

export interface StartOptions {
  driver: DriverName;
  /** The worker's entry module. A test or a bundle passes its own. */
  entry?: URL;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: StorageError) => void;
}

// A worker's own error is not kept as a cause: it can quote anything the worker held.
const workerFailed = (message: string): StorageError =>
  new StorageError("STORAGE_WORKER_FAILED", message);

// ---------------------------------------------------------------------------------------------
// One writer per space in this process

/** What one writer holds: its database file's keys, and its space ID once known. */
class Claim {
  readonly keys = new Set<string>();
}

const claimed = new Map<string, Claim>();

const taken = (): StorageError =>
  new StorageError("SPACE_WRITER_TAKEN", "This space already has a writer in this process");

/** Claims every key, or none when one is taken. */
function claimKeys(claim: Claim, keys: readonly string[]): void {
  if (keys.some((key) => claimed.has(key))) throw taken();
  for (const key of keys) {
    claimed.set(key, claim);
    claim.keys.add(key);
  }
}

function release(claim: Claim): void {
  for (const key of claim.keys) if (claimed.get(key) === claim) claimed.delete(key);
  claim.keys.clear();
}

/**
 * The keys of a database file before it opens, from `literal`, the literal path SQLite will open
 * (sqlite-uri.ts): its real path (symbolic links, junctions and short names resolved, in lower case
 * where the file system usually ignores case) and, when the file exists, its identity on its
 * volume (file-key.ts). A file that does not exist yet takes its folder's real path, and its
 * identity is claimed once SQLite has opened it. MEMORY names no file and has no keys.
 */
async function databaseKeys(literal: string): Promise<string[]> {
  if (literal === MEMORY) return [];
  let real: string;
  try {
    real = await realpath(literal);
  } catch {
    try {
      real = join(await realpath(dirname(literal)), basename(literal));
    } catch {
      real = literal;
    }
  }
  const folded =
    process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
  const keys = [`path:${folded}`];
  try {
    const file = fileKey(await stat(real, { bigint: true }));
    if (file !== null) keys.push(file);
  } catch {
    // Not there yet: the writer creates it.
  }
  return keys;
}

/**
 * Creates a backup's destination at `literal`, exclusively and owner-only, and returns the claim
 * key of the file it created, read from the open file itself. A destination that exists is
 * refused: a backup writes only a new file (A1 3.18), so the file has no other name.
 */
async function createBackupFile(literal: string): Promise<string | null> {
  let file: FileHandle;
  try {
    file = await openFile(literal, "wx", 0o600);
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST"
      ? destinationExists()
      : destinationNotCreated();
  }
  try {
    // Exactly owner-only, whatever the umask (files.ts).
    if (process.platform !== "win32") await file.chmod(FILE_MODE);
    return fileKey(await file.stat({ bigint: true }));
  } catch {
    throw destinationNotCreated();
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * `work`, with a refusal because another process holds the space's writer.lock given the holder
 * that the folder's writer.json names (A2 3.4).
 */
async function namingHolder<T>(dir: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof StorageError &&
      error.code === "SPACE_LOCKED_ELSEWHERE" &&
      !(error instanceof SpaceLockedElsewhere)
    ) {
      throw new SpaceLockedElsewhere(error.message, readWriterHolder(dir));
    }
    throw error;
  }
}

/** `answer`, or STORAGE_TIMEOUT when it takes longer than `ms`. The answer may still come. */
function deadline<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StorageError("STORAGE_TIMEOUT", "The storage worker did not answer in time"));
    }, ms);
  });
  return Promise.race([answer, late]).finally(() => {
    clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------------------------

/** Waits for the worker's start-up message. */
function startup(worker: Worker): Promise<DriverReport> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: StartupMessage): void => {
      done();
      if (message.kind === "ready") resolve(message.report);
      else reject(StorageError.fromJSON(message.error));
    };
    const onError = (): void => {
      done();
      reject(workerFailed("The storage worker failed while starting"));
    };
    const onExit = (code: number): void => {
      done();
      reject(workerFailed(`The storage worker exited with code ${String(code)} while starting`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

export interface SpaceWriterOptions {
  /** This machine (A6 3.4): it must be the space's authority to write. */
  machine: MachineInfo;
  appVersion?: string;
  busyTimeoutMs?: number;
  /** Per request. Default: REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Requests that may wait at once. Default: WRITER_QUEUE_LIMIT. */
  queueLimit?: number;
  /** Where a migration's barrier backup goes (machine-local `backup.dir`). Default: `backups/`. */
  backupDir?: string;
  /** What writer.json says of the holder besides this machine's name (A2 3.4). */
  holder?: HolderFacts;
  /**
   * Called once the worker holds the space's writer.lock, before the open goes on (a migration can
   * take a while), with the file and its identity: the service watches it (A2 3.4).
   */
  onLock?: (lock: LockedFile) => void;
  /**
   * Called when the space is at an older revision and this machine will migrate it now, before the
   * migration starts: a migration of a large space can take long, and its caller may wait for it.
   */
  onMigrating?: (from: Revision) => void;
  /**
   * The space this writer is for (A2 3.2.4: a `[[spaces]]` entry's ID). A folder that holds
   * another space is refused with UnexpectedSpace after a read-only open, before anything is
   * claimed, locked or written.
   */
  spaceId?: Id<"sp">;
}

export interface ClaimCopyOptions {
  /** This machine: the claimed copy's new authority. */
  machine: MachineInfo;
  /** Epochs this machine knows for the space besides the copy's (`spaces_seen`, M1.08). */
  knownEpochs?: readonly number[];
  /** The lowest next task reference the claimed copy may give (restore/claim.ts). */
  refFloor?: number;
  appVersion?: string;
  busyTimeoutMs?: number;
  holder?: HolderFacts;
  /** Called once the worker holds the copy's writer.lock, before the claim runs (A2 3.4). */
  onLock?: (lock: LockedFile) => void;
}

export interface InPlaceRestoreOptions {
  /** This machine's ID: the restored copy's new authority. */
  machineId: Id<"m">;
  /** The space the folder is registered as: a backup of another space is refused. */
  spaceId?: Id<"sp">;
  /** Epochs this machine knows for the space besides the backup's and the live space's. */
  knownEpochs?: readonly number[];
  /** A next task reference other copies of the space reached (restore/restore.ts). */
  refFloor?: number;
  appVersion?: string;
  busyTimeoutMs?: number;
  holder?: HolderFacts;
}

/** One storage worker thread and the connections it holds. */
export class StorageWorker {
  /** The driver and SQLite build the worker checked at start-up. */
  readonly report: DriverReport;
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #claims = new Set<Claim>();
  #nextId = 1;
  #failure: StorageError | undefined;
  #closing: Promise<void> | undefined;

  private constructor(worker: Worker, report: DriverReport) {
    this.#worker = worker;
    this.report = report;
    worker.on("message", (reply: Reply) => {
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(StorageError.fromJSON(reply.error));
    });
    worker.on("error", () => {
      this.#fail(workerFailed("The storage worker failed"));
    });
    worker.on("exit", (code: number) => {
      this.#fail(workerFailed(`The storage worker exited with code ${String(code)}`));
    });
  }

  /**
   * Starts a worker. It loads the driver and runs the start-up check (A1 3.19) before it serves
   * anything, so a build that fails the check rejects here with STORAGE_UNSUPPORTED.
   */
  static async start(options: StartOptions): Promise<StorageWorker> {
    const config: WorkerConfig = { driver: options.driver };
    const worker = new Worker(options.entry ?? DEFAULT_ENTRY, { workerData: config });
    let report: DriverReport;
    try {
      report = await startup(worker);
    } catch (error) {
      await worker.terminate();
      throw error;
    }
    return new StorageWorker(worker, report);
  }

  #fail(error: StorageError): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    // A stopped worker holds no connection, so its writers' claims end.
    for (const claim of this.#claims) release(claim);
    this.#claims.clear();
  }

  /**
   * Sends one request and resolves with its reply, or rejects when the worker refuses it, fails
   * or stops.
   */
  call<K extends Kind>(kind: K, args: Calls[K]["args"]): Promise<Calls[K]["result"]> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ ...args, id, kind });
      } catch {
        // A DataCloneError quotes the value it could not clone, so it is not kept.
        this.#pending.delete(id);
        reject(new StorageError("STORAGE_MISUSE", "The request cannot be sent to the worker"));
      }
    });
  }

  #claim(): Claim {
    if (this.#failure !== undefined) throw this.#failure;
    const claim = new Claim();
    this.#claims.add(claim);
    return claim;
  }

  #release(claim: Claim): void {
    release(claim);
    this.#claims.delete(claim);
  }

  /**
   * Completes a claim with the file SQLite opened for a held connection: its identity joins the
   * claim when the claim lacks it. When another writer holds it, the held connection is closed
   * unused and the claim is refused. The caller releases the claim on any failure.
   */
  async #complete(claim: Claim, held: OpenedFile): Promise<void> {
    if (held.file === null || claim.keys.has(held.file)) return;
    try {
      claimKeys(claim, [held.file]);
    } catch (error) {
      await this.call("close", { handle: held.handle }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Opens a database file in this worker as the writer or as a reader. This is the driver's
   * level: a space opens with openSpaceWriter or openSpaceReader. `path` is a path, never a URI,
   * and the worker opens its literal path (sqlite-uri.ts). A writer claims that file, so no
   * second writer of this process opens it while this one is open: by its path and identity
   * before the open, and by the identity of the file SQLite opened before anything runs on it.
   */
  async open(
    path: string,
    role: Role,
    options: { create?: boolean; busyTimeoutMs?: number } = {},
  ): Promise<WorkerConnection> {
    const literal = literalPath(path);
    if (role !== "writer") {
      const { handle } = await this.call("open", { path: literal, role, ...options });
      return new WorkerConnection(this, handle);
    }
    const keys = await databaseKeys(literal);
    const claim = this.#claim();
    try {
      claimKeys(claim, keys);
      const held = await this.call("open", { path: literal, role, ...options });
      await this.#complete(claim, held);
      await this.call("proceed", { handle: held.handle });
      return new WorkerConnection(this, held.handle, () => {
        this.#release(claim);
      });
    } catch (error) {
      this.#release(claim);
      throw error;
    }
  }

  /**
   * Claims a space folder for this process before anything opens it for writing: its database
   * file (by real path and identity), then, when `probe` is set, its space ID, which a read-only
   * open of the space reads. The caller releases the claim on failure and when it is done.
   */
  async #claimSpace(
    dir: string,
    probe: { appVersion?: string; busyTimeoutMs?: number } | undefined,
  ): Promise<{ claim: Claim; info: OpenedSpaceInfo | undefined }> {
    // A writer of the database, before anything opens it, the probe included: writer.lock guards
    // a folder, so a database file with a second name is never opened for writing.
    if (probe !== undefined) refuseLinkedDatabase(dir);
    const keys = await databaseKeys(literalPath(join(dir, DATABASE_FILE)));
    const claim = this.#claim();
    try {
      claimKeys(claim, keys);
      if (probe === undefined) return { claim, info: undefined };
      // A copy of a space in another folder has the same space ID: it is refused before its
      // writer could open it, rebuild its space.json or write to it.
      const info = await this.call("openSpace", { folder: dir, ...probe });
      await this.call("close", { handle: info.handle });
      claimKeys(claim, [`space:${info.spaceId}`]);
      return { claim, info };
    } catch (error) {
      this.#release(claim);
      throw error;
    }
  }

  /**
   * Opens the claimed space's writer in the worker for `purpose` and goes on once the claim holds
   * the file SQLite opened. Returns what `proceed` reported, checked against the probe.
   */
  async #openClaimed(
    claim: Claim,
    dir: string,
    probe: OpenedSpaceInfo,
    machine: MachineInfo,
    settings: { appVersion?: string; busyTimeoutMs?: number },
    purpose: WriterPurpose,
    holder: { facts?: HolderFacts; onLock?: (lock: LockedFile) => void },
  ): Promise<{ info: OpenedSpaceInfo; lock: LockedFile | undefined }> {
    const held = await namingHolder(
      dir,
      this.call("openSpaceWriter", {
        folder: dir,
        machine,
        ...settings,
        purpose,
        ...(holder.facts === undefined ? {} : { holder: holder.facts }),
        // Under the lock, the space must still be the one the probe read.
        spaceId: probe.spaceId,
      }),
    );
    if (held.lock !== undefined) {
      try {
        holder.onLock?.(held.lock);
      } catch (error) {
        await this.call("close", { handle: held.handle }).catch(() => undefined);
        throw error;
      }
    }
    await this.#complete(claim, held);
    const info = await this.call("proceed", { handle: held.handle });
    if (info === null || info.spaceId !== probe.spaceId) {
      if (purpose.kind === "write") {
        await this.call("close", { handle: held.handle }).catch(() => undefined);
      }
      throw new StorageError("SPACE_CHANGED", "The space changed while it was opening");
    }
    return { info, lock: held.lock };
  }

  /**
   * Opens a space folder as its writer, with openSpace's checks, inside this worker (A1
   * 3.1): the one call that opens a space for writing. The writer takes operations only. Before
   * anything opens the space for writing, it claims the space for this process: its database
   * file, then its space ID, which a read-only open reads first. Once SQLite has opened the
   * database, the claim takes the identity of the file it opened, and only then does phase 2 of
   * openSpace run on the connection. When the space's revision is older than this build's, the
   * worker then migrates it on that connection, behind a verified barrier backup, before the
   * write path attaches (A1 3.17), so no migration runs beside a writer. Then it registers this
   * machine on the space's first open on it (A1 3.6). A failed migration rejects with its error
   * (BACKUP_FAILED, BUNDLE_LIMIT_EXCEEDED, MIGRATION_FAILED or SPACE_CHANGED) and leaves the space
   * at its revision: openSpaceReader then opens it read-only with the reason `older_revision`. A
   * read-only copy is refused with SPACE_READ_ONLY_COPY until claimSpace claims it.
   *
   * Across processes, the worker takes the space's writer.lock before it opens anything for
   * writing and holds it until the writer closes or the worker stops (A2 3.4): a lock another
   * process holds refuses with SpaceLockedElsewhere, which names the holder from writer.json. A
   * database file with a second name is refused with SPACE_DATABASE_LINKED.
   */
  async openSpaceWriter(folder: string, options: SpaceWriterOptions): Promise<SpaceWriterHandle> {
    const { machine, appVersion, busyTimeoutMs, backupDir } = options;
    // The folder as openSpace checks and resolves it, which the worker gets, and the literal path
    // of its database, which SQLite opens and the claim is computed from.
    const dir = checkSpacePath(folder);
    const settings = {
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    };
    const expected = options.spaceId;
    if (expected !== undefined) {
      // The space it is for, read before anything is claimed: another writer of this process may
      // hold the folder's database (another entry that names it), and the answer is the same.
      refuseLinkedDatabase(dir);
      const found = await this.call("openSpace", { folder: dir, ...settings });
      await this.call("close", { handle: found.handle });
      if (found.spaceId !== expected) throw new UnexpectedSpace();
    }
    const { claim, info: probe } = await this.#claimSpace(dir, settings);
    try {
      if (probe === undefined) throw misuse("A writer's claim reads the space ID");
      // Read again by the claim's probe: another space may have been put in its place meanwhile.
      if (expected !== undefined && probe.spaceId !== expected) throw new UnexpectedSpace();
      const purpose: WriterPurpose =
        backupDir === undefined ? { kind: "write" } : { kind: "write", backupDir };
      if (
        probe.readOnlyReasons.includes("older_revision") &&
        probe.authority.machineId === machine.id
      ) {
        options.onMigrating?.(probe.revision);
      }
      const { info, lock } = await this.#openClaimed(
        claim,
        dir,
        probe,
        machine,
        settings,
        purpose,
        {
          ...(options.holder === undefined ? {} : { facts: options.holder }),
          ...(options.onLock === undefined ? {} : { onLock: options.onLock }),
        },
      );
      try {
        const registered = await this.call("registerMachine", { handle: info.handle });
        return new SpaceWriterHandle(this, info, registered, options, lock, () => {
          this.#release(claim);
        });
      } catch (error) {
        await this.call("close", { handle: info.handle }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.#release(claim);
      throw error;
    }
  }

  /**
   * Claims a read-only copy, a backup restored into a new folder (A1 3.18, A6 3.5): a new epoch
   * above every one this machine knows and a new incarnation, in one commit that also ends the
   * copy state. It runs on the space's writer, under the space's claim for this process, and
   * closes it again. A space that is no read-only copy is refused (STORAGE_MISUSE). Its next
   * openSpaceWriter migrates it when its revision is older.
   */
  async claimSpace(folder: string, options: ClaimCopyOptions): Promise<RestoreClaim> {
    const { machine, appVersion, busyTimeoutMs } = options;
    const dir = checkSpacePath(folder);
    const settings = {
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    };
    const { claim, info: probe } = await this.#claimSpace(dir, settings);
    try {
      if (probe === undefined) throw misuse("A claim reads the space ID");
      if (!probe.readOnlyReasons.includes("read_only_copy")) {
        throw misuse("Only a read-only copy is claimed");
      }
      const { info } = await this.#openClaimed(
        claim,
        dir,
        probe,
        machine,
        settings,
        {
          kind: "claim",
          knownEpochs: [...(options.knownEpochs ?? [])],
          ...(options.refFloor === undefined ? {} : { refFloor: options.refFloor }),
        },
        {
          ...(options.holder === undefined ? {} : { facts: options.holder }),
          ...(options.onLock === undefined ? {} : { onLock: options.onLock }),
        },
      );
      if (info.claim === undefined) throw misuse("The worker did not report the claim");
      return info.claim;
    } finally {
      this.#release(claim);
    }
  }

  /**
   * Restores `backupFile` in place of the space at `folder` and claims it (restore/restore.ts),
   * in this worker, while this process holds the space's claim: a writer of this process that has
   * the space open refuses it with SPACE_WRITER_TAKEN, and none opens until it is done. The space's
   * database file is claimed by its path and identity, so a live space that no longer opens is
   * covered too.
   */
  async restoreInPlace(
    backupFile: string,
    folder: string,
    options: InPlaceRestoreOptions,
  ): Promise<RestoredInPlace> {
    const dir = checkSpacePath(folder);
    const { claim } = await this.#claimSpace(dir, undefined);
    try {
      return await namingHolder(
        dir,
        this.call("restoreInPlace", {
          backupFile,
          folder: dir,
          machineId: options.machineId,
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
          knownEpochs: [...(options.knownEpochs ?? [])],
          ...(options.refFloor === undefined ? {} : { refFloor: options.refFloor }),
          ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
          ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
          ...(options.holder === undefined ? {} : { holder: options.holder }),
        }),
      );
    } finally {
      this.#release(claim);
    }
  }

  /**
   * Recovers the space at `folder` from the rollback journal beside its database
   * (restore/recover.ts), in this worker, while this process holds the space's claim, as
   * restoreInPlace does.
   */
  async recoverSpace(
    folder: string,
    options: { appVersion?: string; busyTimeoutMs?: number; holder?: HolderFacts } = {},
  ): Promise<RecoveredSpace> {
    const dir = checkSpacePath(folder);
    const { claim } = await this.#claimSpace(dir, undefined);
    try {
      return await namingHolder(
        dir,
        this.call("recoverSpace", {
          folder: dir,
          ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
          ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
          ...(options.holder === undefined ? {} : { holder: options.holder }),
        }),
      );
    } finally {
      this.#release(claim);
    }
  }

  /** Opens a space folder as a reader, with openSpace's checks. The connection takes SQL. */
  async openSpaceReader(
    folder: string,
    options: { appVersion?: string; busyTimeoutMs?: number } = {},
  ): Promise<{ conn: WorkerConnection; info: OpenedSpaceInfo }> {
    const info = await this.call("openSpace", { folder, ...options });
    return { conn: new WorkerConnection(this, info.handle), info };
  }

  /**
   * Closes every connection the worker holds, then stops it. Calls made while it closes, or
   * after, share the first call's outcome.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#failure !== undefined) return;
    try {
      await this.call("shutdown", {});
    } finally {
      this.#fail(workerFailed("The storage worker is closed"));
      await this.#worker.terminate();
    }
  }
}

/** A connection held by a storage worker. */
export class WorkerConnection {
  readonly #worker: StorageWorker;
  readonly #onClose: (() => void) | undefined;
  readonly handle: number;

  constructor(worker: StorageWorker, handle: number, onClose?: () => void) {
    this.#worker = worker;
    this.handle = handle;
    this.#onClose = onClose;
  }

  async exec(sql: string): Promise<void> {
    await this.#worker.call("exec", { handle: this.handle, sql });
  }

  async run(sql: string, params?: Params): Promise<RunResult> {
    return (await this.#query({ sql, mode: "run", ...(params && { params }) })) as RunResult;
  }

  async get<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    const row = await this.#query({ sql, mode: "get", ...(params && { params }) });
    return row === null ? undefined : (row as T);
  }

  async all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    return (await this.#query({ sql, mode: "all", ...(params && { params }) })) as T[];
  }

  pragma(name: string, value?: string | number): Promise<unknown> {
    return this.#worker.call("pragma", {
      handle: this.handle,
      name,
      ...(value === undefined ? {} : { value }),
    });
  }

  /** Runs the queries in one transaction: all apply, or none, and the call rejects. */
  transaction(mode: TransactionMode, queries: Query[]): Promise<QueryResult[]> {
    return this.#worker.call("transaction", { handle: this.handle, mode, queries });
  }

  /**
   * Copies the database into `destPath`, a new file: A1 3.18 backs up into a temporary file. The
   * backup writes the destination, so this process claims it as a writer for the backup's length,
   * from its literal path (sqlite-uri.ts), the path SQLite writes: by its real path and, when it
   * exists, its identity, which refuses a file another writer holds with SPACE_WRITER_TAKEN. Then
   * this thread creates the file exclusively, which refuses any other existing file, and claims
   * the identity of the file it created, before the backup writes it (A1
   * 3.18). A failed backup leaves its destination as it is.
   */
  async backup(destPath: string, pagesPerStep: number): Promise<number> {
    checkBackupOptions({ pagesPerStep });
    const literal = literalPath(destPath);
    const claim = new Claim();
    try {
      claimKeys(claim, await databaseKeys(literal));
      if (literal !== MEMORY) {
        const file = await createBackupFile(literal);
        if (file !== null) claimKeys(claim, [file]);
      }
      return await this.#worker.call("backup", {
        handle: this.handle,
        destPath: literal,
        pagesPerStep,
      });
    } finally {
      release(claim);
    }
  }

  async close(): Promise<void> {
    try {
      await this.#worker.call("close", { handle: this.handle });
    } finally {
      this.#onClose?.();
    }
  }

  #query(query: Query): Promise<QueryResult> {
    return this.#worker.call("query", { handle: this.handle, query });
  }
}

/** A space's writer in a storage worker (A1 3.9): requests in, results out, no SQL. */
export class SpaceWriterHandle {
  readonly #worker: StorageWorker;
  readonly #onClose: () => void;
  readonly #timeoutMs: number;
  readonly #queueLimit: number;
  readonly handle: number;
  readonly spaceId: Id<"sp">;
  readonly revision: Revision;
  readonly manifestRebuilt: boolean;
  readonly readOnlyReasons: readonly ReadOnlyReason[];
  /** Whether this open wrote the machine's record. */
  readonly machineRegistered: boolean;
  /** The migration this open ran before the write path attached, if the space needed one. */
  readonly migration: MigrationReport | undefined;
  /** The open found the search index damaged and made it again, or could not. */
  readonly searchIndex: OpenedSpaceInfo["searchIndex"];
  /**
   * The space's authority. A writer on another machine refuses every request (SPACE_READ_ONLY,
   * `not_authority`), so an opener can report the space as read-only.
   */
  readonly authority: OpenedSpaceInfo["authority"];
  /** The space's writer.lock this writer holds (A2 3.4), for a watch of its identity. */
  readonly lock: LockedFile | undefined;
  #waiting = 0;

  constructor(
    worker: StorageWorker,
    info: OpenedSpaceInfo,
    machineRegistered: boolean,
    options: SpaceWriterOptions,
    lock: LockedFile | undefined,
    onClose: () => void,
  ) {
    this.#worker = worker;
    this.#onClose = onClose;
    this.handle = info.handle;
    this.spaceId = info.spaceId;
    this.revision = info.revision;
    this.manifestRebuilt = info.manifestRebuilt;
    this.readOnlyReasons = info.readOnlyReasons;
    this.machineRegistered = machineRegistered;
    this.migration = info.migration;
    this.searchIndex = info.searchIndex;
    this.authority = info.authority;
    this.lock = lock;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#queueLimit = options.queueLimit ?? WRITER_QUEUE_LIMIT;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw misuse("timeoutMs is a whole number of milliseconds above 0");
    }
    if (!Number.isSafeInteger(this.#queueLimit) || this.#queueLimit < 1) {
      throw misuse("queueLimit is a whole number above 0");
    }
  }

  /**
   * Sends one write request (A1 3.7). Every decided outcome is a result. A full queue rejects
   * with STORAGE_OVERLOADED and a late answer with STORAGE_TIMEOUT: both may be retried with the
   * same request ID.
   */
  submit(request: unknown, options: { timeoutMs?: number } = {}): Promise<WriteResult> {
    return this.#queued(
      () => this.#worker.call("submit", { handle: this.handle, request }),
      options.timeoutMs,
    );
  }

  /**
   * A request's receipt in a writer scope: what `receipt.get` returns (A1 3.8, A3 3.2.3).
   * Undefined when the scope holds none. It waits in the writer's queue behind the requests sent
   * before it, so it sees their receipts.
   */
  async receipt(lookup: ReceiptLookup): Promise<Receipt | undefined> {
    const found = await this.#queued(() =>
      this.#worker.call("receipt", { handle: this.handle, lookup }),
    );
    return found ?? undefined;
  }

  /**
   * The actor a connection writes as (A3 3.7.4): the space's human, or the agent actor with this
   * label, which the writer adds on its first act (`actor.register`). Waits in the writer's queue.
   */
  actor(kind: "human" | "agent", label: string): Promise<Id<"ac">> {
    return this.#queued(() =>
      this.#worker.call("actor", { handle: this.handle, actorKind: kind, label }),
    );
  }

  /**
   * A launch record as it is now (A4 3.16.1), or undefined. Like `receipt`, it waits in the
   * writer's queue, so it sees every request sent before it.
   */
  async launch(id: string): Promise<LaunchRecord | undefined> {
    const found = await this.#queued(() =>
      this.#worker.call("launch", { handle: this.handle, launch: id }),
    );
    return found ?? undefined;
  }

  /** Every launch of `machine` that is not final, oldest first: `openWork` (A4 3.16.1). */
  openLaunches(machine: string): Promise<LaunchRecord[]> {
    return this.#queued(() => this.#worker.call("openLaunches", { handle: this.handle, machine }));
  }

  /**
   * The projection rendered a batch (A1 3.13 step 5): marks its outbox rows and returns the
   * watermark (write/outbox.ts). Waits in the writer's queue like a request.
   */
  projected(batch: ProjectedBatch): Promise<number> {
    return this.#queued(() => this.#worker.call("projected", { handle: this.handle, batch }));
  }

  /**
   * Queues tasks for the projection: every task, a full rebuild, or only `keys` (at most
   * PROJECTION_QUEUE_KEYS), the tasks a reconciliation found missing or different. Returns the
   * tasks queued.
   */
  queueProjection(keys?: readonly string[]): Promise<number> {
    return this.#queued(() =>
      this.#worker.call("queueProjection", {
        handle: this.handle,
        ...(keys === undefined ? {} : { keys: [...keys] }),
      }),
    );
  }

  /**
   * Checks the search index and makes it again when it is damaged. Waits in the writer's queue; a
   * remake of a large space takes longer than a request, so it has a bound of its own.
   */
  repairSearchIndex(): Promise<"sound" | "remade" | "damaged"> {
    return this.#queued(
      () => this.#worker.call("repairSearchIndex", { handle: this.handle }),
      REPAIR_TIMEOUT_MS,
    );
  }

  /** A run record as it is now (A4 3.16.1), or undefined, behind every request sent before. */
  async run(id: string): Promise<RunRow | undefined> {
    const found = await this.#queued(() =>
      this.#worker.call("run", { handle: this.handle, run: id }),
    );
    return found ?? undefined;
  }

  /** Every run of `machine` that is not final, oldest first: `openWork` (A4 3.11.9, 3.16.1). */
  openRuns(machine: string): Promise<RunRow[]> {
    return this.#queued(() => this.#worker.call("openRuns", { handle: this.handle, machine }));
  }

  /** One call to the writer, within the queue limit and the time limit (A1 3.9). */
  #queued<T>(send: () => Promise<T>, timeoutMs = this.#timeoutMs): Promise<T> {
    if (this.#waiting >= this.#queueLimit) {
      return Promise.reject(
        new StorageError("STORAGE_OVERLOADED", "The space's writer has too many requests waiting"),
      );
    }
    // A request keeps its place until the worker answers it or stops, not until the caller stops
    // waiting: a request that timed out still waits in the worker, which may still decide it.
    this.#waiting += 1;
    const answer = send();
    const free = (): void => {
      this.#waiting -= 1;
    };
    answer.then(free, free);
    return deadline(answer, timeoutMs);
  }

  async close(): Promise<void> {
    try {
      await this.#worker.call("close", { handle: this.handle });
    } finally {
      this.#onClose();
    }
  }
}

export interface SpaceConnections {
  writer: WorkerConnection;
  readers: WorkerConnection[];
}

/**
 * Opens a space on its writer worker and on the reader workers. The writer opens and configures
 * first (busy timeout, then WAL), and only then do the readers open, together. The M0 storage
 * bench saw "database is locked" when they all opened at once. On any failure every connection
 * opened so far is closed again.
 */
export async function openSpaceConnections(
  path: string,
  workers: { writer: StorageWorker; readers: readonly StorageWorker[] },
  options: { create?: boolean } = {},
): Promise<SpaceConnections> {
  if (workers.readers.includes(workers.writer)) {
    throw misuse("The writer and the readers must be different workers");
  }
  const writer = await workers.writer.open(path, "writer", options);
  const opened = await Promise.allSettled(workers.readers.map((w) => w.open(path, "reader")));
  const readers = opened.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = opened.find((r) => r.status === "rejected");
  if (failed === undefined) return { writer, readers };
  await Promise.allSettled([writer, ...readers].map((c) => c.close()));
  throw failed.reason;
}
