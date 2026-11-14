// A child process for the lock race test: on `{go, path}` it waits for the start time, takes the
// lock with acquireLock() and reports whether it won. On `release` it gives the lock up. Tests only.
import { acquireLock, LockBusy, type HeldLock } from "../src/hub/lock.ts";

let held: HeldLock | undefined;

process.on("message", (message: { go?: number; path?: string; release?: true; exit?: true }) => {
  if (message.go !== undefined && message.path !== undefined) {
    const path = message.path;
    while (Date.now() < message.go) {
      // Every racer starts at the same moment.
    }
    acquireLock(path).then(
      (lock) => {
        held = lock;
        process.send?.({ won: true });
      },
      (error: unknown) => {
        process.send?.({ won: false, busy: error instanceof LockBusy });
      },
    );
  } else if (message.release === true) {
    held?.release();
    held = undefined;
    process.send?.({ released: true });
  } else if (message.exit === true) {
    process.exit(0);
  }
});
