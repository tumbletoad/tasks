// An agent's output read as JSON lines by the platform's own parser. The drivers and the answer
// parser read every line through this, once, so no two of them can read a line differently.
//
// - A line up to LINE_CAP_BYTES is parsed as it is.
// - A longer line, up to LONG_LINE_CAP_BYTES, is parsed the same way. Then each string in it longer
//   than LINE_CAP_BYTES is cut to its start, on a whole character: a reader meets no string longer
//   than a line read whole can hold, and every string still longer than an answer is kept, so an
//   answer cut here is cut and marked as any other answer is.
// - A line past LONG_LINE_CAP_BYTES is lost the moment it passes it, and so is a longer line that
//   is not JSON: nothing of either is known. A line the output ended inside is not lost: like a
//   short one, it is read when it is JSON, else skipped.
import { LINE_CAP_BYTES, LONG_LINE_CAP_BYTES } from "@ttasks/contracts/runs";
import { LineSplitter, type Line, type LineResult } from "./lines.ts";

export type JsonLine =
  | { readonly kind: "json"; readonly value: unknown; readonly invalidUtf8: boolean }
  /** Not JSON: skipped. `partial`: the output ended inside it. */
  | {
      readonly kind: "text";
      readonly blank: boolean;
      readonly partial: boolean;
      readonly invalidUtf8: boolean;
    }
  /** Too long to read, or longer than a line read whole and not JSON: it may have been anything. */
  | { readonly kind: "lost" };

const encoder = new TextEncoder();
/** A string may start with U+FEFF: it is kept, as JSON.parse keeps it. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** `text` cut to at most `cap` UTF-8 bytes on a whole character, as a string of its own. */
function cutString(text: string, cap: number): string {
  // Each UTF-16 unit is at most 3 UTF-8 bytes.
  if (text.length * 3 <= cap) return text;
  const kept = new Uint8Array(cap);
  // encodeInto writes whole characters only; decoding copies, so the long string is not held.
  const { read, written } = encoder.encodeInto(text, kept);
  return read >= text.length ? text : decoder.decode(kept.subarray(0, written));
}

/** Each string in `root` longer than `cap` UTF-8 bytes, cut. Keys stay, and so does the shape. */
function cutStrings(root: unknown, cap: number): unknown {
  if (typeof root === "string") return cutString(root, cap);
  // A list, not recursion: JSON.parse reads any depth, and so does this.
  const open: unknown[] = [root];
  for (let next = open.pop(); next !== undefined; next = open.pop()) {
    if (Array.isArray(next)) {
      for (let at = 0; at < next.length; at += 1) {
        const item: unknown = next[at];
        if (typeof item === "string") next[at] = cutString(item, cap);
        else if (typeof item === "object" && item !== null) open.push(item);
      }
    } else if (typeof next === "object" && next !== null) {
      for (const [key, item] of Object.entries(next)) {
        if (typeof item === "object" && item !== null) open.push(item);
        if (typeof item !== "string") continue;
        const kept = cutString(item, cap);
        // Defined, not assigned: a key `__proto__` is the object's own, as JSON.parse made it.
        if (kept !== item) {
          Object.defineProperty(next, key, {
            value: kept,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }
  }
  return root;
}

/** Reads one whole line, `cap` being the longest line read as it is. */
export function readJsonLine(line: Line, cap: number = LINE_CAP_BYTES): JsonLine {
  const { text, invalidUtf8, partial } = line;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (line.bytes > cap && !partial) return { kind: "lost" };
    return { kind: "text", blank: text.trim() === "", partial, invalidUtf8 };
  }
  return { kind: "json", value: line.bytes > cap ? cutStrings(value, cap) : value, invalidUtf8 };
}

/** A byte stream's lines, read. Holds at most `longCap` + 1 bytes of a line. */
export class JsonLines {
  readonly #splitter: LineSplitter;
  readonly #cap: number;

  constructor(cap: number = LINE_CAP_BYTES, longCap: number = LONG_LINE_CAP_BYTES) {
    this.#cap = cap;
    this.#splitter = new LineSplitter(longCap);
  }

  /** Bytes held for an unfinished line, and allocated for it. */
  get held(): { readonly bytes: number; readonly capacity: number } {
    return { bytes: this.#splitter.buffered, capacity: this.#splitter.capacity };
  }

  /** Feeds a chunk. Returns the lines it completed, in order, and a line as it is lost. */
  push(chunk: Uint8Array): JsonLine[] {
    return this.#splitter.push(chunk).map((result) => this.#read(result));
  }

  /** Ends the stream: the unterminated rest, if there is one. */
  end(): JsonLine[] {
    return this.#splitter.end().map((result) => this.#read(result));
  }

  #read(result: LineResult): JsonLine {
    return result.kind === "oversized" ? { kind: "lost" } : readJsonLine(result.line, this.#cap);
  }
}
