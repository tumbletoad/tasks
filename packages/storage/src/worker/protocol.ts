// The message protocol between a caller and a storage worker (A1 3.9: the main thread holds no
// SQLite connection and talks to the workers over a MessagePort with structured clone).
//
// The worker first sends one start-up message: `ready` with the driver report once the start-up
// check passed, or `refused` with the error. Then it answers each request with one reply that
// carries the request's ID. Requests run one at a time in arrival order.
//
// Two kinds of handle. `open` gives a plain connection to a database file, which takes SQL: the
// driver contract suite and the readers use it. `openSpace` opens a space folder as a reader with
// openSpace's two-phase checks, and gives a plain read-only connection. `openSpaceWriter` opens it
// as the space's writer, which takes operations through `submit` and refuses every SQL request, so
// no caller can write to a space except through the write path.
//
// A writable connection comes back held (`open` as the writer, and `openSpaceWriter`): SQLite has
// opened the file, the worker has taken the file's identity, and nothing has run on the
// connection. The caller claims that identity for its process and then sends `proceed`, which
// configures the connection (and, for a space, runs phase 2 of openSpace), or `close`. A held
// handle refuses every other request (A1 3.9). For a space's writer, `proceed` also
// migrates a space at an older revision on that connection before the write path attaches, or,
// with the purpose `claim`, claims a read-only copy and closes the connection (M1.06).
// `restoreInPlace` and `recoverSpace` run while the caller holds the space's claim. Every one of
// these takes the space's writer.lock in the worker first (writer-lock.ts), across processes.
import type { BackupRecord } from "../backup/backup.ts";
import type { DriverName, Params, Row, RunResult, TransactionMode } from "../driver.ts";
import type { SerializedStorageError } from "../errors.ts";
import type { Id } from "../ids.ts";
import type { Role } from "../open.ts";
import type { Claim } from "../restore/claim.ts";
import type { RecoveredSpace } from "../restore/recover.ts";
import type { RestoredInPlace } from "../restore/restore.ts";
import type { Revision } from "../schema.ts";
import type { ReadOnlyReason } from "../space.ts";
import type { DriverReport } from "../startup-check.ts";
import type { LaunchRecord } from "../write/launches.ts";
import type { ProjectedBatch } from "../write/outbox.ts";
import type { Receipt, ReceiptLookup } from "../write/receipts.ts";
import type { WriteResult } from "../write/request.ts";
import type { MachineInfo } from "../write/writer.ts";
import type { HolderFacts } from "../writer-lock.ts";

/** workerData of a storage worker. */
export interface WorkerConfig {
  driver: DriverName;
}

export type QueryMode = "run" | "get" | "all";

export interface Query {
  sql: string;
  params?: Params;
  mode: QueryMode;
}

/** What a query returns: the run result, one row or null, or every row. */
export type QueryResult = RunResult | Row | Row[] | null;

/** A space opened in a worker. */
export interface OpenedSpaceInfo {
  handle: number;
  spaceId: Id<"sp">;
  role: Role;
  revision: Revision;
  /** Empty for the writer, which refuses to open otherwise. */
  readOnlyReasons: readonly ReadOnlyReason[];
  manifestRebuilt: boolean;
  /** The migration the writer's open ran before it attached the write path (A1 3.17). */
  migration?: MigrationReport;
  /** A claim's result. The worker closed the connection after the claim. */
  claim?: Claim;
  /** The space's authority (A1 3.1, A6 3.5): only this machine's writer writes. */
  authority: { machineId: Id<"m">; epoch: number; incarnation: Id<"ai"> };
  /**
   * The space's last_seq when it opened. With the revision and the authority, it names the state of
   * the database a failed migration was tried on (A1 3.17).
   */
  lastSeq: number;
}

/** A space's writer.lock as its holder took it: the file and its identity, for a watch. */
export interface LockedFile {
  path: string;
  dev: bigint;
  ino: bigint;
}

/** A migration that a writer's open ran: from one revision to the build's, behind its backup. */
export interface MigrationReport {
  from: Revision;
  to: Revision;
  /** The verified barrier backup. */
  backup: BackupRecord;
  /** The seq of each step's system commit, in order. */
  seqs: number[];
  /** False when space.json could not be rewritten: the next writer's open does it. */
  manifestWritten: boolean;
}

/** What openSpaceWriter does once the space is claimed for the process. */
export type WriterPurpose =
  /** The writer: migrated first when the space's revision is older, then the write path. */
  | { kind: "write"; backupDir?: string }
  /** A claim of a read-only copy (A1 3.18): the claim commit, then the connection closes. */
  | { kind: "claim"; knownEpochs: number[] };

/** An opened connection. A writer's is held until `proceed`. */
export interface OpenedFile {
  handle: number;
  /**
   * A writer's only: the claim key of the file SQLite opened (worker/file-key.ts), taken before
   * anything ran on the connection. Null for a reader, and where the file system has no file
   * numbers.
   */
  file: string | null;
  /** A space's writer: the writer.lock it holds (A2 3.4), taken before SQLite opened the file. */
  lock?: LockedFile;
}

/** Each request kind with its arguments and the value its reply carries. */
export interface Calls {
  /** Opens a database file. A reader is ready at once, a writer is held. */
  open: {
    args: { path: string; role: Role; create?: boolean; busyTimeoutMs?: number };
    result: OpenedFile;
  };
  /** Opens a space folder as a reader with openSpace. */
  openSpace: {
    args: { folder: string; appVersion?: string; busyTimeoutMs?: number };
    result: OpenedSpaceInfo;
  };
  /**
   * Opens a space folder as its writer, held after SQLite's open in phase 2. Without a purpose it
   * is the writer (`write`).
   */
  openSpaceWriter: {
    args: {
      folder: string;
      machine: MachineInfo;
      appVersion?: string;
      busyTimeoutMs?: number;
      purpose?: WriterPurpose;
      /** What writer.json says of the holder besides the machine's name (writer-lock.ts). */
      holder?: HolderFacts;
      /**
       * The space the caller's probe read. Under the lock, phase 1 must read the same, or the open
       * is refused (SPACE_CHANGED) before phase 2, a migration or a claim.
       */
      spaceId?: Id<"sp">;
    };
    result: OpenedFile;
  };
  /**
   * Goes on with a held writer once the caller's claim holds its file: configures the connection,
   * or finishes the space's open and, for a space's writer, migrates it when its revision is older
   * and attaches the write path, or claims a read-only copy and closes. Null for a plain
   * connection. A failure, a failed migration included, closes the connection.
   */
  proceed: { args: { handle: number }; result: OpenedSpaceInfo | null };
  /**
   * Restores a backup in place of a space (restore/restore.ts). The caller holds the space's claim
   * for its process throughout.
   */
  restoreInPlace: {
    args: {
      backupFile: string;
      folder: string;
      machineId: Id<"m">;
      knownEpochs: number[];
      appVersion?: string;
      busyTimeoutMs?: number;
      holder?: HolderFacts;
    };
    result: RestoredInPlace;
  };
  /**
   * Recovers a space with a rollback journal (restore/recover.ts). The caller holds the space's
   * claim for its process throughout.
   */
  recoverSpace: {
    args: { folder: string; appVersion?: string; busyTimeoutMs?: number; holder?: HolderFacts };
    result: RecoveredSpace;
  };
  /** Writes this machine's record on the space's first open on it. Whether it wrote one. */
  registerMachine: { args: { handle: number }; result: boolean };
  /** The actor a connection writes as, added on its first act (`SpaceWriter.actor`). */
  actor: {
    args: { handle: number; actorKind: "human" | "agent"; label: string };
    result: Id<"ac">;
  };
  /** One write request to a space's writer (A1 3.7). */
  submit: { args: { handle: number; request: unknown }; result: WriteResult };
  /** A request's receipt in a writer scope (A1 3.8, A3 3.2.3's `receipt.get`), or null. */
  receipt: { args: { handle: number; lookup: ReceiptLookup }; result: Receipt | null };
  /** A launch record (A4 3.16.1), or null. (`id` names the request itself.) */
  launch: { args: { handle: number; launch: string }; result: LaunchRecord | null };
  /** A machine's launches that are not final: the execution store's `openWork`. */
  openLaunches: { args: { handle: number; machine: string }; result: LaunchRecord[] };
  /** The projection rendered a batch (A1 3.13): its outbox rows, and the watermark back. */
  projected: { args: { handle: number; batch: ProjectedBatch }; result: number };
  /** Every task queued for the projection: a full rebuild. The tasks queued. */
  queueProjection: { args: { handle: number }; result: number };
  exec: { args: { handle: number; sql: string }; result: null };
  query: { args: { handle: number; query: Query }; result: QueryResult };
  /** The queries in one transaction: all apply, or none. */
  transaction: {
    args: { handle: number; mode: TransactionMode; queries: Query[] };
    result: QueryResult[];
  };
  pragma: { args: { handle: number; name: string; value?: string | number }; result: unknown };
  backup: {
    args: { handle: number; destPath: string; pagesPerStep: number };
    /** Pages copied. */
    result: number;
  };
  close: { args: { handle: number }; result: null };
  /** Closes every connection. The caller then terminates the worker. */
  shutdown: { args: object; result: null };
}

export type Kind = keyof Calls;

export type Request = { [K in Kind]: { id: number; kind: K } & Calls[K]["args"] }[Kind];

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedStorageError };

export type StartupMessage =
  { kind: "ready"; report: DriverReport } | { kind: "refused"; error: SerializedStorageError };
