// Splits a byte stream into lines, incrementally and in bounded memory (A4 3.11.4).
//
// - A line ends at LF. A CR before the LF is dropped, so CRLF streams parse the same.
// - A line longer than the cap is dropped whole: once the buffer would pass the cap, the bytes
//   held so far are released and the rest of the line is skipped up to its LF. The splitter never
//   holds more than cap + 1 bytes, whatever the input and however it is chunked.
// - Bytes are decoded as UTF-8 only once a line is complete, so a code point split across chunks
//   decodes correctly. Invalid UTF-8 is reported and decoded with replacement characters.
// - At the end of the stream, an unterminated rest is handed out as a final, partial line.

/** One line, decoded. `invalidUtf8` says the bytes were not valid UTF-8. */
export interface Line {
  text: string;
  /** Its length in UTF-8 bytes, without its line break. */
  bytes: number;
  invalidUtf8: boolean;
  /** The line had no LF: the stream ended inside it. */
  partial: boolean;
}

export type LineResult = { kind: "line"; line: Line } | { kind: "oversized" };

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
  private skipping = false;
  private readonly cap: number;
  /** The most a line may hold before it is dropped: the cap, plus one for a CR before the LF. */
  private readonly limit: number;

  constructor(cap: number) {
    this.cap = cap;
    this.limit = cap + 1;
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

  /** Feeds a chunk. Returns the lines it completed, in order. */
  push(chunk: Uint8Array): LineResult[] {
    const out: LineResult[] = [];
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, start);
      this.take(chunk.subarray(start, lf === -1 ? chunk.length : lf), out);
      if (lf === -1) return out;
      this.finishLine(false, out);
      start = lf + 1;
    }
  }

  /** Ends the stream. Returns the unterminated rest as a partial line, if there is one. */
  end(): LineResult[] {
    const out: LineResult[] = [];
    if (this.skipping) {
      // The oversized line was reported when the skip began.
      this.skipping = false;
    } else if (this.size > 0) {
      this.finishLine(true, out);
    }
    return out;
  }

  private take(segment: Uint8Array, out: LineResult[]): void {
    if (segment.length === 0 || this.skipping) return;
    const needed = this.size + segment.length;
    if (needed > this.limit) {
      this.reset();
      this.skipping = true;
      out.push({ kind: "oversized" });
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

  private finishLine(partial: boolean, out: LineResult[]): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    let end = this.size;
    if (end > 0 && this.buf[end - 1] === CR) end -= 1;
    if (end > this.cap) {
      this.reset();
      out.push({ kind: "oversized" });
      return;
    }
    const { text, invalidUtf8 } = decodeUtf8(this.buf.subarray(0, end));
    this.reset();
    out.push({ kind: "line", line: { text, bytes: end, invalidUtf8, partial } });
  }

  private reset(): void {
    this.size = 0;
    if (this.buf.length > SMALL) this.buf = new Uint8Array(Math.min(SMALL, this.limit));
  }
}
