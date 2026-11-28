// What the tree's commands share to read their input: a node, a task or a page by its ID, its
// reference (`M-14`) or, for a project, its path; checked text, stored in the one form today's
// writer stores (write/request.ts normaliseStored); where a new row goes; and a note on a node or
// a page. Every refusal is a TreeProblem, so nothing of the request is written.
import type { Row } from "../driver.ts";
import { isId } from "../ids.ts";
import { formatTaskRef, parseTaskRef } from "../refs.ts";
import { positionBetween } from "../write/positions.ts";
import { normaliseStored } from "../write/request.ts";
import { TreeProblem } from "./fields.ts";
import type { Tx } from "./tx.ts";

export type Input = Record<string, unknown>;

const SQL = {
  node: "SELECT * FROM nodes WHERE id = $id",
  taskByRef: "SELECT id FROM tasks WHERE ref = $ref",
  child:
    "SELECT * FROM nodes WHERE parent_id = $parent AND kind = 'project' AND (slug = $slug OR lower(title) = $title)",
  lastPosition: "SELECT max(position) AS p FROM nodes WHERE parent_id = $parent AND kind = $kind",
  task:
    "SELECT n.id, n.parent_id, n.title, n.deleted_at, n.fp AS node_fp, n.created_seq AS node_seq, " +
    "t.ref, t.lifecycle, t.wrap_state, t.outcome FROM nodes n JOIN tasks t ON t.id = n.id WHERE n.id = $id",
  lastOrdinal: "SELECT max(ordinal) AS o FROM notes WHERE owner_id = $owner",
  /** A page, with whether what holds it lives: one under a task in the Trash is hidden. */
  page:
    "SELECT p.*, o.deleted_at IS NULL AS shown FROM pages p JOIN nodes o ON o.id = p.owner_id " +
    "WHERE p.id = $id OR p.ref = $ref",
} as const;

export const problem = (code: string, message: string, field?: string, data?: unknown): never => {
  throw new TreeProblem(code, message, field, data);
};

/**
 * A text field, normalised as stored text is (LF line endings, no C0 controls but tab and newline,
 * NFC) and then checked: at most `max` characters, and on one line unless `oneLine` is false.
 */
export const text = (
  input: Input,
  field: string,
  max: number,
  oneLine = true,
): string | undefined => {
  const given = input[field];
  if (given === undefined) return undefined;
  const value = typeof given === "string" ? normaliseStored(given) : undefined;
  if (value === undefined || Array.from(value).length > max || (oneLine && value.includes("\n"))) {
    return problem(
      "VALIDATION_FAILED",
      `Expected ${field} as text of at most ${String(max)}`,
      field,
    );
  }
  return value;
};

export const title = (input: Input): string => {
  const value = text(input, "title", 300);
  if (value === undefined || value.trim() === "")
    problem("VALIDATION_FAILED", "A title is needed", "title");
  return value as string;
};

/** An ID the caller chose for a new row: one of its kind that the space does not hold yet. */
export function givenId(
  value: unknown,
  prefix: "t" | "p" | "pg",
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isId(value, prefix)) return problem("VALIDATION_FAILED", "Not an ID of that kind", field);
  return value;
}

/** A node by ID, or a task by its reference (`M-14`). Undefined when the space has none. */
export function findNode(tx: Tx, key: unknown): Row | undefined {
  if (typeof key !== "string") return undefined;
  const ref = parseTaskRef(key);
  if (ref !== undefined) {
    if (ref.prefix !== tx.space.refPrefix) return undefined;
    const id = tx.get(SQL.taskByRef, { ref: ref.ref })?.["id"];
    return typeof id === "string" ? tx.get(SQL.node, { id }) : undefined;
  }
  if (key === "space") return tx.get(SQL.node, { id: tx.space.spaceId });
  const byId = tx.get(SQL.node, { id: key });
  if (byId !== undefined) return byId;
  // A project path: each part is a project's slug or title, ignoring case.
  let at: Row | undefined = tx.get(SQL.node, { id: tx.space.spaceId });
  for (const part of key.split("/")) {
    const wanted = part.trim().toLowerCase();
    at = tx.get(SQL.child, { parent: String(at?.["id"]), slug: wanted, title: wanted });
    if (at === undefined) return undefined;
  }
  return at;
}

/** A task by its key: live, in the Trash (`deleted` true), or either. */
export function liveTask(
  tx: Tx,
  key: unknown,
  field = "task",
  deleted: boolean | "either" = false,
): Row {
  const found = findNode(tx, key);
  if (found?.["kind"] !== "task") return problem("NOT_FOUND", "The space has no such task", field);
  const task = tx.get(SQL.task, { id: String(found["id"]) }) as Row;
  if (deleted !== "either" && (task["deleted_at"] !== null) !== deleted) {
    problem(
      deleted ? "INVALID_TRANSITION" : "DELETED",
      deleted ? "The task is not in the Trash" : "The task is in the Trash",
      field,
    );
  }
  return task;
}

/** The end of a parent's children of one kind. */
export const endOf = (tx: Tx, parent: string, kind: string): string => {
  const last = tx.get(SQL.lastPosition, { parent, kind })?.["p"];
  return positionBetween(typeof last === "string" ? last : undefined, undefined);
};

export const refText = (tx: Tx, ref: unknown): string =>
  formatTaskRef(tx.space.refPrefix, Number(ref));

/** Where a new or moved task goes: a live project, a live task, or the space. */
export function parentFor(tx: Tx, under: unknown, field: string): Row {
  const found =
    under === undefined ? tx.get(SQL.node, { id: tx.space.spaceId }) : findNode(tx, under);
  if (found === undefined)
    return problem("NOT_FOUND", "Nothing of that name to put it under", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  if (found["archived_at"] !== null && found["archived_at"] !== undefined) {
    problem("INVALID_TRANSITION", "That project is archived", field);
  }
  return found;
}

export function addNote(
  tx: Tx,
  owner: string,
  node: string,
  body: string,
  kind = "note",
  agents = false,
) {
  const last = tx.get(SQL.lastOrdinal, { owner })?.["o"];
  const ordinal = (typeof last === "number" ? last : 0) + 1;
  const id = tx.newId("n");
  tx.create(
    "notes",
    {
      id,
      owner_id: owner,
      ordinal,
      kind,
      for_agents: agents ? 1 : 0,
      author_id: tx.author,
      session_id: tx.request.actor.session_id ?? null,
      run_id: tx.request.actor.run_id ?? null,
      body,
      created_at: tx.at,
    },
    node,
  );
  return { id, ordinal };
}

/** A page by its reference or ID while what holds it lives, or undefined. */
export function findPage(tx: Tx, key: unknown): Row | undefined {
  if (typeof key !== "string") return undefined;
  const parsed = parseTaskRef(key);
  const ref = parsed !== undefined && parsed.prefix === tx.space.refPrefix ? parsed.ref : -1;
  const row = tx.get(SQL.page, { id: key, ref });
  return row?.["shown"] === 1 ? row : undefined;
}

/** A live node to hold a page or a note: a project, a task or the space. */
export function liveNode(tx: Tx, key: unknown, field: string): Row {
  const found = findNode(tx, key);
  if (found === undefined) return problem("NOT_FOUND", "The space has nothing of that name", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  return found;
}
