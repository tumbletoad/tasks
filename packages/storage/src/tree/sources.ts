// The tree's commands for sources and links. A source is something from outside (a mail, a ticket,
// a document) on one node; a link points from a node to a page or a source elsewhere in the space.
// A source's key is its own column, and one live source holds it: a source added again with a key
// the space holds is linked where it was asked for, never made twice. A task a capture made keeps
// the source it came from (`tasks.origin_source_id`), so a repeat capture finds the task wherever
// the source has moved since (commands.ts, `tasks.add`).
import type { Row } from "../driver.ts";
import { positionBetween } from "../write/positions.ts";
import { sourceFields, type Fields } from "../write/request.ts";
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
  type Check,
  type Input,
} from "./commands.ts";
import type { Command, Tx } from "./tx.ts";

type Run = Command["run"];

const SQL = {
  /** A source, with whether what holds it lives: one under a task in the Trash is hidden. */
  source:
    "SELECT s.*, o.deleted_at IS NULL AS shown FROM sources s JOIN nodes o ON o.id = s.owner_id " +
    "WHERE s.id = $id OR s.ref = $ref",
  liveKey: "SELECT * FROM sources WHERE source_key = $key AND deleted_at IS NULL",
  link: "SELECT * FROM links WHERE owner_id = $owner AND target_id = $target",
  lastLink: "SELECT max(position) AS p FROM links WHERE owner_id = $owner",
} as const;

/** A source by its reference or ID while what holds it lives, or undefined. */
export function findSource(tx: Tx, key: unknown): Row | undefined {
  if (typeof key !== "string") return undefined;
  const match = /^([A-Z]{1,6})-([1-9][0-9]{0,9})$/u.exec(key);
  const ref = match !== null && match[1] === tx.space.refPrefix ? Number(match[2]) : -1;
  const row = tx.get(SQL.source, { id: key, ref });
  return row?.["shown"] === 1 ? row : undefined;
}

function liveNode(tx: Tx, key: unknown, field: string): Row {
  const found = findNode(tx, key);
  if (found === undefined) return problem("NOT_FOUND", "The space has nothing of that name", field);
  if (found["deleted_at"] !== null) problem("DELETED", "That task is in the Trash", field);
  return found;
}

const sourceAnswer = (tx: Tx, source: Row, status?: string) => ({
  ...(status === undefined ? {} : { status }),
  source: { id: source["id"], ref: refText(tx, source["ref"]) },
});

/** A source on a node. One whose key the space holds already is linked there, not made twice. */
const sourceAdd: Run = (tx, input) => {
  const owner = String(liveNode(tx, input["on"], "on")["id"]);
  const given = input["source"] as Input;
  const key = str(given, "key");
  const held = key === undefined ? undefined : tx.get(SQL.liveKey, { key });
  if (held !== undefined) {
    if (held["owner_id"] !== owner) tx.call("link.add", { on: owner, target: held["id"] });
    return sourceAnswer(tx, held, "exists");
  }
  const id = tx.newId("s");
  const ref = tx.ref();
  tx.create(
    "sources",
    {
      id,
      ref,
      owner_id: owner,
      kind: str(given, "kind") ?? "other",
      title: str(given, "title") ?? "",
      brief: str(input, "brief") ?? "",
      body: str(input, "body") ?? "",
      url: str(given, "url") ?? null,
      who: str(given, "who") ?? null,
      outside_ref: str(given, "ref") ?? null,
      at: typeof given["at"] === "number" ? given["at"] : null,
      source_key: key ?? null,
      created_at: tx.at,
      created_by: tx.author,
    },
    owner,
  );
  return { status: "created", source: { id, ref: refText(tx, ref) } };
};

/** A source that is shown: removed ones only when `removed`. */
function liveSource(tx: Tx, key: unknown, removed = false): Row {
  const source =
    findSource(tx, key) ?? problem("NOT_FOUND", "The space has no source there", "source");
  if ((source["deleted_at"] !== null) !== removed) {
    problem(
      "INVALID_TRANSITION",
      removed ? "The source is not removed" : "The source was removed",
      "source",
    );
  }
  return source;
}

/** A source moves to another node; its change rows belong to where it goes. */
const sourceMove: Run = (tx, input) => {
  const source = liveSource(tx, input["source"]);
  const to = String(liveNode(tx, input["on"], "on")["id"]);
  if (source["owner_id"] !== to) tx.set("sources", String(source["id"]), to, { owner: to });
  return sourceAnswer(tx, source);
};

/** A source removed, or put back; put back only while no other live source holds its key. */
const sourceGone =
  (gone: boolean): Run =>
  (tx, input) => {
    const source = liveSource(tx, input["source"], !gone);
    const key = source["source_key"];
    if (!gone && typeof key === "string" && tx.get(SQL.liveKey, { key }) !== undefined) {
      problem("KEY_HELD", "Another source holds its key now", "source");
    }
    const id = String(source["id"]);
    tx.set("sources", id, String(source["owner_id"]), { deleted: gone ? tx.at : null });
    return sourceAnswer(tx, source);
  };

/** A page or a source a link may point at. */
function target(tx: Tx, key: unknown): Row {
  return (
    findPage(tx, key) ??
    findSource(tx, key) ??
    problem("NOT_FOUND", "A link points at a page or a source of the space", "target")
  );
}

/** A link from a node to a page or a source; one removed before comes back. */
const linkAdd: Run = (tx, input) => {
  const owner = String(liveNode(tx, input["on"], "on")["id"]);
  const to = String(target(tx, input["target"])["id"]);
  const link = tx.get(SQL.link, { owner, target: to });
  if (link === undefined) {
    const last = tx.get(SQL.lastLink, { owner })?.["p"];
    const id = tx.newId("lk");
    tx.create(
      "links",
      {
        id,
        owner_id: owner,
        target_id: to,
        position: positionBetween(typeof last === "string" ? last : undefined, undefined),
        added_by: tx.author,
      },
      owner,
    );
    return { link: { id } };
  }
  if (link["removed_at"] !== null) tx.set("links", String(link["id"]), owner, { removed: null });
  return { link: { id: link["id"] } };
};

const linkRemove: Run = (tx, input) => {
  const owner = String(liveNode(tx, input["on"], "on")["id"]);
  const to = String(target(tx, input["target"])["id"]);
  const link = tx.get(SQL.link, { owner, target: to });
  if (link === undefined) return problem("NOT_FOUND", "No such link here", "target");
  if (link["removed_at"] === null) tx.set("links", String(link["id"]), owner, { removed: tx.at });
  return { link: { id: link["id"] } };
};

// The checks. A source's own fields are today's writer's (write/request.ts `sourceFields`): its
// kind, title, who, reference, address, time and key, the key normalised the same way.

/** A source as today's writer reads one, under `key`. */
export const checkSource = (f: Fields, key: string): Input => ({ ...sourceFields(f.sub(key)) });

const checkAdd: Check = (f) => {
  required(f, "on");
  required(f, "source");
  return read(f, {
    on: (k) => f.text(k, KEY),
    source: (k) => checkSource(f, k),
    brief: (k) => f.text(k, BRIEF),
    body: (k) => f.text(k, { ...NOTE, empty: true }),
  });
};

const checkMove: Check = (f) => {
  required(f, "source");
  required(f, "on");
  return read(f, { source: (k) => f.text(k, KEY), on: (k) => f.text(k, KEY) });
};

const oneSource: Check = (f) => {
  required(f, "source");
  return read(f, { source: (k) => f.text(k, KEY) });
};

const checkLink: Check = (f) => {
  required(f, "on");
  required(f, "target");
  return read(f, { on: (k) => f.text(k, KEY), target: (k) => f.text(k, KEY) });
};

export const SOURCES: Readonly<Record<string, Command>> = {
  "source.add": { check: checkAdd, run: sourceAdd },
  "source.move": { check: checkMove, run: sourceMove },
  "source.remove": { check: oneSource, run: sourceGone(true) },
  "source.put_back": { check: oneSource, run: sourceGone(false) },
  "link.add": { check: checkLink, run: linkAdd },
  "link.remove": { check: checkLink, run: linkRemove },
};
