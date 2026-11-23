// Who changed which tasks since an undo's or a redo's change, as a person reads it: the tasks by
// their numbers and the authors by their names, each list short. The page's toast and the command
// line both say it through `newerSaid`, so they never name different tasks or authors.

/** One author who changed one task since the change, as an undo's or a redo's answer names it. */
export interface NewerWorkEntry {
  /** The task's reference; absent for an area, a project or a source. */
  readonly task?: string;
  /** `user`, `import`, `script`, `run` (a run's own progress) or the actor's label. */
  readonly by: string;
  readonly at: string;
}

/** A short list: the names it shows, and how many more it leaves out. */
export interface ShortList {
  readonly shown: readonly string[];
  readonly more: number;
}

/** A list shows three names, or two and how many more. */
const SHOWN = 3;

function shortList(names: readonly string[]): ShortList {
  const unique = [...new Set(names)];
  if (unique.length <= SHOWN) return { shown: unique, more: 0 };
  return { shown: unique.slice(0, SHOWN - 1), more: unique.length - (SHOWN - 1) };
}

/** Who changed which tasks since: the authors and the tasks of an answer's newer work, short. */
export function newerSaid(work: readonly NewerWorkEntry[]): {
  readonly who: ShortList;
  readonly tasks: ShortList;
} {
  return {
    who: shortList(work.map((w) => w.by)),
    tasks: shortList(work.flatMap((w) => (w.task === undefined ? [] : [w.task]))),
  };
}

/** An author's name in an English sentence. */
const englishName = (by: string): string =>
  by === "user"
    ? "you"
    : by === "import"
      ? "the import"
      : by === "run"
        ? "a run"
        : by === "script"
          ? "a script"
          : by;

/** A short list in English: "A", "A and B", "A, B and C", "A, B and 4 more". */
function englishList({ shown, more }: ShortList): string {
  const items = more > 0 ? [...shown, `${String(more)} more`] : [...shown];
  const last = items.pop() ?? "";
  return items.length === 0 ? last : `${items.join(", ")} and ${last}`;
}

/**
 * The command line's words for `newerSaid`: "Codex and a run changed M-1 and M-2 since", or "it"
 * for no task. Undefined when no one else changed anything: the person's own earlier step holds
 * it back.
 */
export function newerText(work: readonly NewerWorkEntry[]): string | undefined {
  if (work.length === 0) return undefined;
  const { who, tasks } = newerSaid(work);
  const names = { shown: who.shown.map(englishName), more: who.more };
  const changed = tasks.shown.length === 0 ? "it" : englishList(tasks);
  return `${englishList(names)} changed ${changed} since`;
}

/** An author as `NewerWorkEntry.by` names it: a run's own progress is the run's. */
export const newerBy = (
  by: { readonly kind: string; readonly label: string; readonly origin?: string | undefined },
  run: boolean,
): string =>
  run ? "run" : by.origin === "import" ? "import" : by.kind === "human" ? "user" : by.label;
