// The entries moved to the tree, family by family (ops/tree.ts). An entry of a family that has not
// moved yet is refused on a tree space.
import { notOnTreeYet, type TreeEntry } from "./tree.ts";
import { TREE_TASKS } from "./tree-tasks.ts";

const TREE_ENTRIES: Readonly<Record<string, TreeEntry>> = { ...TREE_TASKS };

/** The entry's tree handler, or a refusal: its family has not moved to the tree yet. */
export function treeEntry(name: string): TreeEntry {
  return TREE_ENTRIES[name] ?? (() => Promise.reject(notOnTreeYet("This operation")));
}
