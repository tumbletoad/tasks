// The expanded task's detail (A5 3.7, 3.15 item 8): what the live row does not hold, read with
// `task.get` in parts that start together. The digest gives the task's own facts in any
// lifecycle (its place on this machine, when it was created). The sections give the long text in
// full: the context, every note (those to agents too), the log, the sources, the outcome and
// learnings. A sections read comes in pages sized for an agent's budget (A3 3.4.4), so this reads
// page after page, up to `MAX_PAGES`, and joins a text a page boundary split. The notes the
// thread's sessions name as their requests come whole with the digest, by reference, whatever
// their age or length. Plain code: the hook (useDetail.ts) refetches it when the feed touches the
// task.
import type { Client } from "@tasks/contracts/generated/client.ts";
import type { AreaRow, ProjectRow, TaskRow } from "../store/rows.ts";

type GetResult = Awaited<ReturnType<Client["task"]["get"]>>;
type DigestView = Extract<GetResult, { view: "digest" }>;
type SectionsView = Extract<GetResult, { view: "sections" }>;
type Sections = SectionsView["sections"];

/** The digest's task: the facts of a task in any lifecycle. */
export type TaskFacts = DigestView["task"];
export type SourceOutput = NonNullable<Sections["sources"]>[number];
type NoteOutput = NonNullable<Sections["notes"]>[number];
type LogOutput = NonNullable<Sections["log"]>[number];

export interface DetailNote {
  readonly kind: "note";
  readonly ref: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly forAgents: boolean;
  /** The launches this note was the person's request for, oldest first, by reference. */
  readonly requestFor?: readonly { readonly launch: string; readonly instance: string }[];
}

export interface DetailLog {
  readonly kind: "log";
  readonly ref: string;
  readonly author: string;
  readonly at: string;
  readonly text: string;
  readonly logKind: string;
}

export interface Detail {
  readonly task: TaskFacts;
  readonly context: string;
  /** Every note, oldest first. */
  readonly notes: readonly DetailNote[];
  /** Every log entry, oldest first. */
  readonly log: readonly DetailLog[];
  readonly sources: readonly SourceOutput[];
  readonly outcome?: string;
  readonly learnings: readonly string[];
  /** The pages ran out before the end: older notes and log entries are not here. */
  readonly partial: boolean;
}

/** At most this many pages per read: about 80 kB of text, far beyond a task's usual size. */
export const MAX_PAGES = 20;

/** The most notes one read names, as `task.get` takes them: the newest are read. */
const NAMED_NOTES = 64;

const SECTIONS = ["instructions", "context", "notes", "log", "sources", "outcome"] as const;

/** A note reference's ordinal: `n12` is 12. */
const ordinal = (ref: string): number => Number(ref.slice(1));

/**
 * Joins the entries of successive pages, newest first as they come. A text a page boundary split
 * comes as parts of one entry with the same ref, each with its slice: they join into one.
 */
function joined<T extends { ref: string; text: string }>(pages: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (const page of pages) {
    for (const entry of page) {
      const last = out.at(-1);
      if (last !== undefined && last.ref === entry.ref) {
        out[out.length - 1] = { ...last, text: last.text + entry.text };
      } else {
        out.push(entry);
      }
    }
  }
  return out;
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
  const toNote = (n: NoteOutput): DetailNote => ({
    kind: "note",
    ref: n.ref,
    author: n.author,
    at: n.at,
    text: n.text,
    forAgents: n.for_agents,
    ...(n.request_for === undefined ? {} : { requestFor: n.request_for }),
  });
  const byTime = <E extends { at: string; ref: string }>(a: E, b: E) =>
    Date.parse(a.at) - Date.parse(b.at) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  return {
    task,
    context: pages.map((p) => p.context ?? "").join(""),
    notes: [...paged, ...whole.values()].map(toNote).sort(byTime),
    log: log
      .map((l): DetailLog => ({
        kind: "log",
        ref: l.ref,
        author: l.author,
        at: l.at,
        text: l.text,
        logKind: l.kind,
      }))
      .sort(byTime),
    sources: pages.flatMap((p) => p.sources ?? []),
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
  // The digest bounds the title and summary (A3 3.9.6): a text it cut ends in an ellipsis, so the
  // row never passes a shortened text off as the whole.
  const whole = (text: string, cut: number | undefined) =>
    cut === undefined || cut <= 0 ? text : `${text}…`;
  const summary = whole(facts.summary, facts.cut?.summary);
  return {
    id: facts.id,
    ref: facts.ref,
    title: whole(facts.title, facts.cut?.title),
    ...(summary === "" ? {} : { summary }),
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
  };
}

/**
 * Reads the detail of `task` (an ID or a reference) through the client: digest and every page,
 * and whole the notes named in `requests` (the requests of the sessions the thread shows).
 */
export async function readDetail(
  client: Client,
  task: string,
  requests: readonly string[] = [],
): Promise<Detail> {
  const notes = [...new Set(requests)]
    .sort((a, b) => ordinal(b) - ordinal(a))
    .slice(0, NAMED_NOTES);
  const digest = client.task.get({ task, ...(notes.length === 0 ? {} : { notes }) });
  const pages: Sections[] = [];
  let before: string | undefined;
  let partial = false;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      partial = true;
      break;
    }
    const read = await client.task.get({
      task,
      sections: [...SECTIONS],
      log_limit: 50,
      ...(before === undefined ? {} : { before }),
    });
    if (read.view !== "sections") break;
    pages.push(read.sections);
    before = read.before;
    if (before === undefined) break;
  }
  const facts = await digest;
  if (facts.view !== "digest") throw new Error("task.get answered without a digest");
  return mergePages(facts.task, pages, partial, facts.notes ?? []);
}
