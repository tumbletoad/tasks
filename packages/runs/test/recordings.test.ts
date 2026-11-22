// Every recording of lab run N parses to the outcome its recording states (M6.05). The index
// states how each process ended (exit code, signal, cancel); the table below states what the
// stream says, from fixtures/streams/README.md and A4 3.11.3.
// Assertions are on shapes, counts and reasons only, never on message text.
import { describe, expect, test } from "vitest";
import {
  OUTCOME_REASONS,
  PROGRESS_LABELS,
  TEXT_CAP_BYTES,
  createStreamParser,
  parseStream,
  type OutcomeReason,
  type RunEvent,
} from "../src/index.ts";
import { fixtureBytes, fixtureEntry, fixtureFiles, fixtureIndex } from "./fixtures.ts";

interface Expected {
  reason: OutcomeReason;
  /** The stream names the session or thread. */
  nativeId: boolean;
  /** A final result text is present. */
  result: boolean;
  usage: boolean;
}

const ok: Expected = { reason: "success", nativeId: true, result: true, usage: true };
const noOutput: Expected = { reason: "no_output", nativeId: false, result: false, usage: false };
const noResult = (result: boolean): Expected => ({
  reason: "no_result",
  nativeId: true,
  result,
  usage: false,
});

const EXPECTED: Record<string, Expected> = {
  "claude-print/windows-success-tool-call.jsonl": ok,
  "claude-print/windows-resume.jsonl": ok,
  // subtype success with is_error true: judged by is_error (A4 3.11.3).
  "claude-print/windows-error-model.jsonl": {
    reason: "agent_error",
    nativeId: true,
    result: false,
    usage: true,
  },
  "claude-print/windows-error-no-brief.jsonl": noOutput,
  "claude-print/windows-error-max-turns.jsonl": {
    reason: "max_turns",
    nativeId: true,
    result: false,
    usage: true,
  },
  // Ctrl+C: exit 0, but the result says the turn was aborted (A4 3.11.3).
  "claude-print/windows-cancel-ctrl-c.jsonl": {
    reason: "interrupted",
    nativeId: true,
    result: false,
    usage: true,
  },
  "claude-print/windows-cancel-ctrl-c-early.jsonl": {
    reason: "interrupted",
    nativeId: true,
    result: false,
    usage: true,
  },
  // Ctrl+Break: exit 0 with no result event (A4 3.11.3).
  "claude-print/windows-cancel-ctrl-break.jsonl": noResult(false),
  "claude-print/windows-cancel-terminate.jsonl": noResult(false),
  "claude-print/windows-cancel-taskkill-tree.jsonl": noResult(false),
  "claude-print/windows-killed-truncated-final-line.jsonl": noResult(false),
};

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

describe("[A4.5.parsers.recordings] every recording parses to the outcome its recording states", () => {
  test("the table, the index and the folder name the same 11 recordings", () => {
    const files = fixtureFiles().sort();
    expect(files).toHaveLength(11);
    expect(Object.keys(EXPECTED).sort()).toEqual(files);
    expect(
      fixtureIndex()
        .map((e) => e.file)
        .sort(),
    ).toEqual(files);
  });

  test.each(Object.keys(EXPECTED))("%s", (file) => {
    const entry = fixtureEntry(file);
    const want = EXPECTED[file];
    if (want === undefined) throw new Error("unreachable");
    const { events, outcome } = parseStream(entry.cli, fixtureBytes(file), {
      code: entry.exit,
      signal: entry.signal,
    });

    // The outcome the recording states.
    expect(outcome.reason).toBe(want.reason);
    expect(outcome.ok).toBe(want.reason === "success");
    // A run is only a success when the recorded process exited 0 and no cancel was sent.
    if (outcome.ok) expect([entry.exit, entry.signal, entry.cancel]).toEqual([0, null, null]);
    expect(outcome.exit).toEqual({ code: entry.exit, signal: entry.signal });
    expect(outcome.nativeId !== null).toBe(want.nativeId);
    expect(outcome.result !== null).toBe(want.result);
    expect(outcome.usage !== null).toBe(want.usage);
    // A failed run that ended on the agent's own error carries its message.
    if (want.reason === "agent_error") expect(outcome.error).not.toBeNull();
    if (outcome.ok) expect(outcome.error).toBeNull();

    // Nothing was skipped in a recording, except the cut line of a truncated one.
    const c = outcome.counts;
    const cut = entry.final_line === "cut-by-sanitiser" ? 1 : 0;
    expect(c.truncatedTail).toBe(cut);
    expect(c.lines).toBe(entry.lines);
    expect(c.events).toBe(entry.lines - cut);
    expect([c.unknownEvents, c.notJson, c.oversized, c.invalidUtf8, c.malformed]).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(c.handlerFaults).toBe(0);
    expect(c.declined).toBe(0);
    expect(c.permissionDenials).toBe(0);

    // The events: shapes and order only.
    const kinds = events.map((e) => e.kind);
    expect(kinds.at(-1)).toBe("finished");
    expect(kinds.filter((k) => k === "finished")).toHaveLength(1);
    expect(kinds.filter((k) => k === "native-id")).toHaveLength(want.nativeId ? 1 : 0);
    if (want.nativeId) expect(kinds[0]).toBe("native-id");
    for (const e of events) checkShape(e);
    expect(c.progress).toBe(kinds.filter((k) => k === "progress").length);
    expect(c.messages).toBe(kinds.filter((k) => k === "message").length);
    const last = events.at(-1);
    expect(last).toEqual({ kind: "finished", ok: outcome.ok, reason: outcome.reason });
  });

  test("Claude's init reports the working folder and the TTasks tools", () => {
    const claude = parseStream(
      "claude-print",
      fixtureBytes("claude-print/windows-success-tool-call.jsonl"),
      { code: 0, signal: null },
    );
    expect(claude.outcome.session?.appTools).toBe("connected");
    expect(typeof claude.outcome.session?.cwd).toBe("string");
    // The invalid-model run had no MCP server registered.
    const noTools = parseStream(
      "claude-print",
      fixtureBytes("claude-print/windows-error-model.jsonl"),
      { code: 1, signal: null },
    );
    expect(noTools.outcome.session?.appTools).toBe("absent");
  });

  test("the probe call is labelled as a TTasks tool call", () => {
    for (const file of ["claude-print/windows-success-tool-call.jsonl"]) {
      const entry = fixtureEntry(file);
      const { events } = parseStream(entry.cli, fixtureBytes(file), { code: 0, signal: null });
      const labels = events.flatMap((e) => (e.kind === "progress" ? [e.label] : []));
      expect(labels).toContain("tasks");
    }
  });

  test("a recording fed line by line, as the run shim does, gives the same events", () => {
    for (const file of fixtureFiles()) {
      const entry = fixtureEntry(file);
      const exit = { code: entry.exit, signal: entry.signal };
      const whole = parseStream(entry.cli, fixtureBytes(file), exit);
      const text = new TextDecoder().decode(fixtureBytes(file));
      const lines = text.split("\n");
      const tail = lines.pop() ?? "";
      const parser = createStreamParser(entry.cli);
      const events = lines.flatMap((l) => parser.line(l));
      // The shim hands an unterminated rest over as bytes at the end.
      events.push(...parser.push(tail));
      const end = parser.end(exit);
      expect([...events, ...end.events]).toEqual(whole.events);
      expect(end.outcome).toEqual(whole.outcome);
    }
  });
});

function checkShape(e: RunEvent): void {
  switch (e.kind) {
    case "native-id":
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      break;
    case "session":
      expect(["connected", "not-connected", "absent"]).toContain(e.appTools);
      break;
    case "progress":
      expect(PROGRESS_LABELS).toContain(e.label);
      break;
    case "message":
      expect(e.text.length).toBeGreaterThan(0);
      expect(byteLength(e.text)).toBeLessThanOrEqual(TEXT_CAP_BYTES);
      break;
    case "usage":
      for (const v of [e.inputTokens, e.outputTokens, e.cachedInputTokens, e.costUsd]) {
        if (v !== undefined) expect(v).toBeGreaterThanOrEqual(0);
      }
      break;
    case "finished":
      expect(OUTCOME_REASONS).toContain(e.reason);
      break;
  }
}
