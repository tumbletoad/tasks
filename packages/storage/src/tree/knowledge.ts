// The tree's commands for what is known on a node beside its notes: pages, and a node's brief,
// description and text for agents. A page sits on one node; one whose task went to the Trash is not
// found, and comes back with it without being written. A page's earlier versions are its change
// rows.
//
// An edit replaces old words with new words, by step 1's rule (write/pages.ts): it applies while
// the old words stand once in the page, overlapping matches counted, whatever else changed since,
// so two agents editing different passages both stand: it is checked against no base. Old words
// that are gone, or stand more than once, write nothing, and the answer says how often they stand
// with the page's start as it is now. An edit or an append finishes the body as a body sent whole
// is stored, within the same size.
import type { Row } from "../driver.ts";
import { appended, excerptOf, finishedBody, occurrences } from "../write/pages.ts";
import type { Fields } from "../write/request.ts";
import {
  BRIEF,
  findNode,
  findPage,
  KEY,
  NOTE,
  problem,
  read,
  refText,
  required,
  str,
  TITLE,
  type Check,
} from "./commands.ts";
import type { Command, Tx } from "./tx.ts";

type Run = Command["run"];

const SQL = {
  /** The body a change left on a page: its create's, or the one its set wrote. */
  bodyAt:
    "SELECT CASE action WHEN 'create' THEN json_extract(after, '$.body') " +
    "ELSE json_extract(after, '$') END AS body FROM changes " +
    "WHERE entity = 'pages' AND entity_id = $id AND seq = $seq AND (action = 'create' OR field = 'body')",
} as const;

/** A live node to hold a page, or whose texts change: a project, a task or the space. */
function liveNode(tx: Tx, key: unknown, field: string): Row {
  const found = findNode(tx, key);
  if (found === undefined) return problem("NOT_FOUND", "The space has nothing of that name", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  return found;
}

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

const pageCreate: Run = (tx, input) => {
  const owner = String(liveNode(tx, input["on"], "on")["id"]);
  const id = str(input, "id") ?? tx.newId("pg");
  const ref = tx.ref();
  tx.create(
    "pages",
    {
      id,
      ref,
      owner_id: owner,
      title: str(input, "title") ?? "",
      brief: str(input, "brief") ?? "",
      body: str(input, "body") ?? "",
      created_at: tx.at,
      created_by: tx.author,
    },
    owner,
  );
  return { page: { id, ref: refText(tx, ref) } };
};

const pageEdit: Run = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const old = str(input, "old") ?? "";
  const words = String(page["body"]);
  const { count, first } = occurrences(words, old);
  if (count !== 1) return pageAnswer(tx, page, { found: count, excerpt: excerptOf(words) });
  const edited = finishedBody(
    words.slice(0, first) + (str(input, "new") ?? "") + words.slice(first + old.length),
  );
  if (edited === undefined) {
    return problem("TOO_LARGE", "The page would be larger than a page may be", "new");
  }
  tx.set("pages", String(page["id"]), String(page["owner_id"]), { body: edited }, false);
  return pageAnswer(tx, page, { found: 1 });
};

const pageAppend: Run = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const words = finishedBody(appended(String(page["body"]), str(input, "text") ?? ""));
  if (words === undefined) {
    return problem("TOO_LARGE", "The page would be larger than a page may be", "text");
  }
  tx.set("pages", String(page["id"]), String(page["owner_id"]), { body: words }, false);
  return pageAnswer(tx, page);
};

/** A page's title, brief or body, or its body as an earlier version left it: Restore. */
const pageSet: Run = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const id = String(page["id"]);
  let words = str(input, "body");
  if (input["from_seq"] !== undefined) {
    const version = tx.get(SQL.bodyAt, { id, seq: Number(input["from_seq"]) })?.["body"];
    if (typeof version !== "string") {
      return problem("NOT_FOUND", "The page has no version made by this change", "from_seq");
    }
    words = version;
  }
  const set: Record<string, string> = {};
  for (const field of ["title", "brief"]) {
    const value = str(input, field);
    if (value !== undefined) set[field] = value;
  }
  if (words !== undefined) set["body"] = words;
  const changed = Object.fromEntries(Object.entries(set).filter(([f, v]) => page[f] !== v));
  if (Object.keys(changed).length > 0) tx.set("pages", id, String(page["owner_id"]), changed);
  return pageAnswer(tx, page);
};

/** A page moves to another node; its change rows belong to where it goes. */
const pageMove: Run = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const to = String(liveNode(tx, input["on"], "on")["id"]);
  if (page["owner_id"] !== to) tx.set("pages", String(page["id"]), to, { owner: to });
  return pageAnswer(tx, page, { on: to });
};

const pageTrashed =
  (trash: boolean): Run =>
  (tx, input) => {
    const page = livePage(tx, input["page"], !trash);
    tx.set("pages", String(page["id"]), String(page["owner_id"]), {
      deleted: { deleted_at: trash ? tx.at : null, deleted_by: trash ? tx.author : null },
    });
    return pageAnswer(tx, page);
  };

/** A node's brief and description: the words a person or an agent reads first about it. */
const nodeSet: Run = (tx, input) => {
  const node = liveNode(tx, input["node"], "node");
  const id = String(node["id"]);
  const set: Record<string, string> = {};
  for (const field of ["brief", "description"]) {
    const value = str(input, field);
    if (value !== undefined && node[field] !== value) set[field] = value;
  }
  if (Object.keys(set).length > 0) tx.set("nodes", id, id, set);
  return { node: { id } };
};

/** The text for agents on the space or a project: instructions, so only a person writes it. */
const nodeInstruct: Run = (tx, input) => {
  if (tx.request.actor.actor_kind !== "human") {
    problem("USER_ONLY", "Only a person writes the text for agents", "text");
  }
  const node = liveNode(tx, input["node"], "node");
  if (node["kind"] === "task") {
    problem("VALIDATION_FAILED", "A task's instructions are its notes for agents", "node");
  }
  const id = String(node["id"]);
  const words = str(input, "text") ?? "";
  if (node["for_agents"] !== words) tx.set("nodes", id, id, { for_agents: words });
  return { node: { id } };
};

// The checks, through the one `Fields` today's writer reads with.

const onePage: Check = (f) => {
  required(f, "page");
  return read(f, { page: (k) => f.text(k, KEY) });
};

const checkCreate: Check = (f) => {
  required(f, "on");
  required(f, "title");
  return read(f, {
    id: (k) => f.id(k, "pg"),
    on: (k) => f.text(k, KEY),
    title: (k) => f.text(k, TITLE),
    brief: (k) => f.text(k, BRIEF),
    body: (k) => f.text(k, { ...NOTE, empty: true }),
  });
};

const checkEdit: Check = (f) => {
  for (const key of ["page", "old", "new"]) required(f, key);
  return read(f, {
    page: (k) => f.text(k, KEY),
    old: (k) => f.text(k, NOTE),
    new: (k) => f.text(k, { ...NOTE, empty: true }),
  });
};

const checkAppend: Check = (f) => {
  required(f, "page");
  required(f, "text");
  return read(f, { page: (k) => f.text(k, KEY), text: (k) => f.text(k, NOTE) });
};

const checkSet: Check = (f) => {
  required(f, "page");
  return read(f, {
    page: (k) => f.text(k, KEY),
    title: (k) => f.text(k, TITLE),
    brief: (k) => f.text(k, BRIEF),
    body: (k) => f.text(k, { ...NOTE, empty: true }),
    from_seq: (k) => f.int(k, 1, Number.MAX_SAFE_INTEGER),
  });
};

const checkMove: Check = (f) => {
  required(f, "page");
  required(f, "on");
  return read(f, { page: (k) => f.text(k, KEY), on: (k) => f.text(k, KEY) });
};

const nodeKey = (f: Fields) => (k: string) => f.text(k, KEY);

const checkNodeSet: Check = (f) => {
  required(f, "node");
  return read(f, {
    node: nodeKey(f),
    brief: (k) => f.text(k, BRIEF),
    description: (k) => f.text(k, { ...NOTE, empty: true }),
  });
};

const checkInstruct: Check = (f) => {
  required(f, "node");
  required(f, "text");
  return read(f, { node: nodeKey(f), text: (k) => f.text(k, { ...NOTE, empty: true }) });
};

export const KNOWLEDGE: Readonly<Record<string, Command>> = {
  "page.create": { check: checkCreate, run: pageCreate },
  "page.edit": { check: checkEdit, run: pageEdit },
  "page.append": { check: checkAppend, run: pageAppend },
  "page.set": { check: checkSet, run: pageSet },
  "page.move": { check: checkMove, run: pageMove },
  "page.trash": { check: onePage, run: pageTrashed(true) },
  "page.restore": { check: onePage, run: pageTrashed(false) },
  "node.set": { check: checkNodeSet, run: nodeSet },
  "node.instruct": { check: checkInstruct, run: nodeInstruct },
};
