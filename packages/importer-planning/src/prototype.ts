// One parse of a whole prototype folder: both ledgers, the metadata, the events and the optional
// files, plus the checks that need more than one file (A7 3.15.2, 3.15.4 section 1): duplicate IDs
// across TODO.md and DONE.md (an error, as in the prototype's build), metadata entries without a
// task line, task lines without metadata, and counted events for no known task.

import { eventPlace, parseEvents, type EventFileInput, type EventsParse } from "./events.ts";
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
}

export interface PrototypeParse {
  /** TODO.md's task lines, then DONE.md's, each in file order. */
  readonly tasks: readonly LedgerTask[];
  readonly metadata: ReadonlyMap<string, MetadataEntry>;
  readonly events: EventsParse;
  readonly jira: JiraParse;
  readonly audit: AuditParse;
  /** Metadata IDs with no task line, in the file's key order. */
  readonly orphans: readonly string[];
  /** Task IDs with no metadata entry, in task order. */
  readonly withoutMetadata: readonly string[];
  readonly counts: PrototypeCounts;
  /** Every problem of every file. */
  readonly problems: readonly Problem[];
}

export function parsePrototype(input: PrototypeInput, limits?: Partial<Limits>): PrototypeParse {
  const todo = parseLedger("TODO.md", input.todo, limits);
  const done = parseLedger("DONE.md", input.done, limits);
  const metadata = parseMetadata(input.metadata, limits);
  const events = parseEvents(input.events, limits);
  const jira = parseJira(input.jira, limits);
  const audit = parseAudit(input.audit, limits);

  const tasks = [...todo.tasks, ...done.tasks];
  const cross: Problem[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) {
      cross.push(problem("duplicate-id", { file: t.file, line: t.line, task: t.id }));
    }
    ids.add(t.id);
  }
  const orphans = [...metadata.entries.keys()].filter((id) => !ids.has(id));
  for (const id of orphans)
    cross.push(problem("metadata-orphan", { file: METADATA_FILE, task: id }));
  const withoutMetadata = tasks.filter((t) => !metadata.entries.has(t.id)).map((t) => t.id);
  const position = new Map(events.files.map((f, i) => [f.name, i]));
  for (const e of events.applied) {
    if (!ids.has(e.task)) {
      const place = eventPlace(e.file, position.get(e.file) ?? 0);
      cross.push(problem("event-unknown-task", { ...place, task: e.task }));
    }
  }

  return {
    tasks,
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
      countedEventFiles: events.applied.length,
    },
    problems: [
      ...todo.problems,
      ...done.problems,
      ...metadata.problems,
      ...events.problems,
      ...jira.problems,
      ...audit.problems,
      ...cross,
    ],
  };
}
