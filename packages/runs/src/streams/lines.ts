// Splits a byte stream into lines, incrementally and in bounded memory (A4 3.11.4).
//
// - A line ends at LF. A CR before the LF is dropped, so CRLF streams parse the same.
// - A line longer than the cap is not kept: once the buffer would pass the cap, the bytes held so
//   far go to its reader, when the splitter reads long lines (cut-json.ts), and are released; the
//   rest of the line goes to the reader as it comes, up to its LF. The splitter never holds more
//   than cap + 1 bytes, whatever the input and however it is chunked, and the reader keeps at most
//   CUT_KEPT_BYTES. The line is reported when it ends, with its value cut when it could be read.
// - Bytes are decoded as UTF-8 only once a line is complete, so a code point split across chunks
//   decodes correctly. Invalid UTF-8 is reported and decoded with replacement characters.
// - At the end of the stream, an unterminated rest is handed out as a final, partial line.
import { CutJson } from "./cut-json.ts";

/** One line, decoded. `invalidUtf8` says the bytes were not valid UTF-8. */
export interface Line {
  text: string;
  invalidUtf8: boolean;
  /** The line had no LF: the stream ended inside it. */
  partial: boolean;
}

export type LineResult =
  | { kind: "line"; line: Line }
  /**
   * `value`: the line's JSON value with its long strings cut (cut-json.ts), when the splitter
   * reads long lines and the line could be read. Without it, nothing of the line is known.
   */
  | { kind: "oversized"; value?: Record<string, unknown> | unknown[] };

export interface LineSplitterOptions {
  /** Reads each line too long to keep as it passes, its long strings cut (cut-json.ts). */
  readonly readLong?: boolean;
}

const LF = 0x0a;
const CR = 0x0d;
/** The buffer a splitter starts with, and returns to after a long line. */
const SMALL = 16 * 1024;
const strict = new TextDecoder("utf-8", { fatal: true });
const lenient = new TextDecoder("utf-8");

/** Decodes UTF-8, falling back to replacement characters when the bytes are not valid. */
export function decodeUtf8(bytes: Uint8Array): { text: string; invalidUtf8: boolean } {
  try {
    return { text: strict.decode(bytes), invalidUtf8: false };
  } catch {
    return { text: lenient.decode(bytes), invalidUtf8: true };
  }
}

export class LineSplitter {
  private buf: Uint8Array;
  private size = 0;
  /** A line too long to keep is being skipped: what reads it as it passes, when the splitter reads. */
  private skipping: { readonly reader: CutJson | undefined } | undefined;
  private readonly cap: number;
  private readonly reads: boolean;
  /** The most a line may hold before it is dropped: the cap, plus one for a CR before the LF. */
  private readonly limit: number;

  constructor(cap: number, options: LineSplitterOptions = {}) {
    this.cap = cap;
    this.limit = cap + 1;
    this.reads = options.readLong === true;
    this.buf = new Uint8Array(Math.min(SMALL, this.limit));
  }

  /** Bytes held for an unfinished line. Never more than cap + 1. */
  get buffered(): number {
    return this.size;
  }

  /** Bytes allocated for the line buffer. Never more than cap + 1. */
  get capacity(): number {
    return this.buf.length;
  }

  /** Bytes kept of the line too long to keep that is being read. */
  get kept(): number {
    return this.skipping?.reader?.kept ?? 0;
  }

  /** Feeds a chunk. Returns the lines it completed, in order. */
  push(chunk: Uint8Array): LineResult[] {
    const out: LineResult[] = [];
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, start);
      this.take(chunk.subarray(start, lf === -1 ? chunk.length : lf));
      if (lf === -1) return out;
      this.finishLine(false, out);
      start = lf + 1;
    }
  }

  /** Ends the stream. Returns the unterminated rest as a partial line, if there is one. */
  end(): LineResult[] {
    const out: LineResult[] = [];
    if (this.skipping !== undefined || this.size > 0) this.finishLine(true, out);
    return out;
  }

  private take(segment: Uint8Array): void {
    if (segment.length === 0) return;
    if (this.skipping !== undefined) {
      this.skipping.reader?.push(segment);
      return;
    }
    const needed = this.size + segment.length;
    if (needed > this.limit) {
      this.skip(segment);
      return;
    }
    if (needed > this.buf.length) {
      const grown = new Uint8Array(Math.min(Math.max(needed, this.buf.length * 2), this.limit));
      grown.set(this.buf.subarray(0, this.size));
      this.buf = grown;
    }
    this.buf.set(segment, this.size);
    this.size = needed;
  }

  /** From here on the line is skipped: what was held so far and `rest` go to its reader. */
  private skip(rest: Uint8Array): void {
    const reader = this.reads ? new CutJson() : undefined;
    reader?.push(this.buf.subarray(0, this.size));
    reader?.push(rest);
    this.skipping = { reader };
    this.reset();
  }

  private finishLine(partial: boolean, out: LineResult[]): void {
    let end = this.size;
    if (this.skipping === undefined && end > 0 && this.buf[end - 1] === CR) end -= 1;
    if (this.skipping === undefined && end > this.cap) this.skip(new Uint8Array(0));
    const skipped = this.skipping;
    if (skipped !== undefined) {
      this.skipping = undefined;
      const value = skipped.reader?.end();
      out.push(value === undefined ? { kind: "oversized" } : { kind: "oversized", value });
      return;
    }
    const { text, invalidUtf8 } = decodeUtf8(this.buf.subarray(0, end));
    this.reset();
    out.push({ kind: "line", line: { text, invalidUtf8, partial } });
  }

  private reset(): void {
    this.size = 0;
    if (this.buf.length > SMALL) this.buf = new Uint8Array(Math.min(SMALL, this.limit));
  }
}
