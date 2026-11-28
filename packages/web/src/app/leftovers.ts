// What the browser keeps of a space's unsaved text (a composer's draft, a note on its way, a title
// being typed, a field edit that waits) belongs to a task. A finished task or one in the Trash can
// come back, and a task the space does not have now (a backup restored over it, a creation undone)
// may hold words the person still needs: those stay, listed with Copy and Discard at the foot of
// the Trash (views/Trash.tsx), until the person discards them. Only text kept under a key of no
// task's shape is forgotten, when the space next opens.
import type { Api } from "../api.ts";
import { forgetTask, unsentTasks } from "../unsent.ts";

/** A page's or a node's ID: the library's words, which are no task's and never asked about. */
const LIBRARY_KEY = /^(?:pg|sp|a|p)_[0-9a-hjkmnp-tv-z]{26}$/u;

/** The most tasks asked about per opening: the rest wait for the next one. */
const MAX_ASKED = 20;

/** The service says the key is no task's at all. */
const notATask = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "invalid_input";

/** Forgets the kept text of the space's keys that name no task. */
export async function forgetGone(
  space: string,
  api: Api,
  known: (task: string) => boolean,
): Promise<void> {
  const unknown = unsentTasks(space).filter((task) => !known(task) && !LIBRARY_KEY.test(task));
  // A random few each time: tasks that still exist never keep the others from being asked about.
  for (let i = unknown.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [unknown[i], unknown[j]] = [unknown[j] as string, unknown[i] as string];
  }
  const asked = unknown.slice(0, MAX_ASKED);
  for (const task of asked) {
    try {
      await api.client.task.get({ task });
    } catch (error) {
      if (!notATask(error)) continue;
      forgetTask(space, task);
    }
  }
}
