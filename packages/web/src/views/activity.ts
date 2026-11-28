// The Activity screen's parts that are no React: the words of a line, the log of lines the screen
// holds, read from the service's `activity.list` a page at a time by commit number, and how the log
// follows the feed.
//
// A line holds each thing its change touched (a task, a project, an area, a page) with what it did
// to it. The words come from one table: an operation that says what it did in its own words, or a
// field with its value. An operation or a field the table does not know reads "changed", after the
// name of what it changed, so a new kind of change gets a line and never breaks the screen.
//
// Lines never change once made, so the log only grows: newer lines go on top when the feed says
// agents changed something, older ones at the end as the person reads on.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { MessageId, Translate } from "../i18n/intl.tsx";
import { formatDay, formatInstant, type Clock } from "@ttasks/client/today";
import { AGENT_KINDS } from "../app/changes.ts";
import type { Changes } from "../store/store.ts";

type List = Client["activity"]["list"];
/** The service's read of activity lines. */
export type ActivityRead = (input: Parameters<List>[0]) => ReturnType<List>;
export type ActivityLine = Awaited<ReturnType<List>>["lines"][number];
export type Target = ActivityLine["targets"][number];
type Act = ActivityLine["acts"][number];
type Value = Act["to"];

/** What words need besides the line: the page's messages and the viewer's calendar. */
export interface Say {
  readonly t: Translate;
  readonly clock: Clock;
}

const day = (value: Value, { clock }: Say): string =>
  typeof value === "string"
    ? formatDay(value, clock.locale, { day: "numeric", month: "short" })
    : typeof value === "number"
      ? formatInstant(value, clock, { day: "numeric", month: "short" })
      : "";

const text = (value: Value): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** A status by its name on the page, when the page has one. */
function statusOf(value: Value, t: Translate): string {
  const id = `status.${text(value)}`;
  return id in STATUS_IDS ? t(id as MessageId) : text(value);
}
const STATUS_IDS: Readonly<Record<string, true>> = {
  "status.open": true,
  "status.waiting": true,
  "status.review": true,
  "status.backlog": true,
};

/** What an act did, in words. */
type Words = (act: Act, say: Say) => string;

const cleared = (act: Act): boolean => act.to === null || act.to === undefined;
const said =
  (id: MessageId): Words =>
  (_, { t }) =>
    t(id);

/** The fields of a task, a project or an area, by the name the service gives them. */
const FIELDS: Readonly<Record<string, Words>> = {
  title: said("activity.renamed"),
  summary: said("activity.summary"),
  context: said("activity.context"),
  brief: said("activity.brief"),
  color: said("activity.color"),
  owner: said("activity.owner"),
  waiting_on: said("activity.waiting"),
  priority: (act, { t }) =>
    typeof act.from === "number" && act.from !== 4 && act.from !== act.to
      ? t("activity.priorityFrom", { from: act.from, to: text(act.to) })
      : t("activity.priority", { to: text(act.to) }),
  due: (act, say) =>
    cleared(act) ? say.t("activity.dueCleared") : say.t("activity.due", { day: day(act.to, say) }),
  planned_for: (act, say) =>
    cleared(act)
      ? say.t("activity.planCleared")
      : say.t("activity.planned", { day: day(act.to, say) }),
  focus: (act, { t }) => t(cleared(act) ? "activity.unstarred" : "activity.starred"),
  status: (act, { t }) => t("activity.status", { to: statusOf(act.to, t) }),
  inbox: (act, { t }) => t(act.to === true ? "activity.toInbox" : "activity.fromInbox"),
  effort: (act, { t }) =>
    cleared(act) ? t("activity.effortCleared") : t("activity.effort", { to: text(act.to) }),
  reviewed_at: said("activity.reviewed"),
  body: said("activity.pageText"),
  grouping: (act, { t }) =>
    typeof act.to === "string" ? t("activity.moved", { to: act.to }) : t("activity.ungrouped"),
};

const added: Words = (act, { t }) =>
  typeof act.to === "string" ? t("activity.addedTo", { to: act.to }) : t("activity.added");

/** The operations that say what they did in their own words, whatever fields they set. */
const OPS: Readonly<Record<string, Words>> = {
  "task.create": added,
  "project.create": added,
  "area.create": added,
  "task.complete": said("activity.completed"),
  "task.wrap_up": said("activity.wrapped"),
  "task.reopen": said("activity.reopened"),
  "task.archive": said("activity.dropped"),
  "task.delete": said("activity.trashed"),
  "task.restore": said("activity.restored"),
  "project.archive": said("activity.archived"),
  "area.archive": said("activity.archived"),
  "project.unarchive": said("activity.unarchived"),
  "area.unarchive": said("activity.unarchived"),
  "project.delete": said("activity.removed"),
  "area.delete": said("activity.removed"),
  "project.restore": said("activity.restored"),
  "area.restore": said("activity.restored"),
  "task.context_append": said("activity.contextAdded"),
  "task.label": said("activity.labelled"),
  "note.add": said("activity.note"),
  "log.add": said("activity.logged"),
  "log.delete": said("activity.logRemoved"),
  "source.add": said("activity.source"),
  "source.relink": said("activity.source"),
  "source.unlink": said("activity.sourceUnlinked"),
  "place.set": said("activity.folder"),
  "task.folder_set": said("activity.folder"),
  "project.folder_set": said("activity.folder"),
  "place.clear": said("activity.folderCleared"),
  "task.folder_clear": said("activity.folderCleared"),
  "project.folder_clear": said("activity.folderCleared"),
  "pref.set": said("activity.setting"),
  "page.create": added,
  "page.edit": said("activity.pageText"),
  "page.append": said("activity.pageAppended"),
  "page.move": (act, { t }) =>
    typeof act.to === "string" ? t("activity.moved", { to: act.to }) : t("activity.changed"),
  "page.trash": said("activity.trashed"),
  "page.restore": said("activity.restored"),
  "node.set": said("activity.description"),
};

/** The operations whose acts are fields of their target, each in its own words. */
const BY_FIELD: ReadonlySet<string> = new Set([
  "task.patch",
  "task.move",
  "project.patch",
  "project.move",
  "area.patch",
  "area.move",
  "page.set",
]);

/** The operations that finish a task: a task made with one is its follow-up. */
const FINISHES: ReadonlySet<string> = new Set(["task.complete", "task.archive", "task.wrap_up"]);

function wordsOfActs(acts: readonly Act[], say: Say): string {
  const words: string[] = [];
  for (const act of acts) {
    const own = OPS[act.op];
    const field = BY_FIELD.has(act.op) && act.field !== undefined ? FIELDS[act.field] : undefined;
    const one = own?.(act, say) ?? field?.(act, say) ?? say.t("activity.changed");
    if (!words.includes(one)) words.push(one);
  }
  return words.length === 0 ? say.t("activity.changed") : words.join(", ");
}

/**
 * What a change did to one target, in words: "priority P2 to P1, due 3 Dec". A thing the change
 * made says that, and not what came with it (its notes and sources). `place: false` leaves out
 * where it was made.
 */
export function wordsOf(target: Target, say: Say, place = true): string {
  const create =
    target.created === true ? target.acts.find((act) => act.op.endsWith(".create")) : undefined;
  if (create === undefined) return wordsOfActs(target.acts, say);
  return wordsOfActs([place ? create : { op: create.op }], say);
}

/** A target with what the change did to it. */
export interface Said {
  readonly target: Target;
  readonly words: string;
}

/**
 * How a line reads:
 * - `one`: a thing and what happened to it, then what else the change made or touched, each with
 *   its own words ("completed, follow-up added: …");
 * - `many`: several things that the same happened to, counted ("3 tasks added"), each with its own
 *   words when the person opens the count;
 * - `none`: what the change did that touched no task, project or area.
 */
export type Shape =
  | { readonly kind: "one"; readonly main: Said; readonly also: readonly Said[] }
  | {
      readonly kind: "many";
      readonly count: number;
      readonly of: Target["kind"];
      readonly words: string;
      readonly each: readonly Said[];
    }
  | { readonly kind: "none"; readonly words: string };

export function shapeOf(line: ActivityLine, say: Say): Shape {
  const targets = line.targets;
  const first = targets[0];
  if (first === undefined) return { kind: "none", words: wordsOfActs(line.acts, say) };
  const each = targets.map((target) => ({ target, words: wordsOf(target, say) }));
  const short = targets.map((target) => wordsOf(target, say, false));
  if (targets.length > 1 && short.every((words) => words === short[0])) {
    return { kind: "many", count: line.count, of: first.kind, words: short[0] ?? "", each };
  }
  const main = each.find((s) => s.target.created !== true) ??
    each[0] ?? { target: first, words: "" };
  const finished = main.target.acts.some((act) => FINISHES.has(act.op));
  const also = each
    .filter((s) => s !== main)
    .map((s) =>
      finished && s.target.created === true && s.target.kind === "task"
        ? { ...s, words: say.t("activity.followUp") }
        : s,
    );
  return { kind: "one", main, also };
}

/** A line as one sentence, for the announcement of a line that came. */
export function sentenceOf(line: ActivityLine, who: string, say: Say): string {
  const shape = shapeOf(line, say);
  switch (shape.kind) {
    case "none":
      return `${who}, ${shape.words}`;
    case "many":
      return `${who}, ${say.t("activity.many", { count: shape.count, of: shape.of })} ${shape.words}`;
    case "one":
      return [
        `${who}, ${shape.main.target.name}, ${shape.main.words}`,
        ...shape.also.map((s) => `${s.words}: ${s.target.name}`),
      ].join(", ");
  }
}

/** The live session as the log follows it: its frames, and whether its feed is live. */
export interface Feed {
  onChanges(listener: (changes: Changes) => void): () => void;
  subscribe(listener: () => void): () => void;
  getState(): { readonly phase: string };
}

/**
 * Reads newer lines when the feed brings an agent's change, and once when the feed is live again
 * after it was not: a read that failed while the connection was down is not lost in a quiet space.
 * Returns the way to stop.
 */
export function follow(log: ActivityLog, feed: Feed): () => void {
  const stopChanges = feed.onChanges(({ changes, reset }) => {
    if (reset || changes.some((change) => AGENT_KINDS.has(change.actor.kind))) void log.newer();
  });
  let live = feed.getState().phase === "live";
  const stopPhase = feed.subscribe(() => {
    const now = feed.getState().phase === "live";
    if (now && !live) void log.newer();
    live = now;
  });
  return () => {
    stopChanges();
    stopPhase();
  };
}

/** What the screen holds: the lines, newest first, and how its reads went. */
export interface ActivityState {
  readonly lines: readonly ActivityLine[];
  /** The first read: under way, done, or failed. */
  readonly phase: "loading" | "ready" | "failed";
  /** Older lines lie past the last one. */
  readonly more: boolean;
  /** A read of older lines is under way. */
  readonly loadingOlder: boolean;
  /** The last read of older lines failed. */
  readonly olderFailed: boolean;
}

/** The lines one read brings. */
export const PAGE = 50;

const START: ActivityState = {
  lines: [],
  phase: "loading",
  more: false,
  loadingOlder: false,
  olderFailed: false,
};

/**
 * The lines the screen holds. Reads go one at a time, in the order asked: a read of newer lines
 * asked while one waits is the same read, since it reads on from the top whenever it runs.
 */
export class ActivityLog {
  #state: ActivityState = START;
  readonly #read: ActivityRead;
  readonly #listeners = new Set<() => void>();
  #queue: Promise<void> = Promise.resolve();
  #newerQueued = false;

  constructor(read: ActivityRead) {
    this.#read = read;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): ActivityState => this.#state;

  /** Reads the newest lines; again after a failure. */
  start(): Promise<void> {
    this.#set({ ...START });
    return this.#then(async () => {
      try {
        const page = await this.#read({ limit: PAGE });
        this.#set({ ...this.#state, lines: page.lines, more: page.more, phase: "ready" });
      } catch {
        this.#set({ ...this.#state, phase: "failed" });
      }
    });
  }

  /** Reads the lines that came after the newest one held, until none is left. */
  newer(): Promise<void> {
    if (this.#newerQueued) return this.#queue;
    this.#newerQueued = true;
    return this.#then(async () => {
      this.#newerQueued = false;
      if (this.#state.phase !== "ready") return;
      try {
        for (;;) {
          const top = this.#state.lines[0]?.seq ?? 0;
          const page = await this.#read({ after: top, limit: PAGE });
          if (page.lines.length > 0)
            this.#set({ ...this.#state, lines: merge(page.lines, this.#state.lines) });
          if (!page.more || page.lines.length === 0) break;
        }
      } catch {
        // The next change the feed tells of reads on from the same place.
      }
    });
  }

  /** Reads the next stretch of older lines. */
  older(): Promise<void> {
    const state = this.#state;
    if (state.phase !== "ready" || !state.more || state.loadingOlder) return this.#queue;
    this.#set({ ...state, loadingOlder: true, olderFailed: false });
    return this.#then(async () => {
      const last = this.#state.lines.at(-1)?.seq;
      try {
        const page = await this.#read({
          limit: PAGE,
          ...(last === undefined ? {} : { before: last }),
        });
        this.#set({
          ...this.#state,
          lines: merge(this.#state.lines, page.lines),
          more: page.more,
          loadingOlder: false,
        });
      } catch {
        this.#set({ ...this.#state, loadingOlder: false, olderFailed: true });
      }
    });
  }

  #then(step: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(step);
    return this.#queue;
  }

  #set(state: ActivityState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

/** Two runs of lines, newest first, the first newer: each commit once. */
function merge(
  above: readonly ActivityLine[],
  below: readonly ActivityLine[],
): readonly ActivityLine[] {
  const bottom = above.at(-1)?.seq;
  return bottom === undefined ? below : [...above, ...below.filter((line) => line.seq < bottom)];
}
