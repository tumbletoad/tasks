// A test's `tasks serve`: the real runServe() in a child process, with the identity set by the
// test: CI's Windows runners are elevated, and the real check would refuse there (exit 64). The
// package identity still comes from the real TASKS_PACKAGE. main.ts, with the real check, has its
// own test. The registered spaces come from the install's machine.toml, as in the product
// (harness.ts registerSpaces).
//
// Lines on stdin drive it: `stop` raises SIGTERM's handler (a graceful stop on every OS, where
// Windows has no signal), `crash <text>` throws an uncaught error with that message, `reject
// <text>` leaves a rejected promise unhandled. Tests only.
// First, as in the product's entries: this script ends through process.exit (A2 3.12.1).
import "@tasks/bridge/safe-exit";
import { createInterface } from "node:readline";
import { packageIdentity } from "../src/hub/identity.ts";
import { runServe } from "../src/hub/serve.ts";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const [command = "", ...rest] = line.split(" ");
  const text = rest.join(" ");
  if (command === "stop") process.emit("SIGTERM", "SIGTERM");
  if (command === "crash") {
    setImmediate(() => {
      throw new Error(text);
    });
  }
  if (command === "reject") void Promise.reject(new Error(text));
});

// The UI's listener runs as in the product, on a port the OS chooses (never 7713 to 7733 on a
// developer's machine), and machine.toml is not written unless the test set its own [http] port.
const code = await runServe({
  identity: () => ({ root: false, elevated: false, package: packageIdentity(process.env) }),
  http: { ports: [0], persist: false },
});
process.exit(code);
