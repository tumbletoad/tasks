// A task's compact row: the form the change feed carries and the page's lists draw (A5 3.6,
// 3.15), and the read of finished tasks behind the page's Completed view, which gives the same
// rows and one line of how each task ended. A column that is null in the space is left out. No
// body of a note or log entry, no context, outcome or other long text is in it: only what a row
// shows of the task's children, its first three sources and its place's state on the machine
// that serves it.
import type { Row, WorkerConnection } from "@tasks/storage";
import type { Root } from "@tasks/launch";
import { placeState } from "./here.ts";

const PREFIX_SQL = "SELECT ref_prefix FROM space WHERE one = 1";

/** A source as a task's row shows it: its kind and its own text, never a label (A5 3.6). */
export interface CompactSource {
  readonly kind: string;
  readonly title: string;
  readonly who?: string;
  /** The source's own key in its system ("LUM-212"), shown in mono. */
  readonly ref?: string;
  readonly url?: string;
}

/**
 * A task's place as its row shows it, on the machine that serves the feed: a folder here that
 * resolves now, one that does not (its folder is missing, its root is gone, another repository is
 * there), or a place only on another machine, named. A task without a place has none.
 */
export type CompactPlace =
  | { readonly state: "here" | "missing" }
  | { readonly state: "elsewhere"; readonly machine: string };

export type CompactValue = string | number | boolean | readonly CompactSource[] | CompactPlace;
export type CompactRow = Readonly<Record<string, CompactValue>>;

/** The machine the feed resolves places on: its ID, its roots as they are now, its platform. */
export interface FeedHere {
  readonly machine: string;
  readonly roots: () => readonly Root[];
  readonly platform: NodeJS.Platform;
}

/** At most this many sources ride on a task's row: the row shows three, then "+2" (A5 3.6). */
export const ROW_SOURCES = 3;

/**
 * When a finished task was finished: its completion, or for a dropped task, which keeps no
 * completion time, the commit whose write its lifecycle holds (its provenance, else its create),
 * so an undo that brings a drop back keeps the drop's own time.
 */
const FINISHED_AT =
  "COALESCE(t.completed_at, (SELECT c.at FROM commits c WHERE c.seq = " +
  "COALESCE(json_extract(t.fp, '$.lifecycle'), t.created_seq)), t.created_at)";

export const TASK_COLUMNS =
  "t.id, t.ref, t.title, t.summary, t.lifecycle, t.status, t.inbox, t.priority, t.effort, " +
  "t.due_date, t.due_at, t.due_tz, t.planned_for, t.focus_on, t.owner, t.waiting_on, t.area_id, " +
  "t.project_id, t.parent_id, t.position, t.wrap_state, t.completed_at, t.deleted_at, " +
  "t.created_at, t.version, t.touched, " +
  `CASE WHEN t.lifecycle <> 'active' THEN ${FINISHED_AT} END AS finished_at, ` +
  // When a waiting task's wait began (the Waiting view's age): the commit whose write its status
  // holds (its provenance, which an undo sets back), or its creation. Not the last write (`fv`):
  // an undo that brings a wait back would restart its age. A new person waited on is the same wait.
  "CASE WHEN t.status = 'waiting' THEN COALESCE((SELECT c.at FROM commits c WHERE c.seq = " +
  "json_extract(t.fp, '$.status') AND c.seq <> t.created_seq), t.created_at) END AS waiting_since, " +
  // What the row shows of the task's children (A5 3.6), turned into `sources`, `sources_more`
  // and `place` by `taskRows`. A `$machine` of null (no machine given) matches no place.
  "(SELECT json_group_array(json_object('p', x.position, 'kind', x.kind, 'title', x.title, " +
  "'who', x.who, 'ref', x.ref, 'key', x.source_key, 'url', x.url)) FROM (SELECT ts.position, " +
  "s.kind, s.title, s.who, s.ref, s.source_key, s.url FROM task_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.task_id = t.id " +
  `AND ts.removed_at IS NULL AND s.deleted_at IS NULL ORDER BY ts.position LIMIT ${String(ROW_SOURCES)}) x) ` +
  "AS x_sources, " +
  "(SELECT count(*) FROM task_sources ts JOIN sources s ON s.id = ts.source_id WHERE " +
  "ts.task_id = t.id AND ts.removed_at IS NULL AND s.deleted_at IS NULL) AS x_source_count, " +
  "(SELECT json_object('root', pl.root_id, 'path', pl.rel_path, 'kind', pl.kind, 'identity', " +
  "pl.identity) FROM places pl WHERE pl.owner_kind = 'task' AND pl.owner_id = t.id AND " +
  "pl.machine_id = $machine AND pl.deleted_at IS NULL) AS x_place_here, " +
  "(SELECT m.name FROM places pl JOIN machines m ON m.id = pl.machine_id WHERE " +
  "pl.owner_kind = 'task' AND pl.owner_id = t.id AND pl.machine_id <> $machine AND " +
  "pl.deleted_at IS NULL ORDER BY pl.id LIMIT 1) AS x_place_elsewhere";

/** A row without its nulls, booleans as booleans. */
export function compact(row: Row, booleans: readonly string[] = []): CompactRow {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (booleans.includes(name)) out[name] = value === 1 || value === true;
    else if (typeof value === "string" || typeof value === "number") out[name] = value;
    else if (typeof value === "bigint") out[name] = Number(value);
  }
  return out;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** The kinds whose key names the item in its own system, shown before the title: LUM-212. */
const KEYED_KINDS: ReadonlySet<string> = new Set(["ticket", "issue", "pr"]);

/**
 * A ticket's, issue's or pull request's own key from its source key (`jira:LUM-212` gives
 * `LUM-212`), when the source records none: a short single line after the namespace, else none.
 */
function keyRef(kind: unknown, key: unknown): string | undefined {
  if (typeof kind !== "string" || !KEYED_KINDS.has(kind) || typeof key !== "string") {
    return undefined;
  }
  const at = key.indexOf(":");
  const ref = at < 0 ? "" : key.slice(at + 1);
  return ref !== "" && ref.length <= 40 && !/\s/u.test(ref) ? ref : undefined;
}

/** The row's sources from `x_sources`, in their order, each without its empty fields. */
function sourcesOf(value: unknown): CompactSource[] {
  const list = parsed(value);
  if (!Array.isArray(list)) return [];
  const sorted = list
    .filter(isPlain)
    .sort((a, b) =>
      String(a["p"]) < String(b["p"]) ? -1 : String(a["p"]) > String(b["p"]) ? 1 : 0,
    );
  const out: CompactSource[] = [];
  for (const s of sorted) {
    if (typeof s["kind"] !== "string" || typeof s["title"] !== "string") continue;
    const source: { -readonly [K in keyof CompactSource]: CompactSource[K] } = {
      kind: s["kind"],
      title: s["title"],
    };
    for (const key of ["who", "ref", "url"] as const) {
      const v = s[key];
      if (typeof v === "string" && v !== "") source[key] = v;
    }
    const ref = source.ref ?? keyRef(s["kind"], s["key"]);
    if (ref !== undefined) source.ref = ref;
    out.push(source);
  }
  return out;
}

/** A place of this machine as `placeState` reads it, from `x_place_here`. */
interface HerePlace {
  readonly root: unknown;
  readonly path: unknown;
  readonly kind: unknown;
  readonly identity: unknown;
}

/**
 * The tasks' compact rows, with what each row shows of its children: its first sources, how many
 * more, and its place's state on `here`'s machine, each place resolved once now (`placeState`, the
 * rule the digest and `here` use). Without `here`, no place is resolved and none is shown.
 */
export async function taskRows(
  rows: readonly Row[],
  prefix: string,
  here?: FeedHere,
): Promise<CompactRow[]> {
  const states = new Map<string, Promise<"here" | "missing">>();
  const resolve = (place: HerePlace): Promise<"here" | "missing"> => {
    const key = JSON.stringify([place.root, place.path, place.kind, place.identity]);
    let found = states.get(key);
    if (found === undefined) {
      found =
        here === undefined
          ? Promise.resolve("missing")
          : placeState(place, here.roots(), here.platform).then(
              (state) => ("folder" in state ? "here" : "missing"),
              () => "missing",
            );
      states.set(key, found);
    }
    return found;
  };
  return Promise.all(
    rows.map(async (row) => {
      const {
        x_sources: sources,
        x_source_count: count,
        x_place_here: placeHere,
        x_place_elsewhere: elsewhere,
        x_ending: ending,
        ref,
        ...own
      } = row;
      const out: Record<string, CompactValue> = compact(
        { ...own, ref: typeof ref === "number" ? `${prefix}-${String(ref)}` : ref },
        ["inbox"],
      );
      const shown = sourcesOf(sources);
      if (shown.length > 0) out["sources"] = shown;
      const more = Number(count ?? 0) - shown.length;
      if (more > 0) out["sources_more"] = more;
      const ended = endingOf(ending);
      if (ended !== undefined) out["ending"] = ended;
      const place = parsed(placeHere);
      if (here !== undefined && isPlain(place)) {
        out["place"] = { state: await resolve(place as unknown as HerePlace) };
      } else if (here !== undefined && typeof elsewhere === "string") {
        out["place"] = { state: "elsewhere", machine: elsewhere };
      }
      return out;
    }),
  );
}

/** The `$machine` a task read binds: none without `here`, which matches no place. */
export const machineOf = (here: FeedHere | undefined): string | null => here?.machine ?? null;

/** A page of finished tasks: which of them, how many, and the last row of the page before. */
export interface FinishedRequest {
  /** Only the checked-off list (true), every other finished task (false), or all of them. */
  readonly checkedOff?: boolean | undefined;
  readonly limit: number;
  readonly after?: { readonly at: number; readonly id: string } | undefined;
}

const CHECKED_OFF = "(t.lifecycle = 'completed' AND t.wrap_state IS 'pending')";

/**
 * The text a finished task's row says it ended with: why it was dropped, else its outcome once it
 * is wrapped up. A reopen keeps the outcome as the previous result and clears the wrap state, so an
 * outcome without one is an earlier finish's, not this one's. Only its start is read: a row shows
 * one line of it.
 */
const ENDING =
  "substr(CASE WHEN t.lifecycle = 'archived' AND trim(t.archived_reason) <> '' THEN " +
  "t.archived_reason WHEN t.wrap_state = 'wrapped' THEN t.outcome END, 1, 2000)";

/** The most UTF-16 code units of an ending a row carries, its ellipsis included. */
export const ENDING_MAX = 300;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The ending's first line with text, without a Markdown heading, list or quote mark, cut to
 * `ENDING_MAX` with an ellipsis between two characters, never inside one.
 */
export function endingOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)?/u, "").trim();
    if (line === "") continue;
    if (line.length <= ENDING_MAX) return line;
    let cut = "";
    for (const { segment } of graphemes.segment(line)) {
      if (cut.length + segment.length > ENDING_MAX - 1) break;
      cut += segment;
    }
    return `${cut.trimEnd()}…`;
  }
  return undefined;
}

/**
 * Finished tasks newest first, from a key. The page's keys are chosen first and the rows built
 * only for them: a row's sources and place cost a read each, and a space finishes tasks for years.
 */
function finishedSql(request: FinishedRequest): string {
  const where = ["t.lifecycle IN ('completed', 'archived')", "t.deleted_at IS NULL"];
  if (request.checkedOff === true) where.push(CHECKED_OFF);
  if (request.checkedOff === false) where.push(`NOT ${CHECKED_OFF}`);
  const from = request.after === undefined ? "" : "WHERE k.at < $at OR (k.at = $at AND k.id < $id)";
  return (
    `SELECT ${TASK_COLUMNS}, ${ENDING} AS x_ending FROM (SELECT k.id, k.at FROM (SELECT ` +
    `t.id AS id, ${FINISHED_AT} AS at FROM tasks t WHERE ${where.join(" AND ")}) k ${from} ORDER BY k.at DESC, k.id DESC ` +
    "LIMIT $limit) p JOIN tasks t ON t.id = p.id ORDER BY p.at DESC, p.id DESC"
  );
}

/**
 * A page of the space's finished tasks (completed or dropped, not deleted), newest first by the
 * time each was finished, then by ID: up to `limit` compact rows, and whether more follow.
 */
export async function readFinished(
  reader: WorkerConnection,
  request: FinishedRequest,
  here?: FeedHere,
): Promise<{ rows: CompactRow[]; more: boolean }> {
  const [space, rows] = await reader.transaction("deferred", [
    { sql: PREFIX_SQL, mode: "get" },
    {
      sql: finishedSql(request),
      mode: "all",
      params: {
        limit: request.limit + 1,
        machine: machineOf(here),
        ...(request.after === undefined ? {} : { at: request.after.at, id: request.after.id }),
      },
    },
  ]);
  const found = rows as Row[];
  const prefix = (space as Row | null)?.["ref_prefix"];
  const page = await taskRows(
    found.slice(0, request.limit),
    typeof prefix === "string" ? prefix : "",
    here,
  );
  return { rows: page, more: found.length > request.limit };
}
