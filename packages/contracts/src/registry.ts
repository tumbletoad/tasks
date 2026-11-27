// The registry: every entry, and the types the faces derive from it (A3 3.2).
import type { z } from "zod";
import type { AnyEntry, Filled } from "./define.ts";
import { entryAdd } from "./entries/entry-add.ts";
import { entryEdit } from "./entries/entry-edit.ts";
import { folderManage } from "./entries/folder-manage.ts";
import { groupManage } from "./entries/group-manage.ts";
import { historyRedo } from "./entries/history-redo.ts";
import { historyUndo } from "./entries/history-undo.ts";
import { launchOpen } from "./entries/launch-open.ts";
import { noteRemove } from "./entries/note-remove.ts";
import { prefsManage } from "./entries/prefs-manage.ts";
import { receiptGet } from "./entries/receipt-get.ts";
import { runReport } from "./entries/run-report.ts";
import { spaceStatus } from "./entries/space-status.ts";
import { taskAdd } from "./entries/task-add.ts";
import { taskDelete } from "./entries/task-delete.ts";
import { taskFinish } from "./entries/task-finish.ts";
import { taskFinished } from "./entries/task-finished.ts";
import { taskGet } from "./entries/task-get.ts";
import { taskReopen } from "./entries/task-reopen.ts";
import { taskSearch } from "./entries/task-search.ts";
import { taskTrash } from "./entries/task-trash.ts";
import { taskUpdate } from "./entries/task-update.ts";

/**
 * Every entry. The generated files list them sorted by name. The contract suite runs the examples
 * in this order, so undo and redo come after the writes whose change they take back.
 */
export const registry = [
  spaceStatus,
  taskGet,
  // Before the examples that finish or reopen a task: it reads the world's finished tasks.
  taskFinished,
  taskAdd,
  // Before the later writes: as the UI's, its create would be the change the undo takes back.
  groupManage,
  taskUpdate,
  entryAdd,
  // After the notes entry.add writes: it takes back one of them and puts it back.
  noteRemove,
  // After the notes entry.add writes: it corrects one of them.
  entryEdit,
  taskFinish,
  taskReopen,
  receiptGet,
  launchOpen,
  taskSearch,
  prefsManage,
  runReport,
  historyUndo,
  historyRedo,
  // After the undo's and redo's examples: its user's change would be the one they take back.
  folderManage,
  // Last: their examples leave a task of the world in the Trash, which the Trash's example reads.
  taskDelete,
  taskTrash,
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
