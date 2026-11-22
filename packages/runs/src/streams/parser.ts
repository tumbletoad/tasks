// The stream parser frame (A4 3.11.4): bytes or lines in, normalised events and a final outcome
// out. Pure: no I/O, no clock, no logging. The CLI-specific part is a `CliReader` (claude-print.ts)
// that reads one parsed JSON object at a time.
//
// Tolerant by construction: a line is split in bounded memory (lines.ts), decoded leniently,
// parsed inside a try, and read through checked accessors (values.ts). A line handler that still
// throws is a defect; it is caught, counted in `handlerFaults` and the line is skipped, so even a
// defect never ends a run. Nothing of a skipped line is kept or logged: only its count.
import { createHash } from "node:crypto";
import {
  ANSWER_CAP_BYTES,
  LINE_CAP_BYTES,
  emptyCounts,
  type AppToolsState,
  type OutcomeReason,
  type ProcessExit,
  type ProgressLabel,
  type RunEvent,
  type RunOutcome,
  type StreamCounts,
  type StreamKind,
  type Usage,
} from "./events.ts";
import { LineSplitter, type Line, type LineResult } from "./lines.ts";
import { capText, isRecord, type Json } from "./values.ts";

/** What a CLI reader may do while it reads one event. */
export class ReadContext {
  readonly counts: StreamCounts = emptyCounts();
  nativeId: string | null = null;
  lastMessage: string | null = null;
  answerSeen: { text: string; final: boolean; cut: boolean } | null = null;
  /** A line too long to read came after the last answer: it may have been a later one. */
  answerUnsure = false;
  lastError: string | null = null;
  usage: Usage | null = null;
  session: { cwd: string | null; appTools: AppToolsState } | null = null;
  out: RunEvent[] = [];

  /**
   * Reports the native session or thread ID. A repeat of the same ID adds no event. Returns
   * whether the ID is the run's own: false for a second, different one.
   */
  nativeIdSeen(id: string): boolean {
    if (this.nativeId === id) return true;
    if (this.nativeId !== null) {
      // A second, different ID in one stream: keep the first, which the run was started with.
      this.counts.malformed += 1;
      return false;
    }
    this.nativeId = id;
    this.out.push({ kind: "native-id", id });
    return true;
  }

  sessionSeen(cwd: string | null, appTools: AppToolsState): void {
    const capped = cwd === null ? null : this.cap(cwd);
    this.session = { cwd: capped, appTools };
    this.out.push({ kind: "session", cwd: capped, appTools });
  }

  progress(label: ProgressLabel): void {
    this.counts.progress += 1;
    this.out.push({ kind: "progress", label });
  }

  /** An assistant message: a message event (TEXT_CAP_BYTES) and the answer so far. */
  message(text: string): void {
    if (text === "") return;
    const capped = this.cap(text);
    this.lastMessage = capped;
    this.counts.messages += 1;
    this.out.push({ kind: "message", text: capped });
    this.answer(text, false);
  }

  /**
   * The agent's answer (ANSWER_CAP_BYTES), as an answer event. A message never replaces an answer
   * the agent finished its turn with.
   */
  answer(text: string, final: boolean): void {
    if (text === "" || (!final && this.answerSeen?.final === true)) return;
    const r = capText(text, ANSWER_CAP_BYTES);
    if (r.capped) this.counts.cappedTexts += 1;
    this.answerSeen = { text: r.text, final, cut: r.capped };
    this.answerUnsure = false;
    this.out.push({ kind: "answer", ...this.answerSeen });
  }

  /**
   * A new turn began after one the agent finished: the answer it finished that turn with is only
   * the latest thing it said, which the new turn's words replace.
   */
  answerReopened(): void {
    const seen = this.answerSeen;
    if (seen === null || !seen.final) return;
    this.answerSeen = { ...seen, final: false };
    this.out.push({ kind: "answer", ...this.answerSeen });
  }

  /** The agent finished its turn with the answer it gave last, if any. */
  answerFinished(): void {
    const seen = this.answerSeen;
    if (seen === null || seen.final || this.answerUnsure) return;
    this.answerSeen = { ...seen, final: true };
    this.out.push({ kind: "answer", ...this.answerSeen });
  }

  error(text: string): void {
    if (text !== "") this.lastError = this.cap(text);
  }

  /** Reports the run's usage so far. The event always carries the whole run's total. */
  usageSeen(usage: Usage): void {
    if (Object.keys(usage).length === 0) return;
    this.usage = usage;
    this.out.push({ kind: "usage", ...usage });
  }

  cap(text: string): string {
    const r = capText(text);
    if (r.capped) this.counts.cappedTexts += 1;
    return r.text;
  }
}

export interface CliReader {
  /** Reads one JSON object. Returns false when its type is unknown (it is then skipped). */
  read(event: Json, ctx: ReadContext): boolean;
  /** Judges the run from what was read and how the process ended. */
  judge(exit: ProcessExit, ctx: ReadContext): { ok: boolean; reason: OutcomeReason };
  /** Keys the reader keeps for deduplication, for the bounded-memory test. */
  retained(): { keys: number; chars: number };
}

export interface StreamParser {
  readonly kind: StreamKind;
  /** Feeds raw stdout bytes (or text, encoded as UTF-8). Returns the events they completed. */
  push(chunk: Uint8Array | string): RunEvent[];
  /** Feeds one complete line, without its line break (A4 3.11.1 `parse(line)`). */
  line(text: string): RunEvent[];
  /**
   * Ends the stream after the process exited: parses an unterminated rest, then returns the
   * `finished` event and the outcome. Calling it again returns the same outcome and no events.
   */
  end(exit: ProcessExit): { events: RunEvent[]; outcome: RunOutcome };
  /** Counts so far. */
  counts(): StreamCounts;
  /** Memory held between calls, for tests: line-buffer bytes and retained objects. */
  held(): {
    bufferedBytes: number;
    bufferCapacity: number;
    retained: number;
    retainedChars: number;
  };
}

const encoder = new TextEncoder();

export function createParser(kind: StreamKind, reader: CliReader): StreamParser {
  const ctx = new ReadContext();
  const splitter = new LineSplitter(LINE_CAP_BYTES);
  let finished: RunOutcome | null = null;

  const readLine = (line: Line): void => {
    const c = ctx.counts;
    c.lines += 1;
    if (line.invalidUtf8) c.invalidUtf8 += 1;
    if (line.text.trim() === "") {
      c.blank += 1;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line.text);
    } catch {
      if (line.partial) c.truncatedTail = 1;
      else c.notJson += 1;
      return;
    }
    if (!isRecord(value)) {
      c.notJson += 1;
      return;
    }
    try {
      if (reader.read(value, ctx)) c.events += 1;
      else c.unknownEvents += 1;
    } catch {
      c.handlerFaults += 1;
    }
  };

  const take = (results: readonly LineResult[]): RunEvent[] => {
    ctx.out = [];
    for (const r of results) {
      if (r.kind === "oversized") {
        ctx.counts.oversized += 1;
        ctx.counts.lines += 1;
        ctx.answerUnsure = true;
      } else {
        readLine(r.line);
      }
    }
    return ctx.out;
  };

  return {
    kind,
    push(chunk) {
      if (finished) return [];
      return take(splitter.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk));
    },
    line(text) {
      if (finished) return [];
      // A line handed over whole still obeys the cap. Each UTF-16 unit is at least one UTF-8
      // byte, so a longer string is over it without encoding.
      // A BOM at the start is dropped, as the UTF-8 decoder drops it from a pushed line.
      const unmarked = text.startsWith("﻿") ? text.slice(1) : text;
      const body = unmarked.endsWith("\r") ? unmarked.slice(0, -1) : unmarked;
      if (body.length > LINE_CAP_BYTES || encoder.encode(body).length > LINE_CAP_BYTES) {
        return take([{ kind: "oversized" }]);
      }
      const invalidUtf8 = !body.isWellFormed();
      const line = { text: invalidUtf8 ? body.toWellFormed() : body, invalidUtf8, partial: false };
      return take([{ kind: "line", line }]);
    },
    end(exit) {
      if (finished) return { events: [], outcome: finished };
      const events = take(splitter.end());
      const clean: ProcessExit = {
        code: typeof exit.code === "number" && Number.isInteger(exit.code) ? exit.code : null,
        signal:
          typeof exit.signal === "string" && /^[A-Z0-9]{1,16}$/.test(exit.signal)
            ? exit.signal
            : null,
      };
      const verdict =
        ctx.counts.events === 0
          ? { ok: false, reason: "no_output" as const }
          : reader.judge(clean, ctx);
      finished = {
        ok: verdict.ok,
        reason: verdict.reason,
        exit: clean,
        nativeId: ctx.nativeId,
        result: ctx.answerSeen?.text ?? null,
        resultCut: ctx.answerSeen?.cut ?? false,
        resultFinal: ctx.answerSeen?.final ?? false,
        error: verdict.ok ? null : ctx.lastError,
        usage: ctx.usage,
        session: ctx.session,
        counts: { ...ctx.counts },
      };
      return {
        events: [...events, { kind: "finished", ok: verdict.ok, reason: verdict.reason }],
        outcome: finished,
      };
    },
    counts: () => ({ ...ctx.counts }),
    held: () => {
      const kept = reader.retained();
      return {
        bufferedBytes: splitter.buffered,
        bufferCapacity: splitter.capacity,
        retained: kept.keys,
        retainedChars: kept.chars,
      };
    },
  };
}

/** The longest key kept as it is. A longer one is kept as its SHA-256, so no key holds more. */
export const KEY_CAP_CHARS = 128;

/**
 * Remembers recent keys (tool-use and item IDs) so a label is given once per call, in bounded
 * memory: at most `max` keys of at most KEY_CAP_CHARS each. Past `max` keys the oldest half is
 * forgotten. An ID is agent-written and may be close to the line cap, so a long one is kept as
 * its digest: the same long ID still matches, and memory stays bounded by count and size.
 */
export class RecentKeys {
  private keys = new Set<string>();
  private readonly max: number;

  constructor(max = 512) {
    this.max = max;
  }

  /** Adds the key. Returns false when it was already there. */
  add(id: string): boolean {
    const key =
      id.length <= KEY_CAP_CHARS
        ? `=${id}`
        : `#${createHash("sha256").update(id.toWellFormed()).digest("base64")}`;
    if (this.keys.has(key)) return false;
    if (this.keys.size >= this.max) {
      this.keys = new Set([...this.keys].slice(this.max / 2));
    }
    this.keys.add(key);
    return true;
  }

  get size(): number {
    return this.keys.size;
  }

  /** Characters held in keys, for the bounded-memory test. */
  get chars(): number {
    let n = 0;
    for (const k of this.keys) n += k.length;
    return n;
  }
}
