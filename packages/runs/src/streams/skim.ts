// What can be told of a JSON line too long to keep, read as its bytes stream past and in bounded
// memory: the same object with only its short values. A message's method, ID and state are a few
// bytes even when its payload is megabytes, so a reader that skips the payload still learns what
// the message was.
//
// Left out: a string longer than SKIM_STRING_BYTES, every array, objects nested deeper than
// SKIM_DEPTH, and whatever comes once SKIM_BYTES of kept text are used up. A line that is not one
// JSON object gives undefined.
import { TEXT_CAP_BYTES } from "@ttasks/contracts/runs";

/** The longest string kept. */
export const SKIM_STRING_BYTES = TEXT_CAP_BYTES;
/** The most bytes of keys and values kept in all. */
export const SKIM_BYTES = 64 * 1024;
/** The deepest object kept: the line's own object is the first. */
export const SKIM_DEPTH = 4;
/** The longest number or literal kept. */
const LITERAL_BYTES = 64;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
/** What ends a number or a literal. */
const ends = (byte: number): boolean =>
  isSpace(byte) || byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY;

/** An open object, with where its values go (none when it is not kept), or an open array. */
type Frame =
  | {
      readonly kind: "object";
      readonly into: Record<string, unknown> | undefined;
      key: string | undefined;
    }
  | { readonly kind: "array" };

type State = "value" | "key" | "colon" | "after" | "string" | "literal" | "done" | "broken";

const decoder = new TextDecoder();

/** A JSON string's body, escapes and all, as its value; undefined when it is not one. */
function unquote(parts: readonly Uint8Array[]): string | undefined {
  const body = decoder.decode(Buffer.concat(parts));
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export class JsonSkim {
  #state: State = "value";
  readonly #stack: Frame[] = [];
  #root: Record<string, unknown> | undefined;
  #left = SKIM_BYTES;
  /** The string being read: whether it is a key, its bytes so far when they are kept. */
  #key = false;
  #parts: Uint8Array[] | undefined;
  #size = 0;
  #escaped = false;
  /** The number or literal being read. */
  #literal = "";

  /** Reads the next bytes of the line. */
  push(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length) {
      if (this.#state === "string") {
        at = this.#string(bytes, at);
      } else if (this.#state === "literal") {
        at = this.#scalar(bytes, at);
      } else {
        const byte = bytes[at] ?? 0;
        at += 1;
        if (!isSpace(byte)) this.#token(byte);
      }
      if (this.#state === "broken") return;
    }
  }

  /** What could be told of the line, once it ended. */
  end(): Record<string, unknown> | undefined {
    return this.#state === "done" ? this.#root : undefined;
  }

  #token(byte: number): void {
    const top = this.#stack.at(-1);
    switch (this.#state) {
      case "value":
        if (byte === OPEN_OBJECT) this.#open();
        else if (top === undefined) this.#state = "broken";
        else if (byte === OPEN_ARRAY) this.#stack.push({ kind: "array" });
        else if (byte === CLOSE_ARRAY && top.kind === "array") this.#close();
        else if (byte === QUOTE) this.#begin(false);
        else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte >= 0x61) {
          this.#literal = String.fromCharCode(byte);
          this.#state = "literal";
        } else this.#state = "broken";
        return;
      case "key":
        if (byte === QUOTE) this.#begin(true);
        else if (byte === CLOSE_OBJECT) this.#close();
        else this.#state = "broken";
        return;
      case "colon":
        this.#state = byte === COLON ? "value" : "broken";
        return;
      case "after":
        if (byte === COMMA && top !== undefined)
          this.#state = top.kind === "object" ? "key" : "value";
        else if (byte === CLOSE_OBJECT && top?.kind === "object") this.#close();
        else if (byte === CLOSE_ARRAY && top?.kind === "array") this.#close();
        else this.#state = "broken";
        return;
      default:
        // After the line's object only spaces may follow.
        this.#state = "broken";
    }
  }

  /** Where a value read now goes: the open object's key, when that object is kept. */
  #slot(): { into: Record<string, unknown>; key: string } | undefined {
    const top = this.#stack.at(-1);
    if (top?.kind !== "object" || top.into === undefined || top.key === undefined) return undefined;
    return { into: top.into, key: top.key };
  }

  #open(): void {
    if (this.#stack.length === 0) {
      if (this.#root !== undefined) {
        this.#state = "broken";
        return;
      }
      this.#root = {};
      this.#stack.push({ kind: "object", into: this.#root, key: undefined });
    } else {
      const slot = this.#stack.length < SKIM_DEPTH ? this.#slot() : undefined;
      const into = slot === undefined ? undefined : {};
      if (slot !== undefined) slot.into[slot.key] = into;
      this.#stack.push({ kind: "object", into, key: undefined });
    }
    this.#state = "key";
  }

  #close(): void {
    this.#stack.pop();
    this.#state = this.#stack.length === 0 ? "done" : "after";
  }

  #begin(key: boolean): void {
    this.#key = key;
    const top = this.#stack.at(-1);
    const kept = key
      ? top?.kind === "object" && top.into !== undefined
      : this.#slot() !== undefined;
    this.#parts = kept ? [] : undefined;
    this.#size = 0;
    this.#escaped = false;
    this.#state = "string";
  }

  /** Reads a string's bytes from `at`; returns where reading goes on. */
  #string(bytes: Uint8Array, at: number): number {
    let i = at;
    for (; i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      if (this.#escaped) this.#escaped = false;
      else if (byte === BACKSLASH) this.#escaped = true;
      else if (byte === QUOTE) break;
    }
    this.#keep(bytes.subarray(at, i));
    if (i === bytes.length) return i;
    this.#ended(this.#parts === undefined ? undefined : unquote(this.#parts));
    return i + 1;
  }

  #keep(part: Uint8Array): void {
    if (this.#parts === undefined || part.length === 0) return;
    this.#size += part.length;
    if (this.#size > Math.min(SKIM_STRING_BYTES, this.#left)) this.#parts = undefined;
    else this.#parts.push(part.slice());
  }

  #ended(text: string | undefined): void {
    this.#parts = undefined;
    if (text !== undefined) this.#left -= this.#size;
    if (this.#key) {
      const top = this.#stack.at(-1);
      if (top?.kind === "object") top.key = text;
      this.#state = "colon";
    } else {
      this.#set(text);
      this.#state = "after";
    }
  }

  /** Reads a number or literal from `at`; returns where reading goes on. */
  #scalar(bytes: Uint8Array, at: number): number {
    let i = at;
    for (; i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      if (ends(byte)) break;
      if (this.#literal.length <= LITERAL_BYTES) this.#literal += String.fromCharCode(byte);
    }
    if (i === bytes.length) return i;
    if (this.#literal.length <= LITERAL_BYTES) {
      let value: unknown;
      try {
        value = JSON.parse(this.#literal);
      } catch {
        this.#state = "broken";
        return i;
      }
      this.#left -= this.#literal.length;
      this.#set(value);
    }
    this.#state = "after";
    return i;
  }

  #set(value: unknown): void {
    const slot = this.#slot();
    if (slot === undefined || value === undefined || this.#left < 0) return;
    slot.into[slot.key] = value;
  }
}
