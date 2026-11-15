// A second process for the cross-process writer lock tests (A2 3.4). Tests only.
//
//   writer <folder> <machine JSON>  holds the space's writer through a StorageWorker
//   lock <file>                     tries the lock file once (takeFileLock), and holds it if it got it
//
// It prints one JSON line when it is ready, `{"ready": true}` or `{"ready": false, "code": …}`,
// then waits: the line `close` on stdin closes what it holds, prints `{"closed": true}` and exits 0.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "../../bridge/src/safe-exit.ts";
import { createInterface } from "node:readline";
import { DEFAULT_DRIVER, loadDriver } from "../src/drivers.ts";
import { StorageError } from "../src/errors.ts";
import { StorageWorker, type SpaceWriterHandle } from "../src/worker/client.ts";
import type { MachineInfo } from "../src/write/writer.ts";
import { SpaceLockedElsewhere, takeFileLock, type FileLock } from "../src/writer-lock.ts";

/** What the child's writer.json says of it besides its machine. writer-lock.test.ts expects it. */
const CHILD_HOLDER = { instance: "child-instance", stateDir: "/child/state" } as const;

const [mode = "", target = "", machineJson = "{}"] = process.argv.slice(2);
const say = (value: object): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let close: () => Promise<void> = () => Promise.resolve();

if (mode === "writer") {
  const worker = await StorageWorker.start({ driver: DEFAULT_DRIVER });
  let writer: SpaceWriterHandle | undefined;
  try {
    writer = await worker.openSpaceWriter(target, {
      machine: JSON.parse(machineJson) as MachineInfo,
      holder: CHILD_HOLDER,
    });
    say({ ready: true });
  } catch (error) {
    say({
      ready: false,
      code: error instanceof StorageError ? error.code : "unknown",
      ...(error instanceof SpaceLockedElsewhere ? { holder: error.holder } : {}),
    });
  }
  close = async () => {
    await writer?.close();
    await worker.close();
  };
} else if (mode === "lock") {
  const lock: FileLock | undefined = await takeFileLock(await loadDriver(DEFAULT_DRIVER), target);
  say(lock === undefined ? { ready: false, code: "busy" } : { ready: true });
  close = () => {
    lock?.release();
    return Promise.resolve();
  };
} else {
  say({ ready: false, code: "mode" });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line !== "close") return;
  void close().then(() => {
    say({ closed: true });
    process.exit(0);
  });
});
