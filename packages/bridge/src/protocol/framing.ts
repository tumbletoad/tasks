// Framing of `ttasks-local/1`: UTF-8, one JSON message per line, each line ended by
// "\n", no BOM, at most `max` bytes per line. The decoder is pull-based, so the reader can change
// the limit between lines (a short limit before authentication, a longer one after it) and stop
// reading while it waits.
import { MAX_LINE_BYTES } from "./constants.ts";

/** One decoded line, or why the next line could not be decoded. */
export type Frame =
  | { readonly line: string }
  | { readonly error: "invalid_utf8" }
  | { readonly error: "frame_too_large" };

const NEWLINE = 0x0a;

export interface LineDecoderOptions {
  /**
   * Drop a line over the limit and go on with the next one, instead of stopping for good. `next`
   * returns `frame_too_large` once for each dropped line, and the decoder never holds more than
   * the limit plus one chunk. The bridge reads its agent app's stdin this way: one oversized
   * message must not end the session. The socket side keeps the default, which stops.
   */
  readonly resync?: boolean;
}

/**
 * Splits a byte stream into lines. `push` adds bytes, `next` returns the next complete line. A
 * line over `max` bytes (without its "\n") stops the decoder for good: `next` then always returns
 * `frame_too_large`, unless the decoder was made with `resync`. Bytes that are not valid UTF-8
 * give `invalid_utf8` for that line only. A BOM is kept, so the message parser refuses it. Bytes
 * after the last "\n" are never returned: a line cut off by the end of the stream is not a message.
 */
export class LineDecoder {
  #chunks: Buffer[] = [];
  #size = 0;
  /** Bytes from the start of the buffer already known to hold no "\n". */
  #scanned = 0;
  #failed = false;
  readonly #resync: boolean;
  /** Resync mode: the rest of a dropped line is skipped, up to and including its "\n". */
  #skipping = false;
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  /** The longest line accepted from now on. */
  max: number;

  constructor(max: number = MAX_LINE_BYTES, options: LineDecoderOptions = {}) {
    this.max = max;
    this.#resync = options.resync === true;
  }

  /** Bytes held that do not yet form a complete line. */
  get buffered(): number {
    return this.#size;
  }

  /** Whether a line went over the limit. */
  get failed(): boolean {
    return this.#failed;
  }

  push(chunk: Buffer): void {
    if (this.#failed || chunk.length === 0) return;
    let data = chunk;
    if (this.#skipping) {
      const end = data.indexOf(NEWLINE);
      if (end === -1) return;
      this.#skipping = false;
      data = data.subarray(end + 1);
      if (data.length === 0) return;
    }
    this.#chunks.push(data);
    this.#size += data.length;
  }

  next(): Frame | undefined {
    if (this.#failed) return { error: "frame_too_large" };
    const at = this.#findNewline();
    if (at === -1) {
      this.#scanned = this.#size;
      if (this.#size <= this.max) return undefined;
      if (!this.#resync) return this.#fail();
      this.clear();
      this.#skipping = true;
      return { error: "frame_too_large" };
    }
    if (at > this.max) {
      if (!this.#resync) return this.#fail();
      this.#discard(at + 1);
      return { error: "frame_too_large" };
    }
    const bytes = this.#take(at);
    try {
      return { line: this.#utf8.decode(bytes) };
    } catch {
      return { error: "invalid_utf8" };
    }
  }

  /** Drops everything held, for example when the connection closes. */
  clear(): void {
    this.#chunks = [];
    this.#size = 0;
    this.#scanned = 0;
    this.#skipping = false;
  }

  #fail(): Frame {
    this.#failed = true;
    this.clear();
    return { error: "frame_too_large" };
  }

  /** The offset of the first "\n" in the buffer, or -1. Scans each byte once across calls. */
  #findNewline(): number {
    let base = 0;
    for (const chunk of this.#chunks) {
      const from = Math.max(0, this.#scanned - base);
      if (from < chunk.length) {
        const index = chunk.indexOf(NEWLINE, from);
        if (index !== -1) return base + index;
      }
      base += chunk.length;
    }
    return -1;
  }

  /** Removes the first `count` bytes without copying them. */
  #discard(count: number): void {
    let need = count;
    while (need > 0) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) break;
      if (chunk.length <= need) {
        this.#chunks.shift();
        need -= chunk.length;
      } else {
        this.#chunks[0] = chunk.subarray(need);
        need = 0;
      }
    }
    this.#size -= count;
    this.#scanned = 0;
  }

  /** Removes the first `length` bytes and the "\n" after them, and returns those bytes. */
  #take(length: number): Buffer {
    const parts: Buffer[] = [];
    let need = length + 1;
    while (need > 0) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) break;
      if (chunk.length <= need) {
        parts.push(chunk);
        this.#chunks.shift();
        need -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, need));
        this.#chunks[0] = chunk.subarray(need);
        need = 0;
      }
    }
    this.#size -= length + 1;
    this.#scanned = 0;
    const all = parts.length === 1 && parts[0] !== undefined ? parts[0] : Buffer.concat(parts);
    return all.subarray(0, length);
  }
}

/** Thrown when a message cannot be sent as one line within the limit. */
export class FrameSizeError extends Error {
  constructor() {
    super("The message is longer than the line limit");
    this.name = "FrameSizeError";
  }
}

/**
 * One message as a line: JSON with "\n" at the end. JSON escapes every newline inside strings,
 * so the line holds exactly one. Throws FrameSizeError over `max` bytes.
 */
export function encodeLine(message: unknown, max: number = MAX_LINE_BYTES): string {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > max) throw new FrameSizeError();
  return `${text}\n`;
}
