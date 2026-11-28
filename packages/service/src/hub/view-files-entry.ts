// The readable files' worker of a tree space (view-files.ts): it opens a reader of the space and
// keeps the space's `view/` equal to a fresh render until it is asked to stop. It writes nothing to
// the space. Counts and codes go back, never a path or a task's text.
//
// A rebuild is handed to the loop, which takes it after its start and runs it as its next pass, so
// a rebuild shares the start's recovery, the order of passes and their retry.
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
/** A rebuild asked for and not yet taken by the loop. */
let asked = false;
port.on("message", (command: FilesCommand) => {
  if (command.kind === "stop") stopping = true;
  else asked = true;
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
      takeRebuild: () => {
        const taken = asked;
        asked = false;
        return taken;
      },
      onRebuilt: ({ checked: files, suspect, error }) => {
        send(
          error === undefined
            ? { kind: "rebuilt", checked: files, rewritten: suspect }
            : { kind: "rebuilt", checked: files, rewritten: suspect, code: codeOf(error) },
        );
      },
      onStart: (report) => {
        send({ kind: "started", report });
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
