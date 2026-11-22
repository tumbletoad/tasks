// The normalised run events and the final run outcome of A4 3.11.1, as the stream parsers of
// A4 3.11.4 produce them. The shapes live in packages/contracts (`@ttasks/contracts/runs`), beside
// the run record's; this module re-exports them for the parsers and adds what only they use.
import type { StreamCounts } from "@ttasks/contracts/runs";

export {
  ANSWER_CAP_BYTES,
  APP_TOOLS_STATES,
  LINE_CAP_BYTES,
  OUTCOME_REASONS,
  PROGRESS_LABELS,
  TEXT_CAP_BYTES,
  type AppToolsState,
  type OutcomeReason,
  type ProcessExit,
  type ProgressLabel,
  type RunEvent,
  type RunEventKind,
  type RunOutcome,
  type StreamCounts,
  type Usage,
} from "@ttasks/contracts/runs";

/** The print-mode adapters' stream formats: one parser each. */
export const STREAM_KINDS = ["claude-print"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

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
