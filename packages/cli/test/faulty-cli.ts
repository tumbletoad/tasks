// A test's ttasks command with a fault (A7 3.8 M1.10's Verify line): the real CLI, with its rpc
// session wrapped. TTASKS_TEST_FAULT=lose-write loses the reply of a write after the service has
// applied it, as a connection dropped at that moment would. TTASKS_TEST_FAULT=trace prints the
// operation of every op/call on stderr, so a test sees which reads a retry made. Tests only.
import { LocalError } from "@ttasks/bridge/protocol";
import { CLI_SPEC } from "../src/args.ts";
import type { Session } from "../src/connect.ts";
import { main } from "../src/main.ts";
import { processIo } from "../src/process-io.ts";

const fault = process.env["TTASKS_TEST_FAULT"];
const writes = new Set(CLI_SPEC.verbs.filter((v) => v.kind === "write").map((v) => v.entry));

const wrap = (session: Session): Session => ({
  bound: session.bound,
  close: () => {
    session.close();
  },
  call: async (...args: Parameters<Session["call"]>) => {
    const [method, params] = args;
    const op = method === "op/call" ? String(params?.["op"]) : undefined;
    if (fault === "trace" && op !== undefined) process.stderr.write(`trace ${op}\n`);
    const result = await session.call(...args);
    if (fault === "lose-write" && op !== undefined && writes.has(op)) {
      throw new LocalError("connection_lost", "test_lost_reply");
    }
    return result;
  },
});

process.exitCode = await main(processIo(), { wrap });
