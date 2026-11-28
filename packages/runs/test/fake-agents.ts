// Fake agents for tests: a small program that stands in for
// `claude -p` or `codex exec` and replays one recording of lab run N as the real process did, so
// the supervisor, cancellation and adapters can be tested without a real agent.
//
//   node fake-agent.ts --fixture <cli>/<name>.jsonl [--line-delay-ms <n>] [--max-ms <n>]
//                      [--report <file>] [-- <the agent's own argv>]
//
// What it does, from the recording's index entry (fixtures/streams/index-<os>.json):
// 1. Reads stdin to its end, as the real CLIs read the brief. With --report it then writes
//    `{argv, cwd, cwdId, envNames, stdinBytes, stdinSha256}` to the file: the argv after `--`, its
//    working directory's path and identity, names of the environment variables only, and the
//    brief's size and hash, never its text.
// 2. Writes a fixed stderr line naming the recording's stderr class (no recorded text exists).
// 3. Replays the recorded stdout byte for byte, one line at a time with an optional delay.
// 4. Ends as the recording did:
//    - a run without a cancel exits with the recorded exit code;
//    - a run cancelled by Ctrl+C or SIGINT (Ctrl+Break: SIGBREAK, Windows only) holds where the
//      cancel came, and on that signal writes what the CLI wrote after it and exits with the
//      recorded code: for Claude the lines after its last `assistant` event (the tool-result
//      error and the `result`), for Codex nothing (no event after a cancel);
//    - a run that was killed (TerminateProcess, SIGTERM to the group, taskkill forced) writes its
//      whole stream, the cut last line of a truncated recording included, and holds until the
//      test kills it, so the exit is the kill's own (signal SIGTERM from Node's `kill()`).
//    A holding fake exits with code 124 after --max-ms (default 60 s), so none outlives its test.
//
// This lives in packages/runs/test for now; fake agents belong in testkit, where it moves
// later.
import { join } from "node:path";
import type { FixtureEntry } from "./fixtures.ts";

/** The fake agent program. */
export const FAKE_AGENT = join(import.meta.dirname, "fake-agent.ts");

/** The exit code of a holding fake that reached --max-ms. */
export const FAKE_AGENT_GUARD_EXIT = 124;

export interface FakeAgentOptions {
  /** Milliseconds between lines. Default 0. */
  lineDelayMs?: number;
  /** Lifetime limit of a holding fake. Default 60,000. */
  maxMs?: number;
  /** A file to write the report to. */
  report?: string;
  /** The agent's own argv, as an adapter would pass it. */
  argv?: readonly string[];
}

/** The command line that starts a fake agent replaying `fixture` (`<cli>/<name>.jsonl`). */
export function fakeAgentCommand(
  fixture: string,
  options: FakeAgentOptions = {},
): { command: string; args: string[] } {
  const args = [FAKE_AGENT, `--fixture=${fixture}`];
  if (options.lineDelayMs !== undefined)
    args.push(`--line-delay-ms=${String(options.lineDelayMs)}`);
  if (options.maxMs !== undefined) args.push(`--max-ms=${String(options.maxMs)}`);
  if (options.report !== undefined) args.push(`--report=${options.report}`);
  if (options.argv !== undefined) args.push("--", ...options.argv);
  return { command: process.execPath, args };
}

/** What the fake writes to its --report file. */
export interface FakeAgentReport {
  argv: string[];
  cwd: string;
  /**
   * The identity of the directory it started in, read through `.` at its start: the volume and
   * the file number, `<dev>:<ino>` in decimal. A test compares it with the folder it expects.
   */
  cwdId: string;
  envNames: string[];
  stdinBytes: number;
  stdinSha256: string;
}

/** The signal that ends a recorded graceful cancel; null when the run was killed or not cancelled. */
export type GracefulSignal = "SIGINT" | "SIGBREAK";

export interface ReplayPlan {
  /** The recording split into lines, each with its LF; the last may have none. */
  lines: Uint8Array[];
  /** Lines written before the fake holds; null when it writes all and exits. */
  holdAt: number | null;
  /** The signal that releases the rest of the lines and the exit. */
  graceful: GracefulSignal | null;
  /** The exit code after a full replay or a graceful cancel; null when the fake is killed. */
  exitCode: number | null;
}

const GRACEFUL: Readonly<Record<string, GracefulSignal>> = {
  "ctrl-c": "SIGINT",
  "sigint-group": "SIGINT",
  "ctrl-break": "SIGBREAK",
};

/** Splits bytes into lines that keep their LF. */
export function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    const lf = bytes.indexOf(0x0a, start);
    const end = lf === -1 ? bytes.length : lf + 1;
    lines.push(bytes.subarray(start, end));
    start = end;
  }
  return lines;
}

/** Where a graceful cancel came: after Claude's last assistant event. */
function cancelPoint(_entry: FixtureEntry, lines: readonly Uint8Array[]): number {
  const decoder = new TextDecoder();
  let point = Math.min(1, lines.length); // after `system/init` when no assistant event came
  lines.forEach((line, i) => {
    try {
      const event = JSON.parse(decoder.decode(line)) as { type?: unknown };
      if (event.type === "assistant") point = i + 1;
    } catch {
      // A cut line is no assistant event.
    }
  });
  return point;
}

/** How a fake agent replays one recording. Pure: the program and its tests share it. */
export function replayPlan(entry: FixtureEntry, bytes: Uint8Array): ReplayPlan {
  const lines = splitLines(bytes);
  if (entry.cancel === null) {
    return { lines, holdAt: null, graceful: null, exitCode: entry.exit ?? 1 };
  }
  const graceful = GRACEFUL[entry.cancel] ?? null;
  if (graceful === null) return { lines, holdAt: lines.length, graceful: null, exitCode: null };
  return { lines, holdAt: cancelPoint(entry, lines), graceful, exitCode: entry.exit };
}
