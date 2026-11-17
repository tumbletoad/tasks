// The query language (A3 3.9.2): one language for `search`, `tasks find` and the page's search box.
//
//   timezone "time zone" OR dst status:open,waiting area:client-work p<=2 due<7d -is:inbox
//
// - Words are ANDed. `OR` (upper case, alone) joins its two neighbours. A leading `-` negates. A
//   quote starts a phrase, which runs to the next quote (`""` inside is one quote) or to the end.
// - `key:value` and `key<value` (also `<=`, `>`, `>=`) are filters. A key is letters only, so
//   `10:30` stays a word; an unknown key fails with a suggestion. A value may be quoted. A known
//   key with `=` (`p=3`) is read as `p:3`.
// - OR joins words with words or filters with filters, and never a negated term.
// - `sort:effort` lists the smallest effort first by the space's scale, `sort:-effort` the largest;
//   tasks without an effort come last either way. It filters nothing, so it stands alone: never
//   negated, never in an OR, once.
// - At most 500 characters and 20 terms.
//
// Parsing checks everything that does not depend on the space: the keys, the operators each key
// takes, the fixed values, numbers, dates and relative times. The space's own values (statuses,
// effort keys, areas, projects, machines) are checked when the query is planned (plan.ts).
// `printQuery` writes the canonical form, the result's `parsed`, and parsing it again gives the
// same query (A3 5: "Parsing, printing parsed: and parsing again gives the same query").
//
// Errors are `invalid_input` with fixed sentences: no word of the query reaches a message (A3 3.5).
// A suggestion from this module's own vocabulary goes into the hint.
import { AppError, normaliseLine } from "@tasks/contracts";
import { unsupported } from "../ops/errors.ts";

export const QUERY_LIMITS = { length: 500, terms: 20 } as const;

export const KEYS = [
  "status",
  "area",
  "project",
  "p",
  "effort",
  "due",
  "is",
  "has",
  "source",
  "by",
  "created",
  "updated",
  "completed",
  "on",
  "folder",
  "id",
  "sort",
] as const;
export type Key = (typeof KEYS)[number];

export const OPS = [":", "<", "<=", ">", ">="] as const;
export type Op = (typeof OPS)[number];

const COMPARISONS: readonly Op[] = OPS;
const EQUALS: readonly Op[] = [":"];

/** The operators each key takes. */
const KEY_OPS: Readonly<Record<Key, readonly Op[]>> = {
  status: EQUALS,
  area: EQUALS,
  project: EQUALS,
  p: COMPARISONS,
  effort: EQUALS,
  due: COMPARISONS,
  is: EQUALS,
  has: EQUALS,
  source: EQUALS,
  by: EQUALS,
  created: COMPARISONS,
  updated: COMPARISONS,
  completed: COMPARISONS,
  on: EQUALS,
  folder: EQUALS,
  id: EQUALS,
  sort: EQUALS,
};

/** Words people try for a key, and the key they mean. */
const KEY_ALIASES: Readonly<Record<string, Key>> = {
  prio: "p",
  pri: "p",
  priority: "p",
  state: "status",
  proj: "project",
  ref: "id",
  task: "id",
  label: "has",
  modified: "updated",
  changed: "updated",
  done: "completed",
  where: "on",
  order: "sort",
};

/** What `sort:` takes: the effort scale's order, smallest first, or with `-` largest first. */
export const SORT_VALUES = ["effort", "-effort"] as const;
export type Sort = (typeof SORT_VALUES)[number];

export const IS_VALUES = [
  "inbox",
  "focus",
  "overdue",
  "new",
  "proposed",
  "bound",
  "changed",
  "completed",
  "archived",
  "unwrapped",
] as const;
export type IsValue = (typeof IS_VALUES)[number];

/** `is:` values whose data a later step brings: refused naming the step, never ignored. */
const IS_LATER: Readonly<Partial<Record<IsValue, string>>> = {
  new: "M5.09 (the seen cursor)",
  changed: "M5.09 (the seen cursor)",
};

export const HAS_VALUES = [
  "folder",
  "place",
  "sources",
  "learnings",
  "notes",
  "questions",
] as const;
export type HasValue = (typeof HAS_VALUES)[number];

/** `due:` words beside dates and relative days. */
const DUE_WORDS = ["today", "none", "overdue"] as const;

export interface TextTerm {
  readonly type: "text";
  readonly text: string;
  /** Quoted: matched as a phrase, never as a prefix. */
  readonly phrase: boolean;
  readonly negated: boolean;
}

export interface FilterTerm {
  readonly type: "filter";
  readonly key: Key;
  readonly op: Op;
  /** As written, without quotes. */
  readonly value: string;
  readonly negated: boolean;
}

export type Term = TextTerm | FilterTerm;

/** The terms of each group are ORed, and the groups ANDed. */
export interface Query {
  readonly groups: readonly (readonly Term[])[];
}

// ---------------------------------------------------------------------------------------------
// Errors

/** A refusal of the query: a fixed sentence at `q`, with a hint from the fixed vocabulary. */
export function queryProblem(message: string, hint?: string, suggestions?: string[]): AppError {
  return new AppError({
    code: "invalid_input",
    message: `${message}.`,
    hint: hint ?? "Run tasks help find for the query language.",
    data: {
      issues: [{ path: "q", message }],
      ...(suggestions === undefined || suggestions.length === 0 ? {} : { suggestions }),
    },
  });
}

/** Edit distance, for suggestions. */
function distance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[y.length] ?? 0;
}

/** Up to three of `options` close to `word`: an alias, a prefix either way, or two edits away. */
export function suggest(
  word: string,
  options: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string[] {
  const w = word.toLowerCase();
  // An own entry only: `constructor` is no alias, whatever every object inherits.
  const alias = Object.hasOwn(aliases, w) ? aliases[w] : undefined;
  if (alias !== undefined) return [alias];
  return options
    .map((option) => ({ option, d: distance(w, option.toLowerCase()) }))
    .filter(
      ({ option, d }) =>
        d <= Math.min(2, Math.max(1, Math.floor(option.length / 2))) ||
        (w.length >= 2 && option.toLowerCase().startsWith(w)) ||
        (option.length >= 2 && w.startsWith(option.toLowerCase())),
    )
    .sort((a, b) => a.d - b.d || (a.option < b.option ? -1 : 1))
    .slice(0, 3)
    .map(({ option }) => option);
}

const didYouMean = (found: readonly string[]): string | undefined =>
  found.length === 0 ? undefined : `Did you mean ${found.join(" or ")}?`;

// ---------------------------------------------------------------------------------------------
// Values

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A calendar date `YYYY-MM-DD`. */
export function isCalendarDate(text: string): boolean {
  const match = ISO.exec(text);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Relative days for `due`: `7d`, `-3d`, `+2w`. */
export const RELATIVE_DAYS = /^([+-]?)([0-9]{1,4})([dw])$/;
/** Relative time for `created`, `updated` and `completed`: `-24h`, `-7d`, `-2w`. */
export const RELATIVE_TIME = /^([+-]?)([0-9]{1,5})([hdw])$/;

const lower = (value: string): string => value.toLowerCase();

function checkValue(key: Key, op: Op, value: string): void {
  const v = lower(value);
  switch (key) {
    case "p":
      if (!/^[1-4]$/.test(v)) throw queryProblem("A priority is 1, 2, 3 or 4", "Use p:1 or p<=2.");
      return;
    case "is": {
      if (!(IS_VALUES as readonly string[]).includes(v)) {
        throw queryProblem("Unknown is: value", didYouMean(suggest(v, IS_VALUES)));
      }
      const later = IS_LATER[v as IsValue];
      if (later !== undefined) throw unsupported("q", later);
      return;
    }
    case "has":
      if (!(HAS_VALUES as readonly string[]).includes(v)) {
        throw queryProblem("Unknown has: value", didYouMean(suggest(v, HAS_VALUES)));
      }
      return;
    case "due":
      if (isCalendarDate(v) || RELATIVE_DAYS.test(v) || v === "today") return;
      if (op === ":" && (v === "none" || v === "overdue")) return;
      throw queryProblem(
        "A due value is a date, today, a number of days such as 7d, none or overdue",
        didYouMean(suggest(v, DUE_WORDS)),
      );
    case "created":
    case "updated":
    case "completed":
      if (isCalendarDate(v) || RELATIVE_TIME.test(v) || v === "today") return;
      throw queryProblem(
        "A time is a date, today, or a relative time such as -24h or -7d",
        "Use updated>-24h or created>=2026-10-01.",
      );
    case "by":
      if (v === "user" || v === "agent" || (v.startsWith("agent:") && v.length > 6)) return;
      throw queryProblem(
        "A by: value is user, agent or agent:<instance>",
        didYouMean(suggest(v, ["user", "agent"])),
      );
    case "id":
      if (/^[A-Za-z]{1,6}-[1-9][0-9]{0,9}$/.test(value) || /^t_[0-9a-z]{26}$/.test(value)) return;
      throw queryProblem("An id: value is a task reference such as M-14", "Use id:M-14.");
    case "sort":
      if ((SORT_VALUES as readonly string[]).includes(v)) return;
      throw queryProblem(
        "A sort: value is effort or -effort",
        "Use sort:effort for the smallest effort first.",
      );
    default:
      // status, area, project, effort, source, on and folder name the space's own values or this
      // machine's folders (plan.ts).
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing

const SPACE = /\s/u;
const FILTER = /^([A-Za-z]+)(<=|>=|:|<|>|=)/;

/** A quoted string from the quote at `at`: its text and the index after its closing quote. */
function readQuoted(text: string, at: number): [string, number] {
  let out = "";
  let i = at + 1;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === '"') {
      if (text[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += char;
    i += 1;
  }
  return [out, i];
}

type Token = Term | "OR";

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    if (SPACE.test(text[i] ?? "")) {
      i += 1;
      continue;
    }
    let negated = false;
    if (text[i] === "-" && i + 1 < text.length && !SPACE.test(text[i + 1] ?? "")) {
      negated = true;
      i += 1;
    }
    if (text[i] === '"') {
      const [phrase, next] = readQuoted(text, i);
      out.push({ type: "text", text: phrase, phrase: true, negated });
      i = next;
      continue;
    }
    let end = i;
    while (end < text.length && !SPACE.test(text[end] ?? "")) end += 1;
    const word = text.slice(i, end);
    const filter = FILTER.exec(word);
    const key = lower(filter?.[1] ?? "");
    const known = (KEYS as readonly string[]).includes(key);
    // `p=3` is how many other tools write `p:3`. Behind any other word `=` is text, as in `x=1`.
    if (filter !== null && (filter[2] !== "=" || known)) {
      const op = (filter[2] === "=" ? ":" : filter[2]) as Op;
      if (!known) {
        const found = suggest(key, KEYS, KEY_ALIASES);
        throw queryProblem("The query has an unknown key", didYouMean(found), found);
      }
      const at = i + filter[0].length;
      let value: string;
      if (text[at] === '"') {
        [value, i] = readQuoted(text, at);
      } else {
        value = text.slice(at, end);
        i = end;
      }
      out.push({ type: "filter", key: key as Key, op, value, negated });
      continue;
    }
    i = end;
    if (!negated && word === "OR") out.push("OR");
    else out.push({ type: "text", text: word, phrase: false, negated });
  }
  return out;
}

/** Reads a query. An empty query (no terms) lists by the order without text (A3 3.9.3). */
export function parseQuery(given: string): Query {
  const text = normaliseLine(given);
  if (Array.from(text).length > QUERY_LIMITS.length) {
    throw queryProblem("The query is longer than 500 characters");
  }
  const groups: Term[][] = [];
  let joining = false;
  let terms = 0;
  for (const token of tokens(text)) {
    if (token === "OR") {
      if (groups.length === 0 || joining) {
        throw queryProblem("OR stands between two terms", 'Use a OR b, or "or" for the word.');
      }
      joining = true;
      continue;
    }
    terms += 1;
    if (terms > QUERY_LIMITS.terms) throw queryProblem("The query has more than 20 terms");
    if (token.type === "filter") {
      if (!KEY_OPS[token.key].includes(token.op)) {
        throw queryProblem("This key takes only a colon", "Use key:value.");
      }
      if (token.value === "") throw queryProblem("A filter needs a value", "Use key:value.");
      checkValue(token.key, token.op, token.value);
    }
    const last = groups.at(-1);
    if (joining && last !== undefined) {
      last.push(token);
      joining = false;
    } else groups.push([token]);
  }
  if (joining)
    throw queryProblem("OR stands between two terms", 'Use a OR b, or "or" for the word.');
  for (const group of groups) {
    if (group.length < 2) continue;
    if (group.some((t) => t.negated)) {
      throw queryProblem("OR cannot join a negated term", "Write the negated term on its own.");
    }
    if (!group.every((t) => t.type === group[0]?.type)) {
      throw queryProblem("OR joins words with words or filters with filters");
    }
  }
  const sorts = groups.flat().filter((t) => t.type === "filter" && t.key === "sort");
  if (sorts.some((t) => t.negated)) {
    throw queryProblem("A sort cannot be negated", "Use sort:-effort for the largest first.");
  }
  if (sorts.length > 1 || groups.some((g) => g.length > 1 && sorts.some((s) => g.includes(s)))) {
    throw queryProblem("A query sorts once, outside any OR", "Use one sort:effort on its own.");
  }
  // A word or phrase made only of characters the index's tokenizer surely drops (A1 3.12's
  // unicode61) could match nothing and would empty the whole AND: it is left out, and `parsed` shows
  // that. Anything else goes to the index as written, since only SQLite's own tables say for sure
  // which other characters it keeps (it keeps 🧪, and drops 😀).
  const kept = groups
    .map((group) => group.filter((t) => t.type === "filter" || !SEPARATORS_ONLY.test(t.text)))
    .filter((group) => group.length > 0);
  const query = { groups: kept };
  // `parsed` is a query too: printing closes an open phrase and quotes a value with a quote, so
  // the printed form is held to the same limit, and parsing it again always succeeds.
  if (Array.from(printQuery(query)).length > QUERY_LIMITS.length) {
    throw queryProblem("The query is longer than 500 characters");
  }
  return query;
}

/**
 * Characters FTS5's unicode61 tokenizer always treats as separators: ASCII other than letters and
 * digits, and punctuation, symbols and spaces of Latin-1, General Punctuation, CJK punctuation and
 * the fullwidth forms, all assigned long before the tokenizer's tables. `[A3.5.search.query]`
 * checks every one of them against the index's own tokenizer.
 */
export const SEPARATOR_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x2f],
  [0x3a, 0x40],
  [0x5b, 0x60],
  [0x7b, 0xa9],
  [0xab, 0xb1],
  [0xb4, 0xb4],
  [0xb6, 0xb8],
  [0xbb, 0xbb],
  [0xbf, 0xbf],
  [0xd7, 0xd7],
  [0xf7, 0xf7],
  [0x2000, 0x205f],
  [0x3000, 0x3004],
  [0x3008, 0x3020],
  [0xff01, 0xff0f],
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff65],
];

const codePoint = (n: number): string => `\\u{${n.toString(16)}}`;
const SEPARATORS_ONLY = new RegExp(
  `^[${SEPARATOR_RANGES.map(([a, b]) => (a === b ? codePoint(a) : `${codePoint(a)}-${codePoint(b)}`)).join("")}]*$`,
  "u",
);

// ---------------------------------------------------------------------------------------------
// Printing

const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

function printTerm(term: Term): string {
  const sign = term.negated ? "-" : "";
  if (term.type === "text") return `${sign}${term.phrase ? quote(term.text) : term.text}`;
  const value = term.value === "" || /[\s"]/u.test(term.value) ? quote(term.value) : term.value;
  return `${sign}${term.key}${term.op}${value}`;
}

/** The canonical form of a query: what `parsed` shows, and what parses back to the same query. */
export function printQuery(query: Query): string {
  return query.groups.map((group) => group.map(printTerm).join(" OR ")).join(" ");
}

/** The query's terms, in order. */
export const termsOf = (query: Query): Term[] => query.groups.flat();

/** The order the query asks for with `sort:`, if any. */
export function sortOf(query: Query): Sort | undefined {
  const term = termsOf(query).find((t) => t.type === "filter" && t.key === "sort");
  return term === undefined ? undefined : (lower((term as FilterTerm).value) as Sort);
}

/**
 * Whether the query asks for completed or archived tasks itself: then a call without a scope
 * searches every lifecycle (A3 3.9.2), so `tasks find is:completed` finds them.
 */
export function namesLifecycle(query: Query): boolean {
  return termsOf(query).some(
    (t) =>
      t.type === "filter" &&
      !t.negated &&
      (t.key === "completed" ||
        (t.key === "is" && ["completed", "archived", "unwrapped"].includes(lower(t.value)))),
  );
}
