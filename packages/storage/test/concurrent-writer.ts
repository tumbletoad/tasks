// One of the writers for the backup test of A7 M1.06's Verify line ("a backup taken under 10
// writers"). It runs in its own worker thread with its own connection and the real write path
// (M1.04's SpaceWriter, opened in-thread as the testkit does), and creates one task per request
// until the test sets the stop flag. Ten of them commit through ten connections at once, so their
// transactions interleave in SQLite while the backup copies its snapshot. Each request writes one
// commit, one task and its `create` change, and moves last_seq.
import { parentPort, workerData } from "node:worker_threads";
import { isId } from "../src/ids.ts";
import { nodeSqliteDriver } from "../src/node-sqlite.ts";
import { openSpace } from "../src/space.ts";
import { CheckedDriver } from "../src/startup-check.ts";
import { SpaceWriter } from "../src/write/writer.ts";
import { createRequest, FIXTURE_MACHINE, ownerCredential } from "./fixture-requests.ts";

export interface ConcurrentWriterData {
  folder: string;
  writer: number;
  /**
   * Int32 slots: [0] the stop flag, [1] how many writers are open, [2] the start flag, [3 + writer]
   * this writer's commits so far.
   */
  control: SharedArrayBuffer;
}

/** The slots before the writers' own: stop, open, start (backup.test.ts counts the same). */
const CONTROL_SLOTS = 3;

const { folder, writer: index, control } = workerData as ConcurrentWriterData;
const slots = new Int32Array(control);
const checked = await CheckedDriver.check(nodeSqliteDriver);
const opened = openSpace(checked, folder, { role: "writer", busyTimeoutMs: 60_000 });
const owner = opened.conn.prepare("SELECT id FROM actors WHERE kind = 'human'").get()?.["id"];
const writer = SpaceWriter.open(opened, { machine: FIXTURE_MACHINE });
try {
  if (!isId(owner, "ac")) throw new Error("the fixture space has no owner");
  const actor = ownerCredential(owner, `cli:writer-${String(index)}`);
  // Open, with the machine registered. The loops start together once every writer is open: an
  // open's write waiting behind writers already in their loops could starve past its busy
  // timeout on a loaded machine, since SQLite's busy handler is not fair.
  Atomics.add(slots, 1, 1);
  while (Atomics.load(slots, 2) === 0 && Atomics.load(slots, 0) === 0) {
    Atomics.wait(slots, 2, 0, 50);
  }
  let commits = 0;
  while (Atomics.load(slots, 0) === 0) {
    const result = writer.submit(
      createRequest(writer.spaceId, actor, `Writer ${String(index)} task ${String(commits)}`),
    );
    if (result.status !== "applied") throw new Error(`a write was ${result.status}`);
    commits += 1;
    Atomics.store(slots, CONTROL_SLOTS + index, commits);
    // A short pause between transactions. SQLite's busy handler is not fair: without it, writers
    // in tight loops can keep one waiting writer from ever getting the lock (seen on Linux).
    Atomics.wait(slots, 0, 0, 5);
  }
  parentPort?.postMessage({ commits });
} finally {
  writer.close();
}
