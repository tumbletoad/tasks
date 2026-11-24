// The rules every write of the writer keeps, Undo and Redo included: whatever an inversion leaves
// is a space an ordinary write could have made. Every model test of the writer checks them after
// every step (checkSpace), so the next inversion that breaks one is found by a test, not a person.
import { expect } from "vitest";
import type { Connection } from "../src/driver.ts";
import { folderKey, hasFolders, machineOs } from "../src/write/folders.ts";
import { TASK_ORDER } from "../src/write/positions.ts";
import { WRITE_LIMITS, type WriteRequest, type WriteResult } from "../src/write/request.ts";

/** The space as a step found it: what a rule about the step compares with. */
export interface SpaceState {
  readonly lastSeq: number;
  /** Each task's lifecycle. */
  readonly lifecycles: ReadonlyMap<string, string>;
  /** Each source key's open holders: live active tasks with a live link to its live source. */
  readonly open: ReadonlyMap<string, ReadonlySet<string>>;
}

const ids = (conn: Connection, sql: string): string[] =>
  conn
    .prepare(sql)
    .all()
    .map((r) => String(r["id"]));

const GROUPS = {
  stray:
    "SELECT t.id AS id FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE t.area_id IS NOT p.area_id",
  taskInGoneArea:
    "SELECT t.id AS id FROM tasks t JOIN areas a ON a.id = t.area_id " +
    "WHERE t.deleted_at IS NULL AND a.deleted_at IS NOT NULL",
  taskInGoneProject:
    "SELECT t.id AS id FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE t.deleted_at IS NULL AND p.deleted_at IS NOT NULL",
  projectInGoneArea:
    "SELECT p.id AS id FROM projects p JOIN areas a ON a.id = p.area_id " +
    "WHERE p.deleted_at IS NULL AND a.deleted_at IS NOT NULL",
  folderOfGoneProject:
    "SELECT f.id AS id FROM folders f JOIN projects p ON p.id = f.owner_id " +
    "WHERE f.owner_kind = 'project' AND f.deleted_at IS NULL AND p.deleted_at IS NOT NULL",
} as const;

const TASKS = {
  activeWrapped: "SELECT id FROM tasks WHERE lifecycle = 'active' AND wrap_state IS NOT NULL",
  learnings:
    "SELECT task_id AS id FROM learnings WHERE deleted_at IS NULL GROUP BY task_id " +
    `HAVING count(*) > ${String(WRITE_LIMITS.learnings)}`,
} as const;

/** Owners with two live folders on one machine. */
const FOLDERS_OF_ONE_OWNER =
  "SELECT owner_kind || ' ' || owner_id || ' ' || machine_id AS id FROM folders " +
  "WHERE deleted_at IS NULL GROUP BY owner_kind, owner_id, machine_id HAVING count(*) > 1";

const LIVE_PROJECT_FOLDERS =
  "SELECT f.machine_id AS machine, f.path AS path FROM folders f " +
  "JOIN projects p ON p.id = f.owner_id WHERE f.owner_kind = 'project' " +
  "AND f.deleted_at IS NULL AND p.deleted_at IS NULL";

const HOLDERS =
  "SELECT s.source_key AS key, t.id AS task, ts.version AS link FROM sources s " +
  "JOIN task_sources ts ON ts.source_id = s.id JOIN tasks t ON t.id = ts.task_id " +
  "WHERE s.source_key IS NOT NULL AND s.deleted_at IS NULL AND ts.removed_at IS NULL " +
  "AND t.deleted_at IS NULL AND t.lifecycle = 'active'";

/** The kinds of the commits after `$seq`: `ops` for an ordinary write, else undo or redo. */
const KINDS_SINCE = "SELECT DISTINCT kind FROM commits WHERE seq > $seq";

/**
 * Checks the rules a space keeps, and with `before` (the space as the step found it) the rules
 * about the step. Returns the space as it is now, for the next step's check.
 *
 * - A task in a project is in that project's area, in the Trash too.
 * - A live task or project never has an area or a project that is deleted, so a deleted project
 *   holds no live task, and no live folder either.
 * - Every list has one order, which every view reads (TASK_ORDER). Two tasks may share a position
 *   (an Undo puts a task back on its place while another took it); a task placed beside either
 *   still stands right there (ruled).
 * - An owner has at most one live folder on a machine, and two live projects never share one
 *   folder on one machine, by that machine's case rule.
 * - An active task has no wrap-up, and a task has at most 20 live learnings.
 * - A source key gains another open holder only by a task the step made active again (a reopen,
 *   or an undo of a check-off, which repeats it) or by a link an ordinary write made to a task that
 *   was there before it: dedupe gives new work and a restored task none, and neither Undo nor Redo
 *   brings one back. Checked per write: `before` is the space as the write found it.
 */
export function checkSpace(conn: Connection, before?: SpaceState): SpaceState {
  expect(ids(conn, GROUPS.stray), "a task in a project is in its area").toEqual([]);
  expect(ids(conn, GROUPS.taskInGoneArea), "a live task's area is live").toEqual([]);
  expect(ids(conn, GROUPS.taskInGoneProject), "a deleted project holds no live task").toEqual([]);
  expect(ids(conn, GROUPS.projectInGoneArea), "a live project's area is live").toEqual([]);
  expect(ids(conn, TASKS.activeWrapped), "an active task has no wrap-up").toEqual([]);
  expect(ids(conn, TASKS.learnings), "a task has at most 20 live learnings").toEqual([]);
  if (hasFolders(conn)) {
    expect(ids(conn, GROUPS.folderOfGoneProject), "a deleted project holds no folder").toEqual([]);
    expect(ids(conn, FOLDERS_OF_ONE_OWNER), "one live folder per owner and machine").toEqual([]);
    const seen = new Set<string>();
    for (const row of conn.prepare(LIVE_PROJECT_FOLDERS).all()) {
      const machine = String(row["machine"]);
      const os = machineOs(conn, machine);
      if (os === undefined) throw new Error("a folder's machine has no record");
      const key = `${machine}|${folderKey(String(row["path"]), os)}`;
      expect(seen.has(key), `two live projects on one folder: ${key}`).toBe(false);
      seen.add(key);
    }
  }

  const lastSeq = Number(conn.prepare("SELECT last_seq FROM space").get()?.["last_seq"]);
  const lifecycles = new Map(
    conn
      .prepare("SELECT id, lifecycle FROM tasks")
      .all()
      .map((r) => [String(r["id"]), String(r["lifecycle"])]),
  );
  const open = new Map<string, Set<string>>();
  const links = new Map<string, number>();
  for (const row of conn.prepare(HOLDERS).all()) {
    const key = String(row["key"]);
    const task = String(row["task"]);
    open.set(key, (open.get(key) ?? new Set()).add(task));
    links.set(`${key}|${task}`, Number(row["link"]));
  }
  if (before !== undefined) {
    const forward = conn
      .prepare(KINDS_SINCE)
      .all({ seq: before.lastSeq })
      .some((r) => r["kind"] === "ops");
    for (const [key, holders] of open) {
      if (holders.size < 2) continue;
      for (const task of holders) {
        if (before.open.get(key)?.has(task) === true) continue;
        const reopened = (before.lifecycles.get(task) ?? "active") !== "active";
        const linked =
          forward &&
          before.lifecycles.has(task) &&
          (links.get(`${key}|${task}`) ?? 0) > before.lastSeq;
        expect(reopened || linked, `${key}: ${task} is another open holder`).toBe(true);
      }
    }
  }
  return { lastSeq, lifecycles, open };
}

/**
 * `submit`, with the rules checked on the space each write leaves (checkSpace), the space as the
 * write found it as `before`: a step that sends several writes is checked after each of them. And
 * a task a forward write placed right before or after another stands right there in its list, as
 * every view reads the list (listOf), also when two tasks of it share a position: unless a later
 * operation of the request names either task again. A retried request that is answered from its
 * receipt writes nothing.
 */
export function ruled(
  conn: Connection,
  submit: (request: WriteRequest) => WriteResult,
): (request: WriteRequest) => WriteResult {
  let state = checkSpace(conn);
  return (request) => {
    const result = submit(request);
    state = checkSpace(conn, state);
    if (result.status === "applied" && result.replayed !== true) {
      for (const { task, sibling, side } of placedBeside(conn, request, result)) {
        const list = listOf(conn, sibling);
        const at = list.indexOf(sibling) + (side === "before" ? -1 : 1);
        expect(list[at], `${task} right ${side} ${sibling}`).toBe(task);
      }
    }
    return result;
  };
}

/** The tasks the request placed right before or after another that no later operation names. */
function placedBeside(
  conn: Connection,
  request: WriteRequest,
  result: WriteResult,
): { task: string; sibling: string; side: "before" | "after" }[] {
  return request.ops.flatMap((op, k) => {
    if (op.kind !== "task.create" && op.kind !== "task.move") return [];
    const side = op.before !== undefined ? "before" : op.after !== undefined ? "after" : undefined;
    const done = result.results[k];
    if (side === undefined || done === undefined || done.status === "existing") return [];
    const task = done.task ?? done.id;
    const sibling = conn
      .prepare("SELECT id FROM tasks WHERE id = $s OR ref = $s")
      .get({ s: op[side] ?? null })?.["id"];
    if (typeof sibling !== "string") return [];
    const later = JSON.stringify(request.ops.slice(k + 1));
    if (later.includes(task) || later.includes(sibling)) return [];
    return [{ task, sibling, side }];
  });
}

/**
 * Every list of the space in its order, as every view sorts it: the tasks of each project, of each
 * area outside a project and of the Inbox, and the projects of each area and of none. A row in the
 * Trash, or one whose creation was undone, keeps its place in its list.
 */
export function listsOf(conn: Connection): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  for (const sql of [TASK_LISTS, PROJECT_LISTS]) {
    for (const r of conn.prepare(sql).all())
      (lists[String(r["list"])] ??= []).push(String(r["id"]));
  }
  return lists;
}

const TASK_LISTS =
  "SELECT id, CASE WHEN project_id IS NOT NULL THEN 'tasks of project ' || project_id " +
  "WHEN area_id IS NOT NULL THEN 'tasks of area ' || area_id ELSE 'the Inbox' END AS list " +
  `FROM tasks ORDER BY list, ${TASK_ORDER}`;
const PROJECT_LISTS =
  "SELECT id, 'projects of ' || coalesce('area ' || area_id, 'no area') AS list FROM projects " +
  "ORDER BY list, position, id";

/** The tasks of `task`'s list in their order, as every view sorts them (TASK_ORDER). */
export function listOf(conn: Connection, task: string): string[] {
  const group = conn
    .prepare("SELECT project_id AS project, area_id AS area FROM tasks WHERE id = $id")
    .get<{ project: string | null; area: string | null }>({ id: task });
  if (group === undefined) throw new Error("no such task");
  return conn
    .prepare(
      "SELECT id FROM tasks WHERE project_id IS $project " +
        `AND ($project IS NOT NULL OR area_id IS $area) ORDER BY ${TASK_ORDER}`,
    )
    .all(group)
    .map((r) => String(r["id"]));
}

/**
 * A task placed right `side` of `sibling` stands there in its list: before it and after what was
 * before it, or the other way round. `was` is the sibling's list before the move.
 */
export function expectBeside(
  conn: Connection,
  task: string,
  sibling: string,
  side: "before" | "after",
  was: readonly string[],
): void {
  const list = listOf(conn, sibling);
  const others = was.filter((id) => id !== task);
  const at = others.indexOf(sibling);
  const expected = [...others];
  expected.splice(side === "before" ? at : at + 1, 0, task);
  expect(list, `${task} ${side} ${sibling}`).toEqual(expected);
}
