// What the page shows of a background run, from the service's record (api.ts `Run`): its one line
// of state in plain words, what the agent said (its answer, or the question it stopped on), how
// its processes ended, and whether Stop is offered. Pure, so every state is a unit test; the
// words are the catalogue's.
import { Refused, type Instance, type Run } from "../api.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { MarkerFact, Msg } from "../row/model.ts";
import type { RowQuestion, RowRun } from "../store/rows.ts";

/**
 * How a run's entry looks: the one state that asks for attention is `needs_you`. `recorded` is a
 * restored copy's run that was open when its backup was made: nothing of it runs now.
 */
export type RunTone =
  | "waiting"
  | "working"
  | "stopping"
  | "done"
  | "needs_you"
  | "failed"
  | "stopped"
  | "unknown"
  | "recorded";

export interface RunView {
  readonly tone: RunTone;
  /** Its state in plain words, with how its processes ended when that is known. */
  readonly status: readonly Msg[];
  /** How long a working run has said nothing, from a minute on: after Stop, which it never moves. */
  readonly quiet?: Msg;
  /**
   * What the agent said: its answer (`answer`), the question it stopped on (`question`), or the
   * last thing it said before it ended without finishing (`last`). Untrusted text.
   */
  readonly said?: {
    readonly kind: "answer" | "question" | "last";
    readonly text: string;
    readonly cut: boolean;
  };
  /** The agent's own error, untrusted text. */
  readonly error?: string;
  /** Stop is offered: it is queued, works, or may still hold processes. */
  readonly stoppable: boolean;
}

const msg = (id: MessageId, values?: Msg["values"]): Msg =>
  values === undefined ? { id } : { id, values };

/** The instance's label, or its key when this machine no longer has it. */
export function runLabel(run: { readonly instance: string }, instances: readonly Instance[]) {
  return instances.find((i) => i.key === run.instance)?.label ?? run.instance;
}

const CLEANUP: Readonly<Record<string, MessageId>> = {
  confirmed: "run.cleanup.confirmed",
  ended_leftovers: "run.cleanup.leftovers",
  ended_found: "run.cleanup.found",
};

/** Why a run that never started did not, in the record's codes. */
const NOT_STARTED: ReadonlySet<string> = new Set([
  "task_closed",
  "instance_gone",
  "folder_gone",
  "spawn_failed",
  "start_timed_out",
]);

/** A running run says how long it has said nothing, from a minute on. */
const QUIET_SHOWN_MS = 60_000;

/** A run as its thread entry shows it, at `now`. */
export function runView(run: Run, label: string, now = Date.now()): RunView {
  // How its processes ended is said after a stop or a time limit, where the person asked for an
  // end; after an end of its own only when something it left had to be ended.
  const ended =
    run.cleanup === undefined || CLEANUP[run.cleanup] === undefined
      ? []
      : [msg(CLEANUP[run.cleanup] ?? "run.cleanup.confirmed")];
  const cleanup = run.cleanup === "ended_leftovers" ? ended : [];
  const text = run.answer ?? "";
  const said = (kind: "answer" | "question" | "last") =>
    text.trim() === "" ? {} : { said: { kind, text, cut: run.answer_cut } };
  const error = run.error === undefined || run.error.trim() === "" ? {} : { error: run.error };
  const refused =
    run.refused === undefined || run.refused === 0
      ? []
      : [msg("run.permissionRefused", { count: run.refused, label })];
  const quietMs = run.quiet_since === undefined ? 0 : now - run.quiet_since;
  const quiet =
    quietMs < QUIET_SHOWN_MS
      ? {}
      : { quiet: msg("run.quiet", { minutes: Math.floor(quietMs / QUIET_SHOWN_MS) }) };
  switch (run.state) {
    case "recorded":
      return {
        tone: "recorded",
        status: [msg("run.recorded", { label, started: run.started_at === null ? "no" : "yes" })],
        stoppable: false,
      };
    case "queued":
      return {
        tone: "waiting",
        status: [msg("run.waiting", { why: run.waiting ?? "none", label })],
        stoppable: true,
      };
    case "starting":
    case "running":
    case "waiting_for_input":
    case "reconciling":
      // What it said so far stays in view: a server it keeps running is the person's to use.
      return {
        tone: "working",
        status: [msg("run.working", { label })],
        ...quiet,
        ...said("last"),
        stoppable: true,
      };
    case "cancelling":
      return { tone: "stopping", status: [msg("run.stopping")], stoppable: false };
    case "succeeded":
      return {
        tone: "done",
        status: [msg("run.done"), ...refused, ...cleanup],
        ...said(run.answer_final ? "answer" : "last"),
        stoppable: false,
      };
    case "cancelled":
      return {
        tone: "stopped",
        status: [msg(run.started_at === null ? "run.stoppedBeforeStart" : "run.stopped"), ...ended],
        ...said("last"),
        stoppable: false,
      };
    case "timed_out":
      return {
        tone: "failed",
        status: [msg("run.timedOut", { limit: run.reason ?? "wall" }), ...ended],
        ...said("last"),
        ...error,
        stoppable: false,
      };
    case "unknown":
      return { tone: "unknown", status: [msg("run.unknown")], stoppable: true };
    case "failed": {
      const reason = run.reason ?? "";
      if (reason === "needs_input") {
        return {
          tone: "needs_you",
          status: [msg("run.needsYou", { label }), ...cleanup],
          ...said("question"),
          stoppable: false,
        };
      }
      if (NOT_STARTED.has(reason)) {
        return {
          tone: "failed",
          status: [msg("run.notStarted", { reason, label })],
          stoppable: false,
        };
      }
      if (reason === "restored") {
        return {
          tone: "failed",
          status: [msg("run.restored")],
          ...said("last"),
          stoppable: false,
        };
      }
      if (reason === "service_ended") {
        return {
          tone: "failed",
          status: [msg("run.serviceEnded")],
          ...said("last"),
          stoppable: false,
        };
      }
      return {
        tone: "failed",
        status: [msg("run.failed", { reason, label }), ...refused, ...cleanup],
        ...said("last"),
        ...error,
        stoppable: false,
      };
    }
    default:
      return { tone: "working", status: [msg("run.working", { label })], stoppable: false };
  }
}

/**
 * The row's marker for what agents ask of the person: its newest run working or needing them, or
 * else the newest question an agent asked that waits for them; none otherwise.
 */
export function agentMarker(
  run: RowRun | undefined,
  instances: readonly Instance[],
  question?: RowQuestion,
): MarkerFact | undefined {
  const by = run === undefined ? undefined : runLabel(run, instances);
  if (by !== undefined && run?.state === "needs_you") return { kind: "needs_input", by };
  if (question !== undefined) return { kind: "needs_input", by: question.by };
  if (by !== undefined && run?.state === "working") return { kind: "working", by };
  return undefined;
}

/**
 * A task's runs as a read gave them, joined with what the page holds: a run the page holds at a
 * newer version (the answer to a Stop or a Run that came after the read began) stays, and so does
 * a run newer than every run the read has (queued after the read began).
 */
export function mergeRuns(known: readonly Run[], read: readonly Run[]): Run[] {
  const held = new Map(known.map((r) => [r.id, r]));
  const out = read.map((r) => {
    const mine = held.get(r.id);
    return mine !== undefined && mine.version > r.version ? mine : r;
  });
  const newest = Math.max(-Infinity, ...read.map((r) => r.queued_at));
  const seen = new Set(read.map((r) => r.id));
  for (const r of known) if (!seen.has(r.id) && r.queued_at >= newest) out.push(r);
  return out;
}

/** How `run` shows while its Stop is on its way. */
export function stopping(run: Run): Run {
  return { ...run, state: run.state === "queued" ? "cancelled" : "cancelling" };
}

/**
 * A task's runs as the page shows them: a run whose Stop is on its way (`stops`, its version when
 * Stop was pressed) shows as stopping, unless the service already has it further along. The same
 * list when no Stop applies, so a row keeps its props.
 */
export function withStops(
  runs: readonly Run[],
  stops: ReadonlyMap<string, number>,
): readonly Run[] {
  const held = (run: Run) => (stops.get(run.id) ?? -1) >= run.version;
  return runs.some(held) ? runs.map((run) => (held(run) ? stopping(run) : run)) : runs;
}

/**
 * Why the service queued no run, from its answer's code and data: the reason as `run.refused`'s
 * select takes it, and the folder or machine it names.
 */
export function runRefusal(error: unknown): {
  readonly reason: string;
  readonly folder?: string;
  readonly words: { readonly reason: string; readonly folder: string; readonly machine: string };
} {
  const code = error instanceof Refused ? error.code : "unknown";
  const data = error instanceof Refused ? error.data : {};
  const named = typeof data["reason"] === "string" ? data["reason"] : undefined;
  const folder = typeof data["folder"] === "string" ? data["folder"] : undefined;
  const machine = typeof data["machine"] === "string" ? data["machine"] : "";
  const reason =
    named !== undefined && REFUSALS.has(named)
      ? named === "folder_missing" && folder === undefined
        ? "work_folder"
        : named
      : code === "too_large"
        ? "too_large"
        : code === "not_found"
          ? "task_not_found"
          : "unknown";
  return {
    reason,
    ...(folder === undefined ? {} : { folder }),
    words: { reason, folder: folder ?? "", machine },
  };
}

/** The refusals `run.refused` words: anything else is "not started, try again". */
const REFUSALS: ReadonlySet<string> = new Set([
  "task_not_found",
  "task_closed",
  "instance",
  "other_machine",
  "folder_missing",
  "marker_missing",
  "marker_other",
  "runs_unavailable",
  "not_served",
]);

/** The instances that can run, the default first: the first of them in the space's order. */
export const runners = (instances: readonly Instance[]): Instance[] =>
  instances.filter((i) => i.runs === true);
