// What a row's controls do (Row.tsx), apart from the row so the expanded task's seam can take it
// too without a cycle.
import type { Instance } from "../api.ts";
import type { TaskRow } from "../store/rows.ts";
import type { RowMove } from "./model.ts";

/** The agent-only fields a click asks an agent to change (A5 3.11, U11). */
export type AskField = "summary" | "context" | "sources" | "outcome" | "learnings";

/** What a row's controls do. The list keeps one object for every row, so it never changes. */
export interface RowActions {
  /** The title or summary was clicked: expand or collapse. */
  readonly toggle: (task: TaskRow) => void;
  /** The tile shows a launch on its way or done: expand to its thread entry. */
  readonly expand: (task: TaskRow) => void;
  /**
   * Open the task in an instance, with the composer's `text` as the request. True once the
   * service recorded a launch that did not fail.
   */
  readonly open: (task: TaskRow, instance: Instance, text?: string) => Promise<boolean>;
  /**
   * Copy the pointer brief, or with `pack` (Shift+Copy) the context pack (A4 3.15.5), with the
   * composer's `text`. True once it is on the clipboard.
   */
  readonly copy: (task: TaskRow, pack?: boolean, text?: string) => Promise<boolean>;
  readonly star: (task: TaskRow, on: boolean) => void;
  /** The view's visible move out of it (A5 3.5): "Move to Open" or "Back to open". */
  readonly move: (task: TaskRow, kind: RowMove) => void;
  /** The checkbox (A5 3.12): check-off, or, during its hold, its undo. */
  readonly check: (task: TaskRow) => void;
  /** An agent-only field was clicked (A5 3.11): a request for an agent starts in the composer. */
  readonly ask: (task: TaskRow, field: AskField) => void;
  /** Focus moved into the row: it becomes the list's current row. */
  readonly current: (task: TaskRow) => void;
}
