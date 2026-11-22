// Background runs (A4 3.11): the normalised run events and the final outcome the stream parsers
// produce (A4 3.11.1, 3.11.4), and the run record's vocabulary: its states and their edges
// (3.11.2), its reason codes, its evidence keys, and the shapes every backend of the execution
// store reads and writes (3.16.1). Plain TypeScript without Zod, so the parsers, the run shim, the
// execution store and the page load it cheaply (`@ttasks/contracts/runs`).
//
// Nothing here is free text of TTasks's own making: every label, state and reason is a value from a
// fixed vocabulary. The agent-written strings are `message.text`, the answer, the outcome's
// `error`, `native-id.id` and `session.cwd`, each capped (ANSWER_CAP_BYTES, TEXT_CAP_BYTES). A run
// record holds the person's request text and the agent's answer and error, which are task text:
// they stay in the space and never reach a log, an argv, a URL or a snapshot. A working folder
// never reaches a record: the space holds no absolute path (A1 3.15).

// ---------------------------------------------------------------------------------------------
// Adapters and caps

/** The run adapters: the driver a run's agent is spoken to with. */
export const RUN_ADAPTERS = ["claude-print", "codex"] as const;
export type RunAdapterId = (typeof RUN_ADAPTERS)[number];

/**
 * A stdout line longer than this (UTF-8 bytes, without its line break) is skipped (A4 3.11.4). It
 * is well above ANSWER_CAP_BYTES: the line that carries an answer is JSON, whose escaping and other
 * fields make it several times longer than the answer itself.
 */
export const LINE_CAP_BYTES = 8 * 1024 * 1024;

/**
 * The agent's answer is kept whole up to this many UTF-8 bytes, and cut with a flag beyond it: in
 * the parser's answer events and outcome, in the run's answer file and in the run record.
 */
export const ANSWER_CAP_BYTES = 1024 * 1024;

/**
 * Message, error and other agent-written text is cut to this many UTF-8 bytes, in the journal and
 * in the run record alike. The answer has its own cap (ANSWER_CAP_BYTES).
 */
export const TEXT_CAP_BYTES = 8 * 1024;

/** The person's instruction for a run, in UTF-8 bytes: a note's size (A1 3.7). */
export const RUN_REQUEST_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Run events (A4 3.11.1, 3.11.4)

/**
 * A progress label is a key, not a sentence: the UI translates it, and no tool name or input
 * reaches it (A4 3.11.1). "Reading the task", "Running a command", "Editing files".
 */
export const PROGRESS_LABELS = [
  "tasks", // a TTasks tool call
  "command", // a shell command
  "edit", // a file edit
  "read", // reading or searching files
  "web", // a web search or fetch
  "plan", // a to-do list update
  "agent", // a subagent
  "tool", // any other tool
] as const;
export type ProgressLabel = (typeof PROGRESS_LABELS)[number];

/** Whether the run's TTasks MCP server was connected, from Claude's `system/init` (A4 3.11.4). */
export const APP_TOOLS_STATES = ["connected", "not-connected", "absent"] as const;
export type AppToolsState = (typeof APP_TOOLS_STATES)[number];

/**
 * Why a run ended as it did, judged from the stream and the process exit (A4 3.11.4).
 * - `success`: the final event said success and the process exited 0.
 * - `agent_error`: the final event said the turn failed (Claude `is_error`, Codex `turn.failed`).
 * - `interrupted`: Claude's final event says the turn was aborted (Ctrl+C or SIGINT).
 * - `max_turns`, `max_budget`: Claude stopped at `--max-turns` or `--max-budget-usd`.
 * - `exit_status`: the final event said success, but the process did not exit 0.
 * - `no_result`: the stream had events but no final one (killed, or a cancel that flushed none).
 * - `no_output`: the stream held no event at all (a startup failure; see stderr).
 * - `needs_input`: the agent asked for the person's own words and could not go on without them;
 *   its question is the result's text.
 */
export const OUTCOME_REASONS = [
  "success",
  "agent_error",
  "interrupted",
  "max_turns",
  "max_budget",
  "exit_status",
  "no_result",
  "no_output",
  "needs_input",
] as const;
export type OutcomeReason = (typeof OUTCOME_REASONS)[number];

/** Token counts and cost. `inputTokens` includes cached input on both CLIs. */
export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
}

/**
 * A normalised run event (A4 3.11.1). `progress` carries a label key, never text. `session`
 * reports Claude's `system/init` facts that A4 3.11.4 uses: the working folder, which M6.06
 * compares with the run's folder and which never leaves machine state, and whether the TTasks tools
 * connected. There is no `needs-input`: neither v1 adapter can wait for input (A4 3.11.2).
 */
export type RunEvent =
  | { kind: "native-id"; id: string }
  | { kind: "session"; cwd: string | null; appTools: AppToolsState }
  | { kind: "progress"; label: ProgressLabel }
  | { kind: "message"; text: string }
  /**
   * The agent's answer so far (≤ ANSWER_CAP_BYTES, `cut` when it was longer): Claude's `result`,
   * and each assistant message of either CLI. `final` once the agent finished its turn with it:
   * Claude's `result`, or Codex's last message when its turn completed. The run host saves each
   * one at once, so a crash keeps the last.
   */
  | { kind: "answer"; text: string; final: boolean; cut: boolean }
  | ({ kind: "usage" } & Usage)
  | { kind: "finished"; ok: boolean; reason: OutcomeReason };

export type RunEventKind = RunEvent["kind"];

/** One event of a run's journal (`events.jsonl`, A4 3.11.5), numbered from 1. */
export interface RunJournalEntry {
  seq: number;
  event: RunEvent;
}

/** How the agent process ended, as the run shim saw it. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/** What the parser counted. Counts only: no content of a skipped line is kept. */
export interface StreamCounts {
  /** Complete lines, blank ones included, plus a final unterminated line. */
  lines: number;
  blank: number;
  /** JSON objects of a known event type. */
  events: number;
  /** JSON objects of an unknown event type, or a known event with an unknown item type. */
  unknownEvents: number;
  /** Lines that were not JSON, or JSON that was not an object. */
  notJson: number;
  /** Lines over LINE_CAP_BYTES, skipped whole. */
  oversized: number;
  /** Lines that were not valid UTF-8. They are still parsed, with replacement characters. */
  invalidUtf8: number;
  /** 1 when the stream ended inside a line that was not a whole JSON object. */
  truncatedTail: number;
  /** Known events with a field of the wrong shape: the field is ignored. */
  malformed: number;
  /** Texts cut to TEXT_CAP_BYTES, and answers cut to ANSWER_CAP_BYTES. */
  cappedTexts: number;
  /** Progress and message events produced. */
  progress: number;
  messages: number;
  /** Codex command executions with status `declined` (A4 3.11.4: counted and shown). */
  declined: number;
  /** Claude's `permission_denials` in the last result (A4 3.11.4: shown). */
  permissionDenials: number;
  /** A defect guard: an exception inside a line handler. Stays 0; the fuzz test checks it. */
  handlerFaults: number;
}

/** The final run outcome (A4 3.11.5 `exit.json`, without the shim's own fields). */
export interface RunOutcome {
  ok: boolean;
  reason: OutcomeReason;
  exit: ProcessExit;
  nativeId: string | null;
  /** The answer: Claude's `result`, else the last assistant message (≤ ANSWER_CAP_BYTES). */
  result: string | null;
  /** The answer was longer than ANSWER_CAP_BYTES and is cut. */
  resultCut: boolean;
  /** The agent finished its turn with this answer (see the `answer` event). */
  resultFinal: boolean;
  /** The agent's last error message on a failed run (≤ TEXT_CAP_BYTES), else null. */
  error: string | null;
  usage: Usage | null;
  /** Claude's `system/init` facts; null for Codex or when no init event came. */
  session: { cwd: string | null; appTools: AppToolsState } | null;
  counts: StreamCounts;
}

// ---------------------------------------------------------------------------------------------
// Run records (A4 3.11.2, 3.16)

/** A4 3.11.2's states. `reconciling` is a lost shim's record while its files are read. */
export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "reconciling",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * The states `openWork` lists (A4 3.11.9, 3.16.1): the queue and every run whose container may hold
 * processes. It also lists the `unknown` runs not yet confirmed ended (`awaitsConfirmation`).
 */
export const OPEN_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "reconciling",
] as const satisfies readonly RunState[];

/** The states a run ends in. Only `unknown` still moves, on a definite observation. */
export const FINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
] as const satisfies readonly RunState[];

/**
 * An `unknown` run whose container was not confirmed empty: processes of it may still live. End by
 * force or the next start confirms the container and settles it, so `openWork` keeps listing it.
 */
export const awaitsConfirmation = (run: { state: RunState; reason: string | null }): boolean =>
  run.state === "unknown" && run.reason === "stop_timed_out";

/** Whether `openWork` lists the run: the open states, and an `unknown` run not yet confirmed. */
export const isOpenRun = (run: { state: RunState; reason: string | null }): boolean =>
  (OPEN_RUN_STATES as readonly RunState[]).includes(run.state) || awaitsConfirmation(run);

/**
 * The legal transitions. A self edge records evidence and changes no state: the agent's PID on
 * `starting` or `cancelling`, its native ID on `running`. A queued run has no container: a Stop
 * cancels it at once, and one that can no longer start (its task closed, its instance or folder
 * gone) fails with why. `unknown` moves only on a definite outcome, to a final state, and never
 * back to one a process may still hold.
 */
export const RUN_EDGES: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["starting", "running", "failed", "cancelling", "cancelled", "reconciling", "unknown"],
  running: [
    "running",
    "waiting_for_input",
    "succeeded",
    "failed",
    "timed_out",
    "cancelling",
    "reconciling",
  ],
  waiting_for_input: ["waiting_for_input", "running", "cancelling", "reconciling"],
  cancelling: ["cancelling", "cancelled", "unknown", "reconciling"],
  reconciling: ["succeeded", "failed", "timed_out", "cancelled", "unknown"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  unknown: ["reconciling", "succeeded", "failed", "timed_out", "cancelled"],
};

/** Whether `from → to` is an edge of A4's run state machine. */
export const isRunEdge = (from: RunState, to: RunState): boolean => RUN_EDGES[from].includes(to);

/**
 * The fixed reason codes of the states that take one (A4 3.11.2, 3.11.4, 3.11.7). A record holds
 * a code, never a message: the UI words it. `succeeded` and `cancelled` take none.
 */
export const RUN_REASONS = {
  failed: [
    /** A queued run whose task was finished or deleted before it could start. Nothing ran. */
    "task_closed",
    /** A queued run whose agent instance left machine.toml before it could start. Nothing ran. */
    "instance_gone",
    /** A queued run whose folder can no longer be found or used. Nothing ran. */
    "folder_gone",
    /** The agent could not be started in its container. Nothing ran. */
    "spawn_failed",
    /** The container gave no agent within its start time. Nothing of it is left. */
    "start_timed_out",
    /**
     * TTasks restarted, crashed or was updated while the run was open: its processes ended with the
     * service ("Interrupted because TTasks restarted"). The record keeps the last saved answer.
     */
    "service_ended",
    // The outcome's reasons other than `success` (OUTCOME_REASONS).
    "agent_error",
    "interrupted",
    "max_turns",
    "max_budget",
    "exit_status",
    "no_result",
    "no_output",
    "needs_input",
  ],
  /** The run's wall time, or its time without a stdout line, passed (RunLimits). */
  timed_out: ["wall", "idle"],
  unknown: [
    /**
     * The run's container could not be confirmed empty after it was ended: processes of the run may
     * still live. End by force, or the next start, settles it.
     */
    "stop_timed_out",
  ],
} as const satisfies Partial<Record<RunState, readonly string[]>>;

export type RunReason = (typeof RUN_REASONS)[keyof typeof RUN_REASONS][number];

/** The states that take a reason, and whether `reason` is one of `state`'s. */
export function isRunReason(state: RunState, reason: unknown): reason is RunReason {
  const reasons: readonly string[] | undefined = (
    RUN_REASONS as Partial<Record<RunState, readonly string[]>>
  )[state];
  return reasons !== undefined && typeof reason === "string" && reasons.includes(reason);
}

/** Whether entering `state` takes a reason code. */
export const takesReason = (state: RunState): boolean => Object.hasOwn(RUN_REASONS, state);

/** The permission modes a run may use: never `inherit`, which A4 3.11.6 refuses for a run. */
export const RUN_PERMISSIONS = ["full-access", "auto-edit", "read-only"] as const;
export type RunPermission = (typeof RUN_PERMISSIONS)[number];

/** The kinds of an evidence value: an ID, an instant in ms or a count. None holds text. */
export type RunEvidenceKind = "id" | "instant" | "count";

/** The evidence a run record may hold. Evidence only grows: a key, once written, keeps its value. */
export const RUN_EVIDENCE_FIELDS = {
  /** The agent's PID and when it started, once its container started it. */
  pid: "count",
  pid_started_at: "instant",
  /** The agent's native session or thread ID. */
  native_id: "id",
} as const satisfies Record<string, RunEvidenceKind>;

export type RunEvidenceKey = keyof typeof RUN_EVIDENCE_FIELDS;
export type RunEvidence = {
  [K in RunEvidenceKey]?: (typeof RUN_EVIDENCE_FIELDS)[K] extends "id" ? string : number;
};

/** An ID in evidence or a result: plain characters only (the stream parsers' rule). */
export const RUN_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** A signal's name as Node reports it, such as `SIGINT`. */
export const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/u;

/**
 * A run's text as the space stores it (A1 3.7; storage's `normaliseStored`, which a test compares):
 * well-formed, LF line endings, no C0 control but tab and line feed, NFC. Every execution store
 * measures a run's texts in this form, as the writer does, so the size a store accepts is the size
 * the writer stores. NFC can lengthen a text, so a raw size says nothing.
 */
export function normaliseRunText(text: string): string {
  return (
    text
      .toWellFormed()
      .replace(/\r\n?/gu, "\n")
      // eslint-disable-next-line no-control-regex -- the C0 controls are what this removes.
      .replace(/[\u0000-\u0008\u000b-\u001f]/gu, "")
      .normalize("NFC")
  );
}

const runTextEncoder = new TextEncoder();

/**
 * An agent's result text or error as a run record keeps it: normalised, then cut to at most `bytes`
 * UTF-8 bytes on a code point boundary. A result is never refused for its texts, because what an
 * agent wrote must never keep its run from settling (A4 3.11.5).
 */
export function cutRunText(text: string, bytes: number = TEXT_CAP_BYTES): string {
  let out = normaliseRunText(text);
  const buffer = new Uint8Array(bytes);
  // A cut on a code point boundary of a normalised text is normalised; the loop only guards that.
  for (let pass = 0; pass < 8; pass += 1) {
    const { read } = runTextEncoder.encodeInto(out, buffer);
    if (read >= out.length) return out;
    out = normaliseRunText(out.slice(0, read));
  }
  return "";
}

/** An answer as a run record keeps it (`cutRunText` to ANSWER_CAP_BYTES), and whether it was cut. */
export function cutRunAnswer(text: string): { text: string; cut: boolean } {
  const kept = cutRunText(text, ANSWER_CAP_BYTES);
  return { text: kept, cut: kept.length < normaliseRunText(text).length };
}

/** A run's limits (A4 3.11.3, 3.11.7), fixed when it is queued. */
export interface RunLimits {
  /** Claude's `--max-turns`. */
  maxTurns: number;
  /** Wall time, in ms. Without it, a run may take as long as its work does. */
  wallMs?: number;
  /** Time without a stdout line, in ms. Without it, a run may be quiet as long as it needs. */
  idleMs?: number;
  /** Claude's optional `--max-budget-usd`, an estimate that can overshoot. */
  budgetUsd?: number;
}

/**
 * A run's default limits, a task's and a routine's. No time limit ends a run by default: healthy
 * work can be long or quiet, and the person can see a quiet run and stop it. machine.toml's `[runs]`
 * can set one for the runs queued after.
 */
export const RUN_LIMITS: Readonly<Record<"task" | "routine", RunLimits>> = {
  task: { maxTurns: 50 },
  routine: { maxTurns: 150 },
};

/** How many runs may run at once: on this machine, per agent instance, and per task. */
export interface QueueLimits {
  readonly runs: number;
  readonly perInstance: number;
  readonly perTask: number;
}

/** The queue's default limits, guidelines machine.toml's `[runs]` can change. */
export const QUEUE_LIMITS: QueueLimits = { runs: 3, perInstance: 2, perTask: 1 };

/** Bounds of a limit, so a record cannot hold a value no run could use. */
export const RUN_LIMIT_BOUNDS = {
  maxTurns: { min: 1, max: 10_000 },
  wallMs: { min: 1_000, max: 24 * 60 * 60_000 },
  idleMs: { min: 1_000, max: 24 * 60 * 60_000 },
  budgetUsd: { min: 0, max: 100_000 },
} as const;

/**
 * How the run's processes ended, which the run host decides from the container after the work's
 * result is known, and which never changes it:
 * - `confirmed`: nothing was left when the agent ended, as the operating system counts it.
 * - `ended_leftovers`: processes the agent started, or the agent itself, had to be ended; the
 *   operating system then confirmed none is left.
 * - `ended_found`: no process group could hold the run, so TTasks ended the agent's processes it
 *   could find, and nothing confirms that none is left.
 */
export const RUN_CLEANUPS = ["confirmed", "ended_leftovers", "ended_found"] as const;
export type RunCleanup = (typeof RUN_CLEANUPS)[number];

/**
 * The final outcome a run record keeps (A4 3.11.5): the outcome's verdict and counts, the answer
 * (≤ ANSWER_CAP_BYTES) and the error (≤ TEXT_CAP_BYTES), usage and the native ID. Never the working
 * folder.
 */
export interface RunResult {
  ok: boolean;
  outcome: OutcomeReason;
  exitCode: number | null;
  signal: string | null;
  nativeId: string | null;
  /** The agent's answer, or its last message when it never finished its turn (`textFinal`). */
  text: string | null;
  /** The answer was longer than ANSWER_CAP_BYTES and is cut. Absent means false. */
  textCut?: boolean;
  /** The agent finished its turn with `text`. Absent means false. */
  textFinal?: boolean;
  error: string | null;
  usage: Usage | null;
  appTools: AppToolsState | null;
  /** Codex's declined commands and Claude's permission denials (A4 3.11.4). */
  declined: number;
  permissionDenials: number;
  durationMs: number | null;
  /** How the run's processes ended. Absent on a result recorded before it was kept. */
  cleanup?: RunCleanup;
}

/** What Run records (A4 3.11.2: written in `queued` before anything spawns). */
export interface NewRun {
  /** The task (`t_` ID), or null for a routine's run. Exactly one of `task` and `routine`. */
  task: string | null;
  /** The routine (`ro_` ID), or null for a task's run. */
  routine: string | null;
  /** The machine that runs it (`m_` ID): the one whose `openWork` recovers it. */
  machine: string;
  /** The instance's key in this machine's `machine.toml`. */
  instance: string;
  adapter: RunAdapterId;
  /** The place the folder resolved from (`pl_` ID), or null for a TTasks work folder (A4 3.3). */
  place: string | null;
  /** The session it continues (`se_` ID), when there is one. */
  session?: string;
  /** The person's instruction (A4 3.11.7), or null for a routine's run. */
  request: string | null;
  /** SHA-256 of the brief, lower-case hex. The brief itself is never stored. */
  briefHash: string;
  permission: RunPermission;
  limits: RunLimits;
}

/** A run record, as every backend of the execution store returns it. */
export interface RunRecord {
  /** `ru_` ID. */
  id: string;
  /**
   * The task, or null for a routine's run. Never both with `routine`; neither for a run whose task
   * was redacted, which keeps no request and no result text (A1 3.11.4, A4 3.11.1).
   */
  task: string | null;
  routine: string | null;
  session: string | null;
  machine: string;
  instance: string;
  adapter: RunAdapterId;
  place: string | null;
  /** `place` when the folder came from a place, else a TTasks work folder. */
  folderKind: "place" | "work_folder";
  request: string | null;
  briefHash: string;
  permission: RunPermission;
  limits: RunLimits;
  state: RunState;
  /** Why it failed, timed out or is unknown. Null in every other state. */
  reason: RunReason | null;
  attempt: number;
  evidence: RunEvidence;
  /** When it entered each state it has been in, on the writer's wall clock. */
  at: Partial<Record<RunState, number>>;
  /** The final outcome, once a process ended. */
  result: RunResult | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Grows with every change, so two reads can be told apart. */
  version: number;
}

/** What a transition writes beside the state (A4 3.16.1's `RunPatch`). */
export interface RunPatch {
  /** The reason code of `failed`, `timed_out` and `unknown`, entering them only. */
  reason?: RunReason;
  evidence?: RunEvidence;
  /** The final outcome, entering a final state only, once. */
  result?: RunResult;
}
