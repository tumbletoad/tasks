// The brief's sanitiser: the boundary between task data, which anyone or anything may
// have written (a person, an agent, an import, a synced copy), and the brief, which an agent reads
// as its first instructions. Every value that goes into a brief passes here first, whatever the
// space's own normalisation did to it, because a space can hold text that never went through it.
//
// What each value may hold, so it cannot leave its fence (render.ts):
// - A task title sits between double quotes on the brief's first line. It becomes one line (line
//   breaks and tabs are spaces), holds no control, bidi, zero-width, tag or supplementary
//   variation-selector character, and no double quote of any script or backtick (each becomes
//   `'`), so it can neither close its quotes nor start a line of its own. At most 120 grapheme
//   clusters and 512 UTF-16 code units, cut with an ellipsis.
// - A path sits after the fixed `Folder: ` on a line of its own: no control character (line
//   breaks included), bidi, zero-width or tag character, so it cannot start another line.
// - Composer text is the person's own words, so its line breaks stay. Hidden characters go, with a
//   flag for the UI's quiet notice.
// Every value is well-formed UTF-16 afterwards (a lone surrogate becomes U+FFFD), so the brief is
// valid UTF-8. Pure and idempotent: sanitising a sanitised value changes nothing.

/** At most this many grapheme clusters of a title. */
export const TITLE_MAX_CLUSTERS = 120;
/**
 * And at most this many UTF-16 code units: a cluster can hold any number of combining marks, so
 * a count of clusters alone does not bound a title's length.
 */
export const TITLE_MAX_UNITS = 512;
export const ELLIPSIS = "\u{2026}";

type Range = readonly [from: number, to: number];

/** What every value loses: characters a person does not see and a model does. */
const HIDDEN: readonly Range[] = [
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x061c, 0x061c], // Arabic letter mark
  [0x200b, 0x200d], // zero-width space, non-joiner and joiner
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // byte order mark
  [0xe0000, 0xe007f], // tags
  [0xe0100, 0xe01ef], // supplementary variation selectors
];
/** Every C0 and C1 control and DEL. */
const CONTROLS: readonly Range[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
];
/**
 * What ends a line (Unicode's mandatory breaks: LF, CR, VT, FF, NEL, the line and paragraph
 * separators): a title and a path turn each into one space, composer text into LF.
 */
const LINE_BREAKS = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029]);
const TAB = 0x09;
const LF = 0x0a;

/**
 * Whether a code point may stand in a brief as it is: never a control, a line separator or a
 * hidden character, except LF and the tab in the composer's lines (`multiline`). The sanitisers
 * keep only what this allows and the renderer's check accepts only what it allows, so whatever
 * the sanitisers give the renderer, the renderer's check holds.
 */
function allowed(code: number, multiline: boolean): boolean {
  if (multiline && (code === LF || code === TAB)) return true;
  return !within(code, CONTROLS) && !within(code, HIDDEN) && code !== 0x2028 && code !== 0x2029;
}
/**
 * Characters that can close or open a double quotation in some script, and the backtick: inside
 * a title each becomes `'`, so the title's own quotes in the brief are the only ones (the
 * others besides `"` and the backtick are the same mark in other scripts and widths).
 */
const QUOTES: readonly Range[] = [
  [0x22, 0x22],
  [0x60, 0x60],
  [0xab, 0xab],
  [0xbb, 0xbb],
  [0x2ba, 0x2ba],
  [0x2dd, 0x2dd],
  [0x2ee, 0x2ee],
  [0x201c, 0x201f],
  [0x2033, 0x2033],
  [0x2036, 0x2036],
  [0x275d, 0x275e],
  [0x2e42, 0x2e42],
  [0x301d, 0x301f],
  [0xff02, 0xff02],
  [0xff40, 0xff40],
];

const within = (code: number, ranges: readonly Range[]): boolean =>
  ranges.some(([from, to]) => code >= from && code <= to);

/**
 * `text` well-formed, with CRLF as one break, each code point kept, dropped or replaced by
 * `map` (undefined drops it).
 */
function mapped(text: string, map: (code: number, char: string) => string | undefined): string {
  let out = "";
  for (const char of text.toWellFormed().replace(/\r\n/gu, "\n")) {
    out += map(char.codePointAt(0) ?? 0, char) ?? "";
  }
  return out;
}

/** One line: breaks and tabs become spaces, every other control and hidden character goes. */
const oneLine = (code: number, char: string): string | undefined =>
  LINE_BREAKS.has(code) || code === TAB ? " " : allowed(code, false) ? char : undefined;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Grapheme clusters of a text. */
export const clustersOf = (text: string): string[] =>
  Array.from(segmenter.segment(text), (s) => s.segment);

/**
 * A task title as a brief may show it: one line, NFC, without hidden characters or
 * double quotes, within 120 clusters and 512 code units (cut with an ellipsis).
 */
export function sanitiseTitle(text: string): string {
  const line = mapped(mapped(text, oneLine).normalize("NFC"), (code, char) =>
    within(code, QUOTES) ? "'" : char,
  );
  return capped(line);
}

/** `text` cut at a cluster boundary, with an ellipsis, when it is over either bound. */
function capped(text: string): string {
  if (text.length <= TITLE_MAX_UNITS) {
    const clusters = clustersOf(text);
    if (clusters.length <= TITLE_MAX_CLUSTERS) return text;
  }
  let out = "";
  let count = 0;
  for (const cluster of clustersOf(text)) {
    if (count + 1 >= TITLE_MAX_CLUSTERS) break;
    if (out.length + cluster.length + ELLIPSIS.length > TITLE_MAX_UNITS) break;
    out += cluster;
    count += 1;
  }
  return out + ELLIPSIS;
}

/**
 * Composer text: the person's own words, so line breaks stay, each as LF (CRLF, CR,
 * VT, FF, NEL and the line and paragraph separators alike). Hidden characters and controls other
 * than the tab go; `removed` says whether any did (or a lone surrogate was replaced), for the UI's
 * quiet notice.
 */
export function sanitiseComposer(text: string): {
  readonly text: string;
  readonly removed: boolean;
} {
  const whole = text.toWellFormed();
  let removed = whole !== text;
  const kept = mapped(whole, (code, char) => {
    if (LINE_BREAKS.has(code)) return "\n";
    if (allowed(code, true)) return char;
    removed = true;
    return undefined;
  });
  return { text: kept, removed };
}

/**
 * A path or a root's label as a brief shows it: one
 * line, without controls, line breaks or hidden characters.
 */
export function sanitisePath(text: string): string {
  return mapped(text, oneLine);
}

/**
 * Whether a text may stand in a brief as it is: well-formed, without a control (other than the
 * composer's line breaks, which `multiline` allows), a line separator or a hidden character. The
 * renderer checks every brief it returns with this, as a second line behind the sanitiser.
 */
export function isBriefSafe(text: string, multiline: boolean): boolean {
  if (!text.isWellFormed()) return false;
  for (const char of text) {
    if (!allowed(char.codePointAt(0) ?? 0, multiline)) return false;
  }
  return true;
}
