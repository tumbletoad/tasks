// A query planned against a space (A3 3.9.1–3.9.3): the ranked list of at most SEARCH_IDS IDs as one
// statement, with every value bound as a parameter.
//
// Safe execution. The statement is built from this module's fragments only; every value of the
// query, of the space and of the caller is a parameter. Free text reaches FTS5 `MATCH` only as
// quoted strings with their quotes doubled and their control characters removed (an FTS5 string
// ends at a NUL), joined by this module's AND and OR, so no input is ever FTS5 syntax.
//
// - Positive words and phrases come in groups, a group's terms ORed. A task matches when each group
//   matches one of its documents (its own, a note, a log entry, a learning): the words a person
//   remembers of a task need not stand in one of its texts. A phrase is one FTS5 string, so it
//   stays within one text. A learning is one text: there the groups are ANDed in one expression.
//   The last term gets FTS5's prefix `*` when it is an unquoted word of at least two characters,
//   the shortest prefix the index keeps (`prefix = '2 3'`): a one-letter prefix would rank most of
//   the space, the broad case A1 3.12 warns about.
// - Negated words exclude every task (or learning) with a matching document: a NOT IN over its
//   own MATCH, so `-word` works alone, where FTS5's binary NOT cannot.
// - With text, a task's score is its best document's `-bm25(10, 3, 2)` (×1.2 for the task's own
//   document) times A3 3.9.3's boosts; ties go to the most recent change, then the ID. Without
//   text, the order is due date (none last), priority, most recent change, ID. `sort:effort` puts
//   the effort scale's order before either, tasks without an effort last.
// - Agents see documents with audience `all` only, in matches, negations, snippets and `has:notes`.
// - Filters are SQL over the task, each wrapped so a NULL is false and a negation is exact.
import type { FolderOs, SqlValue } from "@ttasks/storage";
import { normaliseSourceKey, separatorOf, SOURCE_KINDS } from "@ttasks/storage";
import { CLI_NAME } from "@ttasks/brand";
import { AppError, type SEARCH_SCOPES } from "@ttasks/contracts";
import { addDays } from "../ops/dates.ts";
import {
  isCalendarDate,
  queryProblem,
  RELATIVE_DAYS,
  RELATIVE_TIME,
  sortOf,
  suggest,
  termsOf,
  type FilterTerm,
  type Query,
  type TextTerm,
} from "./query.ts";

export type Scope = (typeof SEARCH_SCOPES)[number];

/** The space's own values a query may name, read in the search's first transaction. */
export interface Vocabulary {
  readonly refPrefix: string;
  readonly statuses: readonly string[];
  readonly efforts: readonly string[];
  /** The sizes tasks hold, read for an `effort:` filter: one the list lacks is found too. */
  readonly heldEfforts: readonly string[];
  readonly areas: readonly { readonly id: string; readonly slug: string; readonly title: string }[];
  readonly projects: readonly {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
  }[];
  readonly machines: readonly { readonly id: string; readonly name: string }[];
}

export interface PlanContext {
  readonly vocabulary: Vocabulary;
  /** Whether the space holds the search tables (A1 3.12). Text needs them. */
  readonly indexed: boolean;
  /** Why it does not, for the refusal of a query with words. */
  readonly unindexed?: Unindexed;
  readonly scope: Scope;
  readonly audience: "user" | "agent";
  /** Today in the space's time zone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly now: number;
  readonly timeZone: string;
  /** This machine's ID: `on:this-machine`. */
  readonly machine: string;
  /** The bound session's task: its area is boosted. */
  readonly boundTask?: string;
  /**
   * What `cwd` relates to on this machine (ops/here.ts): tasks by their own folder, projects by
   * theirs; undefined without `cwd`.
   */
  readonly here?: HereSets;
  /** The space has its folders (schema 0.5 on): without them no task opens on any machine. */
  readonly folders: boolean;
  /** How many IDs the search keeps (SearchEnv.keep): the plan reads one more, to tell there are more. */
  readonly keep: number;
  /** Tasks with a live session: `is:bound`. */
  readonly live: readonly string[];
  /**
   * A `folder:` value as this machine stores it, with its OS's case rule: `cwd` is the caller's
   * working folder. `no_cwd` without one, `not_a_folder` for a value that names no folder here.
   */
  readonly folderOf?: (
    value: string,
  ) => { readonly stored: string; readonly os: FolderOs } | "no_cwd" | "not_a_folder";
}

export interface SearchPlan {
  readonly kind: "tasks" | "learnings";
  /**
   * Rows `id`, `ref`, `doc` and `entity` (the best document's number and entity ID, or null),
   * best first, at most 1,001.
   */
  readonly sql: string;
  readonly params: Readonly<Record<string, SqlValue>>;
  /**
   * The positive text as one FTS5 expression, for the snippets of a page: for tasks, any of its
   * groups, since each may match another document; null without it.
   */
  readonly match: string | null;
}

/** Why a space has no search index: what notIndexed says. */
export interface Unindexed {
  /** The space's schema revision, `major.minor`. */
  readonly revision: string;
  /** Whether this machine tried to update the space and failed. */
  readonly updateFailed: boolean;
}

/**
 * A search's words need the search index, which a space holds from schema 0.4 on. A space this
 * build serves at an older schema is one it could not update, or one another machine writes: it
 * cannot answer words, and a retry will not help until the space is updated. Filters work.
 */
export function notIndexed(why: Unindexed): AppError {
  return new AppError({
    code: "space_unavailable",
    message: why.updateFailed
      ? `This space could not be updated from schema ${why.revision}, so it has no word ` +
        "index yet and words cannot be searched."
      : `This space is at schema ${why.revision}, from before word search, so words cannot be ` +
        "searched yet.",
    hint: why.updateFailed
      ? `Filters such as status:open work now. ${CLI_NAME} space list shows why the update ` +
        "failed and how to try it again."
      : `Filters such as status:open work now. Words work once the space is updated to this ` +
        `version: ${CLI_NAME} space list shows its state.`,
    data: { reason: "not_indexed", retryable: false },
  });
}

// ---------------------------------------------------------------------------------------------
// Text

/** One term as an FTS5 string: control characters gone, quotes doubled. */
function ftsString(term: TextTerm, prefix: boolean): string {
  const text = term.text.replace(/\p{Cc}/gu, " ");
  return `"${text.replaceAll('"', '""')}"${prefix ? "*" : ""}`;
}

/**
 * Whether `term` takes FTS5's prefix: an unquoted word whose last token, as unicode61 cuts it
 * (letters, digits and private-use characters, with nonspacing marks inside a token, which it
 * removes), keeps two characters or more. The `*` applies to that token, so `M-1` gets none.
 * Enclosing and spacing marks, symbols and emoji end a token here: the index may keep some of
 * them, which only makes its token longer than the one counted, never shorter.
 */
function prefixes(term: TextTerm): boolean {
  if (term.phrase || term.negated) return false;
  const last = term.text.match(/[\p{L}\p{N}\p{Co}\p{Mn}]+/gu)?.at(-1) ?? "";
  return (last.match(/[\p{L}\p{N}\p{Co}]/gu)?.length ?? 0) >= 2;
}

/** Each positive group as one FTS5 expression, its terms ORed. */
function positiveGroups(query: Query): string[] {
  const groups = query.groups.filter((g) => g[0]?.type === "text" && !g[0].negated);
  const terms = termsOf(query).filter((t): t is TextTerm => t.type === "text");
  const last = terms.at(-1);
  return groups.map((group) => {
    const strings = (group as TextTerm[]).map((t) => ftsString(t, t === last && prefixes(t)));
    return strings.length === 1 ? (strings[0] ?? "") : `(${strings.join(" OR ")})`;
  });
}

/** The FTS5 expression of a query's words, its groups ANDed; null for a query without words. */
export function wordsMatch(query: Query): string | null {
  const groups = positiveGroups(query);
  return groups.length === 0 ? null : groups.join(" AND ");
}

/** The FTS5 expression of a query's words, any group enough; null for a query without words. */
export function anyWordsMatch(query: Query): string | null {
  const groups = positiveGroups(query);
  return groups.length === 0 ? null : groups.join(" OR ");
}

export function negativeMatch(query: Query): string | null {
  const terms = termsOf(query).filter((t): t is TextTerm => t.type === "text" && t.negated);
  return terms.length === 0 ? null : terms.map((t) => ftsString(t, false)).join(" OR ");
}

// ---------------------------------------------------------------------------------------------
// Filters

/** Parameters, named in order, so the statement's text depends only on the query's shape. */
class Binder {
  readonly params: Record<string, SqlValue> = {};
  #n = 0;

  bind(value: SqlValue): string {
    const name = `v${String(this.#n)}`;
    this.#n += 1;
    this.params[name] = value;
    return `$${name}`;
  }

  list(values: readonly string[]): string {
    return `(SELECT value FROM json_each(${this.bind(JSON.stringify(values))}))`;
  }
}

/** What a working folder relates to on this machine: tasks by their own folder, and projects. */
export interface HereSets {
  readonly tasks: readonly string[];
  readonly projects: readonly string[];
}

/**
 * The tasks that work where `here` points: those of `here.tasks`, and those of `here.projects`
 * with no folder of their own on this machine, which open in their project's folder.
 */
function hereWhere(here: HereSets, ctx: PlanContext, b: Binder): string {
  if (!ctx.folders) return "0";
  const own =
    "EXISTS (SELECT 1 FROM folders f WHERE f.owner_kind = 'task' AND f.owner_id = t.id " +
    `AND f.machine_id = ${b.bind(ctx.machine)} AND f.deleted_at IS NULL)`;
  return (
    `(t.id IN ${b.list(here.tasks)} OR (t.project_id IN ${b.list(here.projects)} ` +
    `AND NOT ${own}))`
  );
}

/** A task's due day for sorting and `due:none`: its date, or the UTC day of a timed due. */
const DUE = "coalesce(t.due_date, date(t.due_at / 1000, 'unixepoch'))";
/** When a task last changed: the instant of the commit that last touched it. */
const UPDATED = "(SELECT k.at FROM commits k WHERE k.seq = t.touched)";
const SQL_OP: Readonly<Record<string, string>> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNIT_MS: Readonly<Record<string, number>> = { h: HOUR, d: DAY, w: 7 * DAY };

/** The UTC offset of `timeZone` at instant `ms`, in milliseconds. */
function offsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(ms / 1000) * 1000;
}

/**
 * The first instant of `date` in `timeZone`: its midnight, or where the clocks resume when a
 * change skips midnight. It is midnight at the offset of the day before or of the day after,
 * whichever is the earliest that falls on `date`.
 */
export function startOfDay(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const midnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const onDate = (ms: number) => ms + offsetMs(ms, timeZone) >= midnight;
  const starts = [-DAY, DAY]
    .map((side) => midnight - offsetMs(midnight + side, timeZone))
    .filter(onDate);
  return Math.min(...starts);
}

function lowerOf(value: string): string {
  return value.toLowerCase();
}

/**
 * The space's values a comma list names, each matched without regard to case. A stored list may
 * hold two values that differ only in case, so an exact match comes first.
 */
function namedValues(term: FilterTerm, known: readonly string[], what: string): string[] {
  const found: string[] = [];
  for (const part of term.value.split(",")) {
    const want = part.trim();
    if (want === "") continue;
    const hit = known.includes(want) ? want : known.find((k) => lowerOf(k) === lowerOf(want));
    if (hit === undefined) {
      throw queryProblem(`Unknown ${what}`, undefined, suggest(want, known));
    }
    found.push(hit);
  }
  if (found.length === 0) throw queryProblem("A filter needs a value", "Use key:value.");
  return found;
}

/** The IDs of the areas or projects a name or slug names. */
function groupIds(
  term: FilterTerm,
  rows: readonly { readonly id: string; readonly slug: string; readonly title: string }[],
  what: string,
): string[] {
  const want = lowerOf(term.value.trim());
  const ids = rows
    .filter((row) => lowerOf(row.slug) === want || lowerOf(row.title) === want)
    .map((row) => row.id);
  if (ids.length === 0) {
    throw queryProblem(
      `Unknown ${what}`,
      undefined,
      suggest(
        want,
        rows.map((row) => row.slug),
      ),
    );
  }
  return ids;
}

/** An instant comparison for `created`, `updated` and `completed`. */
function instantCondition(column: string, term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const value = lowerOf(term.value);
  const relative = RELATIVE_TIME.exec(value);
  if (relative !== null) {
    const sign = relative[1] === "-" ? -1 : 1;
    const at = ctx.now + sign * Number(relative[2]) * (UNIT_MS[relative[3] ?? "d"] ?? 0);
    const op = term.op === ":" ? ">=" : (SQL_OP[term.op] ?? ">=");
    return `${column} ${op} ${b.bind(at)}`;
  }
  const date = value === "today" ? ctx.today : value;
  if (!isCalendarDate(date)) throw queryProblem("A time is a date, today, or a relative time");
  const start = startOfDay(date, ctx.timeZone);
  const next = startOfDay(addDays(date, 1), ctx.timeZone);
  switch (term.op) {
    case ":":
      return `${column} >= ${b.bind(start)} AND ${column} < ${b.bind(next)}`;
    case "<":
      return `${column} < ${b.bind(start)}`;
    case "<=":
      return `${column} < ${b.bind(next)}`;
    case ">":
      return `${column} >= ${b.bind(next)}`;
    case ">=":
      return `${column} >= ${b.bind(start)}`;
  }
}

/**
 * A task's due compared with a day: a dated due by its date, a timed one by whether its instant
 * falls before, in or after that day in the time zone, as the page shows it.
 */
function dueAgainst(op: FilterTerm["op"], date: string, ctx: PlanContext, b: Binder): string {
  // Bound only where used: the statement names every parameter it is given.
  const start = () => b.bind(startOfDay(date, ctx.timeZone));
  const next = () => b.bind(startOfDay(addDays(date, 1), ctx.timeZone));
  const either = (dated: string, timed: () => string) =>
    `(t.due_date ${dated} ${b.bind(date)} OR (t.due_date IS NULL AND ${timed()}))`;
  switch (op) {
    case ":":
      return either("=", () => `t.due_at >= ${start()} AND t.due_at < ${next()}`);
    case "<":
      return either("<", () => `t.due_at < ${start()}`);
    case "<=":
      return either("<=", () => `t.due_at < ${next()}`);
    case ">":
      return either(">", () => `t.due_at >= ${next()}`);
    case ">=":
      return either(">=", () => `t.due_at >= ${start()}`);
  }
}

function dueCondition(term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const value = lowerOf(term.value);
  if (value === "none") return `${DUE} IS NULL`;
  if (value === "overdue")
    return `t.lifecycle = 'active' AND ${dueAgainst("<", ctx.today, ctx, b)}`;
  const relative = RELATIVE_DAYS.exec(value);
  let date: string;
  if (relative !== null) {
    const n = Number(relative[2]) * (relative[3] === "w" ? 7 : 1);
    date = addDays(ctx.today, relative[1] === "-" ? -n : n);
  } else date = value === "today" ? ctx.today : value;
  return dueAgainst(term.op, date, ctx, b);
}

const LIVE_NOTE = "n.deleted_at IS NULL";

/** ASCII letters in lower case: what SQLite's lower() folds, so both sides fold alike. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/gu, (c) => c.toLowerCase());

/**
 * `folder:<folder>`: the tasks whose folder on this machine (its own, else its project's) is that
 * folder or lies inside it, by stored text and the machine's case rule. Windows and macOS fold
 * ASCII letters only, as SQLite does.
 */
function folderCondition(term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const found = ctx.folderOf?.(term.value) ?? "not_a_folder";
  if (found === "no_cwd") {
    throw queryProblem("folder:cwd needs the working folder", "Pass cwd with the query.");
  }
  if (found === "not_a_folder") {
    throw queryProblem(
      "A folder: value is cwd, an absolute folder or one under ~",
      "Use folder:cwd or folder:~/work/portal.",
    );
  }
  if (!ctx.folders) return "0";
  const fold = found.os === "linux" ? (s: string) => s : asciiLower;
  const column = found.os === "linux" ? "f.path" : "lower(f.path)";
  const path = fold(found.stored);
  const sep = separatorOf(found.os);
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
  const machine = b.bind(ctx.machine);
  return (
    `EXISTS (SELECT 1 FROM folders f WHERE f.machine_id = ${machine} AND f.deleted_at IS NULL ` +
    "AND ((f.owner_kind = 'task' AND f.owner_id = t.id) OR (f.owner_kind = 'project' " +
    "AND f.owner_id = t.project_id AND NOT EXISTS (SELECT 1 FROM folders g WHERE " +
    `g.owner_kind = 'task' AND g.owner_id = t.id AND g.machine_id = ${machine} ` +
    `AND g.deleted_at IS NULL))) AND (${column} = ${b.bind(path)} ` +
    `OR substr(${column}, 1, ${b.bind(Array.from(prefix).length)}) = ${b.bind(prefix)}))`
  );
}

function filterCondition(term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const v = ctx.vocabulary;
  const value = lowerOf(term.value);
  switch (term.key) {
    case "status":
      return `t.status IN ${b.list(namedValues(term, v.statuses, "status"))}`;
    case "effort":
      return `t.effort IN ${b.list(namedValues(term, [...new Set([...v.efforts, ...v.heldEfforts])], "effort"))}`;
    case "area": {
      // An area includes its projects (A3 3.9.2).
      const ids = b.list(groupIds(term, v.areas, "area"));
      return (
        `(t.area_id IN ${ids} OR t.project_id IN ` +
        `(SELECT p.id FROM projects p WHERE p.area_id IN ${ids}))`
      );
    }
    case "project":
      return `t.project_id IN ${b.list(groupIds(term, v.projects, "project"))}`;
    case "p":
      return `t.priority ${term.op === ":" ? "=" : (SQL_OP[term.op] ?? "=")} ${b.bind(Number(value))}`;
    case "due":
      return dueCondition(term, ctx, b);
    case "created":
      return instantCondition("t.created_at", term, ctx, b);
    case "completed":
      return instantCondition("t.completed_at", term, ctx, b);
    case "updated":
      return instantCondition(UPDATED, term, ctx, b);
    case "is":
      switch (value) {
        case "inbox":
          return "t.inbox = 1";
        case "focus":
          // Starred for today or a day before, as the Focus view shows it (A5 3.4).
          return `t.focus_on IS NOT NULL AND t.focus_on <= ${b.bind(ctx.today)}`;
        case "overdue":
          return `t.lifecycle = 'active' AND ${dueAgainst("<", ctx.today, ctx, b)}`;
        case "completed":
          return "t.lifecycle = 'completed'";
        case "archived":
          return "t.lifecycle = 'archived'";
        case "unwrapped":
          // The wrap-up state, not the outcome: a task reopened and checked off again keeps its
          // earlier outcome while its new wrap-up waits.
          return "t.lifecycle = 'completed' AND t.wrap_state = 'pending'";
        case "proposed":
          return "EXISTS (SELECT 1 FROM proposals pr WHERE pr.task_id = t.id AND pr.state = 'pending')";
        case "bound":
          return `t.id IN ${b.list(ctx.live)}`;
        default:
          throw queryProblem("Unknown is: value");
      }
    case "has":
      switch (value) {
        case "folder":
          // Its own folder or its project's, on any machine.
          return ctx.folders
            ? "(EXISTS (SELECT 1 FROM folders f WHERE f.owner_kind = 'task' AND f.owner_id = t.id " +
                "AND f.deleted_at IS NULL) OR EXISTS (SELECT 1 FROM folders f WHERE " +
                "f.owner_kind = 'project' AND f.owner_id = t.project_id AND f.deleted_at IS NULL))"
            : "0";
        case "place":
          return (
            "EXISTS (SELECT 1 FROM places pl WHERE pl.owner_kind = 'task' AND pl.owner_id = t.id " +
            "AND pl.deleted_at IS NULL)"
          );
        case "sources":
          return (
            "EXISTS (SELECT 1 FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
            "WHERE ts.task_id = t.id AND ts.removed_at IS NULL AND s.deleted_at IS NULL)"
          );
        case "learnings":
          return "EXISTS (SELECT 1 FROM learnings lr WHERE lr.task_id = t.id AND lr.deleted_at IS NULL)";
        case "notes":
          return (
            `EXISTS (SELECT 1 FROM notes n WHERE n.task_id = t.id AND ${LIVE_NOTE}` +
            `${ctx.audience === "agent" ? " AND n.audience = 'all'" : ""})`
          );
        case "questions":
          return (
            "EXISTS (SELECT 1 FROM log_entries le WHERE le.task_id = t.id " +
            "AND le.kind = 'question' AND le.deleted_at IS NULL)"
          );
        default:
          throw queryProblem("Unknown has: value");
      }
    case "source": {
      const linked =
        "EXISTS (SELECT 1 FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
        "WHERE ts.task_id = t.id AND ts.removed_at IS NULL AND s.deleted_at IS NULL AND ";
      if ((SOURCE_KINDS as readonly string[]).includes(value)) {
        return `${linked}s.kind = ${b.bind(value)})`;
      }
      const key = term.value.includes(":") ? normaliseSourceKey(term.value) : undefined;
      if (key === undefined) {
        throw queryProblem(
          "A source: value is a kind such as ticket, or a full key such as jira:LUM-212",
          undefined,
          suggest(value, SOURCE_KINDS),
        );
      }
      return `${linked}s.source_key = ${b.bind(key)})`;
    }
    case "by": {
      const creator = "EXISTS (SELECT 1 FROM actors x WHERE x.id = t.created_by AND ";
      if (value === "user") return `${creator}x.kind = 'human')`;
      if (value === "agent") return `${creator}x.kind IN ('agent', 'routine'))`;
      // agent:<instance>: an actor of that instance, unbound or in one of its sessions (A3 3.7.4).
      const label = `agent:${term.value.slice("agent:".length)}`;
      return (
        `${creator}x.kind IN ('agent', 'routine') AND (x.label = ${b.bind(label)} ` +
        `OR substr(x.label, 1, ${b.bind(Array.from(label).length + 1)}) = ${b.bind(`${label}:`)}))`
      );
    }
    case "on": {
      if (value === "cwd") {
        if (ctx.here === undefined) {
          throw queryProblem("on:cwd needs the working folder", "Pass cwd with the query.");
        }
        return hereWhere(ctx.here, ctx, b);
      }
      // A task works on a machine where it or its project has a folder.
      const placed = (machines: string): string =>
        ctx.folders
          ? `EXISTS (SELECT 1 FROM folders f WHERE f.deleted_at IS NULL AND f.machine_id IN ${machines} ` +
            "AND ((f.owner_kind = 'task' AND f.owner_id = t.id) OR (f.owner_kind = 'project' " +
            "AND f.owner_id = t.project_id)))"
          : "0";
      if (value === "this-machine") return placed(b.list([ctx.machine]));
      const machines = v.machines.filter((m) => lowerOf(m.name) === value).map((m) => m.id);
      if (machines.length === 0) {
        throw queryProblem(
          "Unknown machine",
          "Use on:this-machine, on:cwd or a machine's name.",
          suggest(
            value,
            v.machines.map((m) => m.name),
          ),
        );
      }
      return placed(b.list(machines));
    }
    case "folder":
      return folderCondition(term, ctx, b);
    case "sort":
      // An order, not a filter (effortOrder).
      return "1";
    case "id": {
      if (term.value.startsWith("t_")) return `t.id = ${b.bind(term.value)}`;
      const [prefix = "", number = "0"] = term.value.toUpperCase().split("-");
      // Another space's prefix is never a task here (A1 3.3); an old prefix of this one is.
      return (
        `t.ref = ${b.bind(Number(number))} AND (${b.bind(prefix)} = ${b.bind(v.refPrefix)} ` +
        "OR EXISTS (SELECT 1 FROM aliases al WHERE al.namespace = 'ref_prefix' " +
        `AND al.alias = ${b.bind(prefix)}))`
      );
    }
  }
}

/** Every filter group as one condition: a NULL is false, so a negation is exact. */
function filterWhere(query: Query, ctx: PlanContext, b: Binder): string[] {
  const out: string[] = [];
  for (const group of query.groups) {
    if (group[0]?.type !== "filter") continue;
    const parts = (group as FilterTerm[]).map((term) => {
      const condition = `coalesce((${filterCondition(term, ctx, b)}), 0)`;
      return term.negated ? `NOT ${condition}` : condition;
    });
    out.push(parts.length === 1 ? (parts[0] ?? "1") : `(${parts.join(" OR ")})`);
  }
  return out;
}

/**
 * The ORDER BY terms `sort:` puts first: the task's place in the space's effort scale, smallest
 * first or largest first, a task without an effort, or with one the scale no longer has, last.
 */
function effortOrder(query: Query, ctx: PlanContext, b: Binder): string {
  const sort = sortOf(query);
  if (sort === undefined) return "";
  const rank = `(SELECT e.key FROM json_each(${b.bind(JSON.stringify(ctx.vocabulary.efforts))}) e WHERE e.value = t.effort)`;
  return `${rank} IS NULL, ${rank}${sort === "-effort" ? " DESC" : ""}, `;
}

// ---------------------------------------------------------------------------------------------
// The statement

const LIFECYCLES: Readonly<Record<Scope, string | null>> = {
  active: "('active')",
  finished: "('completed', 'archived')",
  all: null,
  learnings: null,
  library: null,
};

/** The documents of a task's own text: its document, notes, log entries and learnings. */
const TASK_TEXT = "('task', 'note', 'log', 'learning')";
const BM25 = "-bm25(search_fts, 10.0, 3.0, 2.0)";

/** Plans `query` as the ranked list of the search's first page (A3 3.9.3). */
export function planSearch(query: Query, ctx: PlanContext): SearchPlan {
  const b = new Binder();
  const groups = positiveGroups(query);
  const negative = negativeMatch(query);
  if ((groups.length > 0 || negative !== null) && !ctx.indexed) {
    throw notIndexed(ctx.unindexed ?? { revision: "?", updateFailed: false });
  }
  const audience = ctx.audience === "agent" ? " AND d.audience = 'all'" : "";
  const where = ["t.deleted_at IS NULL", ...filterWhere(query, ctx, b)];
  const lifecycles = LIFECYCLES[ctx.scope];
  const order = effortOrder(query, ctx, b);
  const limit = b.bind(ctx.keep + 1);

  if (ctx.scope === "learnings") {
    const match = groups.length === 0 ? null : groups.join(" AND ");
    where.push("l.deleted_at IS NULL");
    if (negative !== null) {
      where.push(
        "l.id NOT IN (SELECT d.entity_id FROM search_fts JOIN search_docs d " +
          `ON d.doc = search_fts.rowid WHERE search_fts MATCH ${b.bind(negative)} ` +
          `AND d.kind = 'learning'${audience})`,
      );
    }
    const sql =
      match === null
        ? "SELECT l.id AS id, t.ref AS ref, NULL AS doc, NULL AS entity FROM learnings l " +
          `JOIN tasks t ON t.id = l.task_id WHERE ${where.join(" AND ")} ` +
          `ORDER BY ${order}l.created_at DESC, l.id LIMIT ${limit}`
        : `SELECT l.id AS id, t.ref AS ref, d.doc AS doc, d.entity_id AS entity, ${BM25} AS score ` +
          "FROM search_fts JOIN search_docs d ON d.doc = search_fts.rowid " +
          "JOIN learnings l ON l.id = d.entity_id JOIN tasks t ON t.id = l.task_id " +
          `WHERE search_fts MATCH ${b.bind(match)} AND d.kind = 'learning'${audience} AND ` +
          `${where.join(" AND ")} ORDER BY ${order}score DESC, l.created_at DESC, l.id LIMIT ${limit}`;
    return { kind: "learnings", sql, params: b.params, match };
  }

  if (negative !== null) {
    where.push(
      "t.id NOT IN (SELECT d.task_id FROM search_fts JOIN search_docs d " +
        `ON d.doc = search_fts.rowid WHERE search_fts MATCH ${b.bind(negative)} ` +
        `AND d.kind IN ${TASK_TEXT}${audience})`,
    );
  }
  if (groups.length === 0) {
    if (lifecycles !== null) where.push(`t.lifecycle IN ${lifecycles}`);
    const sql =
      "SELECT t.id AS id, t.ref AS ref, NULL AS doc, NULL AS entity FROM tasks t " +
      `WHERE ${where.join(" AND ")} ` +
      // Tasks one commit touched stay in the order they were made, not by their random IDs.
      `ORDER BY ${order}${DUE} IS NULL, ${DUE}, t.priority, t.touched DESC, t.ref LIMIT ${limit}`;
    return { kind: "tasks", sql, params: b.params, match: null };
  }

  // A3 3.9.3's boosts. A change in the last 7 days: commit instants never go back (A1 3.9), so
  // the newest commit before the cutoff splits the history once for every candidate.
  const boosts = [
    "CASE WHEN t.lifecycle = 'active' THEN 1.5 ELSE 1.0 END",
    `CASE WHEN t.focus_on IS NOT NULL AND t.focus_on <= ${b.bind(ctx.today)} THEN 1.2 ELSE 1.0 END`,
    "CASE WHEN t.touched > coalesce((SELECT k.seq FROM commits k WHERE k.at < " +
      `${b.bind(ctx.now - 7 * 24 * HOUR)} ORDER BY k.seq DESC LIMIT 1), 0) THEN 1.1 ELSE 1.0 END`,
  ];
  if (ctx.here !== undefined && (ctx.here.tasks.length > 0 || ctx.here.projects.length > 0)) {
    boosts.push(`CASE WHEN ${hereWhere(ctx.here, ctx, b)} THEN 1.3 ELSE 1.0 END`);
  }
  if (ctx.boundTask !== undefined) {
    boosts.push(
      "CASE WHEN t.area_id IS NOT NULL AND t.area_id IS (SELECT bt.area_id FROM tasks bt " +
        `WHERE bt.id = ${b.bind(ctx.boundTask)}) THEN 1.2 ELSE 1.0 END`,
    );
  }
  const scoped = lifecycles === null ? "" : ` AND d.lifecycle IN ${lifecycles}`;
  const match = groups.join(" OR ");
  // With two groups or more, only the tasks where each group matches a document of their own.
  const everyGroup =
    groups.length < 2
      ? ""
      : groups
          .map(
            (group) =>
              " AND d.task_id IN (SELECT g.task_id FROM search_fts JOIN search_docs g " +
              `ON g.doc = search_fts.rowid WHERE search_fts MATCH ${b.bind(group)} ` +
              `AND g.kind IN ${TASK_TEXT}${ctx.audience === "agent" ? " AND g.audience = 'all'" : ""})`,
          )
          .join("");
  // bm25() runs only in the FTS query itself, never inside an aggregate or a window, so each
  // matching document's score is materialized first. A task's best document is then the first by
  // score and, among equal scores, by entity ID: neither the order of writing nor a rebuild's
  // document numbers decide which document gives the snippet.
  const sql =
    "WITH scored AS MATERIALIZED (SELECT d.task_id AS task_id, d.doc AS doc, " +
    `d.entity_id AS entity, ${BM25} * CASE WHEN d.kind = 'task' THEN 1.2 ELSE 1.0 END AS score ` +
    "FROM search_fts JOIN search_docs d ON d.doc = search_fts.rowid " +
    `WHERE search_fts MATCH ${b.bind(match)} AND d.kind IN ${TASK_TEXT}${audience}${scoped}${everyGroup}), ` +
    "ranked AS (SELECT task_id, doc, entity, score, row_number() OVER " +
    "(PARTITION BY task_id ORDER BY score DESC, entity) AS n FROM scored), " +
    "hit AS (SELECT task_id, doc, entity, score FROM ranked WHERE n = 1) " +
    "SELECT t.id AS id, t.ref AS ref, hit.doc AS doc, hit.entity AS entity, " +
    `hit.score * ${boosts.join(" * ")} AS score ` +
    `FROM hit JOIN tasks t ON t.id = hit.task_id WHERE ${where.join(" AND ")} ` +
    `ORDER BY ${order}score DESC, t.touched DESC, t.ref LIMIT ${limit}`;
  return { kind: "tasks", sql, params: b.params, match };
}
