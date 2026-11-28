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
// is stored, within the same size. Which input is refused, which write is held to a base and what
// changes nothing are today's writer's rules, read and decided by the same functions
// (write/request.ts, write/pages.ts).
import type { Row } from "../driver.ts";
import {
  appended,
  excerptOf,
  finishedBody,
  nodeTexts,
  occurrences,
  pageInTrashAlready,
  pageSetTexts,
  textWrite,
} from "../write/pages.ts";
import {
  nodeInstructFields,
  nodeSetFields,
  pageAppendFields,
  pageCreateFields,
  pageEditFields,
  pageSetFields,
  type Fields,
} from "../write/request.ts";
import {
  findNode,
  findPage,
  KEY,
  problem,
  read,
  refText,
  required,
  str,
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

/** A page that is shown; one in the Trash only when `restoring`. */
function livePage(tx: Tx, key: unknown, restoring = false): Row {
  const page = findPage(tx, key) ?? problem("NOT_FOUND", "The space has no page there", "page");
  if (page["deleted_at"] !== null && !restoring) {
    problem("DELETED", "The page is in the Trash", "page");
  }
  return page;
}

/** Whether any of a node's texts was written since it was made: then each is held to a base. */
const textsWritten = (node: Row): boolean => {
  const fv = JSON.parse(String(node["fv"])) as Record<string, unknown>;
  return ["brief", "description", "for_agents"].some((field) => field in fv);
};

const pageAnswer = (tx: Tx, page: Row, extra: Record<string, unknown> = {}) => ({
  page: { id: page["id"], ref: refText(tx, page["ref"]) },
  ...extra,
});

const pageCreate: Run = (tx, input) => {
  const owner = String(liveNode(tx, input["owner"], "on")["id"]);
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
  const owner = String(page["owner_id"]);
  let version: string | undefined;
  if (input["from_seq"] !== undefined) {
    const found = tx.get(SQL.bodyAt, { id, seq: Number(input["from_seq"]) })?.["body"];
    if (typeof found !== "string") {
      return problem("NOT_FOUND", "The page has no version made by this change", "from_seq");
    }
    version = found;
  }
  const { held, set } = textWrite(
    pageSetTexts(input, version),
    (field) => String(page[field]),
    true,
  );
  if (tx.held("pages", id, owner, held)) return pageAnswer(tx, page);
  if (Object.keys(set).length > 0) tx.set("pages", id, owner, set, false);
  return pageAnswer(tx, page);
};

/** A page moves to another node; its change rows belong to where it goes. */
const pageMove: Run = (tx, input) => {
  const page = livePage(tx, input["page"]);
  const to = String(liveNode(tx, input["on"], "on")["id"]);
  if (page["owner_id"] !== to) tx.set("pages", String(page["id"]), to, { owner: to }, false);
  return pageAnswer(tx, page, { on: to });
};

const pageTrashed =
  (trash: boolean): Run =>
  (tx, input) => {
    const page = livePage(tx, input["page"], !trash);
    if (pageInTrashAlready(page["deleted_at"] !== null, !trash)) return pageAnswer(tx, page);
    const deleted = { deleted_at: trash ? tx.at : null, deleted_by: trash ? tx.author : null };
    tx.set("pages", String(page["id"]), String(page["owner_id"]), { deleted }, false);
    return pageAnswer(tx, page);
  };

/** Whole texts of a node, held to a base once its texts were written. */
function setTexts(tx: Tx, node: Row, given: ReturnType<typeof nodeTexts>): void {
  const id = String(node["id"]);
  const { held, set } = textWrite(given, (field) => String(node[field]), textsWritten(node));
  if (tx.held("nodes", id, id, held)) return;
  if (Object.keys(set).length > 0) tx.set("nodes", id, id, set, false);
}

/** A node's brief and description: the words a person or an agent reads first about it. */
const nodeSet: Run = (tx, input) => {
  const node = liveNode(tx, input["node"], "node");
  setTexts(tx, node, nodeTexts({ kind: "node.set", ...input }));
  return { node: { id: node["id"] } };
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
  setTexts(tx, node, nodeTexts({ kind: "node.instruct", text: str(input, "text") ?? "" }));
  return { node: { id: node["id"] } };
};

// The checks: today's readers (write/request.ts), with the page and the node named by key.

const keyOf =
  (name: string) =>
  (f: Fields): string =>
    f.text(name, KEY);

/** Today's reader, then nothing left unread. */
const whole =
  (reader: (f: Fields) => object): Check =>
  (f) => {
    const out = { ...reader(f) } as Record<string, unknown>;
    f.done();
    return out;
  };

const onePage: Check = (f) => {
  required(f, "page");
  return read(f, { page: (k) => f.text(k, KEY) });
};

const checkCreate: Check = (f) => {
  const id = f.has("id") ? f.id("id", "pg") : undefined;
  required(f, "on");
  const out = { ...pageCreateFields(f, keyOf("on")), ...(id === undefined ? {} : { id }) };
  f.done();
  return out;
};

const checkMove: Check = (f) => {
  required(f, "page");
  required(f, "on");
  return read(f, { page: (k) => f.text(k, KEY), on: (k) => f.text(k, KEY) });
};

export const KNOWLEDGE: Readonly<Record<string, Command>> = {
  "page.create": { check: checkCreate, run: pageCreate },
  "page.edit": { check: whole((f) => pageEditFields(f, keyOf("page"))), run: pageEdit },
  "page.append": { check: whole((f) => pageAppendFields(f, keyOf("page"))), run: pageAppend },
  "page.set": { check: whole((f) => pageSetFields(f, keyOf("page"))), run: pageSet },
  "page.move": { check: checkMove, run: pageMove },
  "page.trash": { check: onePage, run: pageTrashed(true) },
  "page.restore": { check: onePage, run: pageTrashed(false) },
  // A tree node holds its brief in one place, whatever its kind.
  "node.set": { check: whole((f) => nodeSetFields(f, keyOf("node"), () => true)), run: nodeSet },
  "node.instruct": { check: whole((f) => nodeInstructFields(f, keyOf("node"))), run: nodeInstruct },
};
