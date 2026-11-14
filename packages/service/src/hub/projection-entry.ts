// The projection worker's entry (A1 3.9's maintenance worker, A1 3.13): one space's projection,
// off the main thread, which holds no SQLite connection. It opens a reader of the space, runs the
// projection into the space's `view/` until it is asked to stop, and reaches the space's writer
// only through the main thread (projection.ts). Counts and codes go back, never a path or a task's
// text.
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { codeOf, ProjectionError, Projector, runProjection } from "@tasks/projection";
import {
  CheckedDriver,
  DEFAULT_DRIVER,
  loadDriver,
  openSpace,
  type ProjectedBatch,
} from "@tasks/storage";
import type { ProjectionCommand, ProjectionJob, ProjectionMessage } from "./projection.ts";

const port = parentPort;
if (port === null) throw new Error("The projection runs in a worker thread");
const job = workerData as ProjectionJob;
const send = (message: ProjectionMessage): void => {
  port.postMessage(message);
};

let stopping = false;
let projector: Projector | undefined;
/** A rebuild asked for before the projector exists: it runs once it does. */
const asked = { rebuild: false };
let next = 1;
const waiting = new Map<number, { resolve: (value: number) => void; reject: (e: Error) => void }>();
port.on("message", (command: ProjectionCommand) => {
  if (command.kind === "stop") {
    stopping = true;
    return;
  }
  if (command.kind === "rebuild") {
    if (projector === undefined) asked.rebuild = true;
    else projector.rebuild();
    return;
  }
  const pending = waiting.get(command.id);
  if (pending === undefined) return;
  waiting.delete(command.id);
  if (command.ok) pending.resolve(command.value);
  else pending.reject(new ProjectionError(command.code, "The space's writer refused"));
});

/** One call to the space's writer through the main thread: `message` gets the call's ID. */
const call = (message: (id: number) => ProjectionMessage): Promise<number> =>
  new Promise((resolve, reject) => {
    const id = next;
    next += 1;
    waiting.set(id, { resolve, reject });
    send(message(id));
  });

try {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const opened = openSpace(checked, job.folder, { role: "reader" });
  try {
    projector = new Projector({
      conn: opened.conn,
      spaceFolder: job.folder,
      dir: join(job.folder, "view"),
      record: job.record,
      journal: job.journal,
      writer: {
        projected: (batch: ProjectedBatch) =>
          call((id) => ({ kind: "call", id, method: "projected", batch })),
        queueProjection: (keys?: readonly string[]) =>
          call((id) => ({
            kind: "call",
            id,
            method: "queue",
            ...(keys === undefined ? {} : { keys }),
          })),
      },
    });
    if (asked.rebuild) projector.rebuild();
    await runProjection(projector, {
      stopped: () => stopping,
      onStart: (report) => {
        send({ kind: "started", report });
      },
      onStep: (report, ms) => {
        send({ kind: "step", report, ms });
      },
      onError: (error) => {
        send({ kind: "error", code: codeOf(error) });
      },
    });
  } finally {
    opened.conn.close();
  }
} catch (error) {
  send({ kind: "error", code: codeOf(error) });
}
// Nothing keeps the thread alive now: it ends, and the main thread sees it exit.
port.unref();
