// What this browser holds for a space that the person typed and has not sent: drafts, notes on
// their way and field edits the service did not take. One enumeration of all of it, so the foot of
// the Trash lists every kind for a task in the Trash or one the space does not have now, and its
// Discard removes the one value it shows.
import type { Field } from "../edit/change.ts";
import type { Unsaved } from "../edit/edits.ts";
import { draftTasks, noteTasks, readDraft, readNote, wordsOf } from "../task/composer.ts";

/** A task ID as the service gives one: what is kept under another name is not asked about. */
const TASK_ID = /^t_[0-9a-hjkmnp-tv-z]{26}$/u;

/** One piece of unsent words. */
export type Unsent =
  | { readonly kind: "draft"; readonly key: string; readonly task: string; readonly text: string }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly task: string;
      readonly text: string;
      /** The note's request ID: its Discard removes that note only. */
      readonly id: string;
    }
  | {
      readonly kind: "edit";
      readonly key: string;
      readonly task: string;
      readonly text: string;
      readonly field: Field;
      readonly ref: string;
    };

/** Every piece of unsent words this browser holds for `space`, by task ID. */
export function unsentOf(space: string, unsaved: Iterable<Unsaved>): Unsent[] {
  const out: Unsent[] = [];
  for (const task of draftTasks(space)) {
    const text = readDraft(space, task);
    if (TASK_ID.test(task) && wordsOf(text) !== "") {
      out.push({ kind: "draft", key: `${task}:draft`, task, text });
    }
  }
  for (const task of noteTasks(space)) {
    const note = readNote(space, task);
    if (TASK_ID.test(task) && note !== undefined) {
      out.push({ kind: "note", key: `${task}:note`, task, text: note.words, id: note.id });
    }
  }
  for (const line of unsaved) {
    const shown = line.change.shown;
    if (!TASK_ID.test(line.task) || typeof shown !== "string") continue;
    out.push({
      kind: "edit",
      key: `${line.task}:${line.field}`,
      task: line.task,
      text: shown,
      field: line.field,
      ref: line.ref,
    });
  }
  return out;
}
