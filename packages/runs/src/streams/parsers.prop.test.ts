// Fuzzing the stream parsers over mutated recordings (A4 5.1 "Parsers (fuzzing)", A7 3.18.1).
// Each case takes a recording of lab run N, mutates its lines and bytes (cut, drop, repeat, swap,
// insert noise, unknown events, retyped fields, invalid UTF-8, lines around the cap), feeds it in
// random chunks and ends it with a random exit. The parser must never throw, never log, keep its
// memory bounded and give the same events however the bytes were chunked.
//
// A failure reports only fast-check's seed and path, which reproduce it, and the failed check's
// name: the mutated input may hold fixture text and is not printed.
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fixtureBytes, fixtureEntry, fixtureFiles } from "../../test/fixtures.ts";
import {
  ANSWER_CAP_BYTES,
  APP_TOOLS_STATES,
  LINE_CAP_BYTES,
  LONG_LINE_CAP_BYTES,
  OUTCOME_REASONS,
  PROGRESS_LABELS,
  TEXT_CAP_BYTES,
  createStreamParser,
  type ProcessExit,
  type RunEvent,
  type StreamKind,
} from "./index.ts";

const NUM_RUNS = 200;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RECORDINGS = fixtureFiles().map((file) => ({
  kind: fixtureEntry(file).cli,
  lines: decoder.decode(fixtureBytes(file)).split("\n"),
}));

// ---------------------------------------------------------------------------------------------
// Mutations.
type Mutation =
  | { op: "cut"; at: number; pos: number }
  | { op: "drop"; at: number }
  | { op: "repeat"; at: number }
  | { op: "swap"; at: number; to: number }
  | { op: "insert"; at: number; line: string }
  | { op: "retype"; at: number; key: number; value: unknown }
  | { op: "huge"; at: number; delta: number; valid: boolean };

const index = fc.nat({ max: 1000 });
const eventType = fc.oneof(
  fc.constantFrom(
    "system",
    "assistant",
    "user",
    "result",
    "thread.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "error",
    "item.started",
    "item.updated",
    "item.completed",
  ),
  fc.string({ maxLength: 12 }),
);
const noiseLine = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.stringify(v)),
  fc
    .record({ type: eventType, payload: fc.jsonValue({ maxDepth: 3 }) })
    .map((v) => JSON.stringify(v)),
  fc
    .record({
      type: fc.constantFrom("item.started", "item.completed"),
      item: fc.record({
        id: fc.string({ maxLength: 6 }),
        type: fc.oneof(
          fc.constantFrom("agent_message", "command_execution", "mcp_tool_call", "error"),
          fc.string({ maxLength: 8 }),
        ),
        status: fc.constantFrom("declined", "completed", 3, null),
        text: fc.oneof(fc.string({ maxLength: 20 }), fc.integer()),
      }),
    })
    .map((v) => JSON.stringify(v)),
);
const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant("cut" as const), at: index, pos: index }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("drop" as const), at: index }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("repeat" as const), at: index }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("swap" as const), at: index, to: index }) },
  {
    weight: 3,
    arbitrary: fc.record({ op: fc.constant("insert" as const), at: index, line: noiseLine }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("retype" as const),
      at: index,
      key: index,
      value: fc.jsonValue({ maxDepth: 2 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("huge" as const),
      at: index,
      delta: fc.integer({ min: -3, max: 3 }),
      valid: fc.boolean(),
    }),
  },
);

/** Sets a value at a field chosen by `key` among the object's own fields and its nested ones. */
function retype(line: string, key: number, value: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof parsed !== "object" || parsed === null) return line;
  const holders: Record<string, unknown>[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (typeof v !== "object" || v === null || depth > 4) return;
    if (!Array.isArray(v)) holders.push(v as Record<string, unknown>);
    for (const child of Object.values(v)) collect(child, depth + 1);
  };
  collect(parsed, 0);
  const holder = holders[key % holders.length];
  if (holder === undefined) return line;
  const keys = Object.keys(holder);
  const name = keys[Math.floor(key / holders.length) % Math.max(keys.length, 1)] ?? "added";
  holder[name] = value;
  return JSON.stringify(parsed);
}

/** A line of LINE_CAP_BYTES + delta bytes: whole JSON, or the same length with its end cut off. */
function hugeLine(delta: number, valid: boolean): string {
  const size = LINE_CAP_BYTES + delta;
  const head = '{"type":"assistant","message":{"content":[{"type":"text","text":"';
  const tail = valid ? '"}]}}' : "zzzzz"; // no closing quote or brackets: not JSON
  return head + "z".repeat(size - head.length - tail.length) + tail;
}

function mutate(lines: readonly string[], mutations: readonly Mutation[]): string[] {
  const out = [...lines];
  for (const m of mutations) {
    const n = out.length;
    const at = n === 0 ? 0 : m.at % n;
    switch (m.op) {
      case "cut":
        if (n > 0) out[at] = (out[at] ?? "").slice(0, m.pos % ((out[at] ?? "").length + 1));
        break;
      case "drop":
        if (n > 0) out.splice(at, 1);
        break;
      case "repeat":
        if (n > 0) out.splice(at, 0, out[at] ?? "");
        break;
      case "swap":
        if (n > 1) {
          const to = m.to % n;
          [out[at], out[to]] = [out[to] ?? "", out[at] ?? ""];
        }
        break;
      case "insert":
        out.splice(at, 0, m.line);
        break;
      case "retype":
        if (n > 0) out[at] = retype(out[at] ?? "", m.key, m.value);
        break;
      case "huge":
        out.splice(at, 0, hugeLine(m.delta, m.valid));
        break;
    }
  }
  return out;
}

/** Byte-level damage: invalid UTF-8 and stray bytes at chosen places. */
const byteNoise = fc.array(
  fc.record({
    at: fc.nat(),
    bytes: fc.oneof(
      fc.constantFrom(
        [0xff],
        [0xc0, 0x80],
        [0xed, 0xa0, 0x80],
        [0xe2, 0x82],
        [0x0d],
        [0x0a],
        [0x00],
      ),
      fc.array(fc.nat({ max: 255 }), { minLength: 1, maxLength: 4 }),
    ),
  }),
  { maxLength: 4 },
);

function damage(
  stream: Uint8Array,
  noise: readonly { at: number; bytes: readonly number[] }[],
): Uint8Array {
  let out = stream;
  for (const { at, bytes } of noise) {
    const pos = out.length === 0 ? 0 : at % (out.length + 1);
    const next = new Uint8Array(out.length + bytes.length);
    next.set(out.subarray(0, pos));
    next.set(bytes, pos);
    next.set(out.subarray(pos), pos + bytes.length);
    out = next;
  }
  return out;
}

function chunked(stream: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let at = 0;
  let i = 0;
  while (at < stream.length) {
    const size = sizes.length === 0 ? stream.length : (sizes[i % sizes.length] ?? 1);
    chunks.push(stream.subarray(at, at + size));
    at += size;
    i += 1;
  }
  return chunks;
}

const exitArb: fc.Arbitrary<ProcessExit> = fc.record({
  code: fc.option(fc.oneof(fc.integer({ min: -1, max: 255 }), fc.constant(3221225786))),
  signal: fc.option(fc.constantFrom("SIGTERM", "SIGKILL", "SIGINT", "bogus signal")),
});

const fuzzCase = fc.record({
  recording: fc.constantFrom(...RECORDINGS),
  mutations: fc.array(mutation, { maxLength: 6 }),
  noise: byteNoise,
  trailingNewline: fc.boolean(),
  sizes: fc.array(fc.integer({ min: 1, max: 4096 }), { maxLength: 8 }),
  exit: exitArb,
});

// ---------------------------------------------------------------------------------------------
// Checks. Each throws an Error named after the check, with no content in its message.
class CheckFailed extends Error {}
function check(name: string, holds: boolean): void {
  if (!holds) throw new CheckFailed(name);
}

const byteLength = (s: string): number => encoder.encode(s).length;
const textOk = (s: string, cap = TEXT_CAP_BYTES): boolean =>
  s.isWellFormed() && byteLength(s) <= cap;

function checkEvents(events: readonly RunEvent[]): void {
  check(
    "exactly one finished event, last",
    events.filter((e) => e.kind === "finished").length === 1,
  );
  check("finished is last", events.at(-1)?.kind === "finished");
  check("at most one native ID", events.filter((e) => e.kind === "native-id").length <= 1);
  for (const e of events) {
    switch (e.kind) {
      case "native-id":
        check("native ID shape", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(e.id));
        break;
      case "session":
        check("session state", (APP_TOOLS_STATES as readonly string[]).includes(e.appTools));
        check("session cwd", e.cwd === null || textOk(e.cwd));
        break;
      case "progress":
        check("label vocabulary", (PROGRESS_LABELS as readonly string[]).includes(e.label));
        break;
      case "message":
        check("message text", e.text !== "" && textOk(e.text));
        break;
      case "answer":
        check("answer text", e.text !== "" && textOk(e.text, ANSWER_CAP_BYTES));
        break;
      case "usage":
        for (const v of [
          e.inputTokens,
          e.cachedInputTokens,
          e.outputTokens,
          e.reasoningOutputTokens,
        ]) {
          check("token count", v === undefined || (Number.isSafeInteger(v) && v >= 0));
        }
        check("cost", e.costUsd === undefined || (Number.isFinite(e.costUsd) && e.costUsd >= 0));
        break;
      case "finished":
        check("reason vocabulary", (OUTCOME_REASONS as readonly string[]).includes(e.reason));
        check("ok only on success", e.ok === (e.reason === "success"));
        break;
    }
  }
}

function run(kind: StreamKind, chunks: readonly Uint8Array[], exit: ProcessExit) {
  const parser = createStreamParser(kind);
  const events: RunEvent[] = [];
  for (const c of chunks) {
    events.push(...parser.push(c));
    const held = parser.held();
    check("line buffer bounded", held.bufferCapacity <= LONG_LINE_CAP_BYTES + 1);
    check("retained keys bounded", held.retained <= 1024);
  }
  const end = parser.end(exit);
  return { events: [...events, ...end.events], outcome: end.outcome };
}

const logSinks = ["log", "info", "warn", "error", "debug", "trace"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[A4.5.parsers.fuzz] stream parsers over mutated recordings", () => {
  test(`never throw, never log, bounded memory, chunking-independent (${String(NUM_RUNS)} runs)`, () => {
    // The sinks are silenced, not only watched: a write could hold stream content, so it must
    // neither reach the output nor the failure message. Only the number of calls is checked.
    const spies = [
      ...logSinks.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    const property = fc.property(fuzzCase, (c) => {
      const lines = mutate(c.recording.lines, c.mutations);
      let text = lines.join("\n");
      if (c.trailingNewline && !text.endsWith("\n")) text += "\n";
      const stream = damage(encoder.encode(text), c.noise);

      const whole = run(c.recording.kind, [stream], c.exit);
      const pieces = run(c.recording.kind, chunked(stream, c.sizes), c.exit);

      checkEvents(whole.events);
      const o = whole.outcome;
      const n = o.counts;
      check("no handler fault", n.handlerFaults === 0);
      check(
        "every line counted once",
        n.lines ===
          n.blank + n.events + n.unknownEvents + n.notJson + n.oversized + n.truncatedTail,
      );
      check("ok only on success", o.ok === (o.reason === "success"));
      check("no error on success", !o.ok || o.error === null);
      check("result text", o.result === null || textOk(o.result, ANSWER_CAP_BYTES));
      const last = whole.events.filter((e) => e.kind === "answer").at(-1);
      check("result is the last answer", (last?.text ?? null) === o.result);
      check(
        "result flags",
        o.resultCut === (last?.cut ?? false) && o.resultFinal === (last?.final ?? false),
      );
      check("error text", o.error === null || textOk(o.error));
      check("no_output only without events", (o.reason === "no_output") === (n.events === 0));
      check(
        "chunking: same events",
        JSON.stringify(pieces.events) === JSON.stringify(whole.events),
      );
      check("chunking: same outcome", JSON.stringify(pieces.outcome) === JSON.stringify(o));
    });
    const result = fc.check(property, { numRuns: NUM_RUNS });
    const writes = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    vi.restoreAllMocks();
    expect(writes, "the parsers wrote to the console or stdio").toBe(0);
    if (result.failed) {
      const why =
        result.errorInstance instanceof CheckFailed ? result.errorInstance.message : "exception";
      throw new Error(
        `fuzz check "${why}" failed: seed ${String(result.seed)}, path ${String(result.counterexamplePath)}`,
      );
    }
  });

  test("the unmutated recordings pass the same checks", () => {
    for (const r of RECORDINGS) {
      const stream = encoder.encode(r.lines.join("\n"));
      const out = run(r.kind, [stream], { code: 0, signal: null });
      checkEvents(out.events);
      expect(out.outcome.counts.handlerFaults).toBe(0);
    }
  });
});
