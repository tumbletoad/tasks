// `task.search` (A3 3.4.3, 3.9): a query through the space's reader, a page at a time.
//
// A first page reads the space's vocabulary, plans the query (plan.ts) and runs it in one read
// transaction at as_of S, which freezes the ordered IDs (at most SEARCH_IDS) under a cursor
// (cursors.ts). Then every page, the first included, reads its slice of that list fresh in one
// read transaction through A1's `rows_by_ids`: the header's `as_of` is that read's, the base for
// writes based on the page. A row changed after S is marked `changed`; one deleted or redacted
// since keeps its place as a placeholder with its reference and no content (A3 3.9.5). A snippet
// is always FTS5's `snippet()` over the document's current text, else the current summary, so a
// page never shows text the space no longer holds.
import { AppError, CURSOR_PATTERN, SEARCH_IDS, type SEARCH_SCOPES } from "@ttasks/contracts";
import {
  decodeRowsByIds,
  decodeSpaceRow,
  formatAsOf,
  formatRevision,
  formatTaskRef,
  HAS_SEARCH_TABLES_SQL,
  ROWS_BY_IDS_SQL,
  type FolderOs,
  type FrozenEntry,
  type Query as SqlQuery,
  type QueryResult,
  type Row,
  type SpaceRow,
  type TransactionMode,
} from "@ttasks/storage";
import { dateIn } from "../ops/dates.ts";
import { invalid } from "../ops/errors.ts";
import { keysOf, present, taskRow } from "../ops/read.ts";
import { endingOf, endingText } from "../ops/task-rows.ts";
import {
  cursorExpired,
  type FrozenItem,
  type FrozenSearch,
  type SearchCursors,
} from "./cursors.ts";
import { planSearch, type HereSets, type Scope, type SearchPlan, type Vocabulary } from "./plan.ts";
import { namesLifecycle, parseQuery, printQuery, termsOf, type Query } from "./query.ts";

/** What a search reads through: a space's reader connection (`WorkerConnection`). */
export interface SearchReader {
  transaction(mode: TransactionMode, queries: SqlQuery[]): Promise<QueryResult[]>;
}

/** A3 3.9.4's cuts. */
export const ROW_CUTS = { title: 90, snippet: 100, learning: 200 } as const;

export const DEFAULT_LIMIT = 15;

export interface SearchInput {
  readonly q?: string;
  readonly scope?: (typeof SEARCH_SCOPES)[number];
  readonly limit?: number;
  readonly cursor?: string;
  readonly cwd?: string;
}

/** Who searches, where and when. */
export interface SearchEnv {
  readonly cursors: SearchCursors;
  /** The caller's binding: a cursor serves only the binding it was issued to. */
  readonly owner: string;
  /** The space the call names: a cursor serves only its own space. */
  readonly space: string;
  readonly audience: "user" | "agent";
  readonly today: string;
  readonly now: number;
  readonly timeZone: string;
  readonly machine: string;
  readonly boundTask?: string;
  /** The tasks with a live session, for `is:bound`. */
  readonly live: () => readonly string[];
  /** What `cwd` relates to on this machine (ops/here.ts); nothing when it is no folder here. */
  readonly here: (cwd: string) => Promise<HereSets>;
  /** A folder given to `folder:` as this machine stores it (`cwd` already made the folder). */
  readonly folderOf?: (
    given: string,
  ) => { readonly stored: string; readonly os: FolderOs } | undefined;
  /** Whether this machine's update of the space failed: a refusal of words says so. */
  readonly updateFailed?: boolean;
  /** Whether the caller's face shows this page whole (Caller.shows). Absent: it shows every row. */
  readonly shows?: (page: SearchResult) => boolean;
}

/** The structured result: `TaskSearchResult`. */
export interface SearchResult {
  as_of: string;
  scope: Scope;
  parsed: string;
  total: number | "10000+";
  first: number;
  rows: Record<string, unknown>[];
  cursor?: string;
}

const SPACE: SqlQuery = { sql: "SELECT * FROM space WHERE one = 1", mode: "get" };

const HAS_FOLDERS: SqlQuery = {
  sql: "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'folders'",
  mode: "get",
};

/** The vocabulary's reads, with the folders' stamp when the space has its folders. */
const vocabulary = (folders: boolean): SqlQuery[] => [
  SPACE,
  { sql: "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.statuses'", mode: "get" },
  {
    sql: "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.effort_scale'",
    mode: "get",
  },
  {
    sql: "SELECT id, slug, title FROM areas WHERE deleted_at IS NULL ORDER BY position, id",
    mode: "all",
  },
  {
    sql: "SELECT id, slug, title FROM projects WHERE deleted_at IS NULL ORDER BY position, id",
    mode: "all",
  },
  { sql: "SELECT id, name FROM machines ORDER BY name, id", mode: "all" },
  { sql: HAS_SEARCH_TABLES_SQL, mode: "get" },
  // A stamp of every folder: a folder write makes its row the newest (its version is the commit's
  // seq), so any change to the folders, and with them to what `here` matches, changes the stamp.
  {
    sql: folders
      ? "SELECT count(*) AS n, coalesce(max(version), 0) AS v FROM folders"
      : "SELECT 0 AS n, 0 AS v",
    mode: "get",
  },
];

/**
 * Each document's snippet over its current body, with the facts that say whether it may show:
 * its task and its audience now. A document that no longer matches, or no longer exists, has none.
 * Only the body: a note's title column is its task's title, and the extra column is the index's
 * own list of sources, labels and groups, neither of which reads as where the text matched. The
 * matched words are marked, so a body without a match (the match was in the title) shows none.
 */
const SNIPPETS =
  "SELECT j.value AS doc, d.entity_id AS entity, d.task_id AS task_id, d.kind AS kind, " +
  "d.audience AS audience, " +
  "(SELECT snippet(search_fts, 1, char(2), char(3), '…', 12) FROM search_fts " +
  "WHERE search_fts MATCH $match AND search_fts.rowid = j.value) AS snippet " +
  "FROM json_each($docs) j LEFT JOIN search_docs d ON d.doc = j.value";

const MATCH_START = "\u0002";
const MATCH_END = "\u0003";
const unmarked = (text: string): string =>
  text.replaceAll(MATCH_START, "").replaceAll(MATCH_END, "");

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** One line, cut at `max` code points with an ellipsis. */
export function cut(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

/** What a search plans from: the space's values and the stamp of its folders. */
interface Known {
  space: SpaceRow;
  vocabulary: Vocabulary;
  indexed: boolean;
  folders: string;
}

function vocabularyOf(results: readonly unknown[]): Known {
  const [space, statuses, efforts, areas, projects, machines, indexed, folders] = results;
  const decoded = decodeSpaceRow(space as Row);
  const groups = (value: unknown) =>
    rows(value).map((r) => ({ id: str(r["id"]), slug: str(r["slug"]), title: str(r["title"]) }));
  return {
    space: decoded,
    indexed: (indexed as Row | null)?.["n"] === 2,
    folders: `${String((folders as Row | null)?.["n"])}:${String((folders as Row | null)?.["v"])}`,
    vocabulary: {
      refPrefix: decoded.refPrefix,
      statuses: keysOf("tasks.statuses", statuses),
      efforts: keysOf("tasks.effort_scale", efforts),
      areas: groups(areas),
      projects: groups(projects),
      machines: rows(machines).map((r) => ({ id: str(r["id"]), name: str(r["name"]) })),
    },
  };
}

/** How often a search plans again when the space's values change under it. */
const PLAN_ROUNDS = 3;

/**
 * Whether two reads would plan the same statement: the same values, and the same folders when the
 * plan holds what the caller's working folder relates to.
 */
function samePlan(a: Known, b: Known, here: boolean): boolean {
  return (
    a.indexed === b.indexed &&
    (!here || a.folders === b.folders) &&
    JSON.stringify(a.vocabulary) === JSON.stringify(b.vocabulary)
  );
}

/** The space's values kept changing between a search's reads: a retry will find them settled. */
function vocabularyChanging(): AppError {
  return new AppError({
    code: "space_unavailable",
    message: "The space's statuses, areas, projects or folders changed while searching.",
    hint: "Search again.",
    data: { reason: "busy", retryable: true },
  });
}

/** Whether planning needs what `cwd` relates to: for `on:cwd`, or for the boost of a text query. */
function needsHere(query: Query, scope: Scope): boolean {
  const terms = termsOf(query);
  return terms.some(
    (t) =>
      (t.type === "filter" && t.key === "on" && t.value.toLowerCase() === "cwd") ||
      (t.type === "text" && !t.negated && scope !== "learnings"),
  );
}

/** Runs a search, or the next page of one. Throws AppError. */
export async function runSearch(
  reader: SearchReader,
  input: SearchInput,
  env: SearchEnv,
): Promise<SearchResult> {
  if (input.cursor !== undefined) {
    if (!CURSOR_PATTERN.test(input.cursor)) {
      throw invalid("cursor", "Not a search cursor", "Pass the cursor of the last page as it is.");
    }
    const { search, offset } = env.cursors.take(input.cursor, env.owner, env.space);
    return page(reader, search, offset, env);
  }
  const query = parseQuery(input.q ?? "");
  const scope: Scope = input.scope ?? (namesLifecycle(query) ? "all" : "active");
  const cwd = input.cwd !== undefined && needsHere(query, scope) ? input.cwd : undefined;
  const live = termsOf(query).some((t) => t.type === "filter" && t.key === "is") ? env.live() : [];
  // The plan names the space's values (a status, an area's ID) and what `cwd` relates to (tasks
  // and projects by their folders), so it is made from reads before the query and checked against
  // the same reads in the query's own read transaction at S: a change between them plans again, so
  // S never mixes with an earlier state. The folders are read after the stamp they are checked by,
  // and every change to them changes the stamp. Which tasks a project holds is read at S.
  const [hasFolders] = await reader.transaction("deferred", [HAS_FOLDERS]);
  const folders = Number((hasFolders as Row | null)?.["n"] ?? 0) > 0;
  const VOCABULARY = vocabulary(folders);
  let known = vocabularyOf(await reader.transaction("deferred", [...VOCABULARY]));
  let here = cwd === undefined ? undefined : await env.here(cwd);
  let settled: { space: SpaceRow; plan: SearchPlan; ranked: unknown } | undefined;
  for (let round = 0; round < PLAN_ROUNDS && settled === undefined; round += 1) {
    const plan = planSearch(query, {
      vocabulary: known.vocabulary,
      indexed: known.indexed,
      unindexed: {
        revision: formatRevision(known.space.format),
        updateFailed: env.updateFailed === true,
      },
      scope,
      audience: env.audience,
      today: env.today,
      now: env.now,
      timeZone: env.timeZone,
      machine: env.machine,
      folders,
      ...(env.boundTask === undefined ? {} : { boundTask: env.boundTask }),
      ...(here === undefined ? {} : { here }),
      live,
      folderOf: (value) => {
        const given = value.toLowerCase() === "cwd" ? input.cwd : value;
        if (given === undefined) return "no_cwd";
        return env.folderOf?.(given) ?? "not_a_folder";
      },
    });
    const results = await reader.transaction("deferred", [
      ...VOCABULARY,
      { sql: plan.sql, params: plan.params, mode: "all" },
    ]);
    const atS = vocabularyOf(results);
    if (samePlan(atS, known, cwd !== undefined)) {
      settled = { space: atS.space, plan, ranked: results.at(-1) };
    } else {
      known = atS;
      if (cwd !== undefined) here = await env.here(cwd);
    }
  }
  if (settled === undefined) throw vocabularyChanging();
  const { space, plan } = settled;
  const found = rows(settled.ranked);
  const items: FrozenItem[] = found.slice(0, SEARCH_IDS).map((row) => ({
    id: str(row["id"]),
    ref: formatTaskRef(space.refPrefix, Number(row["ref"])),
    doc: typeof row["doc"] === "number" ? row["doc"] : null,
    entity: typeof row["entity"] === "string" ? row["entity"] : null,
  }));
  const search: FrozenSearch = {
    space: space.spaceId,
    epoch: space.authority.epoch,
    incarnation: space.authority.incarnation,
    seq: space.lastSeq,
    owner: env.owner,
    kind: plan.kind,
    scope,
    parsed: printQuery(query),
    audience: env.audience,
    match: plan.match,
    limit: input.limit ?? DEFAULT_LIMIT,
    items,
    total: found.length > SEARCH_IDS ? "10000+" : found.length,
  };
  return page(reader, search, 0, env);
}

/** One page of a frozen search, read fresh. */
async function page(
  reader: SearchReader,
  search: FrozenSearch,
  offset: number,
  env: SearchEnv,
): Promise<SearchResult> {
  const items = search.items.slice(offset, offset + search.limit);
  const ids = items.map((item) => item.id);
  const docs = items.flatMap((item) => (item.doc === null ? [] : [item.doc]));
  const queries: SqlQuery[] = [
    SPACE,
    { sql: ROWS_BY_IDS_SQL[search.kind], params: { ids: JSON.stringify(ids) }, mode: "all" },
  ];
  // A learning row shows its own text, so only task pages read snippets.
  if (search.match !== null && search.kind === "tasks" && docs.length > 0) {
    queries.push({
      sql: SNIPPETS,
      params: { match: search.match, docs: JSON.stringify(docs) },
      mode: "all",
    });
  }
  const [spaceRow, found, snippetRows] = await reader.transaction("deferred", queries);
  const space = decodeSpaceRow(spaceRow as Row);
  // Never rows from a different history (A3 3.9.5).
  const reason =
    space.spaceId !== search.space
      ? "binding"
      : space.authority.epoch !== search.epoch
        ? "epoch"
        : space.authority.incarnation !== search.incarnation
          ? "incarnation"
          : undefined;
  if (reason !== undefined) {
    env.cursors.expire(search, reason);
    throw cursorExpired(reason);
  }
  const entries = decodeRowsByIds(search.kind, ids, rows(found));
  const snippets = new Map<number, Row>(
    rows(snippetRows).map((row) => [Number(row["doc"]), row] as const),
  );
  const out = entries.map((entry, i) =>
    rowOf(entry, items[i] as FrozenItem, snippets, search, space.refPrefix, env.timeZone),
  );
  const head = {
    as_of: formatAsOf({
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      seq: space.lastSeq,
    }),
    scope: search.scope,
    parsed: search.parsed,
    total: search.total,
  };
  const pageOf = (count: number, cursor: string | undefined): SearchResult => ({
    ...head,
    first: count === 0 ? 0 : offset + 1,
    rows: out.slice(0, count),
    ...(cursor === undefined ? {} : { cursor }),
  });
  // The rows the caller's face shows whole: the next page starts at the first one it would cut.
  let keep = out.length;
  const shows = env.shows;
  if (shows !== undefined && keep > 1) {
    const fits = (count: number) =>
      shows(pageOf(count, offset + count < search.items.length ? SAMPLE_CURSOR : undefined));
    if (!fits(keep)) {
      let low = 1;
      let high = keep - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid)) low = mid;
        else high = mid - 1;
      }
      keep = low;
    }
  }
  const next = offset + keep;
  return pageOf(keep, next < search.items.length ? env.cursors.issue(search, next) : undefined);
}

/** A cursor as long as every cursor is, to measure a page before its cursor is issued. */
const SAMPLE_CURSOR = `c_${"0".repeat(16)}`;

/** A page's row for one frozen entry (A3 3.9.4). */
function rowOf(
  entry: FrozenEntry,
  item: FrozenItem,
  snippets: ReadonlyMap<number, Row>,
  search: FrozenSearch,
  prefix: string,
  timeZone: string,
): Record<string, unknown> {
  if (entry.state === "redacted") return { kind: "redacted", id: entry.id, ref: item.ref };
  if (entry.state === "deleted") {
    return { kind: "deleted", id: entry.id, ref: formatTaskRef(prefix, entry.ref) };
  }
  const row = entry.row;
  if (search.kind === "learnings") {
    // The row shows its task's title and group as well as its own text.
    const changed =
      Number(row["learning_version"]) > search.seq || Number(row["touched"]) > search.seq;
    return {
      kind: "learning",
      id: entry.id,
      task: formatTaskRef(prefix, Number(row["ref"])),
      title: cut(str(row["title"]), ROW_CUTS.title),
      date: dateIn(Number(row["learned_at"]), timeZone),
      ...present("area", row["area_title"]),
      ...present("project", row["project_title"]),
      text: cut(str(row["learning"]), ROW_CUTS.learning),
      ...(changed ? { changed: true } : {}),
    };
  }
  const base = taskRow(row, prefix);
  const snippet = item.doc === null ? undefined : snippets.get(item.doc);
  const marked = str(snippet?.["snippet"]);
  const matched =
    snippet !== undefined &&
    snippet["entity"] === item.entity &&
    snippet["task_id"] === entry.id &&
    (search.audience === "user" || snippet["audience"] === "all") &&
    marked.includes(MATCH_START);
  const ended = endingOf(endingText(row));
  const ending = ended === undefined ? {} : { ending: cut(ended, ROW_CUTS.snippet) };
  // A finished task's ending takes the summary's place, as in the Completed view; where the words
  // matched still shows.
  const shown = matched
    ? { snippet: cut(unmarked(marked), ROW_CUTS.snippet), snippet_from: snippet["kind"] }
    : str(row["summary"]) === "" || ended !== undefined
      ? {}
      : { snippet: cut(str(row["summary"]), ROW_CUTS.snippet) };
  // The day it was finished, completed or dropped, as the Completed view shows it.
  const finishedAt = row["finished_at"];
  return {
    ...base,
    kind: "task",
    title: cut(str(row["title"]), ROW_CUTS.title),
    ...(row["lifecycle"] !== "active" && typeof finishedAt === "number"
      ? { completed: dateIn(finishedAt, timeZone) }
      : {}),
    ...shown,
    ...ending,
    ...(Number(row["touched"]) > search.seq ? { changed: true } : {}),
  };
}
