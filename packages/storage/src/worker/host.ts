// The worker side of the storage protocol. It runs the start-up check, then serves requests one
// at a time against the connections and space writers it holds. A worker may hold connections to
// several spaces, as A1 3.9's shared readers do.
//
// A writable connection is held after SQLite's open: the worker takes the identity of the file
// SQLite opened, by a stat of the same path in the same synchronous step, before any statement,
// and runs nothing on the connection until the caller's claim holds that file (`proceed`).
//
// A space's writer is the only connection that changes a live space. Its open allows an older
// revision, and `proceed` migrates the space on that connection (migrate/runner.ts) before it
// attaches the write path, so a migration never runs beside the writer and always under the
// writer's claim. A claim of a read-only copy (restore/claim.ts) opens the same way, claims on the
// connection and closes it. Restore in place and recovery run here too, while the caller holds the
// space's claim (worker/client.ts).
//
// Across processes, each of these first takes the space's writer.lock (writer-lock.ts) and holds it
// for the writer's life: until the writer closes, the claim or the restore ends, or the worker
// stops. The lock lives in this worker beside the connection it guards, so the two end together.
import { statSync } from "node:fs";
import type { MessagePort } from "node:worker_threads";
import { SCHEMA_STEPS } from "../../migrations/index.ts";
import type { BackupSeams } from "../backup/backup.ts";
import { MEMORY, type Connection, type Row, type SqliteDriver } from "../driver.ts";
import { misuse, StorageError, type SerializedStorageError } from "../errors.ts";
import { fsCall } from "../files.ts";
import { osRandom } from "../ids.ts";
import { migrateOpened, type MigrateSeams } from "../migrate/runner.ts";
import { configureConnection, openSpaceConnection, openUnconfigured } from "../open.ts";
import { claimCopy } from "../restore/claim.ts";
import { checkSwapPath } from "../restore/folders.ts";
import { recoverSpaceWith } from "../restore/recover.ts";
import { restoreInPlaceWith, type RestoreSeams } from "../restore/restore.ts";
import type { SchemaStep } from "../schema.ts";
import { repairSearchIndex } from "../search/remake.ts";
import {
  beginSpaceWriter,
  openSpaceWith,
  SOURCE_APP_VERSION,
  type OpenedSpace,
  type ReadOnlyReason,
} from "../space.ts";
import { checkSpacePath } from "../space-path.ts";
import { literalPath } from "../sqlite-uri.ts";
import { CheckedDriver } from "../startup-check.ts";
import { checkMachine, SpaceWriter, type MachineInfo, type WriteSeams } from "../write/writer.ts";
import {
  checkHolderFacts,
  swapGuard,
  takeWriterLock,
  type HolderFacts,
  type WriterLock,
} from "../writer-lock.ts";
import { fileKey } from "./file-key.ts";
import type {
  Calls,
  Kind,
  OpenedFile,
  OpenedSpaceInfo,
  Query,
  QueryResult,
  Reply,
  Request,
  StartupMessage,
  WriterPurpose,
} from "./protocol.ts";

/** What a worker entry may set besides the driver. */
export interface ServeOptions {
  /** The registered schema steps. Default: SCHEMA_STEPS. A test entry passes stand-in steps. */
  steps?: readonly SchemaStep[];
  /**
   * Fault seams for M1.07's crash harness, called at the named points of the work this worker
   * does. Only a test worker entry passes them: the product's entry (entry.ts) passes none, and no
   * request, setting or environment variable turns them on.
   */
  faults?: WorkerFaults;
}

/** The named points of the work a storage worker does, for a test worker entry (ServeOptions). */
export interface WorkerFaults {
  /** A space writer's request transaction (write/writer.ts). */
  write?: WriteSeams["at"];
  /** The migration that openSpaceWriter runs (migrate/runner.ts). */
  migrate?: MigrateSeams["at"];
  /** The migration's barrier backup (backup/backup.ts). */
  barrier?: BackupSeams["at"];
  /** A restore in place (restore/restore.ts, restore/folders.ts). */
  restore?: RestoreSeams["at"];
}

const ERROR_NAME = /^[A-Za-z]{1,40}$/;

function serialize(error: unknown): SerializedStorageError {
  if (error instanceof StorageError) return error.toJSON();
  // Not a storage error: a bug in this package. Its message could quote a value, so only the
  // error's class name crosses the boundary.
  const name = error instanceof Error && ERROR_NAME.test(error.name) ? ` (${error.name})` : "";
  return { code: "STORAGE_SQL", message: `The storage worker failed unexpectedly${name}` };
}

function runQuery(conn: Connection, query: Query): QueryResult {
  const statement = conn.prepare(query.sql);
  switch (query.mode) {
    case "run":
      return statement.run(query.params);
    case "get":
      return statement.get(query.params) ?? null;
    case "all": {
      const rows: Row[] = statement.all(query.params);
      return rows;
    }
    default:
      throw misuse("Unknown query mode");
  }
}

type Handlers = {
  [K in Kind]: (args: Calls[K]["args"]) => Calls[K]["result"] | Promise<Calls[K]["result"]>;
};

/** A writable connection SQLite opened, on which nothing has run yet. */
interface Held {
  proceed: () => OpenedSpaceInfo | null | Promise<OpenedSpaceInfo>;
  /** Closes the connection unused. */
  abandon: () => void;
  /** A space's writer.lock, held for the writer this connection becomes. */
  lock?: WriterLock;
}

/** The reasons each purpose's open allows: the purpose resolves them before anything writes. */
const ALLOWED: { readonly [K in WriterPurpose["kind"]]: readonly ReadOnlyReason[] } = {
  write: ["older_revision"],
  claim: ["read_only_copy", "older_revision"],
};

/** A purpose from another thread, checked at run time. */
function checkPurpose(purpose: unknown): WriterPurpose {
  if (purpose === undefined) return { kind: "write" };
  const p = purpose as Partial<Record<string, unknown>> | null;
  if (p?.["kind"] === "write") {
    const dir = p["backupDir"];
    if (dir !== undefined && typeof dir !== "string") throw misuse("backupDir is a path");
    return dir === undefined ? { kind: "write" } : { kind: "write", backupDir: dir };
  }
  if (p?.["kind"] === "claim") {
    const epochs = p["knownEpochs"];
    if (!Array.isArray(epochs)) throw misuse("A claim names the epochs this machine knows");
    const floor = p["refFloor"];
    if (floor !== undefined && typeof floor !== "number") throw misuse("refFloor is a number");
    return {
      kind: "claim",
      knownEpochs: epochs as number[],
      ...(floor === undefined ? {} : { refFloor: floor }),
    };
  }
  throw misuse("A space's writer opens to write or to claim");
}

/**
 * The claim key of the file SQLite just opened at `path`, its literal path (sqlite-uri.ts), from
 * a stat by the same path. The drivers give no handle to the file they opened. A file that is
 * gone again is refused.
 */
function openedFile(path: string): string | null {
  if (path === MEMORY) return null;
  try {
    return fileKey(statSync(path, { bigint: true }));
  } catch {
    throw new StorageError("SPACE_CHANGED", "The database file changed while it was opening");
  }
}

/** The optional settings a request carries, without the keys it left out. */
function optional(settings: {
  appVersion?: string | undefined;
  busyTimeoutMs?: number | undefined;
}): {
  appVersion?: string;
  busyTimeoutMs?: number;
} {
  return {
    ...(settings.appVersion === undefined ? {} : { appVersion: settings.appVersion }),
    ...(settings.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: settings.busyTimeoutMs }),
  };
}

/** The reply for a space opened in this worker. */
const spaceInfo = (handle: number, opened: OpenedSpace): OpenedSpaceInfo => ({
  handle,
  spaceId: opened.space.spaceId,
  role: opened.role,
  revision: opened.revision,
  readOnlyReasons: opened.readOnlyReasons,
  manifestRebuilt: opened.manifestRebuilt,
  authority: {
    machineId: opened.space.authority.machineId,
    epoch: opened.space.authority.epoch,
    incarnation: opened.space.authority.incarnation,
  },
  lastSeq: opened.space.lastSeq,
});

/**
 * Takes the writer.lock of the space folder `folder` (checked as a space path, and by `check`
 * first when given) for what this worker is about to do to the space. A database file with a
 * second name is refused before (worker/client.ts), where A1 3.9's claims are.
 */
async function lockSpace(
  checked: CheckedDriver,
  folder: string,
  holder: unknown,
  options: { machineName?: string; check?: (folder: string) => string } = {},
): Promise<{ dir: string; lock: WriterLock }> {
  const { machineName, check = checkSpacePath } = options;
  const dir = check(folder);
  const facts: HolderFacts = checkHolderFacts(holder);
  // A missing folder is reported as the open reports it, and gets no lock file.
  if (fsCall(() => statSync(dir, { throwIfNoEntry: false })?.isDirectory()) !== true) {
    throw new StorageError("SPACE_NOT_FOUND", "No space found: the folder does not exist");
  }
  const lock = await takeWriterLock(checked.driver, dir, {
    ...(machineName === undefined ? {} : { machine: machineName }),
    ...facts,
  });
  return { dir, lock };
}

/**
 * Serves the storage protocol on `port`. `load` returns the driver, which must pass the start-up
 * check before any request is served.
 */
export function serve(
  port: MessagePort,
  load: () => Promise<SqliteDriver>,
  options: ServeOptions = {},
): void {
  const steps = options.steps ?? SCHEMA_STEPS;
  const faults = options.faults ?? {};
  const writeSeams: WriteSeams = faults.write === undefined ? {} : { at: faults.write };
  const migrateSeams: MigrateSeams = {
    steps,
    ...(faults.migrate === undefined ? {} : { at: faults.migrate }),
    ...(faults.barrier === undefined ? {} : { backup: { at: faults.barrier } }),
  };
  const restoreSeams: RestoreSeams = {
    steps,
    ...(faults.restore === undefined ? {} : { at: faults.restore }),
  };
  const send = (message: StartupMessage | Reply): void => {
    port.postMessage(message);
  };

  const connections = new Map<number, Connection>();
  const writers = new Map<number, SpaceWriter>();
  const held = new Map<number, Held>();
  /** Each open space writer's writer.lock, by the writer's handle. */
  const locks = new Map<number, WriterLock>();
  let nextHandle = 1;
  const take = (): number => {
    const handle = nextHandle;
    nextHandle += 1;
    return handle;
  };
  const connection = (handle: number): Connection => {
    const conn = connections.get(handle);
    if (conn !== undefined) return conn;
    // A space's writer takes operations only: SQL sent to it could write around the write path.
    if (writers.has(handle)) throw misuse("A space's writer takes operations, not SQL");
    if (held.has(handle)) throw misuse("This connection waits for its claim");
    throw misuse("No open connection has this handle");
  };
  const writer = (handle: number): SpaceWriter => {
    const found = writers.get(handle);
    if (found === undefined) throw misuse("No space writer has this handle");
    return found;
  };
  /**
   * Holds a writable connection SQLite just opened at `path` under a new handle, with the claim
   * key of that file. Nothing runs on the connection until `proceed`.
   */
  const hold = (path: string, make: (handle: number) => Held): OpenedFile => {
    const handle = take();
    const entry = make(handle);
    let file: string | null;
    try {
      file = openedFile(path);
    } catch (error) {
      entry.abandon();
      entry.lock?.release();
      throw error;
    }
    held.set(handle, entry);
    const { lock } = entry;
    return lock === undefined
      ? { handle, file }
      : { handle, file, lock: { path: lock.path, ...lock.identity } };
  };

  /** Locks whose connection failed to close: kept until the worker's thread ends. */
  const stranded: WriterLock[] = [];

  const closeAll = (): void => {
    const errors: unknown[] = [];
    const attempt = (close: () => void): boolean => {
      try {
        close();
        return true;
      } catch (error) {
        errors.push(error);
        return false;
      }
    };
    for (const conn of connections.values()) {
      attempt(() => {
        conn.close();
      });
    }
    // Each lock after the connection it guards, and only once that connection closed: a close that
    // fails may leave it open, so its lock stays until the thread ends (the lock outlives what it
    // guards, never the reverse).
    for (const [handle, spaceWriter] of writers) {
      const lock = locks.get(handle);
      locks.delete(handle);
      const closed = attempt(() => {
        spaceWriter.close();
      });
      if (closed) lock?.release();
      else if (lock !== undefined) stranded.push(lock);
    }
    for (const h of held.values()) {
      if (attempt(h.abandon)) h.lock?.release();
      else if (h.lock !== undefined) stranded.push(h.lock);
    }
    for (const lock of locks.values()) {
      attempt(() => {
        lock.release();
      });
    }
    connections.clear();
    writers.clear();
    held.clear();
    locks.clear();
    if (errors.length > 0) throw errors[0];
  };

  const start = async (): Promise<CheckedDriver> => CheckedDriver.check(await load());

  start().then(
    (checked) => {
      /**
       * The writer of a space opened with an older revision allowed: migrated first on its own
       * connection, behind the barrier backup, then attached. A failed migration throws its error
       * (BACKUP_FAILED, BUNDLE_LIMIT_EXCEEDED, MIGRATION_FAILED or SPACE_CHANGED), whose message
       * names both revisions and the barrier backup, and the caller closes the connection: the
       * space stays at its revision and opens read-only for readers (A1 3.17).
       */
      const attachWriter = async (
        handle: number,
        opened: OpenedSpace,
        machine: MachineInfo,
        settings: { appVersion?: string; busyTimeoutMs?: number; backupDir?: string },
      ): Promise<OpenedSpaceInfo> => {
        let ready = opened;
        let migration: OpenedSpaceInfo["migration"];
        // Only the authority writes (A1 3.7). Another machine's writer refuses every request, and
        // the service serves its space read-only by this same rule: neither a migration nor the
        // index may change that copy under its owner (in a synced folder, a conflict for them).
        const owned = opened.space.authority.machineId === machine.id;
        if (opened.readOnlyReasons.includes("older_revision")) {
          if (!owned) {
            throw new StorageError(
              "SPACE_NEEDS_MIGRATION",
              "The space needs a migration, which only its authority machine runs",
            );
          }
          const outcome = await migrateOpened(checked, opened, settings, migrateSeams);
          if (outcome.state === "failed") throw outcome.error;
          if (outcome.state === "migrated") {
            const { from, to, backup, seqs, manifestWritten, setFolderAway } = outcome;
            migration = {
              from,
              to,
              backup,
              seqs,
              manifestWritten,
              ...(setFolderAway === undefined ? {} : { setFolderAway }),
            };
            ready = { ...opened, revision: to, readOnlyReasons: [] };
          }
        }
        // A migration made the index just now. Otherwise the owner's open repairs or refreshes it
        // here, so search works without the person doing anything: the tasks are the truth.
        const searchIndex =
          owned && migration === undefined
            ? repairSearchIndex(checked, ready.conn, steps)
            : "sound";
        // Attached only: the caller registers the machine once the space is claimed. Attach
        // refuses a writer that still has a reason to be read-only.
        writers.set(handle, SpaceWriter.attach(ready, { machine }, writeSeams));
        return {
          ...spaceInfo(handle, ready),
          ...(migration === undefined ? {} : { migration }),
          ...(searchIndex === "sound" ? {} : { searchIndex }),
        };
      };

      /** Claims a read-only copy on its writer's connection. The caller closes it. */
      const claimHeld = (
        handle: number,
        opened: OpenedSpace,
        machine: MachineInfo,
        goal: Extract<WriterPurpose, { kind: "claim" }>,
        appVersion: string | undefined,
      ): OpenedSpaceInfo => {
        const claim = claimCopy(opened, {
          machineId: machine.id,
          knownEpochs: goal.knownEpochs,
          ...(goal.refFloor === undefined ? {} : { refFloor: goal.refFloor }),
          now: Date.now(),
          random: osRandom,
          appVersion: appVersion ?? SOURCE_APP_VERSION,
          steps,
        });
        return {
          ...spaceInfo(handle, {
            ...opened,
            space: claim.space,
            // The claim ended the copy state. An older revision is migrated by the next writer.
            readOnlyReasons: opened.readOnlyReasons.filter((r) => r !== "read_only_copy"),
          }),
          claim,
        };
      };

      const handlers: Handlers = {
        open: ({ path, role, create, busyTimeoutMs }) => {
          const options = {
            ...(create === undefined ? {} : { create }),
            ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
          };
          // The client sends the literal path already: this keeps a raw request to the same rule.
          const literal = literalPath(path);
          if (role !== "writer") {
            const conn = openSpaceConnection(checked, literal, role, options);
            const handle = take();
            connections.set(handle, conn);
            return { handle, file: null };
          }
          const conn = openUnconfigured(checked, literal, "writer", options);
          return hold(literal, (handle) => ({
            proceed: () => {
              connections.set(handle, configureConnection(conn, "writer", options));
              return null;
            },
            abandon: () => {
              conn.close();
            },
          }));
        },
        openSpace: ({ folder, appVersion, busyTimeoutMs }) => {
          const opened = openSpaceWith(
            checked,
            folder,
            {
              role: "reader",
              ...(appVersion === undefined ? {} : { appVersion }),
              ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
            },
            { steps },
          );
          const handle = take();
          connections.set(handle, opened.conn);
          return spaceInfo(handle, opened);
        },
        openSpaceWriter: async ({
          folder,
          machine,
          appVersion,
          busyTimeoutMs,
          purpose,
          holder,
          spaceId,
        }) => {
          // Checked before anything opens.
          const record = checkMachine(machine);
          const goal = checkPurpose(purpose);
          if (spaceId !== undefined && typeof spaceId !== "string") {
            throw misuse("spaceId is a space ID");
          }
          const settings = {
            ...(appVersion === undefined ? {} : { appVersion }),
            ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
          };
          // Across processes first: no other process has this space open for writing while this
          // writer, its migration or its claim runs.
          const { dir, lock } = await lockSpace(checked, folder, holder, {
            machineName: record.name,
          });
          let opening: ReturnType<typeof beginSpaceWriter>;
          try {
            opening = beginSpaceWriter(checked, dir, settings, {
              allow: ALLOWED[goal.kind],
              steps,
            });
          } catch (error) {
            lock.release();
            throw error;
          }
          // Another space than the caller's probe read was put in the folder before the lock:
          // refused before phase 2, which could rebuild its space.json, and before a migration or
          // a claim. Phase 2 holds the ID phase 1 read.
          if (spaceId !== undefined && opening.spaceId !== spaceId) {
            opening.abandon();
            lock.release();
            throw new StorageError("SPACE_CHANGED", "The space changed while it was opening");
          }
          return hold(literalPath(opening.dbPath), (handle) => ({
            lock,
            proceed: async () => {
              const opened = opening.finish();
              if (goal.kind === "claim") {
                try {
                  return claimHeld(handle, opened, record, goal, appVersion);
                } finally {
                  opened.conn.close();
                }
              }
              try {
                return await attachWriter(handle, opened, record, {
                  ...settings,
                  ...(goal.backupDir === undefined ? {} : { backupDir: goal.backupDir }),
                });
              } catch (error) {
                opened.conn.close();
                throw error;
              }
            },
            abandon: () => {
              opening.abandon();
            },
          }));
        },
        restoreInPlace: async ({
          backupFile,
          folder,
          machineId,
          spaceId,
          knownEpochs,
          refFloor,
          holder,
          ...rest
        }) => {
          const { dir, lock } = await lockSpace(checked, folder, holder, {
            check: checkSwapPath,
          });
          try {
            return await restoreInPlaceWith(
              checked,
              backupFile,
              dir,
              {
                machineId,
                ...(spaceId === undefined ? {} : { spaceId }),
                knownEpochs,
                ...(refFloor === undefined ? {} : { refFloor }),
                ...optional(rest),
                swap: swapGuard(lock, dir),
              },
              restoreSeams,
            );
          } finally {
            lock.release();
          }
        },
        recoverSpace: async ({ folder, holder, ...rest }) => {
          const { dir, lock } = await lockSpace(checked, folder, holder, {
            check: checkSwapPath,
          });
          try {
            return recoverSpaceWith(
              checked,
              dir,
              { ...optional(rest), swap: swapGuard(lock, dir) },
              { steps },
            );
          } finally {
            lock.release();
          }
        },
        proceed: async ({ handle }) => {
          const entry = held.get(handle);
          if (entry === undefined) throw misuse("No held connection has this handle");
          // Taken out first: a failure closes the connection, and the handle with it.
          held.delete(handle);
          const { lock } = entry;
          try {
            const info = await entry.proceed();
            // A space writer keeps its lock until it closes; a claim, which closed its
            // connection, gives it up now.
            if (lock !== undefined && writers.has(handle)) locks.set(handle, lock);
            else lock?.release();
            return info;
          } catch (error) {
            lock?.release();
            throw error;
          }
        },
        registerMachine: ({ handle }) => writer(handle).registerMachine(),
        actor: ({ handle, actorKind, label }) => writer(handle).actor(actorKind, label),
        submit: ({ handle, request }) => writer(handle).submit(request),
        receipt: ({ handle, lookup }) => writer(handle).receipt(lookup) ?? null,
        keep: ({ handle, lookup, given }) => writer(handle).keep(lookup, given),
        launch: ({ handle, launch }) => writer(handle).launch(launch) ?? null,
        openLaunches: ({ handle, machine }) => writer(handle).openLaunches(machine),
        projected: ({ handle, batch }) => writer(handle).projected(batch),
        queueProjection: ({ handle, keys }) => writer(handle).queueProjection(keys),
        repairSearchIndex: ({ handle }) => writer(handle).repairSearchIndex(checked, steps),
        run: ({ handle, run }) => writer(handle).run(run) ?? null,
        openRuns: ({ handle, machine }) => writer(handle).openRuns(machine),
        exec: ({ handle, sql }) => {
          connection(handle).exec(sql);
          return null;
        },
        query: ({ handle, query }) => runQuery(connection(handle), query),
        transaction: ({ handle, mode, queries }) => {
          const conn = connection(handle);
          return conn.transaction(mode, () => queries.map((q) => runQuery(conn, q)));
        },
        pragma: ({ handle, name, value }) => connection(handle).pragma(name, value),
        backup: ({ handle, destPath, pagesPerStep }) =>
          checked.driver.backup(connection(handle), destPath, { pagesPerStep }),
        close: ({ handle }) => {
          const waiting = held.get(handle);
          if (waiting !== undefined) {
            held.delete(handle);
            try {
              waiting.abandon();
            } catch (error) {
              // The connection may still be open: its lock stays until the thread ends.
              if (waiting.lock !== undefined) stranded.push(waiting.lock);
              throw error;
            }
            waiting.lock?.release();
            return null;
          }
          const spaceWriter = writers.get(handle);
          if (spaceWriter !== undefined) {
            writers.delete(handle);
            const lock = locks.get(handle);
            locks.delete(handle);
            try {
              spaceWriter.close();
            } catch (error) {
              // A close that fails may leave the connection open: its lock then stays until the
              // thread ends. The lock outlives what it guards, never the reverse.
              if (lock !== undefined) stranded.push(lock);
              throw error;
            }
            lock?.release();
            return null;
          }
          const conn = connection(handle);
          connections.delete(handle);
          conn.close();
          return null;
        },
        shutdown: () => {
          closeAll();
          return null;
        },
      };

      // Requests run strictly one after another, backups included, because a connection is
      // synchronous and belongs to this thread alone.
      let queue: Promise<void> = Promise.resolve();
      port.on("message", (request: Request) => {
        queue = queue.then(async () => {
          try {
            const handler = handlers[request.kind] as ((args: Request) => unknown) | undefined;
            if (handler === undefined) throw misuse("Unknown request kind");
            const value: unknown = await handler(request);
            send({ id: request.id, ok: true, value });
          } catch (error) {
            send({ id: request.id, ok: false, error: serialize(error) });
          }
        });
      });
      send({ kind: "ready", report: checked.report });
    },
    (error: unknown) => {
      send({ kind: "refused", error: serialize(error) });
      port.close();
    },
  );
}
