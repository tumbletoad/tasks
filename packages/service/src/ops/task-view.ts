// `get_task`'s two views (A3 3.4.4, 3.9.6): the digest v0, bounded by A3's limits per part, and a
// page of the sections asked for (pages.ts). Both are built by the request path from one snapshot,
// so every face returns the same result; MCP's text is its rendering (mcp/render.ts).
import type { Row } from "@tasks/storage";
import { invalid } from "./errors.ts";
import type { PlaceState } from "./here.ts";
import {
  buildPage,
  parseToken,
  SECTION_ORDER,
  type PageItem,
  type Placed,
  type Section,
  type SectionInput,
  type Token,
} from "./pages.ts";
import {
  historyOf,
  logOf,
  noteOf,
  ordinalOf,
  present,
  sourceOf,
  taskRow,
  text,
  type EntryRange,
  type TaskRead,
} from "./read.ts";

/** A3 3.9.6's limits of the digest, per part. */
export const DIGEST_LIMITS = {
  title: 200,
  summary: 240,
  /** Notes the user addressed to agents: at most 5, each whole up to 1,000 characters. */
  instructions: 5,
  instructionChars: 1_000,
  notes: 3,
  noteChars: 240,
  context: 800,
  log: 3,
  logChars: 240,
  sources: 5,
  sourceTitle: 100,
  /** Not in A3's table: the agent's limit of an outcome (A3 3.4.8). */
  outcome: 600,
} as const;

/** `text` cut to `max` code points, with how many were left out. */
function clipped(value: string, max: number): { text: string; cut?: number } {
  const chars = Array.from(value);
  if (chars.length <= max) return { text: value };
  return { text: chars.slice(0, max).join(""), cut: chars.length - max };
}

/** What the digest reads of the lists: A3 3.9.6's newest few. */
export const DIGEST_RANGES: {
  readonly instructions: EntryRange;
  readonly notes: EntryRange;
  readonly log: EntryRange;
} = {
  instructions: { upto: null, limit: DIGEST_LIMITS.instructions },
  notes: { upto: null, limit: DIGEST_LIMITS.notes },
  log: { upto: null, limit: DIGEST_LIMITS.log },
};

export type { PlaceState };

/** The digest of A3 3.9.6, v0. `place` is the task's place resolved now, when it has one here. */
export function digestOf(
  read: TaskRead,
  today: string,
  place: PlaceState | undefined,
): Record<string, unknown> {
  const { row, counts } = read;
  const cut: Record<string, number> = {};
  const field = (name: string, value: string, max: number): string => {
    const c = clipped(value, max);
    if (c.cut !== undefined) cut[name] = c.cut;
    return c.text;
  };
  // Newest first, each whole, at most five: the digest stops at the first longer one (A3 3.9.6).
  const instructions: Row[] = [];
  for (const note of read.instructions) {
    if (Array.from(text(note["body"])).length > DIGEST_LIMITS.instructionChars) break;
    instructions.push(note);
  }
  const item = <T extends { text: string }>(value: T, max: number): T & { cut?: number } => {
    const c = clipped(value.text, max);
    return { ...value, text: c.text, ...(c.cut === undefined ? {} : { cut: c.cut }) };
  };
  const sources = read.sources.slice(0, DIGEST_LIMITS.sources).map((source) => {
    const value = sourceOf(source);
    const c = clipped(value.title, DIGEST_LIMITS.sourceTitle);
    return { ...value, title: c.text, ...(c.cut === undefined ? {} : { cut: c.cut }) };
  });
  const outcome = text(row["outcome"]);
  const result: Record<string, unknown> = {
    ...taskRow(row, read.space.refPrefix),
    title: field("title", text(row["title"]), DIGEST_LIMITS.title),
    summary: field("summary", text(row["summary"]), DIGEST_LIMITS.summary),
    context: field("context", text(row["context"]), DIGEST_LIMITS.context),
    ...present("waiting_on", row["waiting_on"]),
    focus: row["focus_on"] === today,
    ...(read.place === undefined
      ? {}
      : {
          place: {
            root: text(read.place["root_id"]),
            path: text(read.place["rel_path"]),
            ...(place ?? {}),
          },
        }),
    ...present("wrap_state", row["wrap_state"]),
    ...(outcome === "" ? {} : { outcome: field("outcome", outcome, DIGEST_LIMITS.outcome) }),
    learnings: [],
    instructions: instructions.map(noteOf),
    notes: read.notes.map((note) => item(noteOf(note), DIGEST_LIMITS.noteChars)),
    log: read.log.map((entry) => item(logOf(entry), DIGEST_LIMITS.logChars)),
    sources,
    more: {
      instructions: counts.instructions - instructions.length,
      notes: counts.notes - read.notes.length,
      log: counts.log - read.log.length,
      sources: counts.sources - sources.length,
    },
    version: Number(row["version"]),
  };
  if (Object.keys(cut).length > 0) result["cut"] = cut;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Pages of a sections read

/** At most this many notes or log entries a page can hold: what the reader takes per list. */
const PAGE_ITEMS = 64;

/** The sections asked for, in the order a page shows them, and the token the page starts at. */
export interface PagePlan {
  readonly asked: readonly Section[];
  readonly token: Token | undefined;
  readonly logLimit: number;
}

/** The plan of a sections read: its sections in order and where it starts. */
export function pagePlan(sections: readonly string[], before: unknown, logLimit: number): PagePlan {
  const asked = SECTION_ORDER.filter((section) => sections.includes(section));
  const token = typeof before === "string" ? parseToken(before) : undefined;
  if (token !== undefined && !asked.includes(token.section)) {
    throw invalid(
      "before",
      "The paging token belongs to other sections",
      "Pass the sections of the read the token came from.",
    );
  }
  return { asked, token, logLimit };
}

/** Whether a page that starts at `token` shows anything of `section`. */
const reaches = (plan: PagePlan, section: Section): boolean =>
  plan.asked.includes(section) &&
  (plan.token === undefined ||
    SECTION_ORDER.indexOf(section) >= SECTION_ORDER.indexOf(plan.token.section));

/** What a page's read takes of a list: from the token in it, else the newest. */
function rangeOf(plan: PagePlan, section: Section, limit: number): EntryRange {
  if (!reaches(plan, section)) return { upto: null, limit: 0 };
  const token = plan.token;
  if (token === undefined || token.section !== section || token.kind === "start") {
    return { upto: null, limit };
  }
  return { upto: token.kind === "after" ? token.item - 1 : token.item, limit };
}

/** The ranges a page's read takes. The log takes one more than the page holds, to know of more. */
export function pageRanges(plan: PagePlan): {
  readonly instructions: EntryRange;
  readonly notes: EntryRange;
  readonly log: EntryRange;
} {
  return {
    instructions: rangeOf(plan, "instructions", PAGE_ITEMS),
    notes: rangeOf(plan, "notes", PAGE_ITEMS),
    log: rangeOf(plan, "log", Math.min(plan.logLimit, PAGE_ITEMS) + 1),
  };
}

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** A list of entries as page items, keyed by ordinal. */
function entries<T extends { author: string; text: string }>(
  rows: readonly Row[],
  shape: (row: Row) => T,
): PageItem<T>[] {
  return rows.map((row) => {
    const value = shape(row);
    return { value, key: ordinalOf(row), text: value.text, extra: bytes(value.author) };
  });
}

/** The page of a sections read from `read`, which `pageRanges(plan)` read. */
export function sectionsOf(
  read: TaskRead,
  plan: PagePlan,
): {
  sections: Record<string, unknown>;
  before?: string;
} {
  const { row } = read;
  const { token } = plan;
  const inputs: SectionInput<unknown>[] = [];
  for (const section of plan.asked) {
    if (!reaches(plan, section)) continue;
    const here = token?.section === section ? token : undefined;
    // A page that continues an item starts inside it, if that item is still the first one there.
    const offsetFor = (first: number | undefined): number | undefined =>
      here?.kind === "at" && (first === undefined || first === here.item) ? here.offset : undefined;
    const skip = here?.kind === "after" ? here.item : 0;
    const add = (items: PageItem<unknown>[], extra: Partial<SectionInput<unknown>> = {}) => {
      const offset = offsetFor(items[0]?.key);
      inputs.push({
        section,
        items,
        ...(offset === undefined ? {} : { offset }),
        ...(here === undefined ? {} : { resume: here }),
        ...extra,
      });
    };
    switch (section) {
      case "instructions":
        add(entries(read.instructions, noteOf));
        break;
      case "notes":
        add(entries(read.notes, noteOf));
        break;
      case "log":
        add(entries(read.log, logOf), { limit: plan.logLimit });
        break;
      case "context":
        add([{ value: null, key: 0, text: text(row["context"]), extra: 0 }]);
        break;
      case "outcome":
        add([
          {
            value: { ...present("wrap_state", row["wrap_state"]), learnings: [] },
            key: 0,
            text: text(row["outcome"]),
            extra: 0,
          },
        ]);
        break;
      case "sources":
        add(
          read.sources.slice(skip).map((source, i) => {
            const value = sourceOf(source);
            return {
              value,
              key: skip + i + 1,
              extra: Object.values(value).reduce((n, v) => n + bytes(v), 0),
            };
          }),
        );
        break;
      case "history":
        add(
          read.history.slice(skip).map((entry, i) => {
            const value = historyOf(entry);
            return { value, key: skip + i + 1, extra: bytes(value.actor) + bytes(value.what) };
          }),
        );
        break;
    }
  }
  const page = buildPage(inputs);
  const out: Record<string, unknown> = {};
  const withText = (placed: Placed<unknown>): Record<string, unknown> => ({
    ...(placed.value as Record<string, unknown>),
    ...(placed.text === undefined ? {} : { text: placed.text }),
    ...(placed.slice === undefined ? {} : { slice: placed.slice }),
  });
  for (const [section, placed] of page.sections) {
    switch (section) {
      case "context": {
        const [part] = placed;
        out["context"] = part?.text ?? "";
        if (part?.slice !== undefined) out["context_slice"] = part.slice;
        break;
      }
      case "outcome": {
        const [part] = placed;
        out["outcome"] = {
          ...(part?.value as Record<string, unknown>),
          ...(part?.text === undefined || (part.text === "" && part.slice === undefined)
            ? {}
            : { outcome: part.text }),
          ...(part?.slice === undefined ? {} : { slice: part.slice }),
        };
        break;
      }
      case "sources":
      case "history":
        out[section] = placed.map((p) => p.value);
        break;
      default:
        out[section] = placed.map(withText);
    }
  }
  return { sections: out, ...(page.before === undefined ? {} : { before: page.before }) };
}
