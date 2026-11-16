// The run host tests' stand-in service: a process that hosts runs as the real service does (the
// run host over a fixture space's database, real containers and run folders), so a test can kill
// it by force mid run and start another on the same space. It runs where harness.ts runs: in a
// delegated user unit on Linux, as a plain child of the test on Windows.
//
//   node run-service.ts [<tasks-run.exe>] <config as JSON>
//
// The config names the fixture space (createLaunchSpace), the state folder for the run folders,
// tasks-run.exe on Windows, and the host's times. It reads one JSON request per line on stdin and
// answers each on stdout, in order:
//   {"op":"hello"}                          -> {"pid":<n>}
//   {"op":"recover"}                        -> the runs it looked at, by ID and state
//   {"op":"start","mode","token","maxMs"?}  -> the run's ID, once its record is `starting`
//   {"op":"stop","run"}                     -> the record after the Stop
//   {"op":"forceEnd","run"}                 -> the record after End by force
//   {"op":"read","run"}                     -> the record
//   {"op":"ended","run"}                    -> the record, once the host's work on it is over
// Every answer is {"ok":true,"result":…} or {"ok":false,"error":"…"}.
//
// safe-exit comes first: this script loads the product's code and ends through process.exit.
import "@tasks/bridge/safe-exit";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SpaceExecutionStore } from "@tasks/launch";
import { openLaunchSpaceAt, type LaunchSpaceFolder } from "@tasks/testkit";
import {
  containers,
  RunFiles,
  RunHost,
  RunMachine,
  RUNS_FOLDER,
  type RunTimes,
} from "../../src/index.ts";
import { standInSpec, type StandInMode } from "./stand-ins.ts";

interface Config {
  readonly space: LaunchSpaceFolder;
  readonly state: string;
  readonly helper?: string;
  readonly times?: Partial<RunTimes>;
}

const config = JSON.parse(process.argv.at(-1) ?? "{}") as Config;
const space = await openLaunchSpaceAt(config.space, { now: Date.now });
const store = new SpaceExecutionStore({
  writer: space.writer,
  spaceId: space.spaceId,
  credential: space.credential,
});
const machine = new RunMachine({ store, machine: space.machine });
const host = new RunHost({
  machine,
  containers: containers(config.helper === undefined ? {} : { runHelper: config.helper }),
  files: new RunFiles(join(config.state, RUNS_FOLDER)),
  ...(config.times === undefined ? {} : { times: config.times }),
});
let requests = 0;

interface Request {
  op: string;
  run?: string;
  mode?: StandInMode;
  token?: string;
  maxMs?: number;
}

const brief = (run: { id: string; state: string; reason: string | null } | undefined) =>
  run === undefined ? null : run;

async function handle(request: Request): Promise<unknown> {
  const id = request.run ?? "";
  switch (request.op) {
    case "hello":
      return { pid: process.pid };
    case "recover":
      return (await host.recover()).map((run) => ({ id: run.id, state: run.state }));
    case "start": {
      requests += 1;
      const queued = await machine.queue(
        {
          task: await space.task(),
          routine: null,
          instance: "claude-work",
          adapter: "claude-print",
          place: null,
          request: "Find the cause.",
          briefHash: "0a1b2c3d".repeat(8),
          permission: "auto-edit",
          limits: { maxTurns: 50, wallMs: 10 * 60_000, idleMs: 10 * 60_000 },
        },
        `run-service-${String(process.pid)}-${String(requests).padStart(6, "0")}`,
      );
      const mode = request.mode ?? "talk";
      const token = request.token ?? "";
      await host.start(queued.id, (run) => {
        const spec = standInSpec(run.id, mode, token, {
          ...(request.maxMs === undefined ? {} : { maxMs: request.maxMs }),
        });
        return { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env };
      });
      return { run: queued.id };
    }
    case "stop":
      return brief(await host.stop(id));
    case "forceEnd":
      return brief(await host.forceEnd(id));
    case "read":
      return brief(await machine.read(id));
    case "ended":
      return brief(await host.ended(id));
    default:
      throw new Error(`unknown op ${request.op}`);
  }
}

// Requests are answered in order, one at a time; `ended` waits, so it does not block the others.
let queue = Promise.resolve();
const requestsIn = createInterface({ input: process.stdin, crlfDelay: Infinity });
requestsIn.on("close", () => {
  void queue.then(async () => {
    await host.close();
    space.close();
    process.exit(0);
  });
});
requestsIn.on("line", (line) => {
  const request = JSON.parse(line) as Request;
  const answer = handle(request).then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  queue = queue.then(async () => {
    process.stdout.write(`${JSON.stringify(await answer)}\n`);
  });
});
