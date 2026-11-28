// The readable files' worker of a tree space (view-files.ts): it opens a reader of the space and keeps
// the space's `view/` equal to a fresh render until it is asked to stop. It writes nothing to the
// space. Counts and codes go back, never a path or a task's text.
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { codeOf, FilesProjector, runFiles } from "@ttasks/projection";
import { CheckedDriver, DEFAULT_DRIVER, loadDriver, openSpace } from "@ttasks/storage";
import type { FilesCommand, FilesJob, FilesMessage } from "./view-files.ts";

const port = parentPort;
if (port === null) throw new Error("The readable files run in a worker thread");
const job = workerData as FilesJob;
const send = (message: FilesMessage): void => {
  port.postMessage(message);
};

let stopping = false;
/** The projector, once its start settled what a kill left: no pass runs before that. */
let ready: FilesProjector | undefined;
/** A rebuild asked for before the start: it runs once the start is done. */
let asked = false;

/**
 * `ttasks view rebuild`: every file read, and a pass at once that writes again what is missing or
 * different. Between the loop's steps: both are synchronous, so no pass runs beside it.
 */
function rebuild(p: FilesProjector): void {
  const t0 = performance.now();
  try {
    const suspect = p.check();
    const checked = p.size;
    const report = p.pass();
    send({ kind: "pass", report, ms: Math.round(performance.now() - t0) });
    send({ kind: "rebuilt", checked, suspect });
  } catch (error) {
    send({ kind: "error", code: codeOf(error) });
    send({ kind: "rebuilt", checked: 0, suspect: 0 });
  }
}

port.on("message", (command: FilesCommand) => {
  if (command.kind === "stop") {
    stopping = true;
    return;
  }
  if (ready === undefined) asked = true;
  else rebuild(ready);
});

try {
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const opened = openSpace(checked, job.folder, { role: "reader" });
  try {
    const projector = new FilesProjector({
      conn: opened.conn,
      machine: job.machine,
      dir: join(job.folder, "view"),
      spaceFolder: job.folder,
      record: job.record,
    });
    await runFiles(projector, {
      stopped: () => stopping,
      onStart: (report) => {
        send({ kind: "started", report });
        ready = projector;
        if (asked) {
          asked = false;
          rebuild(projector);
        }
      },
      onPass: (report, ms) => {
        send({ kind: "pass", report, ms });
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
