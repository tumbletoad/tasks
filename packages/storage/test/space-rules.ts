// The rules every write of the writer keeps, Undo and Redo included: whatever an inversion leaves
// is a space an ordinary write could have made. Every model test of the writer checks them after
// every step (checkSpace), so the next inversion that breaks one is found by a test, not a person.
import { expect } from "vitest";
import type { Connection } from "../src/driver.ts";
import { folderKey, hasFolders, machineOs } from "../src/write/folders.ts";

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

/**
 * Positions that two rows of one list share. Placement counts every row of a list, those in the
 * Trash and those whose creation was undone too, so no write gives a row a position another holds.
 */
const SHARED_POSITIONS = {
  tasks:
    "SELECT group_concat(id) AS id FROM tasks " +
    "GROUP BY project_id, CASE WHEN project_id IS NULL THEN area_id END, position " +
    "HAVING count(*) > 1",
  projects:
    "SELECT group_concat(id) AS id FROM projects GROUP BY area_id, position HAVING count(*) > 1",
  areas: "SELECT group_concat(id) AS id FROM areas GROUP BY position HAVING count(*) > 1",
} as const;

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
 * - No two rows of one list share a position: tasks of one project, or of one area outside a
 *   project, projects of one area, areas. So a row placed "before X" sorts before X and after
 *   what was before X (expectBeside).
 * - Two live projects never share one folder on one machine, by that machine's case rule.
 * - A source key gains another open holder only by a task the step made active again (a reopen,
 *   or an undo of a check-off, which repeats it) or by a link an ordinary write made: dedupe gives
 *   new work and a restored task none, and neither Undo nor Redo brings one back.
 */
export function checkSpace(conn: Connection, before?: SpaceState): SpaceState {
  expect(ids(conn, GROUPS.stray), "a task in a project is in its area").toEqual([]);
  expect(ids(conn, GROUPS.taskInGoneArea), "a live task's area is live").toEqual([]);
  expect(ids(conn, GROUPS.taskInGoneProject), "a deleted project holds no live task").toEqual([]);
  expect(ids(conn, GROUPS.projectInGoneArea), "a live project's area is live").toEqual([]);
  for (const [list, sql] of Object.entries(SHARED_POSITIONS)) {
    expect(ids(conn, sql), `two ${list} of one list share a position`).toEqual([]);
  }
  if (hasFolders(conn)) {
    expect(ids(conn, GROUPS.folderOfGoneProject), "a deleted project holds no folder").toEqual([]);
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
        const linked = forward && (links.get(`${key}|${task}`) ?? 0) > before.lastSeq;
        expect(reopened || linked, `${key}: ${task} is another open holder`).toBe(true);
      }
    }
  }
  return { lastSeq, lifecycles, open };
}

/** The tasks of `task`'s list in their order: by position, as every view sorts them. */
export function listOf(conn: Connection, task: string): string[] {
  return conn
    .prepare(
      "SELECT o.id AS id FROM tasks t JOIN tasks o ON o.project_id IS t.project_id " +
        "AND (t.project_id IS NOT NULL OR o.area_id IS t.area_id) WHERE t.id = $id " +
        "ORDER BY o.position, o.id",
    )
    .all({ id: task })
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
