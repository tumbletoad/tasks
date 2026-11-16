// A locator for valid TOML text: where each table header and each key/value line is, as offsets
// into the text, so edit.ts can splice a change into the file without touching any other byte.
//
// It is not a validator. It runs only on text the parser has already accepted, and every edit is
// checked afterwards by parsing the result and comparing it with the intended document, so a
// misplaced splice is refused, never written. It understands what can move a table or a key:
// the four string forms (escapes and the closing quotes multi-line strings may carry), comments,
// arrays and inline tables across lines, and quoted and dotted keys.

export interface ScannedHeader {
  readonly kind: "header";
  /** Offset of the line's first character, and of the character after its line break. */
  readonly start: number;
  readonly end: number;
  readonly path: readonly string[];
  /** `[[…]]`: an element of an array of tables. */
  readonly array: boolean;
}

export interface ScannedKeyValue {
  readonly kind: "keyval";
  readonly start: number;
  /** After the last line break of the value's last line (or the end of the text). */
  readonly end: number;
  /** The value's span: from its first character to just after its last. */
  readonly valueStart: number;
  readonly valueEnd: number;
  /** The dotted key, decoded. */
  readonly key: readonly string[];
}

export type ScannedLine = ScannedHeader | ScannedKeyValue;

export class ScanError extends Error {
  override readonly name = "ScanError";
}

const BARE_KEY = /[A-Za-z0-9_-]/u;

class Scanner {
  readonly text: string;
  pos = 0;
  /** Where each comment's `#` stands. */
  readonly comments: number[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** A method, not a getter: the scanning methods move the position, which narrowing ignores. */
  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text.charAt(this.pos + offset);
  }

  startsWith(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  fail(): never {
    throw new ScanError("unexpected text");
  }

  /** Spaces and tabs. */
  skipBlank(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos += 1;
  }

  /** A comment up to (not including) its line break. */
  skipComment(): void {
    if (this.peek() !== "#") return;
    this.comments.push(this.pos);
    while (!this.atEnd() && this.peek() !== "\n" && !this.startsWith("\r\n")) this.pos += 1;
  }

  /** One line break, if there is one here. */
  skipNewline(): boolean {
    if (this.startsWith("\r\n")) {
      this.pos += 2;
      return true;
    }
    if (this.peek() === "\n") {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** Blanks, comments and line breaks: what may separate values inside an array. */
  skipBlankLines(): void {
    for (;;) {
      this.skipBlank();
      this.skipComment();
      if (!this.skipNewline()) return;
    }
  }

  /** The rest of a line after a header or a value: blanks, a comment, the line break. */
  endLine(): void {
    this.skipBlank();
    this.skipComment();
    if (!this.atEnd() && !this.skipNewline()) this.fail();
  }

  basicString(): string {
    // At the opening quote.
    this.pos += 1;
    let out = "";
    for (;;) {
      if (this.atEnd()) this.fail();
      const c = this.peek();
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      if (c === "\n") this.fail();
      out += c;
      this.pos += 1;
    }
  }

  escape(): string {
    // At the backslash.
    const c = this.peek(1);
    this.pos += 2;
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      e: "\u001b",
      '"': '"',
      "\\": "\\",
    };
    const known = simple[c];
    if (known !== undefined) return known;
    const width = c === "u" ? 4 : c === "U" ? 8 : c === "x" ? 2 : 0;
    if (width === 0) this.fail();
    const hex = this.text.slice(this.pos, this.pos + width);
    if (!/^[0-9A-Fa-f]+$/u.test(hex) || hex.length !== width) this.fail();
    this.pos += width;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }

  literalString(): string {
    this.pos += 1;
    const end = this.text.indexOf("'", this.pos);
    if (end === -1) this.fail();
    const out = this.text.slice(this.pos, end);
    if (out.includes("\n")) this.fail();
    this.pos = end + 1;
    return out;
  }

  /** A multi-line string: `"""` or `'''`, up to two extra quotes before the closing three. */
  multiLineString(quote: '"' | "'"): void {
    const fence = quote.repeat(3);
    this.pos += 3;
    for (;;) {
      if (this.atEnd()) this.fail();
      if (quote === '"' && this.peek() === "\\") {
        this.pos += 2;
        continue;
      }
      if (this.startsWith(fence)) {
        this.pos += 3;
        // `""""` and `"""""` end the string with one or two quotes as content.
        for (let extra = 0; extra < 2 && this.peek() === quote; extra += 1) this.pos += 1;
        return;
      }
      this.pos += 1;
    }
  }

  /** One key segment: bare, basic-quoted or literal-quoted. */
  keySegment(): string {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const start = this.pos;
    while (BARE_KEY.test(this.peek()) && !this.atEnd()) this.pos += 1;
    if (this.pos === start) this.fail();
    return this.text.slice(start, this.pos);
  }

  /** A dotted key, up to (not including) what follows it. */
  dottedKey(): string[] {
    const parts = [this.keySegment()];
    for (;;) {
      this.skipBlank();
      if (this.peek() !== ".") return parts;
      this.pos += 1;
      this.skipBlank();
      parts.push(this.keySegment());
    }
  }

  /** Skips one value. */
  value(): void {
    const c = this.peek();
    if (this.startsWith('"""')) this.multiLineString('"');
    else if (this.startsWith("'''")) this.multiLineString("'");
    else if (c === '"') this.basicString();
    else if (c === "'") this.literalString();
    else if (c === "[") this.array();
    else if (c === "{") this.inlineTable();
    else this.bare();
  }

  array(): void {
    this.pos += 1;
    for (;;) {
      this.skipBlankLines();
      if (this.peek() === "]") {
        this.pos += 1;
        return;
      }
      this.value();
      this.skipBlankLines();
      if (this.peek() === ",") {
        this.pos += 1;
        continue;
      }
      if (this.peek() === "]") {
        this.pos += 1;
        return;
      }
      this.fail();
    }
  }

  inlineTable(): void {
    this.pos += 1;
    for (;;) {
      this.skipBlankLines();
      if (this.peek() === "}") {
        this.pos += 1;
        return;
      }
      this.dottedKey();
      this.skipBlank();
      if (this.peek() !== "=") this.fail();
      this.pos += 1;
      this.skipBlank();
      this.value();
      this.skipBlankLines();
      if (this.peek() === ",") {
        this.pos += 1;
        continue;
      }
      if (this.peek() === "}") {
        this.pos += 1;
        return;
      }
      this.fail();
    }
  }

  /** A number, boolean, date or time. A date and a time may be separated by one space. */
  bare(): void {
    const start = this.pos;
    const stop = (ch: string) => ch === "" || /[\s,\]}#]/u.test(ch);
    while (!stop(this.peek())) this.pos += 1;
    if (this.pos === start) this.fail();
    const token = this.text.slice(start, this.pos);
    if (/^\d{4}-\d{2}-\d{2}$/u.test(token) && this.peek() === " " && /\d/u.test(this.peek(1))) {
      this.pos += 1;
      while (!stop(this.peek())) this.pos += 1;
    }
  }
}

/** The headers and key/value lines of valid TOML text, in order. Throws ScanError otherwise. */
export function scanToml(text: string): ScannedLine[] {
  return scan(text).lines;
}

/**
 * Where each comment's `#` stands in valid TOML text, in order: a `#` inside a string is not
 * one. Throws ScanError otherwise.
 */
export function tomlComments(text: string): readonly number[] {
  return scan(text).comments;
}

function scan(text: string): { lines: ScannedLine[]; comments: readonly number[] } {
  const s = new Scanner(text);
  const lines: ScannedLine[] = [];
  while (!s.atEnd()) {
    const start = s.pos;
    s.skipBlank();
    if (s.skipNewline()) continue;
    if (s.peek() === "#") {
      s.skipComment();
      if (!s.atEnd() && !s.skipNewline()) s.fail();
      continue;
    }
    if (s.atEnd()) break;
    if (s.peek() === "[") {
      const array = s.peek(1) === "[";
      s.pos += array ? 2 : 1;
      s.skipBlank();
      const path = s.dottedKey();
      s.skipBlank();
      const close = array ? "]]" : "]";
      if (!s.startsWith(close)) s.fail();
      s.pos += close.length;
      s.endLine();
      lines.push({ kind: "header", start, end: s.pos, path, array });
      continue;
    }
    const key = s.dottedKey();
    s.skipBlank();
    if (s.peek() !== "=") s.fail();
    s.pos += 1;
    s.skipBlank();
    const valueStart = s.pos;
    s.value();
    const valueEnd = s.pos;
    s.endLine();
    lines.push({ kind: "keyval", start, end: s.pos, valueStart, valueEnd, key });
  }
  return { lines, comments: s.comments };
}
