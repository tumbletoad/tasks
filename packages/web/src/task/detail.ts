// The expanded task's detail (A5 3.7, 3.15 item 8): what the live row does not hold, read with
// `task.get` in parts that start together. The digest gives the task's own facts in any
// lifecycle (its place on this machine, when it was created). The sections give the long text in
// full: the context, every note (those to agents too), the log, the sources, the outcome and
// learnings. A sections read comes in pages sized for an agent's budget (A3 3.4.4), so this reads
// page after page, `PAGES` at first, and joins a text a page boundary split; "Older entries" reads
// `PAGES` more from where the last read ended (`readOlder`). The notes the thread's sessions name
// as their requests come whole with the digest, by reference, whatever their age or length. Plain
// code: the hook (useDetail.ts) refetches it when the feed touches the task.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { AreaRow, ProjectRow, TaskRow } from "@ttasks/client/store";

type GetResult = Awaited<ReturnType<Client["task"]["get"]>>;
type DigestView = Extract<GetResult, { view: "digest" }>;
type SectionsView = Extract<GetResult, { view: "sections" }>;
type Sections = SectionsView["sections"];

/** The digest's task: the facts of a task in any lifecycle. */
export type TaskFacts = DigestView["task"];
export type SourceOutput = NonNullable<Sections["sources"]>[number];
type NoteOutput = NonNullable<Sections["notes"]>[number];
type RemovedOutput = NonNullable<DigestView["removed_notes"]>[number];
type LogOutput = NonNullable<Sections["log"]>[number];

/** The person corrected an entry's words: when, and who (`user`). */
export interface Edited {
  readonly at: string;
  readonly by: string;
}

export interface DetailNote {
  readonly kind: "note";
  readonly ref: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly edited?: Edited;
  /** The pages read so far hold only part of its text: it cannot be corrected from here. */
  readonly partial?: true;
  readonly forAgents: boolean;
  /** The launches this note was the person's request for, oldest first, by reference. */
  readonly requestFor?: readonly { readonly launch: string; readonly instance: string }[];
}

/** A note the person took back: no agent reads it, and the card lists it to put back. */
export interface RemovedNote extends DetailNote {
  readonly removed: { readonly at: string; readonly by: string };
}

export interface DetailLog {
  readonly kind: "log";
  readonly ref: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly edited?: Edited;
  /** The pages read so far hold only part of its text: it cannot be corrected from here. */
  readonly partial?: true;
  readonly logKind: string;
}

export interface Detail {
  readonly task: TaskFacts;
  readonly context: string;
  /** The pages read hold only part of the context: it cannot be corrected from here. */
  readonly contextPartial?: true;
  /** Every note, oldest first. */
  readonly notes: readonly DetailNote[];
  /** Every log entry, oldest first. */
  readonly log: readonly DetailLog[];
  readonly sources: readonly SourceOutput[];
  /** The notes taken back, newest removal first. */
  readonly removedNotes: readonly RemovedNote[];
  readonly outcome?: string;
  readonly learnings: readonly string[];
  /** The pages ran out before the end: older notes and log entries are not here. */
  readonly partial: boolean;
}

/** A read of a thread: its detail, and what a read of the entries before it goes on from. */
export interface ThreadRead {
  readonly detail: Detail;
  readonly facts: TaskFacts;
  readonly named: readonly NoteOutput[];
  readonly removed: readonly RemovedOutput[];
  readonly pages: readonly Sections[];
  /** Where the next page starts; none when the read reached the first entry. */
  readonly before?: string;
}

/**
 * The pages a thread reads at first, and how many more each "Older entries" reads: about 80 kB of
 * text, far beyond a task's usual size.
 */
export const PAGES = 20;

/** The most notes one read names, as `task.get` takes them: the newest are read. */
const NAMED_NOTES = 64;

const SECTIONS = ["instructions", "context", "notes", "log", "sources", "outcome"] as const;

/** A note reference's ordinal: `n12` is 12. */
const ordinal = (ref: string): number => Number(ref.slice(1));

type Slice = NonNullable<Sections["context_slice"]>;

/** Whether parts of one text, in order, hold all of it: from its first character to its last. */
const holdsAll = (first: Slice | undefined, last: Slice | undefined): boolean =>
  (first === undefined || first.from === 0) && (last === undefined || last.to === last.of);

/**
 * Joins the entries of successive pages, newest first as they come. A text a page boundary split
 * comes as parts of one entry with the same ref, each with its slice: they join into one, which is
 * `partial` when the pages read hold only part of it.
 */
function joined<T extends { ref: string; text: string; slice?: Slice | undefined }>(
  pages: readonly (readonly T[])[],
): (T & { partial?: true })[] {
  const out: { entry: T; first: Slice | undefined; last: Slice | undefined }[] = [];
  for (const page of pages) {
    for (const entry of page) {
      const last = out.at(-1);
      if (last !== undefined && last.entry.ref === entry.ref) {
        last.entry = { ...last.entry, text: last.entry.text + entry.text };
        last.last = entry.slice;
      } else {
        out.push({ entry, first: entry.slice, last: entry.slice });
      }
    }
  }
  return out.map(({ entry, first, last }) =>
    holdsAll(first, last) ? entry : { ...entry, partial: true as const },
  );
}

/**
 * Every page of a sections read, merged, with `named`, notes read whole by reference, in place of
 * what the pages hold of them. Pure: the pages are given.
 */
export function mergePages(
  task: TaskFacts,
  pages: readonly Sections[],
  partial: boolean,
  named: readonly NoteOutput[] = [],
  removed: readonly RemovedOutput[] = [],
): Detail {
  const whole = new Map(named.map((note) => [note.ref, note]));
  const paged = [
    ...joined<NoteOutput>(pages.map((p) => p.instructions ?? [])),
    ...joined<NoteOutput>(pages.map((p) => p.notes ?? [])),
  ].filter((note) => !whole.has(note.ref));
  const log = joined<LogOutput>(pages.map((p) => p.log ?? []));
  const outcome = pages
    .map((p) => p.outcome?.outcome ?? "")
    .join("")
    .trim();
  const learnings = pages.flatMap((p) => p.outcome?.learnings ?? []);
  const toNote = (n: NoteOutput & { partial?: true }): DetailNote => ({
    kind: "note",
    ref: n.ref,
    author: n.author,
    at: n.at,
    text: n.text,
    ...(n.edited === undefined ? {} : { edited: n.edited }),
    ...(n.partial === undefined ? {} : { partial: n.partial }),
    forAgents: n.for_agents,
    ...(n.request_for === undefined ? {} : { requestFor: n.request_for }),
  });
  const byTime = <E extends { at: string; ref: string }>(a: E, b: E) =>
    Date.parse(a.at) - Date.parse(b.at) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  return {
    task,
    context: pages.map((p) => p.context ?? "").join(""),
    ...(holdsAll(
      pages.find((p) => p.context !== undefined)?.context_slice,
      pages.findLast((p) => p.context !== undefined)?.context_slice,
    )
      ? {}
      : { contextPartial: true as const }),
    notes: [...paged, ...whole.values()].map(toNote).sort(byTime),
    log: log
      .map((l): DetailLog => ({
        kind: "log",
        ref: l.ref,
        author: l.author,
        at: l.at,
        text: l.text,
        ...(l.edited === undefined ? {} : { edited: l.edited }),
        ...(l.partial === undefined ? {} : { partial: l.partial }),
        logKind: l.kind,
      }))
      .sort(byTime),
    sources: pages.flatMap((p) => p.sources ?? []),
    removedNotes: removed.map((n): RemovedNote => ({ ...toNote(n), removed: n.removed })),
    ...(outcome === "" ? {} : { outcome }),
    learnings: [...new Set(learnings)],
    partial,
  };
}

/**
 * A row for a task the live store does not hold (a completed or archived one, A5 3.3's injected
 * row), from its digest. Its area and project are found by their names among the live ones.
 */
export function rowOfFacts(
  facts: TaskFacts,
  areas: ReadonlyMap<string, AreaRow>,
  projects: ReadonlyMap<string, ProjectRow>,
  today: string,
): TaskRow {
  const area = [...areas.values()].find((a) => a.title === facts.area);
  const project = [...projects.values()].find(
    (p) => p.title === facts.project && (area === undefined || p.area_id === area.id),
  );
  const created = facts.created === undefined ? Number.NaN : Date.parse(facts.created);
  const due = facts.due;
  // The digest bounds the title (A3 3.9.6): a title it cut ends in an ellipsis, so the row never
  // passes a shortened text off as the whole.
  const title = facts.cut?.title === undefined ? facts.title : `${facts.title}…`;
  return {
    id: facts.id,
    ref: facts.ref,
    title,
    ...(facts.summary === "" ? {} : { summary: facts.summary }),
    status: facts.status,
    inbox: facts.inbox,
    lifecycle: facts.lifecycle,
    priority: facts.priority,
    ...(facts.effort === undefined ? {} : { effort: facts.effort }),
    ...(typeof due === "string" ? { due_date: due } : {}),
    ...(typeof due === "object" ? { due_at: Date.parse(due.at), due_tz: due.tz } : {}),
    ...(facts.focus ? { focus_on: today } : {}),
    ...(facts.waiting_on === undefined ? {} : { waiting_on: facts.waiting_on }),
    ...(area === undefined ? {} : { area_id: area.id }),
    ...(project === undefined ? {} : { project_id: project.id }),
    // First in its group: the injected row sits at the top of it (A5 3.3).
    position: "",
    ...(facts.wrap_state === undefined ? {} : { wrap_state: facts.wrap_state }),
    created_at: Number.isFinite(created) ? created : 0,
    version: facts.version,
    // In the Trash: the card offers Restore and takes no other change.
    ...(facts.deleted === undefined ? {} : { deleted_at: Date.parse(facts.deleted.at) }),
  };
}

/** Up to `count` pages of `task`'s sections from `before`, stopping between pages once `stale`. */
async function readPages(
  client: Client,
  task: string,
  before: string | undefined,
  count: number,
  stale: () => boolean,
): Promise<{ pages: Sections[]; before?: string }> {
  const pages: Sections[] = [];
  let next = before;
  for (let page = 0; page < count && !stale(); page += 1) {
    const answer = await client.task.get({
      task,
      sections: [...SECTIONS],
      log_limit: 50,
      ...(next === undefined ? {} : { before: next }),
    });
    if (answer.view !== "sections") return { pages };
    pages.push(answer.sections);
    next = answer.before;
    if (next === undefined) return { pages };
  }
  return { pages, ...(next === undefined ? {} : { before: next }) };
}

const threadRead = (
  facts: TaskFacts,
  named: readonly NoteOutput[],
  removed: readonly RemovedOutput[],
  pages: readonly Sections[],
  before: string | undefined,
): ThreadRead => ({
  detail: mergePages(facts, pages, before !== undefined, named, removed),
  facts,
  named,
  removed,
  pages,
  ...(before === undefined ? {} : { before }),
});

/**
 * Reads the detail of `task` (an ID or a reference) through the client: digest and up to `pages`
 * pages, and whole the notes named in `requests` (the requests of the sessions the thread shows).
 * A read that `stale` says no one waits for any more stops between pages.
 */
export async function readDetail(
  client: Client,
  task: string,
  requests: readonly string[] = [],
  pages = PAGES,
  stale: () => boolean = () => false,
): Promise<ThreadRead> {
  const notes = [...new Set(requests)]
    .sort((a, b) => ordinal(b) - ordinal(a))
    .slice(0, NAMED_NOTES);
  const digest = client.task.get({ task, ...(notes.length === 0 ? {} : { notes }) });
  const read = await readPages(client, task, undefined, pages, stale);
  const facts = await digest;
  if (facts.view !== "digest") throw new Error("task.get answered without a digest");
  return threadRead(
    facts.task,
    facts.notes ?? [],
    facts.removed_notes ?? [],
    read.pages,
    read.before,
  );
}

/** `PAGES` more of the thread `from` holds, from where it ended: the pages before are not read again. */
export async function readOlder(
  client: Client,
  task: string,
  from: ThreadRead,
  stale: () => boolean = () => false,
): Promise<ThreadRead> {
  const read = await readPages(client, task, from.before, PAGES, stale);
  return threadRead(
    from.facts,
    from.named,
    from.removed,
    [...from.pages, ...read.pages],
    read.before,
  );
}
