// The run host tests' stand-in service: a process that hosts runs as the real service does (the
// run host and the supervisor over a fixture space's database, real process groups and run folders),
// so a test can kill it by force mid run and start another on the same space. It runs where
// harness.ts runs: in a delegated user unit on Linux, as a plain child of the test on Windows.
//
//   node run-service.ts [<ttasks-run.exe>] <config as JSON>
//
// The config names the fixture space (createLaunchSpace), the state folder for the run folders,
// ttasks-run.exe on Windows, the host's times and the queue's limits (default: none that a test of a
// single run meets). It reads one JSON request per
// line on stdin and answers each on stdout, in order:
//   {"op":"hello"}                          -> {"pid":<n>}
//   {"op":"recover"}                        -> the runs it looked at, by ID and state
//   {"op":"start","mode","token","maxMs"?}  -> the run's ID, once its record is `starting` or later
//   {"op":"queue","mode","token","wallMs"?,"idleMs"?}
//                                           -> the run's ID, queued for the supervisor to start
//   {"op":"waiting","run"}                  -> why a queued run waits, or null
//   {"op":"hold"} / {"op":"release"}        -> an update's hold on new starts, taken or let go
//   {"op":"blocking"}                       -> the runs an update would cut short
//   {"op":"stopAll"}                        -> those left after a Stop of every one of them
//   {"op":"stop","run"}                     -> the record after the Stop
//   {"op":"forceEnd","run"}                 -> the record after End by force
//   {"op":"read","run"}                     -> the record
//   {"op":"ended","run"}                    -> the record, once it is final
// Every answer is {"ok":true,"result":…} or {"ok":false,"error":"…"}.
//
// safe-exit comes first: this script loads the product's code and ends through process.exit.
import "@ttasks/bridge/safe-exit";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SpaceExecutionStore } from "@ttasks/launch";
import { openLaunchSpaceAt, type LaunchSpaceFolder } from "@ttasks/testkit";
import {
  processGroups,
  QUEUE_LIMITS,
  RunFiles,
  RunHost,
  RunMachine,
  RUNS_FOLDER,
  Supervisor,
  type AgentCommand,
  type Hold,
  type Lane,
  type QueueLimits,
  type RunTimes,
} from "../../src/index.ts";
import { standInSpec, type StandInMode } from "./stand-ins.ts";

interface Config {
  readonly space: LaunchSpaceFolder;
  readonly state: string;
  readonly helper?: string;
  readonly times?: Partial<RunTimes>;
  readonly limits?: QueueLimits;
}

const config = JSON.parse(process.argv.at(-1) ?? "{}") as Config;
const space = await openLaunchSpaceAt(config.space, { now: Date.now });
const store = new SpaceExecutionStore({
  writer: space.writer,
  spaceId: space.spaceId,
  credential: space.credential,
});
const machine = new RunMachine({ store, machine: space.machine });
const files = new RunFiles(join(config.state, RUNS_FOLDER));
const host = new RunHost({
  machine,
  groups: processGroups(config.helper === undefined ? {} : { runHelper: config.helper }),
  files,
  ...(config.times === undefined ? {} : { times: config.times }),
});
const lane: Lane = { space: space.spaceId, machine, host };
const commands = new Map<string, AgentCommand>();
const supervisor = new Supervisor({
  lanes: () => [lane],
  limits: () => config.limits ?? { ...QUEUE_LIMITS, runs: 10, perInstance: 10, perTask: 10 },
  prepare: (_lane, run) => {
    const command = commands.get(run.id);
    commands.delete(run.id);
    return Promise.resolve(
      command === undefined ? { refused: "spawn_failed" as const } : { command: () => command },
    );
  },
  folders: files,
});
const holds: Hold[] = [];
let requests = 0;

interface Request {
  op: string;
  run?: string;
  mode?: StandInMode;
  token?: string;
  maxMs?: number;
  wallMs?: number;
  idleMs?: number;
}

const brief = (run: { id: string; state: string; reason: string | null } | undefined) =>
  run === undefined ? null : run;

async function queue(request: Request): Promise<string> {
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
      limits: {
        maxTurns: 50,
        wallMs: request.wallMs ?? 10 * 60_000,
        idleMs: request.idleMs ?? 10 * 60_000,
      },
    },
    `run-service-${String(process.pid)}-${String(requests).padStart(6, "0")}`,
  );
  const spec = standInSpec(queued.id, request.mode ?? "talk", request.token ?? "", {
    ...(request.maxMs === undefined ? {} : { maxMs: request.maxMs }),
  });
  commands.set(queued.id, { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env });
  return queued.id;
}

async function handle(request: Request): Promise<unknown> {
  const id = request.run ?? "";
  switch (request.op) {
    case "hello":
      return { pid: process.pid };
    case "recover":
      return (await host.recover()).map((run) => ({ id: run.id, state: run.state }));
    case "start": {
      const run = await queue(request);
      await supervisor.round();
      return { run };
    }
    case "queue": {
      const run = await queue(request);
      await supervisor.round();
      return { run };
    }
    case "waiting":
      return supervisor.waiting(id) ?? null;
    case "hold":
      holds.push(supervisor.hold());
      await supervisor.round();
      return null;
    case "release":
      holds.shift()?.release();
      await supervisor.round();
      return null;
    case "blocking":
      return await supervisor.blocking();
    case "stopAll":
      return await supervisor.stopAll();
    case "stop": {
      const after = brief(await host.stop(id));
      void supervisor.round();
      return after;
    }
    case "forceEnd":
      return brief(await host.forceEnd(id));
    case "read":
      return brief(await machine.read(id));
    case "ended":
      return brief(await supervisor.ended(lane, id));
    default:
      throw new Error(`unknown op ${request.op}`);
  }
}

// Requests are answered in order, one at a time; `ended` waits, so it does not block the others.
let answered = Promise.resolve();
const requestsIn = createInterface({ input: process.stdin, crlfDelay: Infinity });
requestsIn.on("close", () => {
  void answered.then(async () => {
    supervisor.close();
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
  answered = answered.then(async () => {
    process.stdout.write(`${JSON.stringify(await answer)}\n`);
  });
});
