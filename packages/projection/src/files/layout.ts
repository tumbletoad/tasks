// Where each node, page and source of a tree has its file: the one calculation of a path, used by
// the renderer and by whatever names a task's file to an agent, so a move cannot give two answers.
//
// The space and each project are a folder with `_index.md`; a project's folder is its stored slug,
// which the tree keeps unique among siblings and never changes, so a rename moves nothing. A task
// is `<ref>-<title slug>.md`, and what it holds goes in `_<ref>/` beside it. A finished or dropped
// task with nothing open below it goes to `_done/` of its folder, and what it holds goes with it.
// Every name added here starts with `_`, which no slug has, so none meets a project, also where
// case is ignored.
import { formatTaskRef } from "@ttasks/storage";
import type { NodeKind, Snapshot, SnapshotNode } from "./snapshot.ts";

/** A title's slug in a file's name: cut at a word within this many characters. */
export const TITLE_SLUG_MAX = 40;

/** Names Windows keeps for devices, whatever follows a dot: no file or folder may have them. */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * A title's slug: ASCII letters and digits in lower case, words joined by `-`, cut at a word
 * within TITLE_SLUG_MAX characters; `fallback` when the title has none (CJK, emoji).
 */
export function titleSlug(title: string, fallback: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii === "") return fallback;
  if (ascii.length <= TITLE_SLUG_MAX) return ascii;
  const cut = ascii.slice(0, TITLE_SLUG_MAX + 1);
  const word = cut.lastIndexOf("-");
  return (word > 0 ? cut.slice(0, word) : ascii.slice(0, TITLE_SLUG_MAX)).replace(/-+$/g, "");
}

/** A project's folder: its slug, with `_` after a device name, which no other slug can have. */
export const projectFolderName = (slug: string): string => (DEVICE.test(slug) ? `${slug}_` : slug);

/** Where a node is: its file, and the folder of what it holds. Paths are relative, with `/`. */
export interface Place {
  readonly file: string;
  readonly folder: string;
  /** In a `_done/` folder: what it holds is finished too, and gets no `_done/` of its own. */
  readonly done: boolean;
}

/** One level on the way from the space down to a node. */
export interface Level {
  readonly kind: NodeKind;
  readonly title: string;
  /** A project's stored slug. */
  readonly slug: string | null;
  /** A task's or a routine's reference number. */
  readonly ref: number | null;
  /** Finished or dropped, with nothing open at any depth below it. */
  readonly settled: boolean;
}

export const SPACE_PLACE: Place = { file: "_index.md", folder: "", done: false };

const under = (folder: string, name: string): string =>
  folder === "" ? name : `${folder}/${name}`;

/** The place of `child` in `parent`. */
export function placeChild(parent: Place, prefix: string, child: Level): Place {
  if (child.kind === "space") return SPACE_PLACE;
  if (child.kind === "project") {
    const folder = under(parent.folder, projectFolderName(child.slug ?? "project"));
    return { file: `${folder}/_index.md`, folder, done: false };
  }
  const ref = formatTaskRef(prefix, child.ref ?? 0);
  const toDone = child.settled && !parent.done;
  const dir = toDone ? under(parent.folder, "_done") : parent.folder;
  return {
    file: under(dir, `${ref}-${titleSlug(child.title, "task")}.md`),
    folder: under(dir, `_${ref}`),
    done: parent.done || toDone,
  };
}

/** The place of the last level of `levels`, the space first. */
export function nodePath(prefix: string, levels: readonly Level[]): Place {
  return levels.reduce((place, level) => placeChild(place, prefix, level), SPACE_PLACE);
}

/** A page's or a source's file in its owner's folder. */
export function knowledgeFile(
  owner: Place,
  prefix: string,
  kind: "page" | "source",
  item: { readonly ref: number; readonly title: string },
): string {
  const folder = kind === "page" ? "_pages" : "_sources";
  return under(
    owner.folder,
    `${folder}/${formatTaskRef(prefix, item.ref)}-${titleSlug(item.title, kind)}.md`,
  );
}

/** Every live node of a snapshot that hangs from the space, with its place and its children. */
export interface Layout {
  readonly space: SnapshotNode;
  readonly places: ReadonlyMap<string, Place>;
  /** Each node's children in their order: projects first, then tasks and routines. */
  readonly children: ReadonlyMap<string, readonly SnapshotNode[]>;
  readonly nodes: ReadonlyMap<string, SnapshotNode>;
  /** Finished or dropped with nothing open below. */
  readonly settled: ReadonlySet<string>;
  readonly pages: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, string>;
}

const KIND_ORDER: Readonly<Record<NodeKind, number>> = {
  space: 0,
  project: 1,
  task: 2,
  routine: 2,
};

const byPosition = (a: SnapshotNode, b: SnapshotNode): number =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  (a.position < b.position ? -1 : a.position > b.position ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The places of a snapshot. A node whose parent is not placed (under something the Trash took)
 * is not placed, nor is what it holds.
 */
export function layoutOf(snapshot: Snapshot): Layout {
  const all = new Map<string, SnapshotNode>();
  const kids = new Map<string, SnapshotNode[]>();
  let space: SnapshotNode | undefined;
  for (const node of snapshot.nodes) {
    all.set(node.id, node);
    if (node.kind === "space") space = node;
    else if (node.parent !== null) {
      const list = kids.get(node.parent) ?? [];
      list.push(node);
      kids.set(node.parent, list);
    }
  }
  if (space === undefined) throw new Error("A tree snapshot holds its space");
  for (const list of kids.values()) list.sort(byPosition);

  // Depth first from the space: what is reached is live; `open` is whether anything open lies at
  // or below a node, from its children up.
  const reached: SnapshotNode[] = [];
  const open = new Map<string, boolean>();
  const walk = (node: SnapshotNode): boolean => {
    reached.push(node);
    let below = false;
    for (const child of kids.get(node.id) ?? []) below = walk(child) || below;
    const own = node.task !== null && node.task.lifecycle === "active";
    open.set(node.id, below);
    return own || below;
  };
  walk(space);

  const settled = new Set<string>();
  for (const node of reached) {
    if (node.task !== null && node.task.lifecycle !== "active" && open.get(node.id) !== true) {
      settled.add(node.id);
    }
  }
  const places = new Map<string, Place>([[space.id, SPACE_PLACE]]);
  const nodes = new Map<string, SnapshotNode>();
  const children = new Map<string, SnapshotNode[]>();
  for (const node of reached) {
    nodes.set(node.id, node);
    const parent = node.parent === null ? undefined : places.get(node.parent);
    if (parent !== undefined) {
      places.set(
        node.id,
        placeChild(parent, snapshot.refPrefix, {
          kind: node.kind,
          title: node.title,
          slug: node.slug,
          ref: node.task?.ref ?? null,
          settled: settled.has(node.id),
        }),
      );
    }
    children.set(node.id, kids.get(node.id) ?? []);
  }
  const pages = new Map<string, string>();
  for (const page of snapshot.pages) {
    const owner = places.get(page.owner);
    if (owner !== undefined)
      pages.set(page.id, knowledgeFile(owner, snapshot.refPrefix, "page", page));
  }
  const sources = new Map<string, string>();
  for (const source of snapshot.sources) {
    const owner = places.get(source.owner);
    if (owner !== undefined) {
      sources.set(source.id, knowledgeFile(owner, snapshot.refPrefix, "source", source));
    }
  }
  return { space, places, children, nodes, settled, pages, sources };
}

/** `to` relative to the folder of the file `from`, both relative to the tree's root. */
export function relativePath(from: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let same = 0;
  while (same < a.length && same < b.length - 1 && a[same] === b[same]) same += 1;
  return [...Array<string>(a.length - same).fill(".."), ...b.slice(same)].join("/");
}
