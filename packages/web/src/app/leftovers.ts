// What the browser keeps of a space's unsaved text (a composer's draft, a field edit that waits)
// belongs to a task. A finished or deleted task can come back, so its text stays as long as the
// service knows the task. Once the task is gone for good, its text is forgotten when the space
// next opens.
import type { Api } from "../api.ts";
import { forgetUnsaved, unsavedTasks } from "../edit/keep.ts";
import { draftTasks, keepDraft } from "../task/composer.ts";

/** The most tasks asked about per opening: the rest wait for the next one. */
const MAX_ASKED = 20;

/** The service knows no such task: not one any more, or never one of this shape. */
const gone = (error: unknown): boolean => {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : "";
  return code === "not_found" || code === "invalid_input";
};

/** Forgets the kept text of the space's tasks that do not exist any more. */
export async function forgetGone(
  space: string,
  api: Api,
  known: (task: string) => boolean,
): Promise<void> {
  const tasks = new Set([...draftTasks(space), ...unsavedTasks(space)]);
  const asked = [...tasks].filter((task) => task !== "" && !known(task)).slice(0, MAX_ASKED);
  for (const task of asked) {
    try {
      await api.client.task.get({ task });
    } catch (error) {
      if (!gone(error)) continue;
      keepDraft(space, task, "");
      forgetUnsaved(space, task);
    }
  }
}
