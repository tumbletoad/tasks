// A task link's host view: `/s/:space/task/:id` names a task in any
// lifecycle, and the route shows it expanded in the view that holds it. Pure, so every row of the
// table is a unit test.
//
// | Task state                             | Host view                                    |
// | Active, in Inbox                       | Inbox                                        |
// | Active, under a project                | That project's screen                        |
// | Active, in no project, not in Inbox    | Its status view (Open for another status)    |
// | Completed, or archived (dropped)       | Completed                                    |
// | In the Trash                           | The Trash, with Restore                      |
// | Purged or unknown                      | The landing view, with "no longer exists"    |
import type { View } from "@ttasks/client/today";

/** What the route knows of the task: from the live row, or from `task.get` for another lifecycle. */
export interface HostFacts {
  readonly lifecycle: string;
  readonly inbox: boolean;
  readonly status: string;
  /** The project it sits in. */
  readonly project?: string | undefined;
  /** In the Trash: moved there on purpose, so Restore brings it back. */
  readonly deleted?: boolean;
}

export type Host =
  | { readonly kind: "view"; readonly view: View }
  | { readonly kind: "project"; readonly project: string }
  | { readonly kind: "trash" }
  | { readonly kind: "gone" };

const STATUS_VIEWS: readonly View[] = ["open", "waiting", "review", "backlog"];

export function hostOf(task: HostFacts | undefined): Host {
  if (task === undefined) return { kind: "gone" };
  if (task.deleted === true) return { kind: "trash" };
  if (task.lifecycle === "completed" || task.lifecycle === "archived") {
    return { kind: "view", view: "completed" };
  }
  if (task.inbox) return { kind: "view", view: "inbox" };
  if (task.project !== undefined) return { kind: "project", project: task.project };
  const view = STATUS_VIEWS.find((v) => v === task.status);
  return { kind: "view", view: view ?? "open" };
}
