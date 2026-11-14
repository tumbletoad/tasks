// A child process for the output deadline's test: serves one rpc connection whose reply cannot
// reach a client that reads nothing, waits until the connection's real output deadline runs,
// ends the connection (argv[3]: "peer" closes it, "server" closes the server and so destroys
// it), closes everything else and prints what became of the deadline. It never calls
// process.exit: the test checks that nothing left behind keeps the process alive. argv[2] is the
// endpoint path. Tests only.
import { connect } from "@tasks/bridge/protocol";
import { clientInfo, testKey, until } from "@tasks/bridge/test/endpoint";
import { serve, type LocalEvent } from "../src/local/index.ts";
import { testClock } from "./clock.ts";
import { INSTANCE } from "./local.ts";

const [path = "", ending = ""] = process.argv.slice(2);
const MiB = 1024 * 1024;
const key = testKey();
const clock = testClock();
const events: LocalEvent[] = [];
let produced = false;
const server = await serve({
  path,
  key,
  instance: INSTANCE,
  service: { version: "0.0.0-test", build: "test" },
  // A reply far larger than the OS buffers, and a deadline far longer than the test waits.
  limits: { outputStallMs: 60_000, maxLineBytes: 32 * MiB },
  handlers: {
    "op/call": () => {
      produced = true;
      return "x".repeat(16 * MiB);
    },
  },
  timers: clock.timers,
  log: (event) => events.push(event),
});
const connected = await connect({ path, key, mode: "rpc", client: clientInfo(), context: {} });
connected.socket.pause();
connected.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "op/call" })}\n`);
// The reply is written in the turn its handler returns, and it cannot all fit.
await until(() => produced && clock.live({ kind: "output", conn: 1 }).length === 1, 20_000);
if (ending === "peer") {
  connected.socket.destroy();
  await until(() => server.connectionCount === 0, 20_000);
  await server.close();
} else {
  await server.close();
  // The test's own client: a paused socket may not see the close, so it is ended here.
  connected.socket.destroy();
}
const output = clock.find({ kind: "output", conn: 1 }).map((timer) => timer.state);
process.stdout.write(
  `${JSON.stringify({
    output: output.every((state) => state === "cleared") ? "cleared" : output.join(","),
    live: clock.live().length,
    slowReader: events.some((event) => event.ev === "local.slow_reader"),
  })}\n`,
);
