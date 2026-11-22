// The agent's answer through the stream parsers: kept whole up to 1 MiB whatever came before it and
// however its line is escaped, cut with a flag beyond that, and reported as answer events the run
// host saves as they come. Generated texts only.
import { describe, expect, test } from "vitest";
import {
  ANSWER_CAP_BYTES,
  createStreamParser,
  LINE_CAP_BYTES,
  STREAM_KINDS,
  type RunEvent,
  type StreamKind,
} from "./index.ts";

const encoder = new TextEncoder();
const size = (text: string): number => encoder.encode(text).length;
const exit0 = { code: 0, signal: null };

/** The CLI's line that carries `text` as its final answer. */
function finalLines(_kind: StreamKind, text: string): string[] {
  return [JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text })];
}

/** An assistant message of the CLI. */
function messageLine(_kind: StreamKind, text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** One MiB of output that is no answer: a known event of the CLI with a long field. */
function otherLine(): string {
  const head = '{"type":"user","pad":"';
  return head + "o".repeat(1024 * 1024 - head.length - 2) + '"}';
}

const answers = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.kind === "answer" ? [e] : []));

/** A text of exactly `bytes` UTF-8 bytes that JSON escaping makes several times longer. */
function escapedHeavy(bytes: number): string {
  const unit = '"\\\n\t"\\\n\t';
  return unit.repeat(Math.floor(bytes / unit.length)) + "x".repeat(bytes % unit.length);
}

describe.each(STREAM_KINDS)(
  "[A4.5.parsers.answer] %s: the answer is kept whole up to 1 MiB, cut with a flag beyond it",
  (kind) => {
    test("a 1 MiB answer after 50 MB of other output is kept whole and final", () => {
      const parser = createStreamParser(kind);
      const other = encoder.encode(`${otherLine()}\n`);
      for (let i = 0; i < 50; i += 1) parser.push(other);
      const text = "a".repeat(ANSWER_CAP_BYTES - 3) + "€";
      const events = parser.push(`${finalLines(kind, text).join("\n")}\n`);
      const { outcome } = parser.end(exit0);
      expect(outcome.reason).toBe("success");
      expect(outcome.result === text).toBe(true);
      expect([outcome.resultCut, outcome.resultFinal]).toEqual([false, true]);
      const last = answers(events).at(-1);
      expect(last?.text === text).toBe(true);
      expect([last?.cut, last?.final]).toEqual([false, true]);
    });

    test("an answer whose line escaping makes far longer than 1 MiB is kept whole", () => {
      const text = escapedHeavy(ANSWER_CAP_BYTES);
      expect(size(text)).toBe(ANSWER_CAP_BYTES);
      const lines = finalLines(kind, text);
      expect(size(lines[0] ?? "")).toBeGreaterThan(2 * ANSWER_CAP_BYTES);
      const parser = createStreamParser(kind);
      parser.push(`${lines.join("\n")}\n`);
      const { outcome } = parser.end(exit0);
      expect(outcome.result === text).toBe(true);
      expect(outcome.resultCut).toBe(false);
    });

    test("an answer longer than 1 MiB is cut on a code point boundary and flagged, and the run still succeeds", () => {
      const text = "€".repeat(ANSWER_CAP_BYTES / 2);
      const parser = createStreamParser(kind);
      parser.push(`${finalLines(kind, text).join("\n")}\n`);
      const { outcome } = parser.end(exit0);
      expect(outcome.reason).toBe("success");
      const kept = outcome.result ?? "";
      expect(size(kept)).toBeLessThanOrEqual(ANSWER_CAP_BYTES);
      expect(size(kept)).toBeGreaterThan(ANSWER_CAP_BYTES - 3);
      expect(text.startsWith(kept)).toBe(true);
      expect([outcome.resultCut, outcome.resultFinal]).toEqual([true, true]);
      expect(outcome.counts.cappedTexts).toBeGreaterThanOrEqual(1);
    });

    test("each message is the answer so far; only the end of the agent's turn makes it final", () => {
      const parser = createStreamParser(kind);
      const first = answers(parser.push(`${messageLine(kind, "Looking.")}\n`));
      expect(first).toEqual([{ kind: "answer", text: "Looking.", final: false, cut: false }]);
      const second = answers(parser.push(`${messageLine(kind, "Found it.")}\n`));
      expect(second).toEqual([{ kind: "answer", text: "Found it.", final: false, cut: false }]);
      // Stopped before the turn ended: the last message is the answer, not final.
      const { outcome } = parser.end({ code: null, signal: "SIGKILL" });
      expect(outcome.result).toBe("Found it.");
      expect(outcome.resultFinal).toBe(false);
    });

    test("an answer on a line too long to read leaves the earlier message unfinished, never final", () => {
      const parser = createStreamParser(kind);
      parser.push(`${messageLine(kind, "Working.")}\n`);
      const lines = finalLines(kind, "a".repeat(LINE_CAP_BYTES + 1));
      parser.push(`${lines.join("\n")}\n`);
      const { outcome } = parser.end(exit0);
      expect([outcome.result, outcome.resultFinal]).toEqual(["Working.", false]);
      expect(outcome.counts.oversized).toBe(1);
    });

    test("a message after the final answer begins a new turn: it replaces the answer, and that turn has no result", () => {
      const parser = createStreamParser(kind);
      parser.push(`${finalLines(kind, "The answer.").join("\n")}\n`);
      expect(answers(parser.push(`${messageLine(kind, "More work.")}\n`)).at(-1)).toMatchObject({
        text: "More work.",
        final: false,
      });
      const { outcome } = parser.end(exit0);
      expect([outcome.result, outcome.resultFinal, outcome.reason]).toEqual([
        "More work.",
        false,
        "no_result",
      ]);
    });
  },
);
