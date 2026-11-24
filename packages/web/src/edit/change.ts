// What a person's edit of one field is (A5 3.11): the `task.update` input that makes it, the
// overlay that shows it at once, and the words the toast says. Every hand edit is one of these, so
// the star, the title and the facts all take one path (edits.ts).
//
// Fields are A1's logical fields as the feed names them (`due` covers the three due columns,
// `grouping` the area and project, `focus` the star), so a conflict and a remote change name the
// same field the edit does.
import type { Client } from "@ttasks/contracts/generated/client.ts";
import type { Msg } from "../row/model.ts";
import type { TaskField } from "../store/pending.ts";
import type { TaskRow } from "../store/rows.ts";

type UpdateInput = Parameters<Client["task"]["update"]>[0];
export type UpdateSet = NonNullable<UpdateInput["set"]>;
export type Clearable = NonNullable<UpdateInput["clear"]>[number];

/** The logical fields a person edits by hand (A5 3.11, U10). */
export type Field =
  | "title"
  | "summary"
  | "status"
  | "inbox"
  | "priority"
  | "effort"
  | "due"
  | "waiting_on"
  | "grouping"
  | "focus";

export interface Change {
  /** The fields it writes: one for a control, several for "Apply mine" of several kept edits. */
  readonly fields: readonly Field[];
  readonly set?: UpdateSet;
  readonly clear?: readonly Clearable[];
  /** What the row shows until the feed confirms it. */
  readonly overlay: {
    readonly set: Partial<Omit<TaskRow, "id">>;
    readonly clear?: readonly TaskField[];
  };
  /** The toast's sentence ("Priority set to P1"). */
  readonly said: Msg;
  /** The person's value as words ("P1"), for "Apply mine" while it is not saved. */
  readonly shown: Words;
  /**
   * A change of several fields, as its one-field changes: a refusal keeps each, and a newer edit
   * of one field replaces only that one (A5 3.11).
   */
  readonly parts?: readonly Change[];
  /** What made a one-field change: `changeOf` makes it again, after a reload. */
  readonly source?: Source;
}

interface Named {
  readonly id: string;
  readonly title: string;
}

/** A one-field change as the control made it: its builder and that builder's arguments. */
export type Source =
  | { readonly kind: "title"; readonly title: string }
  | { readonly kind: "star"; readonly on: boolean; readonly today: string }
  | { readonly kind: "priority"; readonly level: number }
  | { readonly kind: "effort"; readonly effort?: string; readonly levels?: string }
  | { readonly kind: "due"; readonly date?: string; readonly words?: string }
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "inbox" }
  | { readonly kind: "waiting"; readonly person?: string }
  | { readonly kind: "grouping"; readonly area: Named; readonly project?: Named };

/** Words for a value: a message, or the person's own text. */
export type Words = Msg | string;

const plain = (text: string): Words => text;

export function titleChange(title: string): Change {
  return {
    fields: ["title"],
    set: { title },
    overlay: { set: { title } },
    said: { id: "toast.title" },
    shown: plain(title),
    source: { kind: "title", title },
  };
}

export function starChange(on: boolean, today: string): Change {
  const source: Source = { kind: "star", on, today };
  return on
    ? {
        fields: ["focus"],
        set: { focus: true },
        overlay: { set: { focus_on: today } },
        said: { id: "toast.starred" },
        shown: { id: "edit.starOn" },
        source,
      }
    : {
        fields: ["focus"],
        clear: ["focus"],
        overlay: { set: {}, clear: ["focus_on"] },
        said: { id: "toast.unstarred" },
        shown: { id: "edit.starOff" },
        source,
      };
}

/** P1 to P3, or 4: no priority (A1: 4 is the default and means none). */
export function priorityChange(level: number): Change {
  const shown: Words = level >= 1 && level <= 3 ? { id: "row.priority", values: { level } } : none;
  return {
    fields: ["priority"],
    set: { priority: level },
    overlay: { set: { priority: level } },
    said: level >= 1 && level <= 3 ? { id: "toast.priority", values: { value: shown } } : cleared,
    shown,
    source: { kind: "priority", level },
  };
}

const none: Msg = { id: "edit.none" };
const cleared: Msg = { id: "toast.priorityCleared" };

/** The effort levels a size was chosen from, as a kept edit remembers them. */
export const levelsKey = (levels: readonly unknown[]): string => JSON.stringify(levels);

/**
 * A size, with the levels it was chosen from (levelsKey): a kept one is sent again only while the
 * levels are those, since a change of them can give its name another meaning or none.
 */
export function effortChange(effort: string | undefined, levels?: string): Change {
  return effort === undefined
    ? {
        fields: ["effort"],
        clear: ["effort"],
        overlay: { set: {}, clear: ["effort"] },
        said: { id: "toast.effortCleared" },
        shown: none,
        source: { kind: "effort" },
      }
    : {
        fields: ["effort"],
        set: { effort },
        overlay: { set: { effort } },
        said: { id: "toast.effort", values: { value: effort } },
        shown: plain(effort),
        source: { kind: "effort", effort, ...(levels === undefined ? {} : { levels }) },
      };
}

/** A due day (YYYY-MM-DD) in words, as the facts show it: the caller formats it. */
export function dueChange(date: string | undefined, words: Words | undefined): Change {
  return date === undefined
    ? {
        fields: ["due"],
        clear: ["due"],
        overlay: { set: {}, clear: ["due_date", "due_at", "due_tz"] },
        said: { id: "toast.dueCleared" },
        shown: none,
        source: { kind: "due" },
      }
    : {
        fields: ["due"],
        set: { due: date },
        overlay: { set: { due_date: date }, clear: ["due_at", "due_tz"] },
        said: { id: "toast.due", values: { value: words ?? plain(date) } },
        shown: words ?? plain(date),
        source: { kind: "due", date, ...(typeof words === "string" ? { words } : {}) },
      };
}

const STATUS_WORDS: Readonly<Record<string, Msg["id"]>> = {
  open: "status.open",
  waiting: "status.waiting",
  review: "status.review",
  backlog: "status.backlog",
};

export const statusWords = (status: string): Words => {
  const id = STATUS_WORDS[status];
  return id === undefined ? plain(status) : { id };
};

export function statusChange(status: string): Change {
  return {
    fields: ["status"],
    set: { status },
    overlay: { set: { status } },
    said: { id: "toast.status", values: { value: statusWords(status) } },
    shown: statusWords(status),
    source: { kind: "status", status },
  };
}

/** Out of the Inbox, into Open (A5 3.7 "Move to Open"). */
export function triageChange(): Change {
  const out: Change = {
    fields: ["inbox"],
    set: { inbox: false },
    overlay: { set: { inbox: false } },
    said: { id: "toast.triaged" },
    shown: { id: "edit.outOfInbox" },
    source: { kind: "inbox" },
  };
  const joined = joinChanges([out, statusChange("open")]);
  return { ...(joined ?? out), said: { id: "toast.triaged" }, shown: { id: "status.open" } };
}

export function waitingChange(person: string | undefined): Change {
  return person === undefined
    ? {
        fields: ["waiting_on"],
        clear: ["waiting_on"],
        overlay: { set: {}, clear: ["waiting_on"] },
        said: { id: "toast.waitingCleared" },
        shown: none,
        source: { kind: "waiting" },
      }
    : {
        fields: ["waiting_on"],
        set: { waiting_on: person },
        overlay: { set: { waiting_on: person } },
        said: { id: "toast.waiting", values: { value: person } },
        shown: plain(person),
        source: { kind: "waiting", person },
      };
}

/** Into an area, or a project of it (the service moves the task with `task.move`). */
export function groupingChange(
  area: { id: string; title: string },
  project: { id: string; title: string } | undefined,
): Change {
  const shown: Words =
    project === undefined
      ? plain(area.title)
      : { id: "fact.areaProject", values: { area: area.title, project: project.title } };
  return {
    fields: ["grouping"],
    set: { area: area.id, ...(project === undefined ? {} : { project: project.id }) },
    overlay:
      project === undefined
        ? { set: { area_id: area.id }, clear: ["project_id"] }
        : { set: { area_id: area.id, project_id: project.id } },
    said: { id: "toast.moved", values: { value: shown } },
    shown,
    source: {
      kind: "grouping",
      area: { id: area.id, title: area.title },
      ...(project === undefined ? {} : { project: { id: project.id, title: project.title } }),
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The edit that sets one field to `value`, a conflict's value in storage's form (a column's value,
 * or an object of a field's columns), to compare what it does with a person's edit. Undefined for a
 * value no hand edit sets: a due time (the service sets dates only), no area, the lifecycle and
 * every agent-only field.
 */
export function changeTo(field: string, value: unknown): Change | undefined {
  switch (field) {
    case "title":
      return typeof value === "string" && value !== "" ? titleChange(value) : undefined;
    case "status":
      return typeof value === "string" && value !== "" ? statusChange(value) : undefined;
    case "priority":
      if (value === null) return priorityChange(4);
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4
        ? priorityChange(value)
        : undefined;
    case "effort":
      if (value === null) return effortChange(undefined);
      return typeof value === "string" && value !== "" ? effortChange(value) : undefined;
    case "waiting_on":
      if (value === null) return waitingChange(undefined);
      return typeof value === "string" && value !== "" ? waitingChange(value) : undefined;
    case "focus":
      // The star's value is its day; putting it back stars the task for today.
      if (value === null) return starChange(false, "");
      return typeof value === "string" ? { ...starChange(true, value) } : undefined;
    case "due": {
      if (!isRecord(value)) return undefined;
      const date = value["due_date"];
      if (value["due_at"] !== null && value["due_at"] !== undefined) return undefined;
      if (date === null || date === undefined) return dueChange(undefined, undefined);
      return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date)
        ? dueChange(date, undefined)
        : undefined;
    }
    case "grouping": {
      if (!isRecord(value)) return undefined;
      const area = value["area_id"];
      const project = value["project_id"];
      if (typeof area !== "string") return undefined;
      return {
        fields: ["grouping"],
        set: { area, ...(typeof project === "string" ? { project } : {}) },
        overlay:
          typeof project === "string"
            ? { set: { area_id: area, project_id: project } }
            : { set: { area_id: area }, clear: ["project_id"] },
        // Compared, never shown: the area's and project's names are not known here.
        said: none,
        shown: none,
      };
    }
    default:
      return undefined;
  }
}

/** Several fields' edits of one task as one edit: one operation, one toast. */
export function joinChanges(changes: readonly Change[]): Change | undefined {
  if (changes.length === 0) return undefined;
  if (changes.length === 1) return changes[0];
  const set: Record<string, unknown> = {};
  const clear: Clearable[] = [];
  const overlaySet: Record<string, unknown> = {};
  const overlayClear: TaskField[] = [];
  for (const change of changes) {
    Object.assign(set, change.set ?? {});
    clear.push(...(change.clear ?? []));
    Object.assign(overlaySet, change.overlay.set);
    overlayClear.push(...(change.overlay.clear ?? []));
  }
  return {
    fields: changes.flatMap((c) => c.fields),
    ...(Object.keys(set).length > 0 ? { set: set } : {}),
    ...(clear.length > 0 ? { clear } : {}),
    overlay: {
      set: overlaySet,
      ...(overlayClear.length > 0 ? { clear: overlayClear } : {}),
    },
    said: { id: "toast.restored" },
    shown: { id: "edit.restoredMany", values: { count: changes.length } },
    parts: changes.flatMap((c) => c.parts ?? [c]),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
/** An entity's ID as the page reads one: a short prefix and its base32 body. */
const ID = /^[a-z]{1,4}_[0-9a-z]{1,64}$/u;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value !== "" && value.length <= max;

function namedOf(value: unknown): Named | undefined {
  if (!isRecord(value)) return undefined;
  const { id, title } = value;
  return typeof id === "string" && ID.test(id) && text(title, 300) ? { id, title } : undefined;
}

/**
 * The change a source makes, the same as its control made it; undefined for anything a control
 * could not have made. A source read back from the browser's storage is untrusted, so only its
 * values are used, each checked, and the change is built the one way.
 */
export function changeOf(source: unknown): Change | undefined {
  if (!isRecord(source)) return undefined;
  const s = source;
  switch (s["kind"]) {
    case "title":
      return text(s["title"], 1_000) ? titleChange(s["title"]) : undefined;
    case "star": {
      const today = s["today"];
      if (typeof s["on"] !== "boolean" || typeof today !== "string") return undefined;
      return today === "" || DAY.test(today) ? starChange(s["on"], today) : undefined;
    }
    case "priority": {
      const level = s["level"];
      return typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 4
        ? priorityChange(level)
        : undefined;
    }
    case "effort":
      if (s["effort"] === undefined) return effortChange(undefined);
      return text(s["effort"], 40)
        ? effortChange(s["effort"], typeof s["levels"] === "string" ? s["levels"] : undefined)
        : undefined;
    case "due": {
      const date = s["date"];
      if (date === undefined) return dueChange(undefined, undefined);
      if (typeof date !== "string" || !DAY.test(date)) return undefined;
      return dueChange(date, text(s["words"], 80) ? s["words"] : undefined);
    }
    case "status":
      return text(s["status"], 40) && /^[a-z_]+$/u.test(s["status"])
        ? statusChange(s["status"])
        : undefined;
    case "inbox":
      return triageChange().parts?.find((part) => part.fields[0] === "inbox");
    case "waiting":
      if (s["person"] === undefined) return waitingChange(undefined);
      return text(s["person"], 300) ? waitingChange(s["person"]) : undefined;
    case "grouping": {
      const area = namedOf(s["area"]);
      const project = s["project"] === undefined ? undefined : namedOf(s["project"]);
      if (area === undefined || (s["project"] !== undefined && project === undefined)) {
        return undefined;
      }
      return groupingChange(area, project);
    }
    default:
      return undefined;
  }
}
