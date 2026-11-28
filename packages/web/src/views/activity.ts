// The Activity screen's parts that are no React: the words of a line, and the log of lines the
// screen holds, read from the service's `activity.list` a page at a time by commit number.
//
// The words come from one table: an operation that says what it did in its own words, or a task's
// field with its value. An operation or a field the table does not know reads "changed", so a new
// kind of change gets a line and never breaks the screen.
//
// Lines never change once made, so the log only grows: newer lines go on top when the feed says
// agents changed something, older ones at the end as the person reads on.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { MessageId, Translate } from "../i18n/intl.tsx";
import { formatDay, formatInstant, type Clock } from "../row/dates.ts";

type List = Client["activity"]["list"];
/** The service's read of activity lines. */
export type ActivityRead = (input: Parameters<List>[0]) => ReturnType<List>;
export type ActivityLine = Awaited<ReturnType<List>>["lines"][number];
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

/** What a task's field changed to, in words. */
type FieldWords = (act: Act, say: Say) => string;

const cleared = (act: Act): boolean => act.to === null || act.to === undefined;

/** A task's fields, by the name the service gives them (A1's logical fields). */
const FIELDS: Readonly<Record<string, FieldWords>> = {
  title: (_, { t }) => t("activity.renamed"),
  summary: (_, { t }) => t("activity.summary"),
  context: (_, { t }) => t("activity.context"),
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
  owner: (act, { t }) =>
    cleared(act) ? t("activity.ownerCleared") : t("activity.owner", { to: text(act.to) }),
  waiting_on: (act, { t }) =>
    cleared(act) ? t("activity.waitingCleared") : t("activity.waiting", { to: text(act.to) }),
  reviewed_at: (_, { t }) => t("activity.reviewed"),
  grouping: (act, { t }) =>
    typeof act.to === "string" ? t("activity.moved", { to: act.to }) : t("activity.ungrouped"),
};

/** The operations that say what they did in their own words, whatever fields they set. */
const OPS: Readonly<Record<string, (act: Act, say: Say) => string>> = {
  "task.create": (act, { t }) =>
    typeof act.to === "string" ? t("activity.addedTo", { to: act.to }) : t("activity.added"),
  "task.complete": (_, { t }) => t("activity.completed"),
  "task.wrap_up": (_, { t }) => t("activity.wrapped"),
  "task.reopen": (_, { t }) => t("activity.reopened"),
  "task.archive": (_, { t }) => t("activity.dropped"),
  "task.delete": (_, { t }) => t("activity.trashed"),
  "task.restore": (_, { t }) => t("activity.restored"),
  "task.context_append": (_, { t }) => t("activity.contextAdded"),
  "task.label": (_, { t }) => t("activity.labelled"),
  "note.add": (_, { t }) => t("activity.note"),
  "log.add": (_, { t }) => t("activity.logged"),
  "log.delete": (_, { t }) => t("activity.logRemoved"),
  "source.add": (_, { t }) => t("activity.source"),
  "source.relink": (_, { t }) => t("activity.source"),
  "source.unlink": (_, { t }) => t("activity.sourceUnlinked"),
  "place.set": (_, { t }) => t("activity.folder"),
  "task.folder_set": (_, { t }) => t("activity.folder"),
  "project.folder_set": (_, { t }) => t("activity.folder"),
  "place.clear": (_, { t }) => t("activity.folderCleared"),
  "task.folder_clear": (_, { t }) => t("activity.folderCleared"),
  "project.folder_clear": (_, { t }) => t("activity.folderCleared"),
  "area.create": (act, { t }) => t("activity.areaAdded", { to: text(act.to) }),
  "project.create": (act, { t }) => t("activity.projectAdded", { to: text(act.to) }),
  "run.report": (_, { t }) => t("activity.reported"),
  "pref.set": (_, { t }) => t("activity.setting"),
};

/** The operations whose acts are a task's fields, each in its own words. */
const BY_FIELD: ReadonlySet<string> = new Set(["task.patch", "task.move"]);

/**
 * What a line did, in words: "priority P2 to P1, due 3 Dec". A change that made tasks says that,
 * and not what came with them (their notes and sources).
 */
export function wordsOf(line: ActivityLine, say: Say): string {
  const created = line.acts.find((act) => act.op === "task.create");
  const acts = created === undefined ? line.acts : [created];
  const words: string[] = [];
  for (const act of acts) {
    const own = OPS[act.op];
    const field = BY_FIELD.has(act.op) && act.field !== undefined ? FIELDS[act.field] : undefined;
    const said = own?.(act, say) ?? field?.(act, say) ?? say.t("activity.changed");
    if (!words.includes(said)) words.push(said);
  }
  return words.length === 0 ? say.t("activity.changed") : words.join(", ");
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
