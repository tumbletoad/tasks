// A routine as the service reads and answers it, on a tree space: one task that comes back on a
// schedule, its open time and its entries. Each is read from the tree's own tables (`treeTables`).
// An agent reads its schedule in English words (contracts' repeat.ts); the page says it in its own.
import { AppError } from "@ttasks/contracts";
import { repeatWords } from "@ttasks/contracts/repeat";
import { parseRule } from "@ttasks/contracts/schedule";
import { formatTaskRef, parseTaskRef, type Row, type WorkerConnection } from "@ttasks/storage";

/** At most this many of a routine's entries come with it, newest first (contracts' ROUTINE_ENTRIES). */
const ENTRIES = 10;

/** A routine's columns, from the tree's own tables: `main.tasks`, as a served reader names them. */
const COLUMNS =
  "n.id, n.title, n.brief, n.description, n.parent_id, n.position, n.deleted_at, t.ref, " +
  "t.lifecycle, t.priority, max(n.version, t.version, r.version) AS version, r.rule, r.start, " +
  "r.tz, r.due_date, r.due_at, r.paused, r.instance, (SELECT count(*) FROM occurrences o " +
  "WHERE o.routine_id = n.id AND o.deleted_at IS NULL) AS entries";
const FROM =
  "FROM nodes n JOIN main.tasks t ON t.id = n.id JOIN routines r ON r.id = n.id " +
  "WHERE n.kind = 'routine'";

/** The newest live entry of routine `n`, as JSON. */
const LAST =
  "(SELECT json_object('state', o.state, 'due_date', o.due_date, 'due_at', o.due_at, 'at', o.at) " +
  "FROM occurrences o WHERE o.routine_id = n.id AND o.deleted_at IS NULL " +
  "ORDER BY o.at DESC, o.id DESC LIMIT 1) AS last";

const SQL = {
  byId: `SELECT ${COLUMNS} ${FROM} AND n.id = $id`,
  byRef: `SELECT ${COLUMNS} ${FROM} AND t.ref = $ref`,
  prefix: "SELECT ref_prefix FROM space WHERE one = 1",
  entries:
    "SELECT o.due_date, o.due_at, o.state, o.at, o.why, o.note, a.kind AS by_kind, " +
    "a.label AS by_label FROM occurrences o JOIN actors a ON a.id = o.actor_id " +
    "WHERE o.routine_id = $id AND o.deleted_at IS NULL ORDER BY o.at DESC, o.id DESC LIMIT $n",
} as const;

/** Every live routine that is not finished, as the feed's snapshot sends it. */
export const LIVE_ROUTINES = `SELECT ${COLUMNS}, ${LAST} ${FROM} AND n.deleted_at IS NULL AND t.lifecycle = 'active' ORDER BY n.position, n.id`;

/** The routines a batch's commits changed, also those gone to the Trash or finished. */
export const ROUTINE_ROWS =
  `SELECT ${COLUMNS}, ${LAST} ${FROM} AND n.id IN (SELECT task_id FROM changes ` +
  "WHERE seq > $after AND seq <= $upto AND task_id IS NOT NULL)";

const iso = (ms: number): string => new Date(ms).toISOString();

const time = (date: unknown, at: unknown): { date: string; at?: string } => ({
  date: String(date),
  ...(typeof at === "number" ? { at: iso(at) } : {}),
});

/** A routine's schedule in words, from its stored rule. */
export function wordsOf(rule: unknown): string {
  const parsed = parseRule(String(rule));
  return parsed === undefined ? String(rule) : repeatWords(parsed);
}

const stateOf = (row: Row): "active" | "paused" | "finished" =>
  row["lifecycle"] !== "active" ? "finished" : row["paused"] === 1 ? "paused" : "active";

/** A routine's row by its reference (`M-21`) or ID, in or out of the Trash; undefined for none. */
export async function readRoutine(
  reader: WorkerConnection,
  key: string,
): Promise<{ row: Row; prefix: string } | undefined> {
  const [prefixRow, byId] = await reader.transaction("deferred", [
    { sql: SQL.prefix, mode: "get" },
    { sql: SQL.byId, mode: "get", params: { id: key } },
  ]);
  const prefix = String((prefixRow as Row | undefined)?.["ref_prefix"]);
  if (byId !== undefined && byId !== null) return { row: byId as Row, prefix };
  const ref = parseTaskRef(key);
  if (ref === undefined || ref.prefix !== prefix) return undefined;
  const byRef = await reader.get(SQL.byRef, { ref: ref.ref });
  return byRef === undefined ? undefined : { row: byRef, prefix };
}

/** The refusal of a key that names no routine. */
export const noRoutine = (key: string): AppError =>
  new AppError({
    code: "not_found",
    message: `The space has no routine ${key}.`,
    hint: "Name a routine by its reference, such as M-21.",
    data: { field: "routine" },
  });

/** A routine as an answer shows it (contracts' Routine). */
export async function routineView(
  reader: WorkerConnection,
  row: Row,
  prefix: string,
): Promise<Record<string, unknown>> {
  const [last] = await entriesOf(reader, String(row["id"]), 1);
  return {
    id: String(row["id"]),
    ref: formatTaskRef(prefix, Number(row["ref"])),
    title: String(row["title"]),
    repeat: wordsOf(row["rule"]),
    rule: String(row["rule"]),
    tz: String(row["tz"]),
    by: "you",
    state: stateOf(row),
    next: time(row["due_date"], row["due_at"]),
    entries: Number(row["entries"]),
    ...(last === undefined ? {} : { last }),
  };
}

/** A routine's newest entries, newest first (contracts' RoutineEntry). */
export async function entriesOf(
  reader: WorkerConnection,
  id: string,
  n = ENTRIES,
): Promise<Record<string, unknown>[]> {
  const rows = await reader.all(SQL.entries, { id, n });
  return rows.map((e) => ({
    ...(e["due_date"] === null ? {} : { due: time(e["due_date"], e["due_at"]) }),
    state: String(e["state"]),
    at: iso(Number(e["at"])),
    by: e["by_kind"] === "human" ? "user" : `agent:${String(e["by_label"])}`,
    ...(typeof e["why"] === "string" ? { why: e["why"] } : {}),
    ...(typeof e["note"] === "string" ? { note: e["note"] } : {}),
  }));
}

/** What get_task says of a routine, and what an agent may do with it. */
export async function routineGet(
  reader: WorkerConnection,
  row: Row,
  prefix: string,
  asOf: string,
): Promise<Record<string, unknown>> {
  const routine = await routineView(reader, row, prefix);
  const next = routine["next"] as { date: string; at?: string };
  const state = routine["state"];
  const when = next.at ?? next.date;
  const say =
    state === "finished"
      ? `A routine, finished for good: ${String(routine["repeat"])}, by you.`
      : state === "paused"
        ? `A routine, paused: ${String(routine["repeat"])}, by you.`
        : `A routine: ${String(routine["repeat"])}, by you. This time is due ${when}. ` +
          "Checking it off is the person's, in the app; it never finishes the routine. " +
          'update_task with repeat changes its schedule, and repeat "" pauses it.';
  const brief = String(row["brief"]);
  const description = String(row["description"]);
  return {
    view: "routine",
    as_of: asOf,
    say,
    routine: {
      ...routine,
      ...(brief === "" ? {} : { summary: brief }),
      ...(description === "" ? {} : { context: description }),
    },
    history: await entriesOf(reader, String(row["id"])),
  };
}

/** A routine as the feed sends it: the page's row of it, with its newest entry. */
export function compactRoutine(
  row: Row,
  prefix: string,
): Record<string, string | number | boolean> {
  const last =
    typeof row["last"] === "string" ? (JSON.parse(row["last"]) as Record<string, unknown>) : {};
  const out: Record<string, string | number | boolean> = {
    id: String(row["id"]),
    ref: formatTaskRef(prefix, Number(row["ref"])),
    kind: "routine",
    title: String(row["title"]),
    parent: String(row["parent_id"]),
    position: String(row["position"]),
    priority: Number(row["priority"]),
    lifecycle: String(row["lifecycle"]),
    rule: String(row["rule"]),
    start: String(row["start"]),
    tz: String(row["tz"]),
    due_date: String(row["due_date"]),
    paused: row["paused"] === 1,
    by: typeof row["instance"] === "string" ? row["instance"] : "you",
    entries: Number(row["entries"]),
    version: Number(row["version"]),
  };
  if (typeof row["due_at"] === "number") out["due_at"] = row["due_at"];
  if (typeof row["deleted_at"] === "number") out["deleted_at"] = row["deleted_at"];
  if (typeof row["brief"] === "string" && row["brief"] !== "") out["summary"] = row["brief"];
  if (typeof last["state"] === "string") {
    out["last_state"] = last["state"];
    out["last_at"] = Number(last["at"]);
    if (typeof last["due_date"] === "string") out["last_due"] = last["due_date"];
  }
  return out;
}

/** A task's ID by its reference or ID, of any kind, in or out of the Trash; undefined for none. */
export async function readTaskId(
  reader: WorkerConnection,
  key: string,
): Promise<string | undefined> {
  const [prefixRow, byId] = await reader.transaction("deferred", [
    { sql: SQL.prefix, mode: "get" },
    { sql: "SELECT id FROM main.tasks WHERE id = $id", mode: "get", params: { id: key } },
  ]);
  if (byId !== undefined && byId !== null) return String((byId as Row)["id"]);
  const ref = parseTaskRef(key);
  if (ref === undefined || ref.prefix !== String((prefixRow as Row | undefined)?.["ref_prefix"])) {
    return undefined;
  }
  const row = await reader.get("SELECT id FROM main.tasks WHERE ref = $ref", { ref: ref.ref });
  return row === undefined ? undefined : String(row["id"]);
}
