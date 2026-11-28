// The group rules every write is checked against, on the state it made: a deleted project holds
// no live task and no live folder, and a task in a project is in that project's area.
import type { Connection, Row } from "../driver.ts";
import { hasFolders } from "./folders.ts";

const SQL = {
  /** The projects that the tasks in `$tasks` are in now. */
  projectsOfTasks:
    "SELECT id, project_id AS project FROM tasks WHERE id IN (SELECT value FROM json_each($tasks)) " +
    "AND project_id IS NOT NULL",
  /** The project owners of the folders in `$folders`. */
  ownersOfFolders:
    "SELECT owner_id AS project FROM folders WHERE id IN (SELECT value FROM json_each($folders)) " +
    "AND owner_kind = 'project'",
  /** The live tasks of the deleted projects in `$projects`. */
  liveTasksOfDeleted:
    "SELECT t.id AS id, t.project_id AS project FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE p.id IN (SELECT value FROM json_each($projects)) AND p.deleted_at IS NOT NULL " +
    "AND t.deleted_at IS NULL ORDER BY t.project_id, t.ref",
  /** The live folders of the deleted projects in `$projects`. */
  liveFoldersOfDeleted:
    "SELECT f.id AS id, f.owner_id AS project FROM folders f JOIN projects p ON p.id = f.owner_id " +
    "WHERE f.owner_kind = 'project' AND p.id IN (SELECT value FROM json_each($projects)) " +
    "AND p.deleted_at IS NOT NULL AND f.deleted_at IS NULL ORDER BY f.owner_id, f.id",
  /** The tasks in `$tasks`, or in a project in `$projects`, whose area is not their project's. */
  outOfArea:
    "SELECT t.id AS id, t.project_id AS project FROM tasks t JOIN projects p ON p.id = t.project_id " +
    "WHERE (t.id IN (SELECT value FROM json_each($tasks)) " +
    "OR t.project_id IN (SELECT value FROM json_each($projects))) " +
    "AND t.area_id IS NOT p.area_id ORDER BY t.id",
} as const;

/** The rows a write touched that the group rules look at, by ID. */
export interface GroupTouch {
  readonly projects: readonly string[];
  readonly tasks: readonly string[];
  readonly folders: readonly string[];
  /** The projects whose area the write set, and the tasks whose project or area it set. */
  readonly moved: readonly string[];
  readonly regrouped: readonly string[];
}

/**
 * Where a project and what is in it break their rules after a write: a deleted project that holds
 * a live task or a live folder (`held`), or a task whose area is not its project's (`stray`).
 */
export interface GroupBreak {
  readonly rule: "held" | "stray";
  readonly project: string;
  readonly child: { readonly entity: "tasks" | "folders"; readonly id: string };
}

/**
 * The group rules on the state a write made, for the projects it touched, the projects of the
 * tasks and folders it touched, and the tasks it moved: a deleted project holds no live task and no
 * live folder, and a task in a project is in that project's area. Also the project each touched
 * task is in now.
 */
export function groupBreaks(
  conn: Connection,
  touch: GroupTouch,
): { breaks: GroupBreak[]; projectOf: Map<string, string> } {
  const folders = hasFolders(conn) ? touch.folders : [];
  const projectOf = new Map(
    conn
      .prepare(SQL.projectsOfTasks)
      .all({ tasks: JSON.stringify(touch.tasks) })
      .map((row) => [String(row["id"]), String(row["project"])]),
  );
  const projects = [
    ...new Set([
      ...touch.projects,
      ...projectOf.values(),
      ...(folders.length === 0
        ? []
        : conn
            .prepare(SQL.ownersOfFolders)
            .all({ folders: JSON.stringify(folders) })
            .map((row) => String(row["project"]))),
    ]),
  ];
  const breaks: GroupBreak[] = [];
  const held = (entity: "tasks" | "folders", sql: string): void => {
    for (const row of conn.prepare(sql).all({ projects: JSON.stringify(projects) })) {
      breaks.push({
        rule: "held",
        project: String(row["project"]),
        child: { entity, id: String(row["id"]) },
      });
    }
  };
  if (projects.length > 0) {
    held("tasks", SQL.liveTasksOfDeleted);
    if (hasFolders(conn)) held("folders", SQL.liveFoldersOfDeleted);
  }
  if (touch.moved.length > 0 || touch.regrouped.length > 0) {
    const stray = conn.prepare(SQL.outOfArea).all({
      tasks: JSON.stringify(touch.regrouped),
      projects: JSON.stringify(touch.moved),
    });
    for (const row of stray) {
      breaks.push({
        rule: "stray",
        project: String(row["project"]),
        child: { entity: "tasks", id: String(row["id"]) },
      });
    }
  }
  return { breaks, projectOf };
}

/** Whether `found` holds between the rows `rowOf` gives (groupBreaks' statements, on any state). */
export function brokenIn(
  found: GroupBreak,
  rowOf: (entity: "projects" | "tasks" | "folders", id: string) => Row | undefined,
): boolean {
  const project = rowOf("projects", found.project);
  const child = rowOf(found.child.entity, found.child.id);
  if (project === undefined || child === undefined) return false;
  if (found.rule === "stray") {
    return child["project_id"] === found.project && child["area_id"] !== project["area_id"];
  }
  const inside =
    found.child.entity === "tasks"
      ? child["project_id"] === found.project
      : child["owner_kind"] === "project" && child["owner_id"] === found.project;
  return inside && project["deleted_at"] !== null && child["deleted_at"] === null;
}
