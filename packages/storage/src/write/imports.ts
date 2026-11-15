// The writer's part of the prototype import (A7 3.15.5): the preview token recomputed inside the
// applying transaction, and the plan of an import's undo. The importer (packages/importer-planning)
// builds the plan and the token; the writer never imports it (A7 3.2), so the rows the token pins
// are read here in the importer's shape, and `[A7.3.15.importer.apply]` checks that both sides
// give one token for one space.
//
// The token is `pv1_` and the base64url SHA-256 of the canonical JSON of what the preview pinned:
// what the run folder holds (the run, the inputs' hashes, the options, the plan's hash), which the
// service recomputes from the folder and sends as `pinned`, and the space's identity and the rows
// the plan meets with their versions, which this module reads in the request's transaction. So an
// apply never lands on a space that changed since its preview in a row the plan depends on: an
// alias of one of its legacy IDs, a source of one of its keys, an area of one of its slugs, and every
// project slug the placement of its projects looked at, with that project's area.
//
// An import's undo is a revert of its commit under A1 3.10's guards, made partial in one way that
// keeps a person's work whole: a task that someone changed since the import (a field, a note, a
// deletion) stays as it is, with everything the import gave it, and is listed. A source stays while
// a task that stays links it; an area or a project stays while it holds a task or a project that
// stays. The import's aliases and its exchange are never inverted: they record what the import made,
// which a later import reads (A7 3.15.6).
import { createHash } from "node:crypto";
import type { Connection } from "../driver.ts";
import { isId, type Id } from "../ids.ts";
import { RowReader } from "../rows.ts";
import { canonicalJson } from "./canonical.ts";
import { planInversions, readChanges, type InversionPlan } from "./history.ts";
import type { PreviewGuard } from "./request.ts";

const IN = (param: string): string => `IN (SELECT value FROM json_each(${param}))`;

const SQL = {
  space:
    "SELECT space_id, authority_epoch, authority_incarnation FROM space WHERE one = 1",
  aliases:
    "SELECT a.alias AS alias, t.id AS task, t.version AS version FROM aliases a " +
    "JOIN tasks t ON t.id = a.entity_id WHERE a.namespace = 'planning' " +
    `AND a.entity_kind = 'task' AND a.alias ${IN("$names")}`,
  sources: `SELECT source_key AS key, id, version FROM sources WHERE deleted_at IS NULL AND source_key ${IN("$names")}`,
  areas: `SELECT slug, id, version FROM areas WHERE deleted_at IS NULL AND slug ${IN("$names")}`,
  projects:
    "SELECT p.slug AS slug, p.id AS id, p.version AS version, a.slug AS area FROM projects p " +
    "LEFT JOIN areas a ON a.id = p.area_id AND a.deleted_at IS NULL " +
    `WHERE p.deleted_at IS NULL AND p.slug ${IN("$names")}`,
  linksOf: "SELECT task_id FROM task_sources WHERE source_id = $id AND removed_at IS NULL",
  tasksIn:
    "SELECT id FROM tasks WHERE deleted_at IS NULL AND (area_id = $id OR project_id = $id)",
  projectsIn: "SELECT id FROM projects WHERE deleted_at IS NULL AND area_id = $id",
} as const;

const byFirst = <T extends readonly unknown[]>(rows: T[]): T[] =>
  rows.sort((a, b) => {
    const x = String(a[0]);
    const y = String(b[0]);
    return x < y ? -1 : x > y ? 1 : 0;
  });

/**
 * The preview token of `guard`, recomputed from this transaction's state (the module header): the
 * same shape as the importer's `previewToken`, which hashes the rows its dry run read.
 */
export function recomputeToken(conn: Connection, guard: PreviewGuard): string {
  const space = new RowReader("space", conn.prepare(SQL.space).get() ?? {});
  const all = (sql: string, names: readonly string[]) =>
    conn.prepare(sql).all({ names: JSON.stringify(names) });
  const aliases = byFirst(
    all(SQL.aliases, guard.aliases).map((r) => [r["alias"], r["task"], r["version"]] as const),
  );
  const sources = byFirst(
    all(SQL.sources, guard.keys).map((r) => [r["key"], r["id"], r["version"]] as const),
  );
  const areas = byFirst(
    all(SQL.areas, guard.areas).map((r) => [r["slug"], r["id"], r["version"]] as const),
  );
  const found = new Map(all(SQL.projects, guard.projects).map((r) => [r["slug"], r]));
  const projects = byFirst(
    [...new Set(guard.projects)].map((slug) => {
      const p = found.get(slug);
      return p === undefined ? [slug, null] : [slug, p["id"], p["version"], p["area"] ?? null];
    }),
  );
  const hashed = {
    ...guard.pinned,
    space: {
      id: space.text("space_id"),
      epoch: space.int("authority_epoch", "epoch"),
      incarnation: space.text("authority_incarnation"),
    },
    judged: { aliases, sources, areas, projects },
  };
  const digest = createHash("sha256").update(canonicalJson(hashed), "utf8").digest("base64url");
  return `pv1_${digest}`;
}

/** The tables an import's undo never inverts: what the import made, which a re-import reads. */
const RECORDS = new Set(["aliases", "exchanges", "exchange_items"]);

export interface ImportRevert {
  plan: InversionPlan;
  /** The tasks that stay as they are: someone changed them since the import. */
  kept: Set<Id<"t">>;
}

/**
 * Plans the undo of import commit `seq` (the module header): A1 3.10's inversion of its change rows
 * under the provenance guards, partial, then every task with a conflict keeps all it has, and the
 * sources, projects and areas that would hold a task or a project that stays stay too.
 */
export function planImportRevert(
  conn: Connection,
  seq: number,
  options: { refPrefix: string; op: number },
): ImportRevert {
  const changes = readChanges(conn, seq).filter((c) => !RECORDS.has(c.entity));
  const plan = planInversions(conn, changes, {
    creating: new Set([seq]),
    refPrefix: options.refPrefix,
    partial: true,
    op: options.op,
  });
  const tombstoned = new Set(
    plan.inversions.filter((i) => i.kind === "tombstone").map((i) => `${i.entity}|${i.id}`),
  );
  // A task stays as it is when a field or a row of it conflicts, and when the import created it
  // and its tombstone is not planned (someone changed it, or deleted it already).
  const kept = new Set<Id<"t">>();
  for (const c of plan.conflicts) if (c.task !== undefined) kept.add(c.task);
  for (const c of changes) {
    if (c.action === "create" && c.entity === "tasks" && !tombstoned.has(`tasks|${c.entityId}`)) {
      if (isId(c.entityId, "t")) kept.add(c.entityId);
    }
  }
  plan.inversions = plan.inversions.filter((i) => i.task === null || !kept.has(i.task));
  // A source stays while a link to it stays; a project while a task in it stays; an area while a
  // task or a project in it stays. Projects first: a project that stays keeps its area.
  const keep = (entity: string, stays: (id: string, going: ReadonlySet<string>) => boolean) => {
    const going = new Set(
      plan.inversions.filter((i) => i.kind === "tombstone").map((i) => `${i.entity}|${i.id}`),
    );
    plan.inversions = plan.inversions.filter(
      (i) => i.kind !== "tombstone" || i.entity !== entity || !stays(i.id, going),
    );
  };
  keep("sources", (id, going) =>
    conn
      .prepare(SQL.linksOf)
      .all({ id })
      .some((row) => !going.has(`task_sources|${String(row["task_id"])}|${id}`)),
  );
  const holds = (id: string, going: ReadonlySet<string>): boolean =>
    conn
      .prepare(SQL.tasksIn)
      .all({ id })
      .some((row) => !going.has(`tasks|${String(row["id"])}`));
  keep("projects", holds);
  keep(
    "areas",
    (id, going) =>
      holds(id, going) ||
      conn
        .prepare(SQL.projectsIn)
        .all({ id })
        .some((row) => !going.has(`projects|${String(row["id"])}`)),
  );
  return { plan, kept };
}
