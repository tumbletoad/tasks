// The container tests' stand-in service: a process that owns containers, so a test can kill it by
// force as a crash would. On Linux it runs as the main process of a transient user unit with
// Delegate=yes, as the real service runs in its unit; on Windows it is a plain child of the test.
//
//   node harness.ts [<ttasks-run.exe> | ungrouped [<taskkill.exe>]]
//
// It reads one JSON request per line on stdin and answers each on stdout, in order:
//   {"op":"hello"}                                  -> {"pid":<n>}
//   {"op":"probe"}                                  -> the probe result
//   {"op":"start","name","mode","token","maxMs"?,"args"?} -> {"pid":<agent>}
//   {"op":"interrupt","name"}                       -> {"delivered":<bool>}
//   {"op":"kill","name"}                            -> {}
//   {"op":"confirm","name","waitMs"?}               -> the confirmation
//   {"op":"recover","name","waitMs"?}               -> the confirmation
//   {"op":"exited","name"}                          -> the agent's exit, once it has one
//   {"op":"output","name"}                          -> {"bytes","head","ended"}: its stdout so far
//   {"op":"write","name","text"}                    -> {}: `text` written to the agent's stdin
//   {"op":"endStdin","name"}                        -> {}: the agent's stdin ended
//   {"op":"forget"}                                 -> {}: drops what it knows of its containers,
//                                                      as a restarted service would have nothing
// Every answer is {"ok":true,"result":…} or {"ok":false,"error":"…","code"?:"…"}.
//
// safe-exit comes first: this script loads the product's code and ends through process.exit.
import "@ttasks/bridge/safe-exit";
import { createInterface } from "node:readline";
import {
  ContainerError,
  containers,
  UngroupedContainers,
  type AgentExit,
  type Containers,
} from "../../src/container/index.ts";
import { standInSpec, type StandInMode } from "./stand-ins.ts";

interface Output {
  bytes: number;
  head: Buffer;
  ended: boolean;
}

const helper = process.argv[2];
const taskkill = process.argv[3];
const make = (): Containers =>
  helper === "ungrouped"
    ? new UngroupedContainers(taskkill === undefined ? {} : { taskkill })
    : containers(helper === undefined ? {} : { runHelper: helper });
let box = make();
const exits = new Map<string, Promise<AgentExit>>();
const outputs = new Map<string, Output>();
const inputs = new Map<string, NodeJS.WritableStream>();

type Request = {
  op: string;
  name?: string;
  mode?: StandInMode;
  token?: string;
  maxMs?: number;
  args?: string[];
  waitMs?: number;
  text?: string;
};

async function handle(request: Request): Promise<unknown> {
  const name = request.name ?? "";
  const wait = request.waitMs === undefined ? {} : { waitMs: request.waitMs };
  switch (request.op) {
    case "hello":
      return { pid: process.pid };
    case "probe":
      return box.probe();
    case "start": {
      const spec = standInSpec(name, request.mode ?? "behave", request.token ?? "", {
        ...(request.maxMs === undefined ? {} : { maxMs: request.maxMs }),
        ...(request.args === undefined ? {} : { args: request.args }),
      });
      const started = await box.start(spec);
      const output: Output = { bytes: 0, head: Buffer.alloc(0), ended: false };
      outputs.set(name, output);
      started.stdout.on("data", (chunk: Buffer) => {
        output.bytes += chunk.length;
        if (output.head.length < 4096) output.head = Buffer.concat([output.head, chunk]);
      });
      started.stdout.on("end", () => {
        output.ended = true;
      });
      started.stderr.resume();
      exits.set(name, started.exited);
      inputs.set(name, started.stdin);
      return { pid: started.pid };
    }
    case "interrupt":
      return { delivered: await box.interrupt(name) };
    case "kill":
      await box.kill(name);
      return {};
    case "confirm":
      return box.confirmEmpty(name, wait);
    case "recover":
      return box.recover(name, wait);
    case "exited":
      return exits.get(name) ?? null;
    case "output": {
      const output = outputs.get(name);
      if (output === undefined) return null;
      const head = output.head.subarray(0, 4096).toString("utf8");
      return { bytes: output.bytes, head, ended: output.ended };
    }
    case "write":
      inputs.get(name)?.write(request.text ?? "");
      return {};
    case "endStdin":
      inputs.get(name)?.end();
      return {};
    case "forget":
      box = make();
      exits.clear();
      outputs.clear();
      inputs.clear();
      return {};
    default:
      throw new Error(`unknown op ${request.op}`);
  }
}

// Requests are answered in order, one at a time. When stdin closes, the test is done with it.
let queue = Promise.resolve();
const requests = createInterface({ input: process.stdin, crlfDelay: Infinity });
requests.on("close", () => {
  void queue.then(() => process.exit(0));
});
requests.on("line", (line) => {
  queue = queue.then(async () => {
    let answer: unknown;
    try {
      answer = { ok: true, result: await handle(JSON.parse(line) as Request) };
    } catch (error) {
      answer = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ContainerError ? { code: error.code } : {}),
      };
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
});
