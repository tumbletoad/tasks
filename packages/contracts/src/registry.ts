// The registry: every entry, and the types the faces derive from it (A3 3.2).
import type { z } from "zod";
import type { AnyEntry, Filled } from "./define.ts";
import { entryAdd } from "./entries/entry-add.ts";
import { historyRedo } from "./entries/history-redo.ts";
import { historyUndo } from "./entries/history-undo.ts";
import { launchOpen } from "./entries/launch-open.ts";
import { receiptGet } from "./entries/receipt-get.ts";
import { spaceStatus } from "./entries/space-status.ts";
import { taskAdd } from "./entries/task-add.ts";
import { taskFinish } from "./entries/task-finish.ts";
import { taskGet } from "./entries/task-get.ts";
import { taskReopen } from "./entries/task-reopen.ts";
import { taskSearch } from "./entries/task-search.ts";
import { taskUpdate } from "./entries/task-update.ts";

/**
 * Every entry. The generated files list them sorted by name. The contract suite runs the examples
 * in this order, so undo and redo come after the writes whose change they take back.
 */
export const registry = [
  spaceStatus,
  taskGet,
  taskAdd,
  taskUpdate,
  entryAdd,
  taskFinish,
  taskReopen,
  receiptGet,
  launchOpen,
  taskSearch,
  historyUndo,
  historyRedo,
] as const satisfies readonly AnyEntry[];

type Registry = (typeof registry)[number];
type ByName = { [E in Registry as E["name"]]: E };

export type EntryName = keyof ByName;
export type EntryOf<N extends EntryName> = ByName[N];
/** What a caller sends, before SafeText and defaults. */
export type InputOf<N extends EntryName> = z.input<ByName[N]["input"]>;
/** What a handler receives, after SafeText and defaults. */
export type ParsedInputOf<N extends EntryName> = Filled<
  z.output<ByName[N]["input"]>,
  NonNullable<ByName[N]["defaults"]>
>;
export type OutputOf<N extends EntryName> = z.output<ByName[N]["output"]>;

const byName = new Map<string, AnyEntry>(registry.map((e) => [e.name, e]));

export function findEntry(name: string): AnyEntry | undefined {
  return byName.get(name);
}
