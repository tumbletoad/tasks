// The tree's commands for what is known on a node: notes (log entries and learnings in the same
// thread, and a page's comments), pages, and a node's brief, description and text for agents. A
// page sits on one node; one whose task went to the Trash is not found, and comes back with it
// without being written. A page's earlier versions are its change rows.
//
// An edit replaces old words with new words, by step 1's rule (write/pages.ts): it applies while
// the old words stand once in the page, overlapping matches counted, whatever else changed since,
// so two agents editing different passages both stand: it is checked against no base. Old words
// that are gone, or stand more than once, write nothing, and the answer says how often they stand
// with the page's start as it is now. An edit or an append finishes the body as a body sent whole
// is stored, within the same size.
import type { Row } from "../driver.ts";
import { isId } from "../ids.ts";
import { appended, excerptOf, finishedBody, occurrences } from "../write/pages.ts";
import { normaliseStored, WRITE_LIMITS } from "../write/request.ts";
import {
  addNote,
  findNode,
  findPage,
  givenId,
  liveNode,
  problem,
  refText,
  text,
  title,
  type Input,
} from "./inputs.ts";
import type { Command, Tx } from "./tx.ts";

const NOTE_KINDS = [
  "note",
  "progress",
  "evidence",
  "blocker",
  "decision",
  "question",
  "handoff",
  "learning",
];

const SQL = {
  note: "SELECT * FROM notes WHERE id = $id",
  noteAt: "SELECT * FROM notes WHERE owner_id = $owner AND ordinal = $ordinal",
  /** The body a change left on a page: its create's, or the one its set wrote. */
  bodyAt:
    "SELECT CASE action WHEN 'create' THEN json_extract(after, '$.body') " +
    "ELSE json_extract(after, '$') END AS body FROM changes " +
    "WHERE entity = 'pages' AND entity_id = $id AND seq = $seq AND (action = 'create' OR field = 'body')",
} as const;

/** A body: a note's, a page's, a description or a text for agents, stored as today's writer does. */
const body = (input: Input, field: string, required = false): string | undefined => {
  const given = input[field];
  if (given === undefined && !required) return undefined;
  const value = typeof given === "string" ? normaliseStored(given) : undefined;
  if (value === undefined || Buffer.byteLength(value, "utf8") > WRITE_LIMITS.note) {
    return problem("VALIDATION_FAILED", `Expected ${field} as text of at most 64 KiB`, field);
  }
  return value;
};

/** A page that is shown; one in the Trash only when `trashed`. */
function livePage(tx: Tx, key: unknown, trashed = false): Row {
  const page = findPage(tx, key) ?? problem("NOT_FOUND", "The space has no page there", "page");
  if ((page["deleted_at"] !== null) !== trashed) {
    problem(
      trashed ? "INVALID_TRANSITION" : "DELETED",
      trashed ? "The page is not in the Trash" : "The page is in the Trash",
      "page",
    );
  }
  return page;
}

const pageAnswer = (tx: Tx, page: Row, extra: Record<string, unknown> = {}) => ({
  page: { id: page["id"], ref: refText(tx, page["ref"]) },
  ...extra,
});

/** What a note is on, and the node its change rows belong to: a node, or a page and its node. */
function noteOwner(tx: Tx, key: unknown): { owner: string; node: string } {
  const page = findPage(tx, key);
  if (page !== undefined) {
    if (page["deleted_at"] !== null) problem("DELETED", "The page is in the Trash", "on");
    return { owner: String(page["id"]), node: String(page["owner_id"]) };
  }
  const node = liveNode(tx, key, "on");
  return { owner: String(node["id"]), node: String(node["id"]) };
}

/**
 * A note by ID, or by its owner and ordinal, with the node its change rows belong to. A note's
 * words and its removal are the person's to correct: an agent writes a new note instead.
 */
function personsNote(tx: Tx, input: Input): { note: Row; node: string } {
  if (tx.request.actor.actor_kind !== "human") {
    problem("USER_ONLY", "Only a person corrects or removes a note", "note");
  }
  const on = input["on"];
  const note =
    typeof input["note"] === "string"
      ? tx.get(SQL.note, { id: input["note"] })
      : tx.get(SQL.noteAt, {
          owner: String(findPage(tx, on)?.["id"] ?? findNode(tx, on)?.["id"]),
          ordinal: Number(input["ordinal"]),
        });
  if (note === undefined) return problem("NOT_FOUND", "The space has no such note", "note");
  const owner = String(note["owner_id"]);
  const node = isId(owner, "pg") ? String(findPage(tx, owner)?.["owner_id"] ?? owner) : owner;
  return { note, node };
}

const noteAdd: Command = (tx, input) => {
  const { owner, node } = noteOwner(tx, input["on"]);
  const kind = input["kind"] ?? "note";
  if (typeof kind !== "string" || !NOTE_KINDS.includes(kind)) {
    problem("VALIDATION_FAILED", "Not a kind of note", "kind");
  }
  const words = body(input, "body", true) ?? "";
  if (words.trim() === "") problem("VALIDATION_FAILED", "A note needs words", "body");
  return { note: addNote(tx, owner, node, words, kind as string, input["for_agents"] === true) };
};

const noteEdit: Command = (tx, input) => {
  const { note, node } = personsNote(tx, input);
  const words = body(input, "body", true) ?? "";
  if (words.trim() === "") problem("VALIDATION_FAILED", "A note needs words", "body");
  if (note["body"] !== words) {
    tx.set("notes", String(note["id"]), node, { body: { body: words, edited_at: tx.at } });
  }
  return { note: { id: note["id"], ordinal: note["ordinal"] } };
};

const noteGone =
  (gone: boolean): Command =>
  (tx, input) => {
    const { note, node } = personsNote(tx, input);
    tx.set("notes", String(note["id"]), node, { deleted: gone ? tx.at : null });
    return { note: { id: note["id"], ordinal: note["ordinal"] } };
  };

const pageCreate: Command = (tx, input) => {
  const owner = String(liveNode(tx, input["on"], "on")["id"]);
  const id = givenId(input["id"], "pg", "id") ?? tx.newId("pg");
  const ref = tx.ref();
  tx.create(
    "pages",
    {
      id,
      ref,
      owner_id: owner,
      title: title(input),
      brief: text(input, "brief", 400) ?? "",
      body: body(input, "body") ?? "",
      created_at: tx.at,
      created_by: tx.author,
    },
    owner,
  );
  return { page: { id, ref: refText(tx, ref) } };
};

const pageEdit: Command = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const old = body(input, "old", true) ?? "";
  const now = body(input, "new", true) ?? "";
  if (old === "") problem("VALIDATION_FAILED", "Name the words to replace", "old");
  const words = String(page["body"]);
  const { count, first } = occurrences(words, old);
  if (count !== 1) return pageAnswer(tx, page, { found: count, excerpt: excerptOf(words) });
  const edited = finishedBody(words.slice(0, first) + now + words.slice(first + old.length));
  if (edited === undefined)
    problem("TOO_LARGE", "The page would be larger than a page may be", "new");
  tx.set("pages", String(page["id"]), String(page["owner_id"]), { body: edited ?? "" }, false);
  return pageAnswer(tx, page, { found: 1 });
};

const pageAppend: Command = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const more = body(input, "text", true) ?? "";
  if (more.trim() === "") problem("VALIDATION_FAILED", "Give the text to add", "text");
  const words = finishedBody(appended(String(page["body"]), more));
  if (words === undefined)
    problem("TOO_LARGE", "The page would be larger than a page may be", "text");
  tx.set("pages", String(page["id"]), String(page["owner_id"]), { body: words ?? "" }, false);
  return pageAnswer(tx, page);
};

/** A page's title, brief or body, or its body as an earlier version left it: Restore. */
const pageSet: Command = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const id = String(page["id"]);
  let words = body(input, "body");
  if (input["from_seq"] !== undefined) {
    const version = tx.get(SQL.bodyAt, { id, seq: Number(input["from_seq"]) })?.["body"];
    if (typeof version !== "string") {
      problem("NOT_FOUND", "The page has no version made by this change", "from_seq");
    }
    words = version as string;
  }
  const set: Record<string, string> = {};
  if (input["title"] !== undefined) set["title"] = title(input);
  if (input["brief"] !== undefined) set["brief"] = text(input, "brief", 400) ?? "";
  if (words !== undefined) set["body"] = words;
  const changed = Object.fromEntries(Object.entries(set).filter(([f, v]) => page[f] !== v));
  if (Object.keys(changed).length > 0) tx.set("pages", id, String(page["owner_id"]), changed);
  return pageAnswer(tx, page);
};

/** A page moves to another node; its change rows belong to where it goes. */
const pageMove: Command = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const to = String(liveNode(tx, input["on"], "on")["id"]);
  if (page["owner_id"] !== to) tx.set("pages", String(page["id"]), to, { owner: to });
  return pageAnswer(tx, page, { on: to });
};

const pageTrashed =
  (trash: boolean): Command =>
  (tx, input) => {
    const page = livePage(tx, input["page"], !trash);
    tx.set("pages", String(page["id"]), String(page["owner_id"]), {
      deleted: { deleted_at: trash ? tx.at : null, deleted_by: trash ? tx.author : null },
    });
    return pageAnswer(tx, page);
  };

/** A node's brief and description: the words a person or an agent reads first about it. */
const nodeSet: Command = (tx, input) => {
  const node = liveNode(tx, input["node"], "node");
  const id = String(node["id"]);
  const set: Record<string, string> = {};
  if (input["brief"] !== undefined) set["brief"] = text(input, "brief", 400) ?? "";
  if (input["description"] !== undefined) set["description"] = body(input, "description") ?? "";
  const changed = Object.fromEntries(Object.entries(set).filter(([f, v]) => node[f] !== v));
  if (Object.keys(changed).length > 0) tx.set("nodes", id, id, changed);
  return { node: { id } };
};

/** The text for agents on the space or a project: instructions, so only a person writes it. */
const nodeInstruct: Command = (tx, input) => {
  if (tx.request.actor.actor_kind !== "human") {
    problem("USER_ONLY", "Only a person writes the text for agents", "text");
  }
  const node = liveNode(tx, input["node"], "node");
  if (node["kind"] === "task") {
    problem("VALIDATION_FAILED", "A task's instructions are its notes for agents", "node");
  }
  const id = String(node["id"]);
  const words = body(input, "text", true) ?? "";
  if (node["for_agents"] !== words) tx.set("nodes", id, id, { for_agents: words });
  return { node: { id } };
};

export const KNOWLEDGE: Readonly<Record<string, Command>> = {
  "note.add": noteAdd,
  "note.edit": noteEdit,
  "note.remove": noteGone(true),
  "note.put_back": noteGone(false),
  "page.create": pageCreate,
  "page.edit": pageEdit,
  "page.append": pageAppend,
  "page.set": pageSet,
  "page.move": pageMove,
  "page.trash": pageTrashed(true),
  "page.restore": pageTrashed(false),
  "node.set": nodeSet,
  "node.instruct": nodeInstruct,
};
