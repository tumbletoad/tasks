// Pages and a node's texts in the write path: their statements, how a page is found by its
// reference, and the rule of `page.edit`. A page is shown while it and what holds it live; one whose
// task or project went to the Trash is not found, and comes back with it unwritten.
import type { Connection, Row } from "../driver.ts";
import { parseTaskRef } from "../refs.ts";

/** The characters of a page an unapplied edit answers with: the rest is read with its cursor. */
export const EXCERPT_CHARS = 1_200;

/** A page whose holder lives: its row, and the task that holds it when one does. */
const LIVE_OWNER =
  "((p.owner_kind = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = p.owner_id " +
  "AND t.deleted_at IS NULL)) " +
  "OR (p.owner_kind = 'project' AND EXISTS (SELECT 1 FROM projects r WHERE r.id = p.owner_id " +
  "AND r.deleted_at IS NULL)) " +
  "OR (p.owner_kind = 'area' AND EXISTS (SELECT 1 FROM areas a WHERE a.id = p.owner_id " +
  "AND a.deleted_at IS NULL)) " +
  "OR p.owner_kind = 'space')";

export const PAGE_SQL = {
  byId: `SELECT p.*, ${LIVE_OWNER} AS shown FROM pages p WHERE p.id = $id`,
  byRef: `SELECT p.*, ${LIVE_OWNER} AS shown FROM pages p WHERE p.ref = $ref`,
  page: "SELECT * FROM pages WHERE id = $id",
  insert:
    "INSERT INTO pages (id, ref, owner_kind, owner_id, title, brief, body, created_at, " +
    "created_by, created_seq, version) VALUES ($id, $ref, $owner_kind, $owner_id, $title, " +
    "$brief, $body, $at, $by, $seq, $seq)",
  title: "UPDATE pages SET title = $value WHERE id = $id",
  brief: "UPDATE pages SET brief = $value WHERE id = $id",
  body: "UPDATE pages SET body = $value WHERE id = $id",
  owner: "UPDATE pages SET owner_kind = $kind, owner_id = $owner WHERE id = $id",
  deleted: "UPDATE pages SET deleted_at = $at, deleted_by = $by WHERE id = $id",
  versions: "UPDATE pages SET version = $seq, fv = $fv, fp = $fp WHERE id = $id",
  /** The body a change left: its create's, or the one its set wrote. */
  bodyAt:
    "SELECT CASE action WHEN 'create' THEN json_extract(after, '$.body') " +
    "ELSE json_extract(after, '$') END AS body FROM changes " +
    "WHERE entity = 'pages' AND entity_id = $id AND seq = $seq " +
    "AND (action = 'create' OR field = 'body')",
  text: "SELECT * FROM node_texts WHERE owner_id = $id",
  insertText:
    "INSERT INTO node_texts (owner_id, owner_kind, brief, description, for_agents, " +
    "created_seq, version) VALUES ($id, $kind, $brief, $description, $for_agents, $seq, $seq)",
  textBrief: "UPDATE node_texts SET brief = $value WHERE owner_id = $id",
  textDescription: "UPDATE node_texts SET description = $value WHERE owner_id = $id",
  textForAgents: "UPDATE node_texts SET for_agents = $value WHERE owner_id = $id",
  textVersions: "UPDATE node_texts SET version = $seq, fv = $fv, fp = $fp WHERE owner_id = $id",
} as const;

/**
 * A page by its reference (`M-180`, the space's prefix) or its ID, as it stands, with whether it is
 * shown. Undefined when the space has no such page.
 */
export function findPage(
  conn: Connection,
  given: string,
  refPrefix: string,
): (Row & { shown: number }) | undefined {
  const parsed = parseTaskRef(given);
  const row =
    parsed !== undefined && parsed.prefix === refPrefix
      ? conn.prepare(PAGE_SQL.byRef).get({ ref: parsed.ref })
      : conn.prepare(PAGE_SQL.byId).get({ id: given });
  return row as (Row & { shown: number }) | undefined;
}

/** How often `words` stand in `text`, not overlapping, and where the first stands. */
export function occurrences(text: string, words: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + words.length)) {
    if (first === -1) first = at;
    count += 1;
  }
  return { count, first };
}

/** The start of a page's body, whole code points, ending in what was left out. */
export function excerptOf(body: string): string {
  const chars = Array.from(body);
  if (chars.length <= EXCERPT_CHARS) return body;
  return `${chars.slice(0, EXCERPT_CHARS).join("")}... (+${String(chars.length - EXCERPT_CHARS)} chars)`;
}

/** What `page.append` leaves: the text after a blank line, or the text alone on an empty body. */
export const appended = (body: string, text: string): string =>
  body === "" ? text : `${body.replace(/\n+$/u, "")}\n\n${text}`;
