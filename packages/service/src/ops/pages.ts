// Pages of a sections read (A3 3.4.4, 3.2.5): `get_task` with `sections` returns the sections in
// full, a page at a time, and a `before` token reads on. The request path decides the page, so
// every face (RPC, the CLI's --json, HTTP, MCP) gets the same page, and MCP's text of a page
// always fits its result budget whole: nothing a reader asked for in full is ever cut.
//
// A page holds at most PAGE_BYTES of content, measured as an upper bound of its compact text:
// each item costs its text's UTF-8 bytes, a few bytes per line (the indent and the newline) and a
// fixed allowance for the line's prefix (its reference, author, date, kind and range), and each
// section its title line. The compact text adds at most the header, the title and the way on,
// which the renderer keeps within the rest of the 4,000-token budget (render.ts).
//
// Items go whole onto a page while they fit. One that does not fit what is left, but would fit a
// fresh page, starts the next page, so a note the user addressed to agents is cut only when it is
// longer than a page: then it is split across pages by code point, each part with its range
// (`slice`), and the pages together hold every character once, in order.
//
// The token names where the next page starts, in the order of SECTION_ORDER:
//   `<s>`            the start of section s,
//   `<s><k>`         after item k of section s (a note or log ordinal, a source row counted
//                    from 1, a history commit's seq, or a learning's rank),
//   `<s><k>.<o>`     item k of section s from code point o,
//   `c.<o>`, `o.<o>` the context or the outcome's text from code point o,
//   `o0`             after the outcome's text, before the task's first learning,
// where s is i (instructions), c (context), n (notes), l (log), s (sources), o (outcome) or h
// (history). Notes and log entries are named by their ordinal, history by its commit, and
// learnings by their rank among all the task's learnings, removed ones included, so a page read
// later still starts where the last one ended, whatever was added since. The outcome section is its text (item 0) followed by
// the learnings, each whole: a learning is at most 1 KiB, so a fresh page always holds it.
import { invalid } from "./errors.ts";

export const SECTION_ORDER = [
  "instructions",
  "context",
  "notes",
  "log",
  "sources",
  "outcome",
  "history",
] as const;

export type Section = (typeof SECTION_ORDER)[number];

/** Content bytes per page: 4,000 tokens at 1.5 bytes per token is 6,000 bytes in all. */
export const PAGE_BYTES = 4_000;
/** The prefix of an item's line: reference, author's label aside, date, kind and range. */
export const ITEM_BYTES = 96;
/** Each line of a text: its indent and its newline. */
export const LINE_BYTES = 3;
/** Each section's title line. */
export const SECTION_BYTES = 64;
/** The least of a text a page takes when it starts a part of it there. */
const MIN_PART_BYTES = 256;

const LETTERS: Readonly<Record<Section, string>> = {
  instructions: "i",
  context: "c",
  notes: "n",
  log: "l",
  sources: "s",
  outcome: "o",
  history: "h",
};

const SECTIONS_BY_LETTER = new Map(
  Object.entries(LETTERS).map(([section, letter]) => [letter, section as Section]),
);

/**
 * Sections whose item 0 is a text: the context, which is nothing else, and the outcome, whose
 * learnings follow its text. The other sections are lists keyed from 1.
 */
const TEXT_FIRST: ReadonlySet<Section> = new Set(["context", "outcome"]);

/** Where a page starts. `after` and `at` are ordinals or 1-based rows; `offset` code points. */
export type Token =
  | { readonly section: Section; readonly kind: "start" }
  | { readonly section: Section; readonly kind: "after"; readonly item: number }
  | {
      readonly section: Section;
      readonly kind: "at";
      readonly item: number;
      readonly offset: number;
    };

const TOKEN = /^([icnlsoh])(?:(0|[1-9][0-9]{0,8}))?(?:\.([1-9][0-9]{0,8}))?$/;

/** A `before` token as the request path wrote it, or `invalid_input`. */
export function parseToken(text: string): Token {
  const match = TOKEN.exec(text);
  const section = match === null ? undefined : SECTIONS_BY_LETTER.get(match[1] ?? "");
  const bad = () => invalid("before", "Not a paging token from a result");
  if (match === null || section === undefined) throw bad();
  const item = match[2] === undefined ? undefined : Number(match[2]);
  const offset = match[3] === undefined ? undefined : Number(match[3]);
  if (item === undefined) {
    // A section's start, or its text from a code point.
    if (offset === undefined) return { section, kind: "start" };
    if (!TEXT_FIRST.has(section)) throw bad();
    return { section, kind: "at", item: 0, offset };
  }
  // The context has no items after its text; the outcome's learnings are never split; a list's
  // items are keyed from 1.
  if (section === "context") throw bad();
  if (section === "outcome") {
    if (offset !== undefined) throw bad();
    return { section, kind: "after", item };
  }
  if (item === 0) throw bad();
  return offset === undefined
    ? { section, kind: "after", item }
    : { section, kind: "at", item, offset };
}

export function formatToken(token: Token): string {
  const letter = LETTERS[token.section];
  if (token.kind === "start") return letter;
  if (token.kind === "after") return `${letter}${String(token.item)}`;
  return token.item === 0
    ? `${letter}.${String(token.offset)}`
    : `${letter}${String(token.item)}.${String(token.offset)}`;
}

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/** A text's cost: its bytes and its lines. */
export const textCost = (text: string): number => utf8(text) + LINE_BYTES * text.split("\n").length;

/** The part of a text a page holds: code points `from` up to `to` of `of`. */
export interface Slice {
  readonly from: number;
  readonly to: number;
  readonly of: number;
}

/** One item of a section as the page builder sees it. */
export interface PageItem<T> {
  readonly value: T;
  /** Its key in a token: an ordinal, a commit's seq, or a row counted from 1. */
  readonly key: number;
  /** Its text, when a part of it may go on a page; else the item is whole or not at all. */
  readonly text?: string;
  /** What its line costs besides its text: the label of its author, its fields. */
  readonly extra: number;
}

/** A section's items, from where the page starts. */
export interface SectionInput<T> {
  readonly section: Section;
  readonly items: readonly PageItem<T>[];
  /** The code point the first item starts at, when the page continues it. */
  readonly offset?: number;
  /** At most this many items on a page (the log's `log_limit`). */
  readonly limit?: number;
  /** The token the page started with, when it starts inside this section. */
  readonly resume?: Token;
}

/** An item on a page: whole, or a part of its text. */
export interface Placed<T> {
  readonly value: T;
  readonly text?: string;
  readonly slice?: Slice;
}

export interface Page {
  readonly sections: ReadonlyMap<Section, readonly Placed<unknown>[]>;
  readonly before?: string;
}

/**
 * The page that starts at `token` (or at the first section asked for), over `inputs`, which hold
 * each section asked for, in SECTION_ORDER, with its items from where the page starts.
 */
export function buildPage(inputs: readonly SectionInput<unknown>[]): Page {
  const sections = new Map<Section, Placed<unknown>[]>();
  let room = PAGE_BYTES;
  let shown = false;
  // A section whose items all wait for the next page is not on this one: an empty list here would
  // say it has none.
  const stop = (token: Token): Page => {
    if (sections.get(token.section)?.length === 0) sections.delete(token.section);
    return { sections, before: formatToken(token) };
  };
  for (const input of inputs) {
    const { section, items } = input;
    if (shown && room < SECTION_BYTES + ITEM_BYTES + MIN_PART_BYTES) {
      return stop(startOf(input));
    }
    room -= SECTION_BYTES;
    const placed: Placed<unknown>[] = [];
    sections.set(section, placed);
    let previous: PageItem<unknown> | undefined;
    for (const [n, item] of items.entries()) {
      if (input.limit !== undefined && placed.length >= input.limit) {
        return stop(afterOf(section, previous, input));
      }
      const chars = item.text === undefined ? undefined : Array.from(item.text);
      // A token from before the text changed may point past its end: the rest is then empty.
      const offset = n === 0 ? Math.min(input.offset ?? 0, chars?.length ?? 0) : 0;
      const rest = chars === undefined ? undefined : chars.slice(offset).join("");
      const cost = ITEM_BYTES + item.extra + (rest === undefined ? 0 : textCost(rest));
      if (cost <= room) {
        placed.push(partOf(item, chars, offset, chars?.length));
        room -= cost;
        shown = true;
        previous = item;
        continue;
      }
      const freshRoom = PAGE_BYTES - SECTION_BYTES;
      // A whole item that a fresh page holds starts the next page.
      if (shown && (chars === undefined || cost <= freshRoom)) {
        return stop(afterOf(section, previous, input));
      }
      // An item that holds no text cannot be split: it goes alone onto a fresh page.
      if (chars === undefined) {
        placed.push(partOf(item, chars, 0, undefined));
        shown = true;
        previous = item;
        room = 0;
        continue;
      }
      // A text longer than a page: as much of it as fits here, then the next page goes on.
      const space = room - ITEM_BYTES - item.extra;
      if (shown && space < MIN_PART_BYTES) return stop(afterOf(section, previous, input));
      const end = fitChars(chars, offset, space);
      if (end >= chars.length) {
        placed.push(partOf(item, chars, offset, end));
        shown = true;
        previous = item;
        room = 0;
        continue;
      }
      placed.push(partOf(item, chars, offset, end));
      return stop({ section, kind: "at", item: item.key, offset: end });
    }
    if (items.length > 0) shown = true;
  }
  return { sections };
}

/**
 * Where the page ends when it ends before anything of `input`: the token this page started the
 * section with, or the section's start. (A page always shows something of the section it starts
 * with, so the pages move on.)
 */
const startOf = (input: SectionInput<unknown>): Token =>
  input.resume ?? { section: input.section, kind: "start" };

/** The token after `previous`, or the start of what the page held of the section. */
function afterOf(
  section: Section,
  previous: PageItem<unknown> | undefined,
  input: SectionInput<unknown>,
): Token {
  if (previous === undefined) return startOf(input);
  return { section, kind: "after", item: previous.key };
}

/** The item with its text from `from` to `to`, and its slice when that is not all of it. */
function partOf<T>(
  item: PageItem<T>,
  chars: readonly string[] | undefined,
  from: number,
  to: number | undefined,
): Placed<T> {
  if (chars === undefined || to === undefined) return { value: item.value };
  const text = chars.slice(from, to).join("");
  if (from === 0 && to === chars.length) return { value: item.value, text };
  return { value: item.value, text, slice: { from, to, of: chars.length } };
}

/** How far from `from` the code points of `chars` go within `space` bytes: at least one. */
function fitChars(chars: readonly string[], from: number, space: number): number {
  let used = LINE_BYTES;
  let end = from;
  while (end < chars.length) {
    const char = chars[end] ?? "";
    const cost = utf8(char) + (char === "\n" ? LINE_BYTES : 0);
    if (used + cost > space && end > from) break;
    used += cost;
    end += 1;
  }
  return end;
}
