// The normalised run events and the final run outcome of A4 3.11.1, as the stream parsers of
// A4 3.11.4 produce them. Defined here for M6.05; the shapes move to packages/contracts in M6.01,
// when the run records and the event journal need them (A4 3.11.1).
//
// Nothing in these shapes is free text from the parser's own making: every label and reason is a
// value from a fixed vocabulary. The only agent-written strings are `message.text`, the outcome's
// `result` and `error`, `native-id.id` and `session.cwd`, each capped (TEXT_CAP_BYTES) and never
// logged by this package.

/** The two v1 run adapters' stream formats (A4 3.11.3). */
export const STREAM_KINDS = ["claude-print", "codex-exec"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** A line longer than this (UTF-8 bytes, without its line break) is skipped (A4 3.11.4). */
export const LINE_CAP_BYTES = 1024 * 1024;

/** Message, result and error text is cut to this many UTF-8 bytes (A4 3.11.5). */
export const TEXT_CAP_BYTES = 8 * 1024;

/**
 * A progress label is a key, not a sentence, so the UI translates it and no tool input reaches it
 * (A4 3.11.4: "Reading the task", "Running a command", "Editing files").
 */
export const PROGRESS_LABELS = [
  "tasks", // a Tasks tool call
  "command", // a shell command
  "edit", // a file edit
  "read", // reading or searching files
  "web", // a web search or fetch
  "plan", // a to-do list update
  "agent", // a subagent
  "tool", // any other tool
] as const;
export type ProgressLabel = (typeof PROGRESS_LABELS)[number];

/** Whether the run's Tasks MCP server was connected, from Claude's `system/init` (A4 3.11.4). */
export const APP_TOOLS_STATES = ["connected", "not-connected", "absent"] as const;
export type AppToolsState = (typeof APP_TOOLS_STATES)[number];

/**
 * Why a run ended as it did, judged from the stream and the process exit.
 * - `success`: the final event said success and the process exited 0.
 * - `agent_error`: the final event said the turn failed (Claude `is_error`, Codex `turn.failed`).
 * - `interrupted`: Claude's final event says the turn was aborted (Ctrl+C or SIGINT).
 * - `max_turns`, `max_budget`: Claude stopped at `--max-turns` or `--max-budget-usd`.
 * - `exit_status`: the final event said success, but the process did not exit 0.
 * - `no_result`: the stream had events but no final one (killed, or a cancel that flushed none).
 * - `no_output`: the stream held no event at all (a startup failure; see stderr).
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
 * A4 3.11.1's RunEvent, with two local changes for M6.01 to settle in contracts: `progress`
 * carries a label key instead of text, and `session` reports Claude's `system/init` facts that
 * A4 3.11.4 uses (the working folder and whether the Tasks tools connected). `needs-input` is left
 * out: neither v1 adapter can wait for input (A4 3.11.2).
 */
export type RunEvent =
  | { kind: "native-id"; id: string }
  | { kind: "session"; cwd: string | null; appTools: AppToolsState }
  | { kind: "progress"; label: ProgressLabel }
  | { kind: "message"; text: string }
  | ({ kind: "usage" } & Usage)
  | { kind: "finished"; ok: boolean; reason: OutcomeReason };

export type RunEventKind = RunEvent["kind"];

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
  /** Texts cut to TEXT_CAP_BYTES. */
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
  /** The final result: Claude's `result`, else the last assistant message (≤ TEXT_CAP_BYTES). */
  result: string | null;
  /** The agent's last error message on a failed run (≤ TEXT_CAP_BYTES), else null. */
  error: string | null;
  usage: Usage | null;
  /** Claude's `system/init` facts; null for Codex or when no init event came. */
  session: { cwd: string | null; appTools: AppToolsState } | null;
  counts: StreamCounts;
}

export function emptyCounts(): StreamCounts {
  return {
    lines: 0,
    blank: 0,
    events: 0,
    unknownEvents: 0,
    notJson: 0,
    oversized: 0,
    invalidUtf8: 0,
    truncatedTail: 0,
    malformed: 0,
    cappedTexts: 0,
    progress: 0,
    messages: 0,
    declined: 0,
    permissionDenials: 0,
    handlerFaults: 0,
  };
}
