// The projection worker's entry (A1 3.9's maintenance worker, A1 3.13): one space's projection,
// off the main thread, which holds no SQLite connection. It opens a reader of the space, runs the
// projection until it is asked to stop, and reaches the space's writer only through the main
// thread (projection.ts). Counts and codes go back, never a path or a task's text.
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
let next = 1;
const waiting = new Map<number, { resolve: (value: number) => void; reject: (e: Error) => void }>();
port.on("message", (command: ProjectionCommand) => {
  if (command.kind === "stop") {
    stopping = true;
    return;
  }
  const pending = waiting.get(command.id);
  if (pending === undefined) return;
  waiting.delete(command.id);
  if (command.ok) pending.resolve(command.value);
  else pending.reject(new ProjectionError(command.code, "The space's writer refused"));
});

const call = (method: "projected" | "queue", batch?: ProjectedBatch): Promise<number> =>
  new Promise((resolve, reject) => {
    const id = next;
    next += 1;
    waiting.set(id, { resolve, reject });
    send(
      method === "projected" && batch !== undefined
        ? { kind: "call", id, method, batch }
        : { kind: "call", id, method: "queue" },
    );
  });

try {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const opened = openSpace(checked, job.folder, { role: "reader" });
  try {
    const projector = new Projector({
      conn: opened.conn,
      spaceFolder: job.folder,
      dir: job.dir,
      writer: {
        projected: (batch) => call("projected", batch),
        queueProjection: () => call("queue"),
      },
    });
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
