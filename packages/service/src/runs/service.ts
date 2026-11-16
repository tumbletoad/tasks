// Background runs in the service: at start, the probe of this machine's containers (on Linux it is
// also when the service moves itself into its unit's `main` cgroup), then for each space open as
// this machine's a run host over its execution store, whose recovery settles the space's open runs
// before any of them is hosted again. A run starts only through `start`, an internal call: no
// person or agent can start one yet.
import { dirname, join } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import type { NewRun, RunRecord } from "@tasks/contracts/runs";
import { SpaceExecutionStore } from "@tasks/launch";
import {
  containers as platformContainers,
  RUN_HELPER,
  RunFiles,
  RunHost,
  RunMachine,
  RUNS_FOLDER,
  type AgentCommand,
  type Containers,
  type ProbeResult,
  type RunHostLog,
  type RunTimes,
} from "@tasks/runs";
import { errorCode, errorType } from "../hub/crash.ts";
import type { Logger } from "../hub/log.ts";
import type { ServedSpace } from "../ops/index.ts";

/** What a start of the service may set for runs. Tests pass their containers or times. */
export interface RunOptions {
  /** This platform's containers. Default: the cgroup or job containers (`containers()`). */
  readonly containers?: Containers;
  /** Windows: tasks-run.exe. Default: the one in this version folder's `bin`. */
  readonly runHelper?: string;
  readonly times?: Partial<RunTimes>;
}

export interface RunServiceOptions extends RunOptions {
  /** This machine (`m_` ID). */
  readonly machine: string;
  /** The install's machine state folder: run folders go in `<state>/runs`. */
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly spaces: () => readonly ServedSpace[];
  readonly log: Logger;
}

/** How often spaces that opened since are recovered. */
const ROUND_MS = 30_000;

interface Hosted {
  readonly writer: unknown;
  readonly made: Promise<{ host: RunHost; machine: RunMachine }>;
}

/** Runs cannot start here; the message says why, for the person. */
export class RunsUnavailable extends Error {
  override readonly name = "RunsUnavailable";
}

/**
 * tasks-run.exe beside the launchers of the version folder this Node runs from
 * (`<version>/runtime/node.exe`, `<version>/bin/tasks-run.exe`).
 */
export const defaultRunHelper = (execPath: string = process.execPath): string =>
  join(dirname(execPath), "..", "bin", RUN_HELPER);

export class RunService {
  readonly #options: RunServiceOptions;
  readonly #containers: Containers;
  readonly #files: RunFiles;
  readonly #hosted = new Map<string, Hosted>();
  #probe: Promise<ProbeResult> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #round: Promise<void> | undefined;
  #stopped = false;

  constructor(options: RunServiceOptions) {
    this.#options = options;
    this.#containers =
      options.containers ??
      platformContainers({
        platform: options.platform,
        runHelper: options.runHelper ?? defaultRunHelper(),
      });
    this.#files = new RunFiles(join(options.stateDir, RUNS_FOLDER));
  }

  /** Probes this machine's containers once; later calls return the same answer. */
  probe(): Promise<ProbeResult> {
    this.#probe ??= this.#containers.probe().then(
      (result) => {
        this.#options.log.log(
          "runs.probe",
          result.available
            ? { available: true, kind: result.kind }
            : { available: false, reason: result.reason },
        );
        return result;
      },
      (error: unknown) => {
        this.#failed("probe", error);
        return {
          available: false,
          reason: "check_failed",
          message: `${PRODUCT_NAME} could not check whether runs can be contained here.`,
        };
      },
    );
    return this.#probe;
  }

  /** Recovers every open space now and every 30 s the spaces that opened since. */
  watch(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, ROUND_MS);
    this.#timer.unref();
    void this.tick();
  }

  /** One round: a host, with its recovery, for every space that opened since. */
  tick(): Promise<void> {
    this.#round ??= (async () => {
      try {
        for (const space of this.#options.spaces().filter(isOpen)) {
          await this.#space(space.id ?? "").catch(() => undefined);
        }
      } finally {
        this.#round = undefined;
      }
    })();
    return this.#round;
  }

  /** Ends hosting: the containers of live runs are killed; the next start settles their runs. */
  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const hosts = await Promise.all(
      [...this.#hosted.values()].map((hosted) => hosted.made.catch(() => undefined)),
    );
    await Promise.all(hosts.map((made) => made?.host.close() ?? Promise.resolve()));
  }

  /**
   * Queues a run and starts it in its container with `command`. Internal: nothing reaches it from
   * a person or an agent yet. Throws RunsUnavailable when runs cannot be contained here.
   */
  async start(
    space: string,
    input: Omit<NewRun, "machine">,
    requestId: string,
    command: (run: RunRecord) => AgentCommand | Promise<AgentCommand>,
  ): Promise<RunRecord | undefined> {
    const probe = await this.probe();
    if (!probe.available) throw new RunsUnavailable(probe.message);
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    const queued = await hosted.machine.queue(input, requestId);
    return hosted.host.start(queued.id, command);
  }

  /** The person's Stop. */
  async stop(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).host.stop(run);
  }

  /** End by force, for an `unknown` run. */
  async forceEnd(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).host.forceEnd(run);
  }

  /** The run as the space holds it now. */
  async read(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).machine.read(run);
  }

  /** The run once its host's work on it is over. */
  async ended(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).host.ended(run);
  }

  async #required(space: string): Promise<{ host: RunHost; machine: RunMachine }> {
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    return hosted;
  }

  /** The space's run host, made once per writer with that writer's recovery. */
  async #space(space: string): Promise<{ host: RunHost; machine: RunMachine } | undefined> {
    const served = this.#options.spaces().find((s) => s.id === space && isOpen(s));
    const writer = served?.writer;
    if (served === undefined || writer === undefined) return undefined;
    const known = this.#hosted.get(space);
    if (known?.writer === writer) return known.made;
    const made = this.#make(space, served);
    this.#hosted.set(space, { writer, made });
    made.catch(() => {
      if (this.#hosted.get(space)?.made === made) this.#hosted.delete(space);
    });
    return made;
  }

  /** A host over the space's store; it is handed out once its recovery ended. */
  async #make(space: string, served: ServedSpace): Promise<{ host: RunHost; machine: RunMachine }> {
    const writer = served.writer;
    if (writer === undefined) throw new Error("The space has no writer");
    const id = this.#options.machine;
    const human = await writer.actor("human", "user");
    const store = new SpaceExecutionStore({
      writer,
      spaceId: space,
      credential: {
        scope_id: `runs:${id}`,
        principal_id: human,
        actor_kind: "human",
        machine_id: id,
        origin: "ui",
      },
    });
    const machine = new RunMachine({ store, machine: id });
    const log: RunHostLog = (event, fields) => {
      this.#options.log.log(event, fields);
    };
    const host = new RunHost({
      machine,
      containers: this.#containers,
      files: this.#files,
      log,
      ...(this.#options.times === undefined ? {} : { times: this.#options.times }),
    });
    // Recovery waits for the probe: on Linux the service must sit in its own cgroup first.
    await this.probe();
    await host.recover();
    return { host, machine };
  }

  #failed(stage: "probe", error: unknown): void {
    const code = errorCode(error);
    this.#options.log.log("run.failed", {
      stage,
      type: errorType(error),
      ...(code === undefined ? {} : { code }),
    });
  }
}

const isOpen = (space: ServedSpace): boolean =>
  space.state === "open" && space.writer !== undefined && space.id !== undefined;
