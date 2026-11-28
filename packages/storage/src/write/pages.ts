// Pages and a node's texts in the write path: their statements, how a page is found by its
// reference, and the rule of `page.edit`. A page is shown while it and what holds it live; one whose
// task or project went to the Trash is not found, and comes back with it unwritten.
import type { Connection, Row } from "../driver.ts";
import { parseTaskRef } from "../refs.ts";
import { normaliseStored, WRITE_LIMITS } from "./request.ts";

/** The characters of a page an unapplied edit answers with: the rest is read with its cursor. */
export const EXCERPT_CHARS = 1_200;

/**
 * Whether page row `p` is shown: what holds it lives. A page on a task or project in the Trash goes
 * with it, unwritten.
 */
export const PAGE_SHOWN =
  "((p.owner_kind = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = p.owner_id " +
  "AND t.deleted_at IS NULL)) " +
  "OR (p.owner_kind = 'project' AND EXISTS (SELECT 1 FROM projects r WHERE r.id = p.owner_id " +
  "AND r.deleted_at IS NULL)) " +
  "OR (p.owner_kind = 'area' AND EXISTS (SELECT 1 FROM areas a WHERE a.id = p.owner_id " +
  "AND a.deleted_at IS NULL)) " +
  "OR p.owner_kind = 'space')";

export const PAGE_SQL = {
  byId: `SELECT p.*, ${PAGE_SHOWN} AS shown FROM pages p WHERE p.id = $id`,
  byRef: `SELECT p.*, ${PAGE_SHOWN} AS shown FROM pages p WHERE p.ref = $ref`,
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

/**
 * How often `words` stand in `text`, overlapping ones too (`..` stands twice in `...`), and where
 * the first stands. An edit applies only to words that stand once.
 */
export function occurrences(text: string, words: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + 1)) {
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

/**
 * A body an append or an edit finished, in the form and within the size of a body sent whole:
 * normalised as stored text is, so words joined across the edit read as they show; undefined when
 * it would be larger than a body may be.
 */
export function finishedBody(body: string): string | undefined {
  const text = normaliseStored(body);
  return Buffer.byteLength(text, "utf8") > WRITE_LIMITS.note ? undefined : text;
}

/** What `page.append` leaves: the text after a blank line, or the text alone on an empty body. */
export const appended = (body: string, text: string): string =>
  body === "" ? text : `${body.replace(/\n+$/u, "")}\n\n${text}`;

/** Whole texts a request gives, field by field, in the order they are written. */
export type GivenTexts = readonly (readonly [field: string, value: string])[];

/** A page's set: its title, brief and body as given, the body a version left in place of one sent. */
export function pageSetTexts(
  op: { title?: string; brief?: string; body?: string },
  version: string | undefined,
): GivenTexts {
  const body = version ?? op.body;
  return [
    ...(op.title === undefined ? [] : [["title", op.title] as const]),
    ...(op.brief === undefined ? [] : [["brief", op.brief] as const]),
    ...(body === undefined ? [] : [["body", body] as const]),
  ];
}

/** A node's texts as `node.set` or `node.instruct` gives them. */
export function nodeTexts(
  op:
    | { kind: "node.set"; brief?: string; description?: string }
    | { kind: "node.instruct"; text: string },
): GivenTexts {
  if (op.kind === "node.instruct") return [["for_agents", op.text]];
  return [
    ...(op.brief === undefined ? [] : [["brief", op.brief] as const]),
    ...(op.description === undefined ? [] : [["description", op.description] as const]),
  ];
}

/**
 * What whole texts write where they are held now: the fields the caller's base holds the request
 * to, and the ones that change. Every given field is held to the base, the same words included, so a
 * save made on a stale read is a conflict also where it matches what is there. Texts never written
 * before hold nothing: a first description races nothing its person read. A page's texts were
 * written by its create, so they are always held.
 */
export function textWrite(
  given: GivenTexts,
  now: (field: string) => string,
  written: boolean,
): { held: string[]; set: Record<string, string> } {
  return {
    held: written ? given.map(([field]) => field) : [],
    set: Object.fromEntries(given.filter(([field, value]) => now(field) !== value)),
  };
}

/**
 * Whether a removal, or a putting back, finds what it names there already: a page in the Trash or
 * out of it, a source's link removed or back. Nothing is written, and the answer is unchanged. A
 * page's move to the Trash, out of it or to another holder is held to no base: each says where the
 * page goes, whatever else changed.
 */
export const alreadyThere = (removed: boolean, puttingBack: boolean): boolean =>
  removed !== puttingBack;
