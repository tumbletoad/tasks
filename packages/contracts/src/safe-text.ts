// SafeText (A3 3.10 item 4): the normalisation every text input gets at the registry boundary, for
// every face and for imports. It removes characters that hide text from people but not from models.
// It never rejects input, so it is the one kind of transform a schema may use (A3 3.2.1).
import { z } from "zod";
import { normaliser } from "./define.ts";

// - the Unicode tag block U+E0000 to U+E007F
// - bidirectional controls U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F and U+061C
// - C0 controls except tab and newline, DEL and the C1 controls (CR is turned into LF first)
// - zero-width space U+200B, word joiner U+2060 and byte-order marks U+FEFF inside text
// ZWJ U+200D and ZWNJ U+200C stay, because emoji and some scripts need them (A6 3.16.2).
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0xe0000, 0xe007f], // tag block
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2066, 0x2069], // bidirectional isolates
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x061c, 0x061c], // Arabic letter mark
  [0x0000, 0x0008], // C0 controls before tab
  [0x000b, 0x001f], // C0 controls after newline
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x200b, 0x200b], // zero-width space
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // byte-order mark
];

function visible(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return !HIDDEN_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * SafeText: a lone surrogate becomes U+FFFD, then LF line endings, hidden characters removed and
 * NFC. Idempotent. The writer stores text as UTF-8, which has no lone surrogates, and turns them
 * into U+FFFD the same way (A1 3.7), so a face and the store agree on the text.
 */
export const normaliseText = normaliser((text: string): string =>
  Array.from(text.toWellFormed().replace(/\r\n?/g, "\n")).filter(visible).join("").normalize("NFC"),
);

/**
 * SafeText for one-line fields such as titles (A1 keeps them to one line): every line break and
 * the spaces around it become one space. Idempotent, and it never rejects.
 */
export const normaliseLine = normaliser((text: string): string => joinLines(normaliseText(text)));

const isGap = (char: string): boolean => char === " " || char === "\t" || char === "\n";

/**
 * Every run of spaces, tabs and line breaks that holds a line break becomes one space. A loop, not
 * the regular expression it replaces, which retried from every position of a long run of spaces:
 * quadratic time on the long texts an import reads.
 */
function joinLines(text: string): string {
  if (!text.includes("\n")) return text;
  const parts: string[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!isGap(text.charAt(i))) {
      i += 1;
      continue;
    }
    let end = i;
    let breaks = false;
    while (end < text.length && isGap(text.charAt(end))) {
      if (text.charAt(end) === "\n") breaks = true;
      end += 1;
    }
    if (breaks) {
      parts.push(text.slice(from, i), " ");
      from = end;
    }
    i = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * Multi-line text of at most `max` characters, normalised with SafeText. Lengths count Unicode
 * code points, in Zod 4.6 as in JSON Schema, so Zod and Ajv agree on astral characters such as
 * emoji. The schema checks the input as sent. NFC can lengthen text, so `parseInput()` checks the
 * limit again on the normalised value. Normalising can leave a string empty, so handlers check
 * required text for emptiness after parsing.
 */
export function safeText(max: number) {
  return z.string().max(max).transform(normaliseText);
}

/** One line of at most `max` characters, normalised with SafeText and `normaliseLine`. */
export function safeLine(max: number) {
  return z.string().max(max).transform(normaliseLine);
}
