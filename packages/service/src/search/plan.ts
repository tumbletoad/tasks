// A query planned against a space (A3 3.9.1–3.9.3): the ranked list of at most 1,000 IDs as one
// statement, with every value bound as a parameter.
//
// Safe execution. The statement is built from this module's fragments only; every value of the
// query, of the space and of the caller is a parameter. Free text reaches FTS5 `MATCH` only as
// quoted strings with their quotes doubled and their control characters removed (an FTS5 string
// ends at a NUL), joined by this module's AND and OR, so no input is ever FTS5 syntax.
//
// - Positive words and phrases are one MATCH expression: groups ANDed, a group's terms ORed. The
//   last term gets FTS5's prefix `*` when it is an unquoted word of at least two characters, the
//   shortest prefix the index keeps (`prefix = '2 3'`): a one-letter prefix would rank most of the
//   space, the broad case A1 3.12 warns about.
// - Negated words exclude every task (or learning) with a matching document: a NOT IN over its
//   own MATCH, so `-word` works alone, where FTS5's binary NOT cannot.
// - With text, a task's score is its best document's `-bm25(10, 3, 2)` (×1.2 for the task's own
//   document) times A3 3.9.3's boosts; ties go to the most recent change, then the ID. Without
//   text, the order is due date (none last), priority, most recent change, ID.
// - Agents see documents with audience `all` only, in matches, negations, snippets and `has:notes`.
// - Filters are SQL over the task, each wrapped so a NULL is false and a negation is exact.
import type { SqlValue } from "@tasks/storage";
import { normaliseSourceKey, SOURCE_KINDS } from "@tasks/storage";
import { AppError, type SEARCH_SCOPES } from "@tasks/contracts";
import { addDays } from "../ops/dates.ts";
import {
  isCalendarDate,
  queryProblem,
  RELATIVE_DAYS,
  RELATIVE_TIME,
  suggest,
  termsOf,
  type FilterTerm,
  type Query,
  type TextTerm,
} from "./query.ts";

export type Scope = (typeof SEARCH_SCOPES)[number];

/** The most IDs a search freezes (A3 3.9.5); one more is read to tell `1000+`. */
export const SEARCH_IDS = 1000;

/** The space's own values a query may name, read in the search's first transaction. */
export interface Vocabulary {
  readonly refPrefix: string;
  readonly statuses: readonly string[];
  readonly efforts: readonly string[];
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
  /** Tasks whose place here matches `cwd`; undefined without `cwd`. */
  readonly here?: readonly string[];
  /** Tasks with a live session: `is:bound`. */
  readonly live: readonly string[];
}

export interface SearchPlan {
  readonly kind: "tasks" | "learnings";
  /**
   * Rows `id`, `ref`, `doc` and `entity` (the best document's number and entity ID, or null),
   * best first, at most 1,001.
   */
  readonly sql: string;
  readonly params: Readonly<Record<string, SqlValue>>;
  /** The positive text as one FTS5 expression, for the snippets of a page; null without it. */
  readonly match: string | null;
}

/**
 * A search's words need the search tables, which this space's schema does not hold yet (A1 3.12):
 * the space cannot answer this query, and a retry will not help. A query of filters works.
 */
export function notIndexed(): AppError {
  return new AppError({
    code: "space_unavailable",
    message: "This space has no search index yet, so words cannot be searched.",
    hint: "Filters such as status:open work now. The index arrives with a later update.",
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
 * (letters, digits and private-use characters, with marks inside a token), keeps two characters
 * or more. The `*` applies to that token, so `M-1` gets none.
 */
function prefixes(term: TextTerm): boolean {
  if (term.phrase || term.negated) return false;
  const last = term.text.match(/[\p{L}\p{N}\p{Co}\p{M}]+/gu)?.at(-1) ?? "";
  return (last.match(/[\p{L}\p{N}\p{Co}]/gu)?.length ?? 0) >= 2;
}

function positiveMatch(query: Query): string | null {
  const groups = query.groups.filter((g) => g[0]?.type === "text" && !g[0].negated);
  if (groups.length === 0) return null;
  const terms = termsOf(query).filter((t): t is TextTerm => t.type === "text");
  const last = terms.at(-1);
  const parts = groups.map((group) => {
    const strings = (group as TextTerm[]).map((t) => ftsString(t, t === last && prefixes(t)));
    return strings.length === 1 ? (strings[0] ?? "") : `(${strings.join(" OR ")})`;
  });
  return parts.join(" AND ");
}

function negativeMatch(query: Query): string | null {
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

/** A task's due day: its date, or the UTC day of a timed due (M8's reminders bring zones). */
const DUE = "coalesce(t.due_date, date(t.due_at / 1000, 'unixepoch'))";
/** When a task last changed: the instant of the commit that last touched it. */
const UPDATED = "(SELECT k.at FROM commits k WHERE k.seq = t.touched)";
const SQL_OP: Readonly<Record<string, string>> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=" };

const HOUR = 3_600_000;
const UNIT_MS: Readonly<Record<string, number>> = { h: HOUR, d: 24 * HOUR, w: 7 * 24 * HOUR };

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

/** The first instant of `date` in `timeZone`. */
export function startOfDay(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const midnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const first = midnight - offsetMs(midnight, timeZone);
  return midnight - offsetMs(first, timeZone);
}

function lowerOf(value: string): string {
  return value.toLowerCase();
}

/** The space's values a comma list names, each matched without regard to case. */
function namedValues(term: FilterTerm, known: readonly string[], what: string): string[] {
  const found: string[] = [];
  for (const part of term.value.split(",")) {
    const want = part.trim();
    if (want === "") continue;
    const hit = known.find((k) => lowerOf(k) === lowerOf(want));
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

function dueCondition(term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const value = lowerOf(term.value);
  if (value === "none") return `${DUE} IS NULL`;
  if (value === "overdue") return `t.lifecycle = 'active' AND ${DUE} < ${b.bind(ctx.today)}`;
  const relative = RELATIVE_DAYS.exec(value);
  let date: string;
  if (relative !== null) {
    const n = Number(relative[2]) * (relative[3] === "w" ? 7 : 1);
    date = addDays(ctx.today, relative[1] === "-" ? -n : n);
  } else date = value === "today" ? ctx.today : value;
  if (term.op === ":") return `${DUE} = ${b.bind(date)}`;
  return `${DUE} IS NOT NULL AND ${DUE} ${SQL_OP[term.op] ?? "="} ${b.bind(date)}`;
}

const LIVE_NOTE = "n.deleted_at IS NULL";

function filterCondition(term: FilterTerm, ctx: PlanContext, b: Binder): string {
  const v = ctx.vocabulary;
  const value = lowerOf(term.value);
  switch (term.key) {
    case "status":
      return `t.status IN ${b.list(namedValues(term, v.statuses, "status"))}`;
    case "effort":
      return `t.effort IN ${b.list(namedValues(term, v.efforts, "effort"))}`;
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
          return `t.lifecycle = 'active' AND ${DUE} < ${b.bind(ctx.today)}`;
        case "completed":
          return "t.lifecycle = 'completed'";
        case "archived":
          return "t.lifecycle = 'archived'";
        case "unwrapped":
          return "t.lifecycle = 'completed' AND coalesce(t.outcome, '') = ''";
        case "proposed":
          return "EXISTS (SELECT 1 FROM proposals pr WHERE pr.task_id = t.id AND pr.state = 'pending')";
        case "bound":
          return `t.id IN ${b.list(ctx.live)}`;
        default:
          throw queryProblem("Unknown is: value");
      }
    case "has":
      switch (value) {
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
      const placed =
        "EXISTS (SELECT 1 FROM places pl WHERE pl.owner_kind = 'task' AND pl.owner_id = t.id " +
        "AND pl.deleted_at IS NULL AND pl.machine_id ";
      if (value === "cwd") {
        if (ctx.here === undefined) {
          throw queryProblem("on:cwd needs the working folder", "Pass cwd with the query.");
        }
        return `t.id IN ${b.list(ctx.here)}`;
      }
      if (value === "this-machine") return `${placed}= ${b.bind(ctx.machine)})`;
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
      return `${placed}IN ${b.list(machines)})`;
    }
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

// ---------------------------------------------------------------------------------------------
// The statement

const LIFECYCLES: Readonly<Record<Scope, string | null>> = {
  active: "('active')",
  finished: "('completed', 'archived')",
  all: null,
  learnings: null,
};

/** The documents of a task's own text: its document, notes, log entries and learnings. */
const TASK_TEXT = "('task', 'note', 'log', 'learning')";
const BM25 = "-bm25(search_fts, 10.0, 3.0, 2.0)";

/** Plans `query` as the ranked list of the search's first page (A3 3.9.3). */
export function planSearch(query: Query, ctx: PlanContext): SearchPlan {
  const b = new Binder();
  const match = positiveMatch(query);
  const negative = negativeMatch(query);
  if ((match !== null || negative !== null) && !ctx.indexed) throw notIndexed();
  const audience = ctx.audience === "agent" ? " AND d.audience = 'all'" : "";
  const where = ["t.deleted_at IS NULL", ...filterWhere(query, ctx, b)];
  const lifecycles = LIFECYCLES[ctx.scope];
  const limit = b.bind(SEARCH_IDS + 1);

  if (ctx.scope === "learnings") {
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
          `ORDER BY l.created_at DESC, l.id LIMIT ${limit}`
        : `SELECT l.id AS id, t.ref AS ref, d.doc AS doc, d.entity_id AS entity, ${BM25} AS score ` +
          "FROM search_fts JOIN search_docs d ON d.doc = search_fts.rowid " +
          "JOIN learnings l ON l.id = d.entity_id JOIN tasks t ON t.id = l.task_id " +
          `WHERE search_fts MATCH ${b.bind(match)} AND d.kind = 'learning'${audience} AND ` +
          `${where.join(" AND ")} ORDER BY score DESC, l.created_at DESC, l.id LIMIT ${limit}`;
    return { kind: "learnings", sql, params: b.params, match };
  }

  if (negative !== null) {
    where.push(
      "t.id NOT IN (SELECT d.task_id FROM search_fts JOIN search_docs d " +
        `ON d.doc = search_fts.rowid WHERE search_fts MATCH ${b.bind(negative)} ` +
        `AND d.kind IN ${TASK_TEXT}${audience})`,
    );
  }
  if (match === null) {
    if (lifecycles !== null) where.push(`t.lifecycle IN ${lifecycles}`);
    const sql =
      "SELECT t.id AS id, t.ref AS ref, NULL AS doc, NULL AS entity FROM tasks t " +
      `WHERE ${where.join(" AND ")} ` +
      `ORDER BY ${DUE} IS NULL, ${DUE}, t.priority, t.touched DESC, t.id LIMIT ${limit}`;
    return { kind: "tasks", sql, params: b.params, match };
  }

  // A3 3.9.3's boosts. A change in the last 7 days: commit instants never go back (A1 3.9), so
  // the newest commit before the cutoff splits the history once for every candidate.
  const boosts = [
    "CASE WHEN t.lifecycle = 'active' THEN 1.5 ELSE 1.0 END",
    `CASE WHEN t.focus_on IS NOT NULL AND t.focus_on <= ${b.bind(ctx.today)} THEN 1.2 ELSE 1.0 END`,
    "CASE WHEN t.touched > coalesce((SELECT k.seq FROM commits k WHERE k.at < " +
      `${b.bind(ctx.now - 7 * 24 * HOUR)} ORDER BY k.seq DESC LIMIT 1), 0) THEN 1.1 ELSE 1.0 END`,
  ];
  if (ctx.here !== undefined && ctx.here.length > 0) {
    boosts.push(`CASE WHEN t.id IN ${b.list(ctx.here)} THEN 1.3 ELSE 1.0 END`);
  }
  if (ctx.boundTask !== undefined) {
    boosts.push(
      "CASE WHEN t.area_id IS NOT NULL AND t.area_id IS (SELECT bt.area_id FROM tasks bt " +
        `WHERE bt.id = ${b.bind(ctx.boundTask)}) THEN 1.2 ELSE 1.0 END`,
    );
  }
  const scoped = lifecycles === null ? "" : ` AND d.lifecycle IN ${lifecycles}`;
  // bm25() runs only in the FTS query itself, never inside an aggregate or a window, so each
  // matching document's score is materialized first. A task's best document is then the first by
  // score and, among equal scores, by entity ID: neither the order of writing nor a rebuild's
  // document numbers decide which document gives the snippet.
  const sql =
    "WITH scored AS MATERIALIZED (SELECT d.task_id AS task_id, d.doc AS doc, " +
    `d.entity_id AS entity, ${BM25} * CASE WHEN d.kind = 'task' THEN 1.2 ELSE 1.0 END AS score ` +
    "FROM search_fts JOIN search_docs d ON d.doc = search_fts.rowid " +
    `WHERE search_fts MATCH ${b.bind(match)} AND d.kind IN ${TASK_TEXT}${audience}${scoped}), ` +
    "ranked AS (SELECT task_id, doc, entity, score, row_number() OVER " +
    "(PARTITION BY task_id ORDER BY score DESC, entity) AS n FROM scored), " +
    "hit AS (SELECT task_id, doc, entity, score FROM ranked WHERE n = 1) " +
    "SELECT t.id AS id, t.ref AS ref, hit.doc AS doc, hit.entity AS entity, " +
    `hit.score * ${boosts.join(" * ")} AS score ` +
    `FROM hit JOIN tasks t ON t.id = hit.task_id WHERE ${where.join(" AND ")} ` +
    `ORDER BY score DESC, t.touched DESC, t.id LIMIT ${limit}`;
  return { kind: "tasks", sql, params: b.params, match };
}
