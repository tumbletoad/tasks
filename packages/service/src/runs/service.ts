// Background runs in the service: at start, the probe of this machine's process groups (on Linux
// it is also when the service moves itself into its unit's `main` cgroup), which decides only how a
// run's processes are ended: in a process group where one can be made, else as far as Tasks can
// find them. Then for each space open as this machine's a run host over its execution store, whose
// recovery settles the space's open runs before any of them is hosted again; and over all of them
// one supervisor, which starts queued runs within machine.toml's `[runs]` limits, holds new starts
// while an update waits, and removes old run folders.
import { dirname, join } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import {
  FINAL_RUN_STATES,
  RUN_LIMITS,
  type NewRun,
  type RunLimits,
  type RunRecord,
} from "@tasks/contracts/runs";
import { decodeRun, newTicket, SpaceExecutionStore, type BridgeTicket } from "@tasks/launch";
import { decodeRunRow } from "@tasks/storage";
import {
  containers as platformContainers,
  FallbackContainers,
  RUN_HELPER,
  UngroupedContainers,
  RunFiles,
  RunHost,
  RunMachine,
  RUNS_FOLDER,
  Supervisor,
  TOOLS_FILE,
  type AgentCommand,
  type Containers,
  type Hold,
  type Lane,
  type Prepared,
  type ProbeResult,
  type RunHostLog,
  type RunTimes,
  type StartRefusal,
  type WaitReason,
} from "@tasks/runs";
import { DEFAULT_RUN_SETTINGS, type RunSettings } from "../config/machine-toml.ts";
import { errorCode, errorType } from "../hub/crash.ts";
import type { Logger } from "../hub/log.ts";
import type { ServedSpace } from "../ops/index.ts";
import { readLaunchTask, readRunRows, readTaskRef, type TaskFolder } from "../ops/read.ts";
import {
  buildRun,
  runAdapter,
  runBriefHash,
  runFolder,
  runPermission,
  runsWith,
  WORK_ON_IT,
  type BuiltRun,
  type RunAgents,
} from "./agent.ts";

/** What a start of the service may set for runs. Tests pass their containers or times. */
export interface RunOptions {
  /** This platform's process groups. Default: the cgroup or job containers (`containers()`). */
  readonly containers?: Containers;
  /** Where no process group can be made. Default: the agent's process tree as Tasks finds it. */
  readonly ungrouped?: Containers;
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
  /** machine.toml's `[runs]` as it is now. Default: DEFAULT_RUN_SETTINGS. */
  readonly settings?: () => RunSettings;
  /** The agent instances machine.toml names now. Default: not checked. */
  readonly instances?: () => readonly { readonly id: string }[];
  /**
   * Whether the folder a task opens in here, as a launch decides it, is one a run can use now.
   * Default: not checked.
   */
  readonly folderUsable?: (space: string, folder: TaskFolder) => Promise<boolean>;
  /** Whether an update of this install has not finished (its journal is there). Default: no. */
  readonly updating?: () => boolean;
  /** What a run starts, built from its record. Without it only the internal call starts runs. */
  readonly agents?: RunAgents;
}

/** What a run ticket names: the run its bridge acts for. */
interface RunTicket {
  readonly space: string;
  readonly run: string;
  readonly task: string | null;
  readonly instance: string;
  used: boolean;
}

/** A run as a person sees it in a list: its record and its task's reference. */
export interface ListedRun {
  readonly run: RunRecord;
  readonly task: string | null;
}

/** What `tasks run` asks: a task, the instance to use or none, and the person's words. */
export interface RunRequest {
  /** The task's reference or ID. */
  readonly task: string;
  readonly instance?: string;
  /** The person's request, or null for "work on this task". */
  readonly request: string | null;
  readonly requestId: string;
}

/** How often spaces that opened since are recovered, and the queue looked at. */
const ROUND_MS = 30_000;

interface Hosted {
  readonly writer: unknown;
  readonly made: Promise<{ host: RunHost; machine: RunMachine }>;
  readonly life: HostLife;
}

interface HostLife {
  /** Set once made, before its recovery: closing it also ends a recovery still under way. */
  host: RunHost | undefined;
  /** Its space's writer is gone, or the service ends: no recovery starts on it any more. */
  closed: boolean;
}

/** A run an update would cut short, as the updater shows it to the person. */
export interface RunBlocker {
  readonly space: string;
  readonly space_name: string | null;
  readonly run: string;
  /** The task's reference, such as `MIRA-12`, or null for a routine's run. */
  readonly task: string | null;
  readonly state: string;
}

/** Whether runs get a process group here, for `service status` and doctor. */
export type RunsStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string; readonly message: string }
  | { readonly available: null };

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
  /** The spaces whose host recovered, as the supervisor works on them. */
  readonly #lanes = new Map<string, Lane>();
  /** What runs for each run the internal call queued, until it starts. */
  readonly #commands = new Map<string, (run: RunRecord) => AgentCommand | Promise<AgentCommand>>();
  /** The tickets of the runs this service started, by ticket. */
  readonly #tickets = new Map<string, RunTicket>();
  readonly #supervisor: Supervisor;
  #probe: Promise<ProbeResult> | undefined;
  #probed: ProbeResult | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #ending: () => void = () => undefined;
  /** Resolves once the service began to close: an update's hold ends with it. */
  readonly closing: Promise<void> = new Promise((resolve) => {
    this.#ending = resolve;
  });

  constructor(options: RunServiceOptions) {
    this.#options = options;
    const grouped =
      options.containers ??
      platformContainers({
        platform: options.platform,
        runHelper: options.runHelper ?? defaultRunHelper(),
      });
    this.#containers = new FallbackContainers(
      grouped,
      options.ungrouped ?? new UngroupedContainers({ platform: options.platform }),
      async () => (await this.probe()).available,
    );
    this.#files = new RunFiles(join(options.stateDir, RUNS_FOLDER));
    this.#supervisor = new Supervisor({
      lanes: () => [...this.#lanes.values()],
      limits: () => this.#settings().limits,
      prepare: (lane, run) => this.#prepare(lane, run),
      ...(options.updating === undefined ? {} : { updating: options.updating }),
      folders: this.#files,
      log: (event, fields) => {
        this.#options.log.log(event, fields);
      },
    });
  }

  /**
   * Probes this machine's containers. Only a success is kept: a machine that could not contain
   * runs a moment ago, a busy user manager for one, is asked again at the next call.
   */
  probe(): Promise<ProbeResult> {
    const probe = (this.#probe ??= this.#containers.probe().then(
      (result) => {
        this.#options.log.log(
          "runs.probe",
          result.available
            ? { available: true, kind: result.kind }
            : { available: false, reason: result.reason },
        );
        return result;
      },
      (error: unknown): ProbeResult => {
        this.#failed("probe", error);
        return {
          available: false,
          reason: "check_failed",
          message: `${PRODUCT_NAME} could not check whether runs can be contained here.`,
        };
      },
    ));
    void probe.then((result) => {
      this.#probed = result;
      if (!result.available && this.#probe === probe) this.#probe = undefined;
    });
    return probe;
  }

  /** What the last probe found, without asking again: for `service status`. */
  status(): RunsStatus {
    const probed = this.#probed;
    if (probed === undefined) return { available: null };
    return probed.available
      ? { available: true }
      : { available: false, reason: probed.reason, message: probed.message };
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

  /**
   * One round: a host, with its recovery, for every space that opened since, the end of the hosts
   * whose space closed, and then the supervisor's round. Each space's recovery goes on by itself,
   * so one whose store does not answer holds up no other space and no later round. Resolves once
   * this round's recoveries ended.
   */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    for (const [space, hosted] of [...this.#hosted]) {
      if (!this.#serves(space, hosted.writer)) this.#drop(space, hosted);
    }
    await Promise.all(
      this.#options
        .spaces()
        .filter(isOpen)
        .map((space) => this.#space(space.id ?? "").catch(() => undefined)),
    );
    await this.#supervisor.round();
  }

  /** Ends hosting: the containers of live runs are killed; the next start settles their runs. */
  async close(): Promise<void> {
    this.#stopped = true;
    this.#ending();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#supervisor.close();
    await Promise.all([...this.#hosted.values()].map((hosted) => this.#close(hosted)));
  }

  /**
   * Queues a run to start with `command`, once its limits allow. Its time limits are `[runs]`'s
   * unless it names its own.
   */
  async start(
    space: string,
    input: Omit<NewRun, "machine" | "limits"> & { readonly limits?: RunLimits },
    requestId: string,
    command: (run: RunRecord) => AgentCommand | Promise<AgentCommand>,
  ): Promise<RunRecord> {
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    const settings = this.#settings();
    const limits = input.limits ?? {
      ...RUN_LIMITS[input.routine === null ? "task" : "routine"],
      wallMs: settings.wallMs,
      idleMs: settings.idleMs,
    };
    // No round may take the run before its command is known.
    const hold = this.#supervisor.hold();
    try {
      const queued = await hosted.machine.queue({ ...input, limits }, requestId);
      if (queued.state === "queued") this.#commands.set(queued.id, command);
      return queued;
    } finally {
      hold.release();
    }
  }

  /**
   * `tasks run`: queues a run of a task, to start once its limits allow, built from its record
   * then. Refused at once with the person's words when it could not start here: no such task, a
   * task that is done, no instance that runs tasks, or a folder on another computer or not found.
   * A repeat of the same request ID gives the run it queued, and starts nothing twice.
   */
  async queueTask(space: string, asked: RunRequest): Promise<RunRecord> {
    const agents = this.#options.agents;
    const served = this.#served(space);
    const hosted = await this.#space(space);
    if (agents === undefined || served?.reader === undefined || hosted === undefined) {
      throw refusal("not_served", "The space is not open on this machine.");
    }
    let task: Awaited<ReturnType<typeof readLaunchTask>>;
    try {
      task = await readLaunchTask(served.reader, asked.task, this.#options.machine);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        throw refusal("task_not_found", "No task has this reference in this space.");
      }
      throw error;
    }
    if (!task.active) throw refusal("task_closed", "This task is done or deleted.");
    const able = agents.instances().filter(runsWith);
    const instance =
      asked.instance === undefined
        ? able.length === 1
          ? able[0]
          : undefined
        : able.find((i) => i.id === asked.instance);
    if (instance === undefined) {
      const ids = able.map((i) => i.id).join(", ");
      throw refusal(
        "instance",
        asked.instance !== undefined
          ? "No instance with this ID on this computer can run a task."
          : able.length === 0
            ? "No instance on this computer can run a task: runs use a Codex or Claude Code instance."
            : "Several instances on this computer can run a task.",
        able.length === 0
          ? `Set one up with: ${CLI_NAME} setup instances`
          : `Name one with --instance: ${ids}`,
      );
    }
    const folder = await runFolder(agents, space, task.folder);
    if (!folder.ok) {
      throw folder.reason === "other_machine"
        ? refusal(
            "other_machine",
            `This task's folder is on another computer (${folder.machine}): it runs there.`,
          )
        : refusal("folder_missing", "This task's folder is not found on this computer.");
    }
    const settings = this.#settings();
    const queued = await hosted.machine.queue(
      {
        task: task.id,
        routine: null,
        instance: instance.id,
        adapter: runAdapter(instance),
        place: null,
        // A task's run always holds what was asked: the person's words, else to work on the task.
        request: asked.request ?? WORK_ON_IT,
        briefHash: runBriefHash(task.ref, task.title),
        permission: runPermission(instance),
        limits: { ...RUN_LIMITS.task, wallMs: settings.wallMs, idleMs: settings.idleMs },
      },
      asked.requestId,
    );
    void this.#supervisor.round();
    return queued;
  }

  /** A space's newest runs, or a task's, each with its task's reference. */
  async list(space: string, task?: string): Promise<ListedRun[]> {
    const served = this.#served(space);
    if (served?.reader === undefined) {
      throw refusal("not_served", "The space is not open on this machine.");
    }
    let id: string | undefined;
    if (task !== undefined) {
      try {
        id = (await readLaunchTask(served.reader, task, this.#options.machine)).id;
      } catch (error) {
        if (error instanceof AppError && error.code === "not_found") {
          throw refusal("task_not_found", "No task has this reference in this space.");
        }
        throw error;
      }
    }
    const rows = await readRunRows(served.reader, id);
    return rows.flatMap(({ row, ref }) => {
      try {
        return [{ run: decodeRun(decodeRunRow(row)), task: ref }];
      } catch {
        return [];
      }
    });
  }

  /**
   * One run as a person reads it: its record, with the answer saved so far while it has none in
   * its record yet, and why it waits when it is queued.
   */
  async show(
    space: string,
    run: string,
  ): Promise<{ run: RunRecord; task: string | null; answer: string | null } | undefined> {
    const record = await this.read(space, run).catch(() => undefined);
    if (record === undefined) return undefined;
    const served = this.#served(space);
    const task =
      record.task === null || served?.reader === undefined
        ? null
        : ((await readTaskRef(served.reader, record.task).catch(() => undefined)) ?? null);
    let answer: string | null = record.result?.text ?? null;
    if (answer === null && !FINAL.has(record.state)) {
      try {
        answer = this.#files.readAnswer(record.id)?.text ?? null;
      } catch {
        answer = null;
      }
    }
    return { run: record, task, answer };
  }

  /** What a run's ticket names for the bridge, or undefined for no ticket of a live run. */
  bridgeTicket(ticket: string): BridgeTicket | undefined {
    const found = this.#tickets.get(ticket);
    if (found === undefined) return undefined;
    return {
      space: found.space,
      launch: found.run,
      task: found.task,
      used: found.used,
      // A run's bridge may connect whenever the agent starts it, for as long as the run runs.
      inWindow: true,
    };
  }

  /** Spends a run ticket's first redemption. */
  redeemBridge(ticket: string): { space: string; launch: string } | undefined {
    const found = this.#tickets.get(ticket);
    if (found === undefined || found.used) return undefined;
    found.used = true;
    return { space: found.space, launch: found.run };
  }

  /** Whether a run this service started still runs. */
  agentRuns(run: string): boolean {
    return [...this.#lanes.values()].some((lane) => lane.host.hosted().includes(run));
  }

  /**
   * Whether `run`, of `instance`, runs in `space` now: Tasks gave that run its tools, so its own
   * calls may use that space whether or not its home was set up for it.
   */
  allows(instance: string, space: string, run: string): boolean {
    for (const ticket of this.#tickets.values()) {
      if (ticket.run === run && ticket.instance === instance && ticket.space === space) {
        return true;
      }
    }
    return false;
  }

  /**
   * The person's Stop: a queued run is cancelled at once and never starts, and one whose processes
   * were not confirmed ended (`unknown`) is ended by force.
   */
  async stop(space: string, run: string): Promise<RunRecord | undefined> {
    const { host } = await this.#required(space);
    let after = await host.stop(run);
    if (after?.state === "unknown") after = await host.forceEnd(run);
    if (after?.state === "cancelled") this.#commands.delete(run);
    void this.#supervisor.round();
    return after;
  }

  /** End by force, for an `unknown` run. */
  async forceEnd(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).host.forceEnd(run);
  }

  /** The run as the space holds it now. */
  async read(space: string, run: string): Promise<RunRecord | undefined> {
    return (await this.#required(space)).machine.read(run);
  }

  /** The run once it is final: started and ended, refused, or stopped. */
  async ended(space: string, run: string): Promise<RunRecord | undefined> {
    const { host, machine } = await this.#required(space);
    return this.#supervisor.ended({ space, host, machine }, run);
  }

  /** Why a queued run waits, as the last round saw it. */
  waiting(run: string): WaitReason | undefined {
    return this.#supervisor.waiting(run);
  }

  /** An update's hold: no run starts until it is released. */
  hold(): Hold {
    this.#options.log.log("runs.hold", { held: true });
    const hold = this.#supervisor.hold();
    return {
      release: () => {
        hold.release();
        this.#options.log.log("runs.hold", { held: false });
      },
    };
  }

  /** The runs an update would cut short now, each with its space's name and its task's reference. */
  async blocking(): Promise<RunBlocker[]> {
    return this.#described(await this.#supervisor.blocking());
  }

  /** Stops every run an update would cut short, and returns those that did not end in time. */
  async stopAll(): Promise<RunBlocker[]> {
    return this.#described(await this.#supervisor.stopAll());
  }

  async #described(
    blockers: readonly { space: string; run: string; task: string | null; state: string }[],
  ): Promise<RunBlocker[]> {
    const spaces = this.#options.spaces();
    return Promise.all(
      blockers.map(async (b) => {
        const served = spaces.find((s) => s.id === b.space);
        let task: string | null = null;
        if (b.task !== null && served?.reader !== undefined) {
          task = (await readTaskRef(served.reader, b.task).catch(() => undefined)) ?? null;
        }
        return {
          space: b.space,
          space_name: served?.name ?? null,
          run: b.run,
          task,
          state: b.state,
        };
      }),
    );
  }

  #settings(): RunSettings {
    try {
      return this.#options.settings?.() ?? DEFAULT_RUN_SETTINGS;
    } catch {
      return DEFAULT_RUN_SETTINGS;
    }
  }

  /**
   * A queued run checked again right before it starts, and what runs for it, built from its
   * record. Its command is taken only once its `starting` commit landed, so a start that did not
   * land can be tried again; its ticket names it to the bridge from then until it ends.
   */
  async #prepare(lane: Lane, run: RunRecord): Promise<Prepared> {
    const served = this.#served(lane.space);
    if (served === undefined) throw new Error("The space is not open on this machine");
    const given = this.#commands.get(run.id);
    const agents = this.#options.agents;
    if (given === undefined && agents !== undefined) {
      const ticket = newTicket();
      let built: BuiltRun | StartRefusal;
      try {
        const toolsPath = join(this.#files.folder(run.id), TOOLS_FILE);
        built = await buildRun(agents, served, run, this.#options.machine, ticket, toolsPath);
      } catch (error) {
        if (error instanceof AppError && error.code === "not_found")
          return { refused: "task_closed" };
        throw error;
      }
      if (typeof built === "string") return { refused: built };
      const { command, toolsFile } = built;
      return {
        command: () => {
          // The run's folder is there now: its tools file goes in before its program starts.
          if (toolsFile !== undefined) this.#files.writePrivate(run.id, TOOLS_FILE, toolsFile);
          this.#tickets.set(ticket, {
            space: lane.space,
            run: run.id,
            task: run.task,
            instance: run.instance,
            used: false,
          });
          const forget = (): void => {
            this.#tickets.delete(ticket);
          };
          void lane.host.hosting(run.id).then(forget, forget);
          return command;
        },
      };
    }
    const refused = await this.#check(served, run);
    if (refused !== undefined || given === undefined) {
      this.#commands.delete(run.id);
      return { refused: refused ?? "spawn_failed" };
    }
    return {
      command: (started) => {
        this.#commands.delete(run.id);
        return given(started);
      },
    };
  }

  #served(space: string): ServedSpace | undefined {
    return this.#options.spaces().find((s) => s.id === space && isOpen(s));
  }

  /** What a queued run needs, read now: its task open, its instance and its folder still there. */
  async #check(served: ServedSpace, run: RunRecord): Promise<StartRefusal | undefined> {
    if (run.task !== null && served.reader !== undefined) {
      let task: Awaited<ReturnType<typeof readLaunchTask>>;
      try {
        task = await readLaunchTask(served.reader, run.task, this.#options.machine);
      } catch (error) {
        if (error instanceof AppError && error.code === "not_found") return "task_closed";
        throw error;
      }
      if (!task.active) return "task_closed";
      const usable = this.#options.folderUsable;
      if (usable !== undefined && !(await usable(served.id ?? "", task.folder))) {
        return "folder_gone";
      }
    }
    const instances = this.#options.instances?.();
    if (instances !== undefined && !instances.some((i) => i.id === run.instance)) {
      return "instance_gone";
    }
    return undefined;
  }

  async #required(space: string): Promise<{ host: RunHost; machine: RunMachine }> {
    const hosted = await this.#space(space);
    if (hosted === undefined) throw new Error("The space is not open on this machine");
    return hosted;
  }

  /** The space's run host, made once per writer with that writer's recovery. */
  async #space(space: string): Promise<{ host: RunHost; machine: RunMachine } | undefined> {
    if (this.#stopped) return undefined;
    const served = this.#options.spaces().find((s) => s.id === space && isOpen(s));
    const writer = served?.writer;
    if (served === undefined || writer === undefined) return undefined;
    const known = this.#hosted.get(space);
    if (known?.writer === writer) return known.made;
    if (known !== undefined) this.#drop(space, known);
    const life: HostLife = { host: undefined, closed: false };
    const made = this.#make(space, served, life);
    this.#hosted.set(space, { writer, made, life });
    made.catch(() => {
      if (this.#hosted.get(space)?.made === made) this.#hosted.delete(space);
    });
    return made;
  }

  /** A host over the space's store; it is handed out, and supervised, once its recovery ended. */
  async #make(
    space: string,
    served: ServedSpace,
    life: HostLife,
  ): Promise<{ host: RunHost; machine: RunMachine }> {
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
    life.host = host;
    // Recovery waits for the probe: on Linux the service must sit in its own cgroup first.
    await this.probe();
    const closed = (): boolean => life.closed;
    if (closed()) throw new Error("The space's host was closed");
    await host.recover();
    if (closed()) throw new Error("The space's host was closed");
    this.#lanes.set(space, { space, machine, host });
    return { host, machine };
  }

  #serves(space: string, writer: unknown): boolean {
    return this.#options.spaces().some((s) => s.id === space && isOpen(s) && s.writer === writer);
  }

  /**
   * Ends the host of a space whose writer is gone: its runs can no longer be recorded, so their
   * containers are killed, and the space's next open settles them.
   */
  #drop(space: string, hosted: Hosted): void {
    if (this.#hosted.get(space) === hosted) this.#hosted.delete(space);
    if (this.#lanes.get(space)?.host === hosted.life.host) this.#lanes.delete(space);
    void this.#close(hosted);
  }

  async #close(hosted: Hosted): Promise<void> {
    hosted.life.closed = true;
    await hosted.life.host?.close();
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

/** A refusal of `tasks run`, in the person's words. */
const refusal = (reason: string, message: string, hint?: string): AppError =>
  new AppError({
    code: reason === "task_not_found" ? "not_found" : "invalid_input",
    message,
    ...(hint === undefined ? {} : { hint }),
    data: { reason },
  });

const FINAL: ReadonlySet<string> = new Set(FINAL_RUN_STATES);

const isOpen = (space: ServedSpace): boolean =>
  space.state === "open" && space.writer !== undefined && space.id !== undefined;
