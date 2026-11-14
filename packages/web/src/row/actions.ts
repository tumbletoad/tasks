// What a row's controls do (Row.tsx), apart from the row so the expanded task's seam can take it
// too without a cycle.
import type { Instance } from "../api.ts";
import type { TaskRow } from "../store/rows.ts";

/** What a row's controls do. The list keeps one object for every row, so it never changes. */
export interface RowActions {
  /** The title or summary was clicked: expand or collapse. */
  readonly toggle: (task: TaskRow) => void;
  /** The tile shows a launch on its way or done: expand to its thread entry. */
  readonly expand: (task: TaskRow) => void;
  readonly open: (task: TaskRow, instance: Instance) => void;
  readonly copy: (task: TaskRow) => void;
  readonly star: (task: TaskRow, on: boolean) => void;
  /**
   * The title's editor opened (A5 3.7). The function it returns saves a changed title, which shows
   * at once and holds until the feed confirms it. Its base is what the row showed when the editor
   * opened, so a title an agent changed while the person typed is a conflict, never overwritten.
   */
  readonly rename: (task: TaskRow) => (title: string) => void;
  /** Focus moved into the row: it becomes the list's current row. */
  readonly current: (task: TaskRow) => void;
}
