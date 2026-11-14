// Stream parsers for the two v1 run adapters (A4 3.11.4).
import { createClaudePrintParser } from "./claude-print.ts";
import { createCodexExecParser } from "./codex-exec.ts";
import type { ProcessExit, RunEvent, RunOutcome, StreamKind } from "./events.ts";
import type { StreamParser } from "./parser.ts";

export * from "./events.ts";
export { claudeToolLabel, createClaudePrintParser } from "./claude-print.ts";
export { createCodexExecParser } from "./codex-exec.ts";
export type { StreamParser } from "./parser.ts";

/** A fresh parser for one run's stdout. */
export function createStreamParser(kind: StreamKind): StreamParser {
  return kind === "claude-print" ? createClaudePrintParser() : createCodexExecParser();
}

/** Parses a whole recorded stream at once: every event, the `finished` one last, and the outcome. */
export function parseStream(
  kind: StreamKind,
  stdout: Uint8Array | string,
  exit: ProcessExit,
): { events: RunEvent[]; outcome: RunOutcome } {
  const parser = createStreamParser(kind);
  const events = parser.push(stdout);
  const end = parser.end(exit);
  return { events: [...events, ...end.events], outcome: end.outcome };
}
