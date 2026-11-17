// The crash harness's child process: one round of real work on a real space folder, as the
// service will do it (M1.08), until the parent kills it or the plan ends.
//
// It finishes an interrupted restore and opens the space's writer through a StorageWorker, which
// migrates the space first when its revision is older (the harness's build has the stand-in steps
// up to 0.6). Then it sends the plan's requests through the writer, up to `window` at a time, from
// several writer scopes (the sessions), two of them as agent actors that the writer adds on their
// first act (`actor.register`, as the service does), takes backups beside the writes from its main thread as the
// maintenance worker will, and restores a backup in place through the worker. It reports every
// request before it sends it and every result when it arrives, reduced to statuses, IDs and codes.
// At the armed point the seam reports the point and waits to be killed (protocol.ts).
//
// Run by harness.ts only: node tests/crash/child.ts, with the plan on stdin.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../packages/bridge/src/safe-exit.ts";
import { join } from "node:path";
import { backupSpaceWith, backupsFolder } from "../../packages/storage/src/backup/backup.ts";
import { DATA_SUFFIX } from "../../packages/storage/src/backup/sidecar.ts";
import { StorageError } from "../../packages/storage/src/errors.ts";
import type { Id } from "../../packages/storage/src/ids.ts";
import { nodeSqliteDriver } from "../../packages/storage/src/node-sqlite.ts";
import { finishInterruptedRestore } from "../../packages/storage/src/restore/folders.ts";
import { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import { StorageWorker, type SpaceWriterHandle } from "../../packages/storage/src/worker/client.ts";
import {
  formatAsOf,
  type Credential,
  type WriteRequest,
} from "../../packages/storage/src/write/request.ts";
import { FIXTURE_MACHINE } from "../../packages/storage/test/fixture-requests.ts";
import {
  armFromEnvironment,
  emit,
  faultSeam,
  reduce,
  type BackupFacts,
  type PlannedRequest,
  type RoundPlan,
} from "./protocol.ts";
import { HARNESS_STEPS } from "./steps.ts";

/** Generous limits: a slow runner must not turn a slow request into a failure. */
const REQUEST_TIMEOUT_MS = 120_000;
const BUSY_TIMEOUT_MS = 60_000;

function codeOf(error: unknown): string {
  if (error instanceof StorageError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

/** Reports an error the plan did not expect, and ends the process. */
function fail(during: string, error: unknown): never {
  emit({ t: "error", during, code: codeOf(error) });
  process.exit(1);
}

async function readPlan(): Promise<RoundPlan> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RoundPlan;
}

/** Whether the as_of `a` (wire form `<epoch>.<seq>.<tag>`) is after `b`. */
function after(a: string, b: string): boolean {
  const [ea, sa] = a.split(".").map(Number);
  const [eb, sb] = b.split(".").map(Number);
  return (ea ?? 0) > (eb ?? 0) || ((ea ?? 0) === (eb ?? 0) && (sa ?? 0) > (sb ?? 0));
}

async function main(): Promise<void> {
  const plan = await readPlan();
  const arm = armFromEnvironment();
  const backupSeam = faultSeam("backup", arm);
  const machine = FIXTURE_MACHINE;
  const checked = await CheckedDriver.check(nodeSqliteDriver);
  // What the service does before a space opens (A1 3.18).
  finishInterruptedRestore(plan.folder);
  const worker = await StorageWorker.start({
    driver: "node:sqlite",
    entry: new URL("./fault-worker.ts", import.meta.url),
  });

  // The as_of values results reported, newest last: `fresh` takes the newest, `stale` an older one.
  const seen: string[] = [plan.base];
  const remember = (asOf: string): void => {
    const last = seen.at(-1);
    if (last === undefined || after(asOf, last)) {
      seen.push(asOf);
      if (seen.length > 64) seen.shift();
    }
  };
  const knownEpochs = [...plan.knownEpochs];

  const open = async (): Promise<SpaceWriterHandle> => {
    const handle = await worker.openSpaceWriter(plan.folder, {
      machine,
      timeoutMs: REQUEST_TIMEOUT_MS,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      queueLimit: 100_000,
    });
    const migration = handle.migration;
    let migrated: BackupFacts | null = null;
    if (migration !== undefined) {
      const { sidecar } = migration.backup;
      migrated = {
        name: migration.backup.name,
        seq: sidecar.seq,
        incarnation: sidecar.incarnation,
        userVersion: sidecar.user_version,
      };
    }
    emit({ t: "ready", migrated });
    return handle;
  };
  let handle = await open().catch((error: unknown) => fail("open", error));

  // The agent actors this writer resolved, by label, as the service's request path keeps them per
  // writer: a restore in place opens a new writer, whose space may not hold the actor any more.
  let agents = new Map<string, Promise<Id<"ac">>>();
  const agentOf = (label: string): Promise<Id<"ac">> => {
    let found = agents.get(label);
    if (found === undefined) {
      found = handle.actor("agent", label).then(
        (id) => {
          emit({ t: "actor", label, id });
          return id;
        },
        (error: unknown) => fail("actor", error),
      );
      agents.set(label, found);
    }
    return found;
  };

  const credential = async (planned: PlannedRequest): Promise<Credential> => ({
    scope_id: planned.scope_id,
    principal_id:
      planned.agent === undefined ? (plan.owner as Id<"ac">) : await agentOf(planned.agent),
    actor_kind: planned.agent === undefined ? "human" : "agent",
    machine_id: machine.id,
    origin: "cli",
  });

  const inFlight = new Set<Promise<void>>();
  const drain = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  const submit = async (planned: PlannedRequest): Promise<void> => {
    while (inFlight.size >= plan.window) await Promise.race([...inFlight]);
    const newest = seen.at(-1) ?? plan.base;
    const base =
      planned.base === "fresh"
        ? newest
        : planned.base === "stale"
          ? (seen[Math.max(0, seen.length - 6)] ?? newest)
          : undefined;
    const request: WriteRequest = {
      space_id: plan.spaceId as Id<"sp">,
      request_id: planned.request_id,
      actor: await credential(planned),
      ops: planned.ops,
      ...(base === undefined ? {} : { base }),
    };
    emit({ t: "send", key: planned.key });
    const answer = handle.submit(request).then(
      (result) => {
        remember(result.as_of);
        emit({ t: "ack", key: planned.key, result: reduce(result) });
      },
      (error: unknown) => fail("submit", error),
    );
    inFlight.add(answer);
    void answer.finally(() => inFlight.delete(answer));
  };

  let backups = 0;
  let running: Promise<void> = Promise.resolve();
  let lastBackup: string | undefined;
  const backup = async (kind: "manual" | "daily"): Promise<void> => {
    await running;
    backups += 1;
    const n = backups;
    emit({ t: "backup-start", n });
    running = backupSpaceWith(
      checked,
      plan.folder,
      { kind, busyTimeoutMs: BUSY_TIMEOUT_MS },
      { at: backupSeam, steps: HARNESS_STEPS },
    ).then(
      (record) => {
        lastBackup = record.name;
        emit({
          t: "backup-done",
          n,
          backup: {
            name: record.name,
            seq: record.sidecar.seq,
            incarnation: record.sidecar.incarnation,
            userVersion: record.sidecar.user_version,
          },
        });
      },
      (error: unknown) => fail("backup", error),
    );
  };

  const restore = async (name: string): Promise<void> => {
    await drain();
    await running;
    const chosen = name === "" ? lastBackup : name;
    if (chosen === undefined) return;
    await handle.close();
    emit({ t: "restore-start", backup: chosen });
    const restored = await worker
      .restoreInPlace(join(backupsFolder(plan.folder), `${chosen}${DATA_SUFFIX}`), plan.folder, {
        machineId: machine.id,
        knownEpochs,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
      })
      .catch((error: unknown) => fail("restore", error));
    const { claim } = restored;
    emit({
      t: "restore-done",
      backup: chosen,
      epoch: claim.epoch,
      incarnation: claim.incarnation,
      seq: claim.seq,
    });
    knownEpochs.push(claim.epoch);
    seen.push(formatAsOf({ epoch: claim.epoch, incarnation: claim.incarnation, seq: claim.seq }));
    handle = await open().catch((error: unknown) => fail("open", error));
    agents = new Map();
  };

  for (const action of plan.actions) {
    if (action.a === "submit") await submit(action.req);
    else if (action.a === "backup") await backup(action.kind);
    else await restore(action.backup);
  }
  await drain();
  await running;
  await handle.close();
  await worker.close();
  emit({ t: "done" });
  process.exit(0);
}

main().catch((error: unknown) => fail("round", error));
