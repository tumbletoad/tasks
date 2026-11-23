// The page's launch tiles and receipts (A5 3.6 launch tile, 3.9 receipts; A7 3.9 M2.13, M2.10).
//
// Open and Copy are A4's `launch.open`, a registry entry the page calls like every other
// (`POST /api/v1/op/launch.open`), on the hub's one launch machine per space: the page's click,
// the shim's claim, recovery after a restart and the sweep all act on the same machine (A4
// 3.9.1's section rule holds across them). This module keeps what the page needs besides: the
// instances it draws a tile for, from the hub's launch service, which agent apps are busy with a
// task on this machine, and a task's last receipts, its history, which the page refetches when the
// change feed names a launch. And Run: the page's click starts a
// background run of a task, reads a task's runs (refetched when the feed names a run) and stops
// one, on the service's runs (runs/service.ts), the same ones `ttasks run` uses. And a task's folder
// shown in the file manager. The page's sign-in is the person: no agent reaches these routes.
//
// A receipt holds IDs, states, instants and fixed codes only, as the launch record does, and what
// only this machine knows: whether its session runs now. The person's request for a launch is a
// note on the task, which the page reads with the task's other notes: a receipt names it by its
// reference. A run as the page reads it holds the person's request and the agent's answer, task
// text that travels in a request's or a response's body only.
import { AppError, RequestId } from "@ttasks/contracts";
import {
  isOpenRun,
  RECORDED,
  RUN_REQUEST_MAX_BYTES,
  type ReadRunState,
  type RunRecord,
} from "@ttasks/contracts/runs";
import {
  INSTANCE_KEY,
  isOpenLaunch,
  isRoute,
  sessionRecord,
  TASK_ID,
  TERMINAL_APPS,
  TERMINAL_SOURCES,
  type IntentState,
  type OpenResult,
  type Route,
} from "@ttasks/launch";
import { findSpace, isAmbiguity, spaceChanged } from "../ops/copies.ts";
import { launchError } from "../ops/handlers.ts";
import { readOnly, type OpsHost, type ServedSpace } from "../ops/index.ts";
import { readLaunchTask, type TaskFolder } from "../ops/read.ts";
import { WORK_ON_IT } from "../runs/agent.ts";
import { runAnswer } from "../runs/service.ts";
import type { HttpLog } from "./events.ts";

/** An instance as the page draws its tile (A5 3.6): a key, a label, a monogram and a ring slot. */
export interface UiInstance {
  /** The instance's key in machine.toml's `[[instance]]`. */
  readonly key: string;
  /** Names the account: "Codex · work". */
  readonly label: string;
  /** A neutral monogram, one or two characters: "Cx". */
  readonly glyph: string;
  /** One of the eight ring slots of A5 3.19. */
  readonly ring: number;
  readonly route: Route;
  /** It can work on a task in the background (Run). Absent: it cannot. */
  readonly runs?: true;
}

/**
 * The hub's launch service as the page sees it: the instances Open can open a task in here, and
 * a way to hear that a space's launch records changed (the feed catches up at once).
 */
export interface UiLaunchPort {
  instances(): readonly UiInstance[];
  onChange?(listener: (space: string) => void): () => void;
  /**
   * Whether the launch's session runs now, as this service follows it, and was made in the copy
   * `copy` of its space.
   */
  running?(launch: string, copy: string | undefined): boolean;
  /** The task and agent pairs of a space busy on this machine. */
  busy?(space: string): Promise<readonly UiBusy[]>;
  /** Shows the folder a task opens in here in the file manager (LaunchService.showFolder). */
  showFolder?(space: string, folder: TaskFolder): Promise<OpenResult>;
}

/**
 * An agent app busy with a task on this machine, as the page holds its Open: `opening` while an
 * Open of it is on its way, `running` while a session of it runs.
 */
export interface UiBusy {
  readonly task: string;
  readonly instance: string;
  readonly state: "opening" | "running";
}

/** What a folder's file manager answered: it opened, or it ran and said nothing either way. */
export interface FolderShown {
  readonly result: "opened" | "unknown";
  /** This computer's name: the folder opens here, also for a page looked at from elsewhere. */
  readonly machine: string | undefined;
}

/**
 * The service's background runs, as the page starts, reads and stops a task's runs
 * (runs/service.ts), and which instances can run.
 */
export interface UiRunPort {
  /** Whether the instance with this key can work on a task in the background. */
  runnable(instance: string): boolean;
  queueTask(
    space: string,
    asked: {
      readonly task: string;
      readonly instance?: string;
      readonly request: string | null;
      readonly requestId: string;
    },
  ): Promise<RunRecord>;
  list(space: string, task?: string): Promise<readonly { readonly run: RunRecord }[]>;
  stop(space: string, run: string): Promise<RunRecord | undefined>;
  /** What the run's record cannot say now, in the copy `space` serves (RunService.live). */
  live(run: RunRecord, space: ServedSpace): UiRunLive;
  /** Hears each run a person queues or stops, here or with `ttasks run`. */
  onChange?(listener: (space: string) => void): () => void;
}

/**
 * Why a queued run waits, since when a running one is quiet, and what a started one said so far;
 * or that the run is only recorded open, in a restored copy (RunLive).
 */
export interface UiRunLive {
  readonly recorded?: true;
  readonly waiting?: string;
  readonly quietSince?: number;
  readonly said?: { readonly text: string; readonly final: boolean; readonly cut: boolean };
}

/**
 * A run as the page shows it in its task's thread. The person's words (`asked`, null when they
 * gave none), the agent's answer or question and its error are task text: they reach the page in
 * a response body only, never a URL or a log.
 */
export interface UiRun {
  readonly id: string;
  readonly instance: string;
  /** `recorded`: open in a restored copy that is not claimed, so nothing of it runs now. */
  readonly state: ReadRunState;
  readonly reason: string | null;
  /** Why a queued run waits. */
  readonly waiting?: string;
  /** Since when a running run has written nothing, milliseconds since 1970. */
  readonly quiet_since?: number;
  readonly queued_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly asked: string | null;
  readonly outcome?: string;
  readonly cleanup?: string;
  /**
   * The agent's answer, or its question when it needs the person. While it works, what it said
   * last, so the person can use what it made, a server it keeps running, before stopping it.
   */
  readonly answer: string | null;
  /** The agent finished its turn with `answer`: otherwise it is the last thing it said. */
  readonly answer_final: boolean;
  readonly answer_cut: boolean;
  readonly error?: string;
  /** How many of the agent's requests its permission refused, when any were. */
  readonly refused?: number;
  /** Grows with every change of the run. */
  readonly version: number;
}

/** The page's view of a run record, with what only the service knows of it now. */
export function uiRun(run: RunRecord, live: UiRunLive = {}): UiRun {
  const result = run.result;
  const { waiting, quietSince, said } = live;
  const refused = result === null ? 0 : result.declined + result.permissionDenials;
  const asked = run.request === null || run.request === WORK_ON_IT ? null : run.request;
  return {
    id: run.id,
    instance: run.instance,
    state: live.recorded === true ? RECORDED : run.state,
    reason: run.reason,
    ...(waiting === undefined ? {} : { waiting }),
    ...(quietSince === undefined ? {} : { quiet_since: quietSince }),
    queued_at: run.queuedAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    asked,
    ...(result === null
      ? {}
      : {
          outcome: result.outcome,
          ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
          ...(result.error === null ? {} : { error: result.error }),
        }),
    ...runAnswer(run, said),
    ...(refused === 0 ? {} : { refused }),
    version: run.version,
  };
}

/** A launch receipt as the page shows it (A5 3.9). IDs, states, instants and codes only. */
export interface UiReceipt {
  readonly id: string;
  readonly reference: string;
  readonly instance: string;
  readonly route: string;
  /**
   * `recorded`: open (isOpenLaunch) in a restored copy that is not claimed, so nothing of it goes
   * on now; `at` says how far it had come.
   */
  readonly state: IntentState | typeof RECORDED;
  readonly reason: string | null;
  /** When it entered each state, milliseconds since 1970. */
  readonly at: Readonly<Partial<Record<IntentState, number>>>;
  /**
   * A terminal launch: the terminal that was Dispatched and why it was chosen, as the
   * fixed words of `[terminal] app` and TERMINAL_SOURCES. Absent before its dispatch, and for a
   * launch recorded by a build that did not record them.
   */
  readonly terminal?: { readonly app: string; readonly source: string };
  /** The note on the task that holds what the person asked the launch's agent, such as `n2`. */
  readonly request?: string;
  /**
   * A Confirmed launch's session: `running` while this service follows it and it runs, `ended`
   * once its agent's end was reported, `restored` once a claim or a restore in place ended it as a
   * backup's. Absent when the service does not know: a link or a T3 launch, a shim that went
   * without a word, a launch of another computer or of an earlier build.
   */
  readonly session?: "running" | "ended" | "restored";
  /** How long its agent ran, when its end was reported with it. */
  readonly ran_ms?: number;
}

/** A note's entry reference, as a launch's evidence names its request. */
const NOTE_REF = /^n[1-9][0-9]{0,5}$/u;

const MONOGRAM = /^[A-Za-z0-9]{1,2}$/;

/** The port's instances, checked: an entry that is not one is left out, never guessed. */
export function checkInstances(list: readonly UiInstance[]): UiInstance[] {
  const seen = new Set<string>();
  const out: UiInstance[] = [];
  for (const item of list) {
    if (
      !INSTANCE_KEY.test(item.key) ||
      seen.has(item.key) ||
      typeof item.label !== "string" ||
      item.label.length === 0 ||
      item.label.length > 40 ||
      !MONOGRAM.test(item.glyph) ||
      !Number.isInteger(item.ring) ||
      item.ring < 1 ||
      item.ring > 8 ||
      !isRoute(item.route)
    ) {
      continue;
    }
    seen.add(item.key);
    out.push({
      key: item.key,
      label: item.label,
      glyph: item.glyph,
      ring: item.ring,
      route: item.route,
      ...(item.runs === true ? { runs: true } : {}),
    });
  }
  return out;
}

const invalid = (message: string, field?: string): AppError =>
  new AppError({
    code: "invalid_input",
    message,
    ...(field === undefined ? {} : { data: { field } }),
  });

const LIST_SQL =
  "SELECT id, reference, instance_id, route, state, reason, detail FROM launches " +
  "WHERE task_id = $task ORDER BY created_at DESC, id DESC LIMIT 10";

/**
 * A `launches` row as the page's receipt, or undefined for a detail that does not parse. `runs`
 * says whether this service follows the launch's session as running now: it counts only for a
 * Confirmed launch whose record names no end. `restored`: the row is read in a restored copy that
 * is not claimed, where an open launch is `recorded`.
 */
export function receiptOf(
  row: Record<string, unknown>,
  runs: (launch: string) => boolean = () => false,
  restored = false,
): UiReceipt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row["detail"]));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const detail = parsed as { at?: Record<string, unknown>; evidence?: Record<string, unknown> };
  const at: Partial<Record<IntentState, number>> = {};
  for (const [state, value] of Object.entries(detail.at ?? {})) {
    if (typeof value === "number") at[state as IntentState] = value;
  }
  const evidence = detail.evidence ?? {};
  // Only the fixed words reach the page: anything else is left out, never shown.
  const app = evidence["terminal"];
  const source = evidence["terminal_source"];
  const terminal =
    typeof app === "string" &&
    typeof source === "string" &&
    app !== "auto" &&
    (TERMINAL_APPS as readonly string[]).includes(app) &&
    (TERMINAL_SOURCES as readonly string[]).includes(source)
      ? { app, source }
      : undefined;
  const asked = evidence["request"];
  const request = typeof asked === "string" && NOTE_REF.test(asked) ? asked : undefined;
  const id = String(row["id"]);
  const state = String(row["state"]) as IntentState;
  const route = String(row["route"]);
  const reason = row["reason"];
  const ran = evidence["ran_ms"];
  const ranMs = typeof ran === "number" && Number.isSafeInteger(ran) && ran >= 0 ? ran : undefined;
  const recorded = restored && isOpenLaunch({ state, route, evidence });
  const record = state === "confirmed" && !recorded ? sessionRecord(evidence) : undefined;
  const session =
    record === "ended" || record === "restored"
      ? record
      : record === "open" && runs(id)
        ? "running"
        : undefined;
  return {
    id,
    reference: String(row["reference"]),
    instance: String(row["instance_id"]),
    route,
    state: recorded ? RECORDED : state,
    reason: typeof reason === "string" ? reason : null,
    at,
    ...(terminal === undefined ? {} : { terminal }),
    ...(request === undefined ? {} : { request }),
    ...(session === undefined ? {} : { session }),
    ...(ranMs === undefined ? {} : { ran_ms: ranMs }),
  };
}

export interface UiLaunchesOptions {
  readonly host: OpsHost;
  readonly port: UiLaunchPort | undefined;
  /** The service's runs. None: no instance runs and Run is refused. */
  readonly runs?: UiRunPort | undefined;
  readonly log: HttpLog;
  /** A launch record changed: the feed's subscribers of that space catch up. */
  readonly changed: (space: string) => void;
}

/** The page's tiles, receipts and runs, over the hub's launch service and runs. */
export class UiLaunches {
  readonly #options: UiLaunchesOptions;
  readonly #unlisten: readonly (() => void)[];

  constructor(options: UiLaunchesOptions) {
    this.#options = options;
    const changed = (space: string): void => {
      options.changed(space);
    };
    this.#unlisten = [options.port?.onChange?.(changed), options.runs?.onChange?.(changed)].filter(
      (off) => off !== undefined,
    );
  }

  /**
   * The instances the page draws a tile for, each marked when it can run. None without a launch
   * service: Copy only.
   */
  instances(): UiInstance[] {
    const port = this.#options.port;
    const runs = this.#options.runs;
    if (port === undefined) return [];
    return checkInstances(
      port
        .instances()
        .map((tile) =>
          runs?.runnable(tile.key) === true ? { ...tile, runs: true as const } : tile,
        ),
    );
  }

  close(): void {
    for (const off of this.#unlisten) off();
  }

  /**
   * The served space a request names (its `TTasks-Space`): an ID or a name (A2 3.10.5). `copy`, the
   * copy the page loaded, must be the one served (copies.ts spaceChanged).
   */
  #space(ref: string | undefined, copy: string | undefined): ServedSpace {
    if (ref === undefined) throw invalid("Name the space of this tab.", "space");
    const found = findSpace(
      this.#options.host.spaces().filter((s) => s.id !== undefined && s.reader !== undefined),
      ref,
    );
    const space = isAmbiguity(found) ? undefined : found;
    if (space?.reader === undefined || space.id === undefined) {
      if (copy !== undefined) throw spaceChanged();
      throw new AppError({
        code: "space_unavailable",
        message: "This space cannot open tasks on this machine now.",
      });
    }
    if (copy !== undefined && space.copy !== copy) throw spaceChanged();
    return space;
  }

  /**
   * The served space a run starts or stops in, which must take changes: a read-only one is refused
   * with its own reason, as a write to it is.
   */
  #writable(ref: string | undefined, copy: string | undefined): ServedSpace {
    const space = this.#space(ref, copy);
    if (space.state === "read_only") throw readOnly(space.reason, space.message);
    return space;
  }

  /**
   * The agent apps busy with a task on this machine, for every task of the space: what the
   * page's tiles and Open buttons hold to, whatever receipts a tab has read.
   */
  async busy(spaceRef: string | undefined, copy?: string): Promise<readonly UiBusy[]> {
    const space = this.#space(spaceRef, copy).id ?? "";
    return (await this.#options.port?.busy?.(space)) ?? [];
  }

  /**
   * Shows a task's folder in this computer's file manager: the folder the task itself names here,
   * never a path the page sends. A folder that is gone, on another computer, or a file, and a
   * computer where no file manager answers, are refused with the reason.
   */
  async showFolder(
    spaceRef: string | undefined,
    input: Record<string, unknown>,
    copy?: string,
  ): Promise<FolderShown> {
    const { task } = input;
    if (typeof task !== "string" || !TASK_ID.test(task)) {
      throw invalid("Expected a task ID.", "task");
    }
    const space = this.#space(spaceRef, copy);
    const show = this.#options.port?.showFolder?.bind(this.#options.port);
    if (show === undefined || space.reader === undefined || space.id === undefined) {
      throw new AppError({
        code: "space_unavailable",
        message: "This space cannot open folders on this machine now.",
      });
    }
    const { machine } = this.#options.host;
    const read = await readLaunchTask(space.reader, task, machine.id);
    let result: OpenResult;
    try {
      result = await show(space.id, read.folder);
    } catch (error) {
      throw launchError(error);
    }
    if (result !== "opened" && result !== "unknown") {
      throw new AppError({
        code: "invalid_input",
        message: "No file manager answered on this computer.",
        data: { field: "task", reason: "no_file_manager" },
      });
    }
    return { result, machine: machine.name };
  }

  /** A task's launch receipts, newest last (at most ten). */
  async list(
    spaceRef: string | undefined,
    input: Record<string, unknown>,
    copy?: string,
  ): Promise<UiReceipt[]> {
    const { task } = input;
    if (typeof task !== "string" || !TASK_ID.test(task))
      throw invalid("Expected a task ID.", "task");
    const space = this.#space(spaceRef, copy);
    const reader = space.reader;
    if (reader === undefined) throw invalid("The space is not served.", "space");
    const rows = await reader.all(LIST_SQL, { task });
    const port = this.#options.port;
    // Only the copy a launch was made in shows its session as running: a restored copy shows its
    // open launches as recorded.
    const runs = (launch: string): boolean => port?.running?.(launch, space.copy) ?? false;
    const restored = space.restored !== undefined;
    return rows.flatMap((r) => receiptOf(r, runs, restored) ?? []).reverse();
  }

  /**
   * Run: the person's click starts a background run of a task, with their words as its request
   * or none. A repeat of the same request ID gives the run it queued and starts nothing twice. A
   * run that cannot start here is refused with its reason, and nothing is queued.
   */
  async run(
    spaceRef: string | undefined,
    input: Record<string, unknown>,
    copy?: string,
  ): Promise<UiRun> {
    const runs = this.#runs();
    const { task, instance, text, request_id: requestId } = input;
    if (typeof task !== "string" || !TASK_ID.test(task))
      throw invalid("Expected a task ID.", "task");
    if (instance !== undefined && (typeof instance !== "string" || !INSTANCE_KEY.test(instance))) {
      throw invalid("Expected an instance's key.", "instance");
    }
    if (typeof requestId !== "string" || !RequestId.safeParse(requestId).success) {
      throw invalid("Expected a request ID.", "request_id");
    }
    if (text !== undefined && typeof text !== "string") throw invalid("Expected a text.", "text");
    const words = text === undefined || text.trim() === "" ? null : text;
    if (words !== null && Buffer.byteLength(words, "utf8") > RUN_REQUEST_MAX_BYTES) {
      throw new AppError({
        code: "too_large",
        message: "The request is longer than a note may be.",
        data: { field: "text" },
      });
    }
    const space = this.#writable(spaceRef, copy);
    const queued = await runs.queueTask(space.id ?? "", {
      task,
      ...(instance === undefined ? {} : { instance }),
      request: words,
      requestId,
    });
    return uiRun(queued, runs.live(queued, space));
  }

  /** A task's newest runs, and every older one that may still work, oldest first. */
  async runs(
    spaceRef: string | undefined,
    input: Record<string, unknown>,
    copy?: string,
  ): Promise<UiRun[]> {
    const runs = this.#runs();
    const { task } = input;
    if (typeof task !== "string" || !TASK_ID.test(task))
      throw invalid("Expected a task ID.", "task");
    const space = this.#space(spaceRef, copy);
    const listed = await runs.list(space.id ?? "", task);
    return listed
      .filter(({ run }, at) => at < RUNS_SHOWN || isOpenRun(run))
      .map(({ run }) => uiRun(run, runs.live(run, space)))
      .reverse();
  }

  /**
   * Stop: a queued run never starts, a working one is asked to stop and its processes are ended
   * after a grace time. Answers at once with the run as it is then.
   */
  async stop(
    spaceRef: string | undefined,
    input: Record<string, unknown>,
    copy?: string,
  ): Promise<UiRun> {
    const runs = this.#runs();
    const { run } = input;
    if (typeof run !== "string" || !RUN_ID.test(run)) throw invalid("Expected a run ID.", "run");
    const space = this.#writable(spaceRef, copy).id ?? "";
    const after = await runs.stop(space, run);
    if (after === undefined) {
      throw new AppError({ code: "not_found", message: "No run has this ID in this space." });
    }
    return uiRun(after);
  }

  #runs(): UiRunPort {
    const runs = this.#options.runs;
    if (runs === undefined) {
      throw new AppError({
        code: "service_unavailable",
        message: "This service runs no agent in the background.",
        data: { reason: "runs_unavailable", retryable: false },
      });
    }
    return runs;
  }
}

/** A task's runs the thread shows: the newest ones. */
const RUNS_SHOWN = 10;

const RUN_ID = /^ru_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
