// M6.05 Verify: truncated, unknown and over-long lines never make the parser throw (A4 3.11.4, A4 5.1
// "Parsers (fuzzing)"). Also invalid UTF-8, unknown fields, a stream that ends mid-line, and
// bounded memory however the input is chunked. Assertions are on counts and shapes only.
import { describe, expect, test } from "vitest";
import {
  ANSWER_CAP_BYTES,
  LINE_CAP_BYTES,
  STREAM_KINDS,
  TEXT_CAP_BYTES,
  createStreamParser,
  parseStream,
  type RunEvent,
  type StreamKind,
} from "./index.ts";

const encoder = new TextEncoder();
const bytes = (s: string): Uint8Array => encoder.encode(s);
const exit0 = { code: 0, signal: null };

/** A minimal successful stream of each CLI. */
const OK: Record<StreamKind, string[]> = {
  "claude-print": [
    '{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001","cwd":"/w","mcp_servers":[{"name":"ttasks","status":"connected"}]}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"b","usage":{"input_tokens":1,"output_tokens":2}}',
  ],
};

const kinds = (events: readonly RunEvent[]): string[] => events.map((e) => e.kind);

/** A JSON line of the given UTF-8 length that is a whole, known-but-unused event. */
function bigLine(_kind: StreamKind, length: number): string {
  const head = '{"type":"user","pad":"';
  return head + "x".repeat(length - head.length - 2) + '"}';
}

/** A message event whose text is `size` times `char`. */
function bigMessage(_kind: StreamKind, size: number, char = "y"): string {
  const text = char.repeat(size);
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

describe.each(STREAM_KINDS)(
  "[A4.5.parsers.tolerance] %s: truncated, unknown and over-long lines never make the parser throw",
  (kind) => {
    test("a truncated line in the middle is skipped and counted, and the run still succeeds", () => {
      const [first, ...rest] = OK[kind];
      const cut = (rest[0] ?? "").slice(0, 20);
      const stream = [first, cut, ...rest].join("\n") + "\n";
      const { outcome } = parseStream(kind, stream, exit0);
      expect(outcome.counts.notJson).toBe(1);
      expect(outcome.reason).toBe("success");
    });

    test("a stream that ends mid-line counts its truncated tail and judges what came before", () => {
      const stream = OK[kind].join("\n");
      const cut = stream.slice(0, stream.length - 5);
      const { outcome } = parseStream(kind, cut, { code: null, signal: "SIGTERM" });
      expect(outcome.counts.truncatedTail).toBe(1);
      expect(outcome.reason).toBe("no_result");
      // A whole final event without its newline still counts.
      const whole = parseStream(kind, stream, exit0);
      expect(whole.outcome.counts.truncatedTail).toBe(0);
      expect(whole.outcome.reason).toBe("success");
    });

    test("unknown event types, unknown fields and wrong field types are skipped, not fatal", () => {
      const noise = [
        '{"type":"some.future.event","payload":{"deep":[1,2,3]}}',
        '{"no_type_at_all":true}',
        '{"type":42}',
        "[1,2,3]",
        '"just a string"',
        "null",
        "not json at all",
        '{"type":"assistant","message":"not an object"}',
        '{"type":"item.completed","item":{"id":"i","type":"future_item"}}',
        '{"type":"item.started","item":null}',
        '{"type":"result","is_error":"yes","usage":{"input_tokens":-1,"output_tokens":1e400}}',
      ];
      const lines = [...OK[kind]];
      lines.splice(1, 0, ...noise);
      // Unknown fields on known events.
      lines.push(lines.pop()?.replace(/}$/, ',"unknown_field":{"x":[null]}}') ?? "");
      const { outcome } = parseStream(kind, lines.join("\n") + "\n", exit0);
      const c = outcome.counts;
      expect(c.unknownEvents).toBeGreaterThanOrEqual(3);
      expect(c.notJson).toBe(4);
      expect(c.handlerFaults).toBe(0);
      expect(c.events).toBeGreaterThanOrEqual(OK[kind].length);
    });

    test("a line exactly at the cap is parsed; one byte more is skipped whole", () => {
      const atCap = bigLine(kind, LINE_CAP_BYTES);
      const overCap = bigLine(kind, LINE_CAP_BYTES + 1);
      expect(bytes(atCap).length).toBe(LINE_CAP_BYTES);
      const stream = [OK[kind][0], atCap, overCap, ...OK[kind].slice(1)].join("\n") + "\n";
      const { outcome } = parseStream(kind, stream, exit0);
      expect(outcome.counts.oversized).toBe(1);
      expect(outcome.counts.events).toBe(OK[kind].length + 1);
      expect(outcome.reason).toBe("success");
      // CRLF: the CR does not count against the cap.
      const crlf = parseStream(kind, `${atCap}\r\n${overCap}\r\n`, exit0);
      expect([crlf.outcome.counts.events, crlf.outcome.counts.oversized]).toEqual([1, 1]);
    });

    test("a message over the answer cap: its message event is cut to 8 KB and its answer to 1 MiB, on a code point boundary", () => {
      // Three-byte characters, so each cut falls inside a code point unless it is careful.
      const parser = createStreamParser(kind);
      const line = bigMessage(kind, 400_000, "€");
      const events = parser.push(`${line}\n`);
      const message = events.find((e) => e.kind === "message");
      if (message?.kind !== "message") throw new Error("no message event");
      const size = bytes(message.text).length;
      expect(size).toBeLessThanOrEqual(TEXT_CAP_BYTES);
      expect(size).toBeGreaterThan(TEXT_CAP_BYTES - 3);
      expect(message.text.isWellFormed()).toBe(true);
      const answer = events.find((e) => e.kind === "answer");
      if (answer?.kind !== "answer") throw new Error("no answer event");
      expect(bytes(answer.text).length).toBeLessThanOrEqual(ANSWER_CAP_BYTES);
      expect(bytes(answer.text).length).toBeGreaterThan(ANSWER_CAP_BYTES - 3);
      expect(answer.text.isWellFormed()).toBe(true);
      expect([answer.cut, answer.final]).toEqual([true, false]);
      expect(parser.counts().cappedTexts).toBe(2);
    });

    test("invalid UTF-8 is counted and decoded leniently, so its event is not lost", () => {
      // A message whose text holds an invalid byte and an overlong encoding.
      const [pre = "", post = ""] = bigMessage(kind, 3).split("yyy");
      const parser = createStreamParser(kind);
      const events = [
        ...parser.push(bytes(`${pre}y`)),
        ...parser.push(new Uint8Array([0xff, 0xc0, 0x80])),
        ...parser.push(bytes(`y${post}`)),
        ...parser.push(new Uint8Array([0x0a, 0xff, 0xfe, 0x0a])),
        // An encoded lone surrogate, which UTF-8 does not allow.
        ...parser.push(new Uint8Array([0xed, 0xa0, 0x80, 0x0a])),
      ];
      const message = events.find((e) => e.kind === "message");
      if (message?.kind !== "message") throw new Error("no message event");
      expect(message.text.isWellFormed()).toBe(true);
      const { outcome } = parser.end(exit0);
      expect(outcome.counts.invalidUtf8).toBe(3);
      expect(outcome.counts.notJson).toBe(2);
      expect(outcome.counts.handlerFaults).toBe(0);
    });

    test("a lone surrogate in a whole line handed over as text is made well-formed", () => {
      const parser = createStreamParser(kind);
      const events = parser.line(bigMessage(kind, 3).replace("yyy", "y\\ud800y"));
      const message = events.find((e) => e.kind === "message");
      if (message?.kind !== "message") throw new Error("no message event");
      expect(message.text.isWellFormed()).toBe(true);
      const raw = parser.line(`{"type":"x","v":"\ud800"}`);
      expect(raw).toEqual([]);
      expect(parser.counts().invalidUtf8).toBe(1);
    });

    test("a whole line over the cap handed over as text is skipped", () => {
      const parser = createStreamParser(kind);
      expect(parser.line(bigLine(kind, LINE_CAP_BYTES + 1))).toEqual([]);
      expect(parser.line("€".repeat(LINE_CAP_BYTES / 3 + 1))).toEqual([]);
      expect(parser.counts().oversized).toBe(2);
    });

    test("memory stays bounded: 64 MB without a newline holds at most the cap", () => {
      const parser = createStreamParser(kind);
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      let most = 0;
      for (let i = 0; i < 1024; i += 1) {
        parser.push(chunk);
        most = Math.max(most, parser.held().bufferCapacity);
      }
      expect(most).toBeLessThanOrEqual(LINE_CAP_BYTES + 1);
      expect(parser.held().bufferedBytes).toBe(0);
      // The skipped line ends at its newline, and parsing goes on.
      parser.push(`\n${OK[kind].join("\n")}\n`);
      const { outcome } = parser.end(exit0);
      expect(outcome.counts.oversized).toBe(1);
      expect(outcome.reason).toBe("success");
      // After the long line the buffer shrinks back.
      expect(parser.held().bufferCapacity).toBeLessThanOrEqual(16 * 1024);
    });

    test("memory stays bounded: a line at the cap fed in small pieces", () => {
      const parser = createStreamParser(kind);
      const line = bytes(bigLine(kind, LINE_CAP_BYTES));
      for (let i = 0; i < line.length; i += 61) parser.push(line.subarray(i, i + 61));
      expect(parser.held().bufferedBytes).toBe(LINE_CAP_BYTES);
      parser.push("\n");
      expect(parser.counts().events).toBe(1);
    });

    test("memory stays bounded: 100,000 distinct tool calls keep a bounded key set", () => {
      const parser = createStreamParser(kind);
      for (let i = 0; i < 100_000; i += 1) {
        parser.push(
          `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t${String(i)}","name":"Bash"}]}}\n`,
        );
      }
      expect(parser.held().retained).toBeLessThanOrEqual(2 * 512);
      expect(parser.counts().progress).toBe(100_000);
    });

    test("memory stays bounded: tool and item IDs near 1 MB keep the key set small", () => {
      const parser = createStreamParser(kind);
      const event = (i: number): string => {
        const id = String(i).padStart(8, "0") + "k".repeat(1024 * 1024 - 200);
        return JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name: "Bash" }] },
        });
      };
      for (let i = 0; i < 600; i += 1) parser.push(event(i) + "\n");
      // The same long ID again is still the same call.
      parser.push(event(599) + "\n");
      const held = parser.held();
      expect(held.retained).toBeLessThanOrEqual(2 * 512);
      expect(held.retainedChars).toBeLessThanOrEqual(2 * 512 * 128);
      expect(parser.counts().progress).toBe(600);
    });

    test("an end in the middle of a code point, a CR, or nothing at all never throws", () => {
      for (const tail of [new Uint8Array([0xe2, 0x82]), bytes("\r"), new Uint8Array(0)]) {
        const parser = createStreamParser(kind);
        parser.push(bytes(OK[kind][0] ?? ""));
        parser.push(bytes("\n"));
        parser.push(tail);
        const { events, outcome } = parser.end({ code: 1, signal: null });
        expect(kinds(events).at(-1)).toBe("finished");
        expect(outcome.counts.handlerFaults).toBe(0);
      }
    });

    test("end is final: it returns the same outcome again, and later input is ignored", () => {
      const parser = createStreamParser(kind);
      parser.push(OK[kind].join("\n") + "\n");
      const first = parser.end(exit0);
      expect(parser.push(OK[kind].join("\n") + "\n")).toEqual([]);
      expect(parser.line(OK[kind][0] ?? "")).toEqual([]);
      const second = parser.end({ code: 9, signal: null });
      expect(second.events).toEqual([]);
      expect(second.outcome).toBe(first.outcome);
    });

    test("a deeply nested line parses without a stack overflow", () => {
      const depth = 200_000;
      const nested = `{"type":"x","v":${"[".repeat(depth)}${"]".repeat(depth)}}`;
      const parser = createStreamParser(kind);
      parser.push(`${nested}\n`);
      expect(parser.counts().handlerFaults).toBe(0);
      expect(parser.counts().lines).toBe(1);
    });

    test("an out-of-range exit code or a strange signal name is normalised, not trusted", () => {
      const parser = createStreamParser(kind);
      parser.push(OK[kind].join("\n") + "\n");
      const { outcome } = parser.end({ code: 1.5, signal: "not a signal; rm" });
      expect(outcome.exit).toEqual({ code: null, signal: null });
      expect(outcome.reason).toBe("exit_status");
    });
  },
);
