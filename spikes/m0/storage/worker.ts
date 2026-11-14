// Worker threads for R02 and R04, following A1 3.9: the main thread holds no SQLite connection, one
// writer worker owns the write connection, two reader workers hold read-only connections shared by
// all spaces, and a maintenance worker takes the backup.
//
// Every role closes its connections on every path. A role that fails reports the error, and the
// main thread then terminates the worker.
import { setTimeout as sleep } from "node:timers/promises";
import { backup, type DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { closeConnection } from "./connection.ts";
import { summaryText } from "./fixture.ts";
import { Rng } from "./rng.ts";
import { openReader, openWriter, SpaceReader, SpaceWriter } from "./space.ts";

export type Role = "writer" | "reader" | "maintenance" | "queue";

export interface WorkerConfig {
  role: Role;
  /** Names the worker in its random seed, for example "reader-2". */
  name: string;
  /** The space databases. The writer and the maintenance worker use the first one. */
  paths: string[];
  seed: string;
  /** Pause between the writer's commits in R02, in milliseconds. */
  pauseMs?: number;
  /** The writer queue limit of A1 3.9. */
  queueLimit?: number;
  /** R04: the number of agent sessions that send patches, one per simulated writer. */
  sessions?: number;
}

/** Messages from the main thread. */
export type Command =
  | { type: "start" }
  | { type: "stop" }
  | { type: "backup"; target: string }
  | { type: "patch"; id: number; writer: number };

/** Messages to the main thread. */
export type Reply =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "writer-stats"; commits: Float64Array; sessions: number }
  | {
      type: "reader-stats";
      byRef: Float64Array;
      openView: Float64Array;
      consistencyChecks: number;
      consistencyErrors: number;
    }
  | {
      type: "backup-done";
      backupMs: number;
      steps: number;
      pages: number;
      integrityMs: number;
      integrity: string;
      lastSeq: number;
    }
  | { type: "patched"; id: number; commitMs: number; overloaded: boolean };

const port = parentPort;
if (port === null) throw new Error("worker.ts runs only as a worker thread");
const config = workerData as WorkerConfig;
const send = (reply: Reply): void => {
  port.postMessage(reply);
};

let stopping = false;
const commands: Command[] = [];
let wake: (() => void) | undefined;
const enqueue = (command: Command): void => {
  if (command.type === "stop") stopping = true;
  commands.push(command);
  wake?.();
};
port.on("message", enqueue);

function nextCommand(): Promise<Command> {
  const queued = commands.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => {
    wake = () => {
      wake = undefined;
      resolve(commands.shift() as Command);
    };
  });
}

const firstPath = (): string => {
  const path = config.paths[0];
  if (path === undefined) throw new Error("no database path");
  return path;
};

async function writer(): Promise<void> {
  const db = openWriter(firstPath());
  const commits: number[] = [];
  try {
    const w = new SpaceWriter(db, `r02-${config.seed}`);
    const rng = new Rng(`${config.seed}/${config.name}`);
    send({ type: "ready" });
    await nextCommand(); // start
    while (!stopping) {
      const t0 = performance.now();
      w.patchSummary(rng.pick(w.openRefs), summaryText(rng));
      commits.push(performance.now() - t0);
      await sleep(config.pauseMs ?? 2);
    }
  } finally {
    closeConnection(db);
  }
  send({ type: "writer-stats", commits: Float64Array.from(commits), sessions: 1 });
}

async function reader(): Promise<void> {
  const connections: DatabaseSync[] = [];
  try {
    for (const path of config.paths) connections.push(openReader(path));
    await readLoop(connections.map((db) => new SpaceReader(db)));
  } finally {
    for (const db of connections) closeConnection(db);
  }
}

async function readLoop(spaces: SpaceReader[]): Promise<void> {
  const rng = new Rng(`${config.seed}/${config.name}`);
  const byRef: number[] = [];
  const openView: number[] = [];
  let checks = 0;
  let errors = 0;
  send({ type: "ready" });
  await nextCommand(); // start
  let n = 0;
  while (!stopping) {
    n += 1;
    // Two reader workers are shared by all spaces (A1 3.9), so reads alternate between them.
    const space = spaces[rng.int(spaces.length)] as SpaceReader;
    const t0 = performance.now();
    if (n % 10 === 0) {
      space.openView();
      openView.push(performance.now() - t0);
    } else {
      space.taskWithChildren(rng.range(1, space.refs));
      byRef.push(performance.now() - t0);
    }
    if (n % 20 === 0) {
      checks += 1;
      if (!(spaces[0] as SpaceReader).consistent()) errors += 1;
    }
    if (n % 25 === 0) await sleep(0);
  }
  send({
    type: "reader-stats",
    byRef: Float64Array.from(byRef),
    openView: Float64Array.from(openView),
    consistencyChecks: checks,
    consistencyErrors: errors,
  });
}

async function maintenance(): Promise<void> {
  send({ type: "ready" });
  const command = await nextCommand();
  if (command.type !== "backup") return;
  const source = openReader(firstPath());
  let steps = 0;
  let pages: number;
  const t0 = performance.now();
  try {
    // A single step copies every page in one sqlite3_backup_step call, so writes on other
    // connections cannot restart it (A1 3.18). The rate is larger than any page count.
    pages = await backup(source, command.target, {
      rate: 2_147_483_647,
      progress: () => {
        steps += 1;
      },
    });
  } finally {
    closeConnection(source);
  }
  const backupMs = performance.now() - t0;
  const t1 = performance.now();
  const copy = openWriter(command.target);
  let rows: { integrity_check: string }[];
  let integrityMs: number;
  let lastSeq: number;
  try {
    rows = copy.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    integrityMs = performance.now() - t1;
    lastSeq = (copy.prepare("SELECT last_seq FROM space").get() as { last_seq: number }).last_seq;
  } finally {
    closeConnection(copy);
  }
  send({
    type: "backup-done",
    backupMs,
    // The progress callback runs only between steps, so a single-step backup reports none.
    steps: steps + 1,
    pages,
    integrityMs,
    integrity: rows.map((r) => r.integrity_check).join("; "),
    lastSeq,
  });
}

async function queue(): Promise<void> {
  const db = openWriter(firstPath());
  let sessions: number;
  try {
    const w = new SpaceWriter(db, `r04-${config.seed}`, config.sessions ?? 1);
    sessions = w.sessions.length;
    await serveQueue(w);
  } finally {
    closeConnection(db);
  }
  send({ type: "writer-stats", commits: Float64Array.from([]), sessions });
}

/** The writer queue of A1 3.9: patches run one at a time in arrival order. */
async function serveQueue(w: SpaceWriter): Promise<void> {
  const rng = new Rng(`${config.seed}/${config.name}`);
  const limit = config.queueLimit ?? 1000;
  const pending: { id: number; writer: number }[] = [];
  let draining = false;
  // Set by drain(), which runs outside the command loop.
  const state: { failure?: Error } = {};
  const failed = (): Error | undefined => state.failure;
  const drain = (): void => {
    const next = pending.shift();
    if (next === undefined) {
      draining = false;
      return;
    }
    try {
      const t0 = performance.now();
      // Each simulated writer is one agent session (A1 3.20: 10 concurrent agent sessions).
      w.patchSummary(rng.pick(w.openRefs), summaryText(rng), next.writer);
      send({ type: "patched", id: next.id, commitMs: performance.now() - t0, overloaded: false });
    } catch (error) {
      // Hand the failure to the command loop, which closes the connection and reports it.
      state.failure = error instanceof Error ? error : new Error(String(error));
      draining = false;
      pending.length = 0;
      enqueue({ type: "stop" });
      return;
    }
    setImmediate(drain);
  };
  send({ type: "ready" });
  for (;;) {
    const command = await nextCommand();
    const failure = failed();
    if (failure !== undefined) throw failure;
    if (command.type === "stop") break;
    if (command.type !== "patch") continue;
    if (pending.length >= limit) {
      // A full queue answers STORAGE_OVERLOADED (A1 3.9).
      send({ type: "patched", id: command.id, commitMs: 0, overloaded: true });
      continue;
    }
    pending.push({ id: command.id, writer: command.writer });
    if (!draining) {
      draining = true;
      setImmediate(drain);
    }
  }
  while (pending.length > 0 && failed() === undefined) await sleep(1);
  const failure = failed();
  if (failure !== undefined) throw failure;
}

const roles: Record<Role, () => Promise<void>> = { writer, reader, maintenance, queue };
roles[config.role]().catch((error: unknown) => {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
});
