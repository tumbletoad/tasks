// The change feed (A1 3.7 "Change feed (X8)", A5 3.15), read from a space's reader connection: a
// `snapshot` of the open working set with its cursor, then `batch`es of compact events, each with
// its coverage interval `(from, through]` and the cursor `(epoch, incarnation, seq)` it brings the
// subscriber to. Every read is one deferred transaction on the reader, so a snapshot and each batch
// see one state of the space. A batch's rows are as of its `through`: a row that a later commit
// changed, or that a commit hidden from the subscriber changed in the batch, is withheld (null).
//
// - A batch accounts for every commit in its interval, whether it carries it or leaves it out for a
//   subscriber that may not see it. `visible` is that filter: in v1 every commit is visible to
//   every local subscriber, so batches are never filtered, but a hidden commit already gives an
//   empty batch that still advances coverage, and the feed sends empty batches as heartbeats.
// - The compact form: each event names its commit (`seq`, `op_id`, `request_id`, actor, kind) and
//   the entities it touched, `{type, id, task?, row, changed, created?}`. `row` is the compact row
//   of a task, area or project (the working set's kinds) and null for the rest (notes, log
//   entries, sources, links, places, launches): a client refetches the task those touch. No body
//   of a note or log entry, no context, outcome or other long text is in the feed.
// - A task's compact row also carries what its row shows of its children (A5 3.6): its first
//   three sources with their own text and URL (`sources`), how many more it has
//   (`sources_more`), and its place's state on this machine (`place`). A commit that changes a
//   source, a link or a place of a task therefore carries the task's row too, as an entity of
//   its own, so the row the client holds never shows a source or a place the space no longer has.
import type { PreferenceRead } from "@tasks/contracts";
import type { Row, WorkerConnection } from "@tasks/storage";
import type { Root } from "@tasks/launch";
import { placeState } from "../ops/here.ts";
import { PREFERENCE_ROWS, spacePreferencesOf } from "../ops/preferences.ts";

/** The applied-through cursor (A1 3.7). */
export interface Cursor {
  readonly epoch: number;
  readonly incarnation: string;
  readonly seq: number;
}

export interface SpaceHead {
  readonly id: string;
  readonly name: string;
  readonly ref_prefix: string;
  readonly cursor: Cursor;
}

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

export interface FeedEntity {
  readonly type: string;
  readonly id: string;
  readonly task?: string;
  readonly row: CompactRow | null;
  readonly changed: readonly string[];
  readonly created?: true;
}

export interface FeedEvent {
  readonly seq: number;
  readonly op_id: string;
  readonly request_id: string;
  readonly actor: { readonly kind: string; readonly label: string };
  readonly kind: string;
  readonly entities: readonly FeedEntity[];
}

export interface SnapshotMessage {
  readonly type: "snapshot";
  readonly space: { readonly id: string; readonly name: string; readonly ref_prefix: string };
  readonly cursor: Cursor;
  readonly tasks: readonly CompactRow[];
  readonly areas: readonly CompactRow[];
  readonly projects: readonly CompactRow[];
  /**
   * Every space preference and flag the registry declares, with its value as readers take it and
   * its state (A1 3.16, A5 3.15 step 1). A batch names a changed preference as an entity of type
   * `preference` without a row: the page takes a snapshot for its new value.
   */
  readonly preferences: readonly PreferenceRead[];
  /** Why a subscriber with a cursor got a snapshot instead of batches. */
  readonly reason?: "epoch" | "cursor_ahead";
}

export interface BatchMessage {
  readonly type: "batch";
  readonly space_id: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly from: number;
  readonly through: number;
  readonly events: readonly FeedEvent[];
}

/** What a commit looks like to the filter. */
export interface CommitFacts {
  readonly seq: number;
  readonly kind: string;
  readonly actor_kind: string;
  readonly origin: string;
}

/**
 * Which commits a subscriber may see. v1: every one (A1 3.7, "unfiltered in v1"). It filters
 * commits, and with them the rows a hidden commit in a batch touched. It does not filter state: a
 * snapshot, and a row that an earlier hidden commit shaped, show the space as it is. The audience
 * filter that M3.12 tests needs a row-level rule as well, applied to snapshots and rows.
 */
export type Visibility = (commit: CommitFacts) => boolean;
export const ALL_VISIBLE: Visibility = () => true;

/** A2's batch bound: at most this many commits in one batch. */
export const BATCH_COMMITS = 100;

const SPACE_SQL =
  "SELECT space_id, name, ref_prefix, authority_epoch, authority_incarnation, last_seq " +
  "FROM space WHERE one = 1";

const TASK_COLUMNS =
  "t.id, t.ref, t.title, t.summary, t.lifecycle, t.status, t.inbox, t.priority, t.effort, " +
  "t.due_date, t.due_at, t.due_tz, t.planned_for, t.focus_on, t.owner, t.waiting_on, t.area_id, " +
  "t.project_id, t.parent_id, t.position, t.wrap_state, t.completed_at, t.deleted_at, " +
  "t.created_at, t.version, t.touched, " +
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
const AREA_COLUMNS =
  "a.id, a.slug, a.title, a.position, a.color, a.lifecycle, a.deleted_at, a.version";
const PROJECT_COLUMNS =
  "p.id, p.area_id, p.slug, p.title, p.position, p.color, p.lifecycle, p.deleted_at, p.version";

const OPEN_TASKS = `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.lifecycle = 'active' AND t.deleted_at IS NULL ORDER BY t.position, t.id`;
const LIVE_AREAS = `SELECT ${AREA_COLUMNS} FROM areas a WHERE a.deleted_at IS NULL ORDER BY a.position, a.id`;
const LIVE_PROJECTS = `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.position, p.id`;

const IN_BATCH = "seq > $after AND seq <= $upto";
const COMMITS =
  "SELECT seq, id, request_id, kind, actor_kind, origin, principal_id FROM commits " +
  `WHERE ${IN_BATCH} ORDER BY seq`;
const CHANGES =
  "SELECT seq, n, entity, entity_id, task_id, action, field FROM changes " +
  `WHERE ${IN_BATCH} ORDER BY seq, n`;
const ACTORS = `SELECT id, kind, label FROM actors WHERE id IN (SELECT principal_id FROM commits WHERE ${IN_BATCH})`;
/** The entities a commit after the batch's reach touched: their rows are past its `through`. */
const LATER = "SELECT DISTINCT entity, entity_id, task_id FROM changes WHERE seq > $upto";
const touched = (entity: string) =>
  `SELECT entity_id FROM changes WHERE ${IN_BATCH} AND entity = '${entity}'`;
/** The tables whose rows a task's compact row shows (A5 3.6): a change to one carries the row. */
const ROW_CHILDREN = ["sources", "task_sources", "places"] as const;
const TASK_ROWS =
  `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id IN (${touched("tasks")}) OR t.id IN ` +
  `(SELECT task_id FROM changes WHERE ${IN_BATCH} AND task_id IS NOT NULL AND entity IN ` +
  `(${ROW_CHILDREN.map((c) => `'${c}'`).join(", ")}))`;
const AREA_ROWS = `SELECT ${AREA_COLUMNS} FROM areas a WHERE a.id IN (${touched("areas")})`;
const PROJECT_ROWS = `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id IN (${touched("projects")})`;

/** The words entities are named by in the feed. Another table is `other`. */
export const ENTITY_TYPES: Readonly<Record<string, string>> = {
  tasks: "task",
  areas: "area",
  projects: "project",
  notes: "note",
  log_entries: "log",
  sources: "source",
  task_sources: "link",
  places: "place",
  launches: "launch",
  machines: "machine",
  learnings: "learning",
  preferences: "preference",
};

/** A row without its nulls, booleans as booleans. */
function compact(row: Row, booleans: readonly string[] = []): CompactRow {
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
async function taskRows(
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
const machineOf = (here: FeedHere | undefined): string | null => here?.machine ?? null;

function headOf(row: unknown): SpaceHead {
  const r = (row ?? {}) as Row;
  return {
    id: String(r["space_id"]),
    name: String(r["name"]),
    ref_prefix: String(r["ref_prefix"]),
    cursor: {
      epoch: Number(r["authority_epoch"]),
      incarnation: String(r["authority_incarnation"]),
      seq: Number(r["last_seq"]),
    },
  };
}

/** The space's head: its ID, name and current cursor. */
export async function readHead(reader: WorkerConnection): Promise<SpaceHead> {
  return headOf(await reader.get(SPACE_SQL));
}

/**
 * The open working set (A5 3.15 step 1) with its cursor, in one snapshot. With `here`, each task's
 * row carries its place's state on that machine.
 */
export async function readSnapshot(
  reader: WorkerConnection,
  here?: FeedHere,
): Promise<SnapshotMessage> {
  const [space, tasks, areas, projects, preferences] = await reader.transaction("deferred", [
    { sql: SPACE_SQL, mode: "get" },
    { sql: OPEN_TASKS, mode: "all", params: { machine: machineOf(here) } },
    { sql: LIVE_AREAS, mode: "all" },
    { sql: LIVE_PROJECTS, mode: "all" },
    { sql: PREFERENCE_ROWS, mode: "all" },
  ]);
  const head = headOf(space);
  return {
    type: "snapshot",
    space: { id: head.id, name: head.name, ref_prefix: head.ref_prefix },
    cursor: head.cursor,
    tasks: await taskRows(tasks as Row[], head.ref_prefix, here),
    areas: (areas as Row[]).map((row) => compact(row)),
    projects: (projects as Row[]).map((row) => compact(row)),
    preferences: spacePreferencesOf(preferences as Row[]),
  };
}

/**
 * The batch after `after`: the commits up to `after + limit` that exist in one snapshot, their
 * entities and rows. `through` is the last seq the batch accounts for; when nothing is newer it
 * equals `after` and the batch is an empty heartbeat. The head says whether the epoch or
 * incarnation moved: the caller then sends a snapshot instead.
 *
 * Rows are read from the tables, which hold the state at the head. A row is carried only when that
 * is its state as of `through` and nothing hidden from this subscriber shaped it in the batch:
 * an entity that a commit after `through` touched, or that a hidden commit in the batch touched,
 * travels with `row: null`, and the client refetches it. So no batch carries state its coverage
 * does not reach, and a hidden commit's content never rides on a visible event.
 */
export async function readBatch(
  reader: WorkerConnection,
  after: number,
  options: { limit?: number; visible?: Visibility; here?: FeedHere } = {},
): Promise<{ head: SpaceHead; batch: BatchMessage }> {
  const limit = options.limit ?? BATCH_COMMITS;
  const visible = options.visible ?? ALL_VISIBLE;
  const params = { after, upto: after + limit };
  const taskParams = { ...params, machine: machineOf(options.here) };
  const [space, commits, changes, actors, tasks, areas, projects, later] = await reader.transaction(
    "deferred",
    [
      { sql: SPACE_SQL, mode: "get" },
      { sql: COMMITS, mode: "all", params },
      { sql: CHANGES, mode: "all", params },
      { sql: ACTORS, mode: "all", params },
      { sql: TASK_ROWS, mode: "all", params: taskParams },
      { sql: AREA_ROWS, mode: "all", params },
      { sql: PROJECT_ROWS, mode: "all", params },
      { sql: LATER, mode: "all", params: { upto: params.upto } },
    ],
  );
  const head = headOf(space);
  const through = Math.max(after, Math.min(head.cursor.seq, after + limit));
  const actorOf = new Map((actors as Row[]).map((a) => [String(a["id"]), a]));
  const rows = new Map<string, CompactRow>();
  for (const row of await taskRows(tasks as Row[], head.ref_prefix, options.here)) {
    const id = row["id"];
    if (typeof id === "string") rows.set(`tasks:${id}`, row);
  }
  for (const row of areas as Row[]) rows.set(`areas:${String(row["id"])}`, compact(row));
  for (const row of projects as Row[]) rows.set(`projects:${String(row["id"])}`, compact(row));

  // Which commits this subscriber sees. A hidden commit is accounted for by the interval only.
  const shown = new Map<number, Row>();
  for (const commit of commits as Row[]) {
    const seq = Number(commit["seq"]);
    if (seq > through) continue;
    const facts: CommitFacts = {
      seq,
      kind: String(commit["kind"]),
      actor_kind: String(commit["actor_kind"]),
      origin: String(commit["origin"]),
    };
    if (visible(facts)) shown.set(seq, commit);
  }

  // Rows that are not the state as of `through` for this subscriber: withheld. A change to a
  // task's note, log entry or other child also changes the task's own row (its `touched`), so
  // the change's task is withheld with it.
  const withheld = new Set<string>();
  const withhold = (change: Row) => {
    withheld.add(`${String(change["entity"])}:${String(change["entity_id"])}`);
    const task = change["task_id"];
    if (typeof task === "string") withheld.add(`tasks:${task}`);
  };
  for (const row of (later ?? []) as Row[]) withhold(row);
  for (const change of changes as Row[]) {
    const seq = Number(change["seq"]);
    if (seq <= through && !shown.has(seq)) withhold(change);
  }

  // Entities per shown commit, in change order: one per (table, row), with the fields it set.
  const bySeq = new Map<number, Map<string, { entity: FeedEntity; changed: string[] }>>();
  for (const change of changes as Row[]) {
    const seq = Number(change["seq"]);
    if (!shown.has(seq)) continue;
    const table = String(change["entity"]);
    const id = String(change["entity_id"]);
    const key = `${table}:${id}`;
    let entities = bySeq.get(seq);
    if (entities === undefined) {
      entities = new Map();
      bySeq.set(seq, entities);
    }
    let found = entities.get(key);
    if (found === undefined) {
      const task = change["task_id"];
      const changed: string[] = [];
      found = {
        changed,
        entity: {
          type: ENTITY_TYPES[table] ?? "other",
          id,
          ...(typeof task === "string" ? { task } : {}),
          row: withheld.has(key) ? null : (rows.get(key) ?? null),
          changed,
          ...(change["action"] === "create" ? { created: true as const } : {}),
        },
      };
      entities.set(key, found);
    }
    const field = change["field"];
    if (typeof field === "string" && !found.changed.includes(field)) found.changed.push(field);
    // A source, link or place of a task changes what the task's row shows: the event carries the
    // task's row too, after the child, as a change that names no field of the task.
    const task = change["task_id"];
    const owner = `tasks:${String(task)}`;
    if (
      typeof task === "string" &&
      (ROW_CHILDREN as readonly string[]).includes(table) &&
      !entities.has(owner)
    ) {
      // One array, as above: a later change of the task's own fields in the commit adds to it.
      const fields: string[] = [];
      entities.set(owner, {
        changed: fields,
        entity: {
          type: "task",
          id: task,
          task,
          row: withheld.has(owner) ? null : (rows.get(owner) ?? null),
          changed: fields,
        },
      });
    }
  }

  const events: FeedEvent[] = [];
  for (const [seq, commit] of shown) {
    const actor = actorOf.get(String(commit["principal_id"]));
    events.push({
      seq,
      op_id: String(commit["id"]),
      request_id: String(commit["request_id"]),
      actor: {
        kind: typeof actor?.["kind"] === "string" ? actor["kind"] : String(commit["actor_kind"]),
        label: typeof actor?.["label"] === "string" ? actor["label"] : "",
      },
      kind: String(commit["kind"]),
      entities: [...(bySeq.get(seq)?.values() ?? [])].map((e) => e.entity),
    });
  }
  return {
    head,
    batch: {
      type: "batch",
      space_id: head.id,
      epoch: head.cursor.epoch,
      incarnation: head.cursor.incarnation,
      from: after,
      through,
      events,
    },
  };
}

/** Whether a subscriber's cursor belongs to the space's current authority. */
export function sameAuthority(a: Cursor, b: Cursor): boolean {
  return a.epoch === b.epoch && a.incarnation === b.incarnation;
}
