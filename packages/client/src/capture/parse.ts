// What a quick capture's text says besides its title: a due date, a priority, an area or project,
// a person it waits on, and a star. Pure, so every reading is a unit test, and run on every
// keystroke: the field shows each shortcut as what it became before the task is saved, and a
// shortcut the person turns back into text (`kept`) stays text.
//
// A word becomes a shortcut only when the whole word is one, so "p10", "#3", "mail@ana" and
// "sunlight" stay text. Words that are everyday words more often than dates ("sun", "sat", "wed",
// "tom", "may" alone) are never read as dates; numbers that differ by locale ("11/12") are not
// read either, so no date is a guess. Only the first shortcut of each kind applies: a second
// "p2" stays in the title.
import { filedAs } from "../store/tree.ts";
import { parseRepeat } from "@ttasks/contracts/repeat";
import { formatRule } from "@ttasks/contracts/schedule";
import { addDays, isDate, weekdayOf } from "./due.ts";

export interface CaptureArea {
  readonly id: string;
  readonly title: string;
}

export interface CaptureProject {
  readonly id: string;
  readonly title: string;
  /** Its area's ID. */
  readonly parent?: string;
}

export interface CaptureContext {
  /** The viewer's today, YYYY-MM-DD: relative dates count from it. */
  readonly today: string;
  readonly areas: readonly CaptureArea[];
  readonly projects: readonly CaptureProject[];
  /**
   * The archived areas and projects, and the projects of archived areas: they take no new task, but
   * a name of theirs still means them, so it never falls through to another group of that name.
   */
  readonly archived?: {
    readonly areas: readonly CaptureArea[];
    readonly projects: readonly CaptureProject[];
  };
  /** The area (and project) of the view the person is in: a capture lands there by default. */
  readonly here?: { readonly area: string; readonly project?: string } | undefined;
  /** The keys of shortcuts the person turned back into text. */
  readonly kept?: ReadonlySet<string>;
  /** The space keeps routines (a tree space): "every saturday" makes the capture one. */
  readonly repeats?: boolean;
}

interface Span {
  /** Stable while the text holds the same words: what `kept` names. */
  readonly key: string;
  /** Where the shortcut is in the text, in UTF-16 units; none for the view's area. */
  readonly start?: number;
  readonly end?: number;
  /** The words as typed. */
  readonly text: string;
}

export type Chip =
  | (Span & { readonly kind: "due"; readonly date: string })
  | (Span & { readonly kind: "priority"; readonly level: 1 | 2 | 3 | 4 })
  | (Span & {
      readonly kind: "area";
      readonly area: CaptureArea;
      readonly project?: CaptureProject;
      /** From the view the person is in, not from the text. */
      readonly fromView?: true;
    })
  | (Span & { readonly kind: "waiting"; readonly who: string })
  | (Span & { readonly kind: "star" })
  /** A schedule in words: the capture is a routine you do. `rule` is its stored form. */
  | (Span & { readonly kind: "repeat"; readonly rule: string });

export type ChipKind = Chip["kind"];

/** What `task.add` gets for one capture. */
export interface CaptureDraft {
  readonly title: string;
  readonly inbox: boolean;
  readonly area?: string;
  readonly project?: string;
  readonly priority?: number;
  readonly due?: string;
  readonly status?: string;
  readonly waiting_on?: string;
  readonly focus?: true;
  /** A routine's schedule in the words typed: `task.add`'s `repeat`. */
  readonly repeat?: string;
}

export interface Capture {
  /** The title the task gets: the text without its shortcuts, spaces collapsed. */
  readonly title: string;
  /** The shortcuts in the order they appear; the view's area first. */
  readonly chips: readonly Chip[];
  /** The task to add; none while the title is empty. */
  readonly draft: CaptureDraft | undefined;
  /** The archived group the first `#name` that matched none named: its words stay in the title. */
  readonly archived?: string;
}

interface Word {
  readonly text: string;
  readonly lower: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /\S+/gu;

function wordsOf(text: string): Word[] {
  return [...text.matchAll(WORD)].map((m) => ({
    text: m[0],
    lower: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Full weekday names, Sunday first, and the short forms that are not also everyday words. */
const WEEKDAYS: readonly (readonly string[])[] = [
  ["sunday"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday"],
];

/** Month names, January first. "May" is a month only beside a day number. */
const MONTHS: readonly (readonly string[])[] = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];

/** Words directly before a date that belong to it: "pay rent by fri". */
const LEADS = new Set(["on", "by", "due"]);

/** The words a schedule starts with in a capture: "every saturday", "daily at 7", "weekdays". */
const REPEAT_LEADS = new Set(["every", "each", "daily", "weekly", "monthly", "yearly", "weekdays"]);

/** The longest run of words from `i` that says a schedule, with its stored rule. */
function repeatAt(
  words: readonly Word[],
  i: number,
  today: string,
): { count: number; rule: string } | undefined {
  for (let n = Math.min(10, words.length - i); n >= 1; n -= 1) {
    const said = words
      .slice(i, i + n)
      .map((w) => w.text)
      .join(" ");
    const rule = parseRepeat(said, today);
    if (rule !== undefined) return { count: n, rule: formatRule(rule) };
  }
  return undefined;
}

const weekday = (word: string): number => WEEKDAYS.findIndex((names) => names.includes(word));
const month = (word: string): number => MONTHS.findIndex((names) => names.includes(word));
const DAY = /^([1-9]|[12]\d|3[01])(st|nd|rd|th)?$/u;
const YEAR = /^(19|20)\d{2}$/u;
const OFFSET = /^\+([1-9]\d{0,2})([dw])$/u;
const COUNT = /^[1-9]\d{0,2}$/u;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** A day of a month: in the year given, else the next one on or after today. */
function dayOfMonth(day: number, m: number, year: number | undefined, today: string): string {
  if (year !== undefined) return `${pad(year, 4)}-${pad(m + 1)}-${pad(day)}`;
  const thisYear = Number(today.slice(0, 4));
  const date = `${pad(thisYear, 4)}-${pad(m + 1)}-${pad(day)}`;
  // 29 February in a year without it: the next year that has it is too far to be meant.
  if (!isDate(date)) return `${pad(thisYear + 1, 4)}-${pad(m + 1)}-${pad(day)}`;
  return date < today ? `${pad(thisYear + 1, 4)}-${pad(m + 1)}-${pad(day)}` : date;
}

/** A date that starts at `words[i]`: the date and how many words it takes. */
function dateAt(words: readonly Word[], i: number, today: string): [string, number] | undefined {
  const w = words[i]?.lower;
  if (w === undefined) return undefined;
  const next = words[i + 1]?.lower;
  const third = words[i + 2]?.lower;
  if (w === "today") return [today, 1];
  if (w === "tomorrow") return [addDays(today, 1), 1];
  if (isDate(w)) return [w, 1];
  const offset = OFFSET.exec(w);
  if (offset !== null) {
    const n = Number(offset[1]);
    return [addDays(today, offset[2] === "w" ? n * 7 : n), 1];
  }
  const wd = weekday(w);
  // A weekday is the next one, today when it is that day (as the date field and the service).
  if (wd >= 0) return [addDays(today, (wd - weekdayOf(today) + 7) % 7), 1];
  if (w === "next" && next === "week") {
    const toMonday = (1 - weekdayOf(today) + 7) % 7;
    return [addDays(today, toMonday === 0 ? 7 : toMonday), 2];
  }
  if (w === "in" && next !== undefined && COUNT.test(next) && third !== undefined) {
    const n = Number(next);
    if (third === "days" || (third === "day" && n === 1)) return [addDays(today, n), 3];
    if (third === "weeks" || (third === "week" && n === 1)) return [addDays(today, n * 7), 3];
    return undefined;
  }
  // 20 nov [2026], nov 20 [2026].
  const dayFirst = DAY.exec(w);
  const m = next === undefined ? -1 : month(next);
  const yearAfter = (k: number): number | undefined => {
    const y = words[i + k]?.lower;
    return y !== undefined && YEAR.test(y) ? Number(y) : undefined;
  };
  if (dayFirst !== null && m >= 0) {
    const year = yearAfter(2);
    const date = dayOfMonth(Number(dayFirst[1]), m, year, today);
    return isDate(date) ? [date, year === undefined ? 2 : 3] : undefined;
  }
  const mFirst = month(w);
  const dayAfter = next === undefined ? null : DAY.exec(next);
  if (mFirst >= 0 && dayAfter !== null) {
    const year = yearAfter(2);
    const date = dayOfMonth(Number(dayAfter[1]), mFirst, year, today);
    return isDate(date) ? [date, year === undefined ? 2 : 3] : undefined;
  }
  return undefined;
}

/** A title as a slug for matching `#words`: lower case, letters and digits joined by "-". */
export function slugOf(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

const PRIORITY = /^p([1-4])$/u;
const PERSON = /^@([\p{L}\p{N}][\p{L}\p{N}._'-]*)$/u;
const GROUP = /^#([^#/\s]+)(?:\/([^#/\s]+))?$/u;

/**
 * The area and project `#words` names, when it names exactly one live one; the archived group it
 * names, when it names one and no live one has the name; else none. An area's name comes before a
 * project's, archived or not.
 */
function groupOf(
  word: string,
  areas: readonly CaptureArea[],
  projects: readonly CaptureProject[],
  shelved: NonNullable<CaptureContext["archived"]>,
): { area: CaptureArea; project?: CaptureProject } | { archived: string } | undefined {
  const match = GROUP.exec(word);
  if (match === null) return undefined;
  const first = slugOf(match[1] ?? "");
  const second = match[2] === undefined ? undefined : slugOf(match[2]);
  if (first === "") return undefined;
  const areasNamed = areas.filter((a) => slugOf(a.title) === first);
  const shelvedArea = shelved.areas.find((a) => slugOf(a.title) === first);
  if (second !== undefined) {
    if (areasNamed.length === 0) {
      return shelvedArea === undefined ? undefined : { archived: shelvedArea.title };
    }
    if (areasNamed.length !== 1) return undefined;
    const area = areasNamed[0] as CaptureArea;
    const inArea = projects.filter((p) => p.parent === area.id && slugOf(p.title) === second);
    if (inArea.length === 1) return { area, project: inArea[0] as CaptureProject };
    if (inArea.length > 1) return undefined;
    const gone = shelved.projects.find((p) => p.parent === area.id && slugOf(p.title) === second);
    return gone === undefined ? undefined : { archived: gone.title };
  }
  if (areasNamed.length === 1) return { area: areasNamed[0] as CaptureArea };
  if (areasNamed.length > 1) return undefined;
  if (shelvedArea !== undefined) return { archived: shelvedArea.title };
  // A project's name alone, when one project in an area has it.
  const named = projects.filter((p) => slugOf(p.title) === first && p.parent !== undefined);
  if (named.length > 1) return undefined;
  const project = named[0];
  if (project === undefined) {
    const gone = shelved.projects.find((p) => slugOf(p.title) === first);
    return gone === undefined ? undefined : { archived: gone.title };
  }
  const area = areas.find((a) => a.id === project.parent);
  return area === undefined ? undefined : { area, project };
}

const NOTHING_ARCHIVED = { areas: [], projects: [] } as const;

/** The key a chip is kept by: its kind and its words, in lower case. */
const keyOf = (kind: ChipKind, text: string): string => `${kind}:${text.toLowerCase()}`;

/** The key of the view's own area, which the person can also turn off. */
export const HERE_KEY = "area:@view";

export function parseCapture(text: string, ctx: CaptureContext): Capture {
  const kept = ctx.kept ?? new Set<string>();
  let archived: string | undefined;
  const words = wordsOf(text);
  const found: Chip[] = [];
  const seen = new Set<ChipKind>();
  /** The words a chip took, by index. */
  const taken = new Set<number>();
  const span = (from: number, count: number) => {
    const first = words[from] as Word;
    const last = words[from + count - 1] as Word;
    return { start: first.start, end: last.end, text: text.slice(first.start, last.end) };
  };
  const take = (from: number, count: number) => {
    for (let k = from; k < from + count; k += 1) taken.add(k);
  };

  for (let i = 0; i < words.length; i += 1) {
    if (taken.has(i)) continue;
    const word = words[i] as Word;
    if (ctx.repeats === true && !seen.has("repeat") && REPEAT_LEADS.has(word.lower)) {
      const said = repeatAt(words, i, ctx.today);
      if (said !== undefined) {
        const s = span(i, said.count);
        if (!kept.has(keyOf("repeat", s.text))) {
          found.push({ kind: "repeat", key: keyOf("repeat", s.text), ...s, rule: said.rule });
          seen.add("repeat");
          take(i, said.count);
          i += said.count - 1;
          continue;
        }
      }
    }
    if (!seen.has("due")) {
      // A lead word ("by fri") goes with its date; the date alone when the lead is kept as text.
      const lead = LEADS.has(word.lower) ? dateAt(words, i + 1, ctx.today) : undefined;
      if (lead !== undefined) {
        const s = span(i, lead[1] + 1);
        // Kept as text, the date's own words stay text with it.
        if (kept.has(keyOf("due", s.text))) {
          i += lead[1];
          continue;
        }
        found.push({ kind: "due", key: keyOf("due", s.text), ...s, date: lead[0] });
        seen.add("due");
        take(i, lead[1] + 1);
        i += lead[1];
        continue;
      }
      const date = dateAt(words, i, ctx.today);
      if (date !== undefined) {
        const s = span(i, date[1]);
        if (!kept.has(keyOf("due", s.text))) {
          found.push({ kind: "due", key: keyOf("due", s.text), ...s, date: date[0] });
          seen.add("due");
          take(i, date[1]);
          i += date[1] - 1;
          continue;
        }
      }
    }
    const one = (chip: Chip) => {
      if (seen.has(chip.kind) || kept.has(chip.key)) return false;
      found.push(chip);
      seen.add(chip.kind);
      take(i, 1);
      return true;
    };
    const s = span(i, 1);
    const priority = PRIORITY.exec(word.lower);
    if (priority !== null) {
      const level = Number(priority[1]) as 1 | 2 | 3 | 4;
      if (one({ kind: "priority", key: keyOf("priority", s.text), ...s, level })) continue;
    }
    if (word.text === "*" && one({ kind: "star", key: keyOf("star", s.text), ...s })) continue;
    const person = PERSON.exec(word.text);
    if (person !== null) {
      const who = person[1] ?? "";
      if (one({ kind: "waiting", key: keyOf("waiting", s.text), ...s, who })) continue;
    }
    const group = groupOf(word.text, ctx.areas, ctx.projects, ctx.archived ?? NOTHING_ARCHIVED);
    if (group !== undefined && "archived" in group) archived ??= group.archived;
    else if (group !== undefined) one({ kind: "area", key: keyOf("area", s.text), ...s, ...group });
  }

  // The view's area, unless the text names one or the person turned it off.
  if (!seen.has("area") && ctx.here !== undefined && !kept.has(HERE_KEY)) {
    const area = ctx.areas.find((a) => a.id === ctx.here?.area);
    const project =
      ctx.here.project === undefined
        ? undefined
        : ctx.projects.find((p) => p.id === ctx.here?.project && p.parent === area?.id);
    if (area !== undefined) {
      found.unshift({
        kind: "area",
        key: HERE_KEY,
        text: "",
        area,
        ...(project === undefined ? {} : { project }),
        fromView: true,
      });
    }
  }

  const title = words
    .filter((_, i) => !taken.has(i))
    .map((w) => w.text)
    .join(" ");
  return {
    title,
    chips: found,
    draft: title === "" ? undefined : draftOf(title, found),
    ...(archived === undefined ? {} : { archived }),
  };
}

function draftOf(title: string, chips: readonly Chip[]): CaptureDraft {
  let draft: {
    -readonly [K in keyof CaptureDraft]: CaptureDraft[K];
  } = { title, inbox: true };
  for (const chip of chips) {
    switch (chip.kind) {
      case "due":
        draft.due = chip.date;
        break;
      case "priority":
        draft.priority = chip.level;
        break;
      case "star":
        draft.focus = true;
        break;
      case "waiting":
        draft = { ...draft, status: "waiting", waiting_on: chip.who, inbox: false };
        break;
      case "repeat":
        draft.repeat = chip.text;
        break;
      case "area": {
        const filed = filedAs(chip.area, chip.project);
        draft = {
          ...draft,
          ...(filed.area === undefined ? {} : { area: filed.area.title }),
          ...(filed.project === undefined ? {} : { project: filed.project.title }),
          inbox: false,
        };
        break;
      }
    }
  }
  // A routine you do keeps its title, words, place and priority; its schedule takes the place of a
  // date, a star, a status and the Inbox.
  if (draft.repeat !== undefined) {
    return {
      title: draft.title,
      inbox: false,
      repeat: draft.repeat,
      ...(draft.area === undefined ? {} : { area: draft.area }),
      ...(draft.project === undefined ? {} : { project: draft.project }),
      ...(draft.priority === undefined ? {} : { priority: draft.priority }),
    };
  }
  return draft;
}

/** The `#words` being typed at the caret, for the area type-ahead. */
export function groupTyped(
  text: string,
  caret: number,
): { start: number; typed: string } | undefined {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)(#[^\s#]*)$/u.exec(before);
  if (match === null) return undefined;
  const typed = match[1] ?? "";
  const after = text.slice(caret);
  if (after !== "" && !/^\s/u.test(after)) return undefined;
  return { start: caret - typed.length, typed };
}

/** Areas and projects whose `#name` starts with what is typed, areas first, at most `max`. */
export function groupSuggestions(
  typed: string,
  areas: readonly CaptureArea[],
  projects: readonly CaptureProject[],
  max = 5,
): { readonly insert: string; readonly area: CaptureArea; readonly project?: CaptureProject }[] {
  const body = typed.replace(/^#/u, "");
  const [first = "", second] = body.split("/");
  const out: { insert: string; area: CaptureArea; project?: CaptureProject }[] = [];
  const a = slugOf(first);
  if (second === undefined) {
    for (const area of areas) {
      if (slugOf(area.title).startsWith(a)) out.push({ insert: `#${slugOf(area.title)}`, area });
    }
  }
  for (const area of areas) {
    const areaSlug = slugOf(area.title);
    if (second !== undefined && areaSlug !== a) continue;
    for (const project of projects) {
      if (project.parent !== area.id) continue;
      const p = slugOf(project.title);
      const wanted = second === undefined ? p.startsWith(a) : p.startsWith(slugOf(second));
      if (wanted) out.push({ insert: `#${areaSlug}/${p}`, area, project });
    }
  }
  return out.filter((s) => s.insert !== typed.toLowerCase()).slice(0, max);
}
