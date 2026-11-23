// A JSON line too long to keep, read as its bytes stream past: the same value, with the same
// shape, in which every string longer than CUT_STRING_BYTES is cut to its start and marked as cut
// (wasCut). Objects and arrays stay, in their order, and so do numbers, literals and short
// strings, so whoever reads the line reads it as it reads every other line.
//
// Memory stays bounded however long the line is: at most CUT_KEPT_BYTES of it are kept (written
// as JSON), and at most CUT_DEPTH objects and arrays are open at once. A line past either bound,
// or one that is not JSON, gives undefined: nothing of it may be trusted.
import { LINE_CAP_BYTES, TEXT_CAP_BYTES } from "@ttasks/contracts/runs";

/** The longest string kept whole: a longer one keeps this many bytes of its start. */
export const CUT_STRING_BYTES = TEXT_CAP_BYTES;
/** The most of a line kept, as its JSON: as much as a line read whole may hold. */
export const CUT_KEPT_BYTES = LINE_CAP_BYTES;
/** The most objects and arrays open at once. */
export const CUT_DEPTH = 64;
/** The longest number or literal. */
const LITERAL_BYTES = 64;

/** On an object or array the reader made: the keys of what it cut there, or inside it. */
const CUT = Symbol("cut");

type Container = (Record<string, unknown> | unknown[]) & { [CUT]?: Set<string | number> };

/**
 * Whether the reader cut the string at `key` of `container`, or one inside the value there.
 * Without a key: whether it cut anything inside `container`. Never true of a value read whole.
 */
export function wasCut(container: unknown, key?: string | number): boolean {
  if (typeof container !== "object" || container === null) return false;
  const cut = (container as Container)[CUT];
  return cut !== undefined && (key === undefined || cut.has(key));
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const U = 0x75;
/** What may follow a backslash, besides `u`. */
const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

const isSpace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isHex = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x46) ||
  (byte >= 0x61 && byte <= 0x66);
/** What ends a number or a literal. */
const ends = (byte: number): boolean =>
  isSpace(byte) || byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY;

/** An open object or array, and where its last value went. */
interface Frame {
  readonly into: Container;
  /** An object's key for the value being read, or the index of an array's last value. */
  at: string | number;
}

/**
 * - `value`: a value comes (at the start, after a colon, after an array's comma);
 * - `first value`, `first key`: right after `[` or `{`, which may also close at once;
 * - `key`: an object's key comes, after its comma; `colon`: the colon after a key;
 * - `after`: a value ended inside an object or array.
 */
type State =
  "value" | "first value" | "first key" | "key" | "colon" | "after" | "string" | "literal" | "done";

/** A string may start with U+FEFF: it is kept, as JSON.parse keeps it. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** How many bytes of `bytes` end on a whole character and a whole escape. */
function wholeEnd(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i] ?? 0;
    const length =
      byte === BACKSLASH
        ? bytes[i + 1] === U
          ? 6
          : 2
        : byte >= 0xf0
          ? 4
          : byte >= 0xe0
            ? 3
            : byte >= 0xc0
              ? 2
              : 1;
    if (i + length > bytes.length) break;
    i += length;
  }
  return i;
}

/** Sets `key` of `into` as JSON.parse would, `__proto__` included. */
function put(into: Container, key: string | number, value: unknown): void {
  if (Array.isArray(into)) into.push(value);
  else if (key === "__proto__") {
    Object.defineProperty(into, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else into[key] = value;
}

export class CutJson {
  #state: State = "value";
  /** The line is not JSON, or did not fit: nothing more of it is read. */
  #failed = false;
  readonly #stack: Frame[] = [];
  #root: Container | undefined;
  /** Bytes of the line kept so far, as JSON. */
  #kept = 0;
  /** The string being read: whether it is a key, its start, its length, its escapes. */
  #key = false;
  #parts: Uint8Array[] = [];
  #size = 0;
  #escaped = false;
  #hex = 0;
  #plain = true;
  /** The number or literal being read. */
  #literal = "";

  /** Bytes of the line kept so far, the start of a string being read included. */
  get kept(): number {
    return this.#kept + (this.#state === "string" ? Math.min(this.#size, CUT_STRING_BYTES + 1) : 0);
  }

  /** Reads the next bytes of the line. */
  push(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length && !this.#failed) {
      if (this.#state === "string") at = this.#string(bytes, at);
      else if (this.#state === "literal") at = this.#scalar(bytes, at);
      else {
        const byte = bytes[at] ?? 0;
        at += 1;
        if (!isSpace(byte)) this.#token(byte);
      }
    }
  }

  /** The line's value, once it ended: undefined when it was not JSON or did not fit. */
  end(): Record<string, unknown> | unknown[] | undefined {
    return this.#state === "done" && !this.#failed ? this.#root : undefined;
  }

  #token(byte: number): void {
    const top = this.#stack.at(-1);
    switch (this.#state) {
      case "first value":
        if (byte === CLOSE_ARRAY) this.#close();
        else this.#value(byte);
        return;
      case "value":
        this.#value(byte);
        return;
      case "first key":
        if (byte === CLOSE_OBJECT) this.#close();
        else this.#keyStart(byte);
        return;
      case "key":
        this.#keyStart(byte);
        return;
      case "colon":
        if (byte !== COLON) {
          this.#broken();
          return;
        }
        this.#count(1);
        this.#state = "value";
        return;
      case "after":
        if (byte === COMMA && top !== undefined) {
          this.#count(1);
          this.#state = Array.isArray(top.into) ? "value" : "key";
        } else if (byte === (Array.isArray(top?.into) ? CLOSE_ARRAY : CLOSE_OBJECT)) {
          this.#close();
        } else this.#broken();
        return;
      default:
        // After the line's value only spaces may follow.
        this.#broken();
    }
  }

  #value(byte: number): void {
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      this.#open(byte === OPEN_OBJECT ? {} : []);
    } else if (this.#stack.length === 0) {
      // A line is an object or an array.
      this.#broken();
    } else if (byte === QUOTE) {
      this.#begin(false);
    } else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte >= 0x61) {
      this.#literal = String.fromCharCode(byte);
      this.#state = "literal";
    } else this.#broken();
  }

  #keyStart(byte: number): void {
    if (byte === QUOTE) this.#begin(true);
    else this.#broken();
  }

  #open(into: Container): void {
    if (this.#stack.length >= CUT_DEPTH) {
      this.#broken();
      return;
    }
    this.#count(1);
    if (this.#stack.length === 0) this.#root = into;
    else this.#place(into, false);
    this.#stack.push({ into, at: -1 });
    this.#state = Array.isArray(into) ? "first value" : "first key";
  }

  #close(): void {
    this.#count(1);
    this.#stack.pop();
    this.#state = this.#stack.length === 0 ? "done" : "after";
  }

  /** Puts a value where the open object or array takes it; `cut` marks it, and where it is, cut. */
  #place(value: unknown, cut: boolean): void {
    const top = this.#stack.at(-1);
    if (top === undefined) return;
    if (Array.isArray(top.into)) top.at = top.into.length;
    put(top.into, top.at, value);
    if (!cut) return;
    for (const frame of this.#stack) {
      const marks = frame.into[CUT] ?? new Set<string | number>();
      if (frame.into[CUT] === undefined) {
        Object.defineProperty(frame.into, CUT, { value: marks });
      }
      marks.add(frame.at);
    }
  }

  #begin(key: boolean): void {
    this.#key = key;
    this.#parts = [];
    this.#size = 0;
    this.#escaped = false;
    this.#hex = 0;
    this.#plain = true;
    this.#state = "string";
  }

  /** Reads a string's bytes from `at`; returns where reading goes on. */
  #string(bytes: Uint8Array, at: number): number {
    let i = at;
    for (; i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      if (this.#hex > 0) {
        if (!isHex(byte)) {
          this.#broken();
          return bytes.length;
        }
        this.#hex -= 1;
      } else if (this.#escaped) {
        this.#escaped = false;
        if (byte === U) this.#hex = 4;
        else if (!ESCAPES.has(byte)) {
          this.#broken();
          return bytes.length;
        }
      } else if (byte === BACKSLASH) {
        this.#escaped = true;
        this.#plain = false;
      } else if (byte === QUOTE) {
        break;
      } else if (byte < 0x20) {
        this.#broken();
        return bytes.length;
      }
    }
    this.#keep(bytes.subarray(at, i));
    if (i === bytes.length) return i;
    this.#stringEnded();
    return i + 1;
  }

  /** Keeps a string's bytes up to one byte past CUT_STRING_BYTES: that byte says it is cut. */
  #keep(part: Uint8Array): void {
    const room = CUT_STRING_BYTES + 1 - this.#size;
    if (room > 0 && part.length > 0) this.#parts.push(part.slice(0, room));
    this.#size += part.length;
  }

  #stringEnded(): void {
    const cut = this.#size > CUT_STRING_BYTES;
    // A key that is cut names another key: the line's shape would not be its own.
    if (cut && this.#key) {
      this.#broken();
      return;
    }
    const whole = Buffer.concat(this.#parts);
    this.#parts = [];
    const body = cut ? whole.subarray(0, wholeEnd(whole.subarray(0, CUT_STRING_BYTES))) : whole;
    let text: string;
    try {
      text = this.#plain
        ? decoder.decode(body)
        : (JSON.parse(`"${decoder.decode(body)}"`) as string);
    } catch {
      this.#broken();
      return;
    }
    this.#count(body.length + 2);
    if (this.#key) {
      const top = this.#stack.at(-1);
      if (top !== undefined) top.at = text;
      this.#state = "colon";
    } else {
      this.#place(text, cut);
      this.#state = "after";
    }
  }

  /** Reads a number or literal from `at`; returns where reading goes on. */
  #scalar(bytes: Uint8Array, at: number): number {
    let i = at;
    for (; i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      if (ends(byte)) break;
      if (this.#literal.length >= LITERAL_BYTES) {
        this.#broken();
        return bytes.length;
      }
      this.#literal += String.fromCharCode(byte);
    }
    if (i < bytes.length) this.#scalarEnded();
    return i;
  }

  #scalarEnded(): void {
    let value: unknown;
    try {
      value = JSON.parse(this.#literal);
    } catch {
      this.#broken();
      return;
    }
    this.#count(this.#literal.length);
    this.#place(value, false);
    this.#state = "after";
  }

  #count(bytes: number): void {
    this.#kept += bytes;
    if (this.#kept > CUT_KEPT_BYTES) this.#broken();
  }

  #broken(): void {
    this.#failed = true;
    this.#stack.length = 0;
    this.#parts = [];
    this.#root = undefined;
  }
}
