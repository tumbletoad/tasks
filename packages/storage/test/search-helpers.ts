// Stand-ins for the operations later steps add, played directly on a fixture space's database for
// the search tests (A1 3.12, A3 3.9.5): a tombstone and a restore (M3.04), entity and text
// redaction (M3.14), a learning (wrap-up, M3.04) and an authority change (M3.08). Each writes the
// rows its operation will write and passes the change rows that operation will produce to the
// index, as the writer does. Tests only; fixture text only.
import type { Connection, NotPromise } from "../src/driver.ts";
import { newId } from "../src/ids.ts";
import { indexChanges, type IndexedChange } from "../src/search/documents.ts";
import { decodeSpaceRow } from "../src/rows.ts";
import { openSpace } from "../src/space.ts";
import { checkedDriver } from "./space-helpers.ts";
import type { Fixture } from "./write-helpers.ts";

/**
 * Runs `fn` on the space's writable connection in one transaction, with the fixture's writer
 * closed around it, and returns what `fn` returns. The fixture's writer is a new one afterwards.
 */
export async function directly<T>(f: Fixture, fn: (conn: Connection) => NotPromise<T>): Promise<T> {
  f.writer.close();
  const opened = openSpace(await checkedDriver(), f.folder, { role: "writer" });
  try {
    return opened.conn.transaction("immediate", () => fn(opened.conn));
  } finally {
    opened.conn.close();
    f.reopen();
  }
}

export const lastSeq = (conn: Connection): number =>
  decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get()).lastSeq;

export const taskChange = (id: string, field: string): IndexedChange => ({
  entity: "tasks",
  entityId: id,
  taskId: id,
  action: "set",
  field,
});

/** A tombstone, as `task.delete` will write it (A1 3.11.4). */
export function tombstone(conn: Connection, id: string, human: string): void {
  conn
    .prepare("UPDATE tasks SET deleted_at = 1, deleted_by = $by WHERE id = $id")
    .run({ id, by: human });
  indexChanges(conn, lastSeq(conn), [taskChange(id, "deleted")]);
}

/** A restore, as `task.restore` will write it. */
export function restore(conn: Connection, id: string): void {
  conn.prepare("UPDATE tasks SET deleted_at = NULL, deleted_by = NULL WHERE id = $id").run({ id });
  indexChanges(conn, lastSeq(conn), [taskChange(id, "deleted")]);
}

/**
 * Entity redaction's effect on state (A1 3.11.4): the task and its children leave every table,
 * and their documents leave the index.
 */
export function redactTask(conn: Connection, id: string): void {
  for (const table of ["task_sources", "task_labels", "notes", "log_entries", "learnings"]) {
    conn.prepare(`DELETE FROM ${table} WHERE task_id = $id`).run({ id });
  }
  conn.prepare("DELETE FROM places WHERE owner_kind = 'task' AND owner_id = $id").run({ id });
  conn.prepare("DELETE FROM tasks WHERE id = $id").run({ id });
  indexChanges(conn, lastSeq(conn), [taskChange(id, "deleted")]);
}

/** Text redaction's effect: `text` becomes `[redacted]` in every text, then a re-index. */
export function redactText(conn: Connection, text: string): void {
  for (const [table, column] of [
    ["tasks", "title"],
    ["tasks", "summary"],
    ["tasks", "context"],
    ["tasks", "outcome"],
    ["notes", "body"],
    ["log_entries", "body"],
    ["learnings", "body"],
    ["sources", "title"],
  ] as const) {
    conn
      .prepare(`UPDATE ${table} SET ${column} = replace(${column}, $text, '[redacted]')`)
      .run({ text });
  }
  const ids = conn.prepare("SELECT id FROM tasks").all<{ id: string }>();
  indexChanges(
    conn,
    lastSeq(conn),
    ids.map((t) => taskChange(t.id, "title")),
  );
}

/** A learning on `task`, as wrap-up will add it. Returns its ID. */
export function addLearning(conn: Connection, task: string, body: string, human: string): string {
  const id = newId("lr");
  conn
    .prepare(
      "INSERT INTO learnings (id, task_id, position, body, created_by, created_at, created_seq, " +
        "version) VALUES ($id, $task, 'a0', $body, $by, 1, $seq, $seq)",
    )
    .run({ id, task, body, by: human, seq: lastSeq(conn) });
  indexChanges(conn, lastSeq(conn), [
    { entity: "learnings", entityId: id, taskId: task, action: "create", field: null },
  ]);
  return id;
}

/**
 * A new authority incarnation, in the next epoch or in the same one (two claims of one backup can
 * reach the same epoch, A1 3.5), with its lineage entry, as a claim writes them (A1 3.18).
 */
export function changeAuthority(conn: Connection, what: "epoch" | "incarnation"): void {
  const space = decodeSpaceRow(conn.prepare("SELECT * FROM space WHERE one = 1").get());
  const incarnation = newId("ai");
  const epoch = space.authority.epoch + (what === "epoch" ? 1 : 0);
  const entry = {
    incarnation,
    epoch,
    kind: "claim",
    parent: { incarnation: space.authority.incarnation, through_seq: space.lastSeq },
    machine_id: space.authority.machineId,
    at: 1,
  };
  const lineage = { ...space.lineage, incarnations: [...space.lineage.incarnations, entry] };
  conn
    .prepare(
      "UPDATE space SET authority_epoch = $epoch, authority_incarnation = $incarnation, " +
        "lineage = $lineage WHERE one = 1",
    )
    .run({ epoch, incarnation, lineage: JSON.stringify(lineage) });
}
