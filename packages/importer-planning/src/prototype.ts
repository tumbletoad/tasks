// One parse of a whole prototype folder: both ledgers, the metadata, the events and the optional
// files, plus the checks that need more than one file (A7 3.15.2, 3.15.4 section 1): IDs on more
// than one line, metadata entries without a task line, task lines without metadata, and counted
// events for no known task. With the page's actions export (`--actions`), its events are merged
// with those of events/ (events.ts).
//
// One ID on more than one line: an ID in both ledgers is the page's case of a task archived while
// its open line stayed, and the page shows the DONE.md line and hides the open one, so the DONE.md
// line wins (`open-copy-hidden`, a warning). Two lines of one ledger with one ID are two tasks the
// prototype's build refuses: the first is kept and each later one is left out (`duplicate-id`, an
// error, which blocks the preview).

import { parseActions } from "./actions.ts";
import { placeOfEvent, parseEvents, type EventFileInput, type EventsParse } from "./events.ts";
import { parseLedger, type LedgerTask } from "./ledger.ts";
import type { Limits } from "./limits.ts";
import { METADATA_FILE, parseMetadata, type MetadataEntry } from "./metadata.ts";
import { parseAudit, parseJira, type AuditParse, type JiraParse } from "./optional.ts";
import { problem, type Problem } from "./problems.ts";
import type { Source } from "./text.ts";

/** The files of a prototype folder that the importer reads, as bytes or text. */
export interface PrototypeInput {
  readonly todo?: Source;
  readonly done?: Source;
  readonly metadata?: Source;
  readonly jira?: Source;
  readonly audit?: Source;
  readonly events: readonly EventFileInput[];
  /** The page's actions export (`--actions`), when one is given. */
  readonly actions?: Source;
}

/** The ledger counts of the dry-run report (A7 3.15.4 section 1). */
export interface PrototypeCounts {
  readonly todoTaskLines: number;
  readonly doneTaskLines: number;
  readonly taskLines: number;
  readonly metadataEntries: number;
  readonly metadataOrphans: number;
  readonly taskLinesWithoutMetadata: number;
  readonly eventFiles: number;
  readonly readyFiles: number;
  readonly countedEventFiles: number;
  /** web- event files without their .ready file: skipped, as the prototype skips them. */
  readonly eventsNotReady: number;
}

export interface PrototypeParse {
  /** TODO.md's task lines, then DONE.md's, each in file order. */
  readonly tasks: readonly LedgerTask[];
  /** The task lines that stand for their ID: one per ID (`keptLines`), in `tasks` order. */
  readonly kept: readonly LedgerTask[];
  readonly metadata: ReadonlyMap<string, MetadataEntry>;
  readonly events: EventsParse;
  readonly jira: JiraParse;
  readonly audit: AuditParse;
  /** Metadata IDs with no task line, in the file's key order. */
  readonly orphans: readonly string[];
  /** The IDs of the task lines with no metadata entry, one per line, in task order. */
  readonly withoutMetadata: readonly string[];
  readonly counts: PrototypeCounts;
  /** Every problem of every file. */
  readonly problems: readonly Problem[];
}

/**
 * The line that stands for each ID: the first DONE.md line with it, else the first TODO.md line,
 * as the page shows them. Returned in `tasks` order.
 */
export function keptLines(tasks: readonly LedgerTask[]): LedgerTask[] {
  const winner = new Map<string, LedgerTask>();
  for (const t of tasks) {
    const now = winner.get(t.id);
    if (now === undefined || (now.file === "TODO.md" && t.file === "DONE.md")) winner.set(t.id, t);
  }
  return tasks.filter((t) => winner.get(t.id) === t);
}

export function parsePrototype(input: PrototypeInput, limits?: Partial<Limits>): PrototypeParse {
  const todo = parseLedger("TODO.md", input.todo, limits);
  const done = parseLedger("DONE.md", input.done, limits);
  const metadata = parseMetadata(input.metadata, limits);
  const actions = input.actions === undefined ? undefined : parseActions(input.actions, limits);
  const events = parseEvents(input.events, limits, actions?.events);
  const jira = parseJira(input.jira, limits);
  const audit = parseAudit(input.audit, limits);

  const tasks = [...todo.tasks, ...done.tasks];
  const kept = keptLines(tasks);
  const keptSet = new Set(kept);
  const inDone = new Set(done.tasks.map((t) => t.id));
  const cross: Problem[] = [];
  for (const t of tasks) {
    if (keptSet.has(t)) continue;
    const code = t.file === "TODO.md" && inDone.has(t.id) ? "open-copy-hidden" : "duplicate-id";
    cross.push(problem(code, { file: t.file, line: t.line, task: t.id }));
  }
  const ids = new Set(tasks.map((t) => t.id));
  const orphans = [...metadata.entries.keys()].filter((id) => !ids.has(id));
  for (const id of orphans)
    cross.push(problem("metadata-orphan", { file: METADATA_FILE, task: id }));
  const withoutMetadata = tasks.filter((t) => !metadata.entries.has(t.id)).map((t) => t.id);
  const position = new Map(events.files.map((f, i) => [f.name, i]));
  for (const e of events.applied) {
    if (!ids.has(e.task)) {
      cross.push(problem("event-unknown-task", { ...placeOfEvent(e, position), task: e.task }));
    }
  }

  return {
    tasks,
    kept,
    metadata: metadata.entries,
    events,
    jira,
    audit,
    orphans,
    withoutMetadata,
    counts: {
      todoTaskLines: todo.tasks.length,
      doneTaskLines: done.tasks.length,
      taskLines: tasks.length,
      metadataEntries: metadata.entries.size,
      metadataOrphans: orphans.length,
      taskLinesWithoutMetadata: withoutMetadata.length,
      eventFiles: events.files.length,
      readyFiles: events.readyFiles,
      countedEventFiles: events.files.filter((f) => f.counted).length,
      eventsNotReady: events.notReady,
    },
    problems: [
      ...todo.problems,
      ...done.problems,
      ...metadata.problems,
      ...events.problems,
      ...(actions?.problems ?? []),
      ...jira.problems,
      ...audit.problems,
      ...cross,
    ],
  };
}
