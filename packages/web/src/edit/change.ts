// What a person's edit of one field is (A5 3.11): the `task.update` input that makes it, the
// overlay that shows it at once, and the words the toast says. Every hand edit is one of these, so
// the star, the title, the facts and "Restore mine" all take one path (edits.ts).
//
// Fields are A1's logical fields as the feed names them (`due` covers the three due columns,
// `grouping` the area and project, `focus` the star), so a conflict and a remote change name the
// same field the edit does.
import type { Client } from "@tasks/contracts/generated/client.ts";
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
  /** The fields it writes: one for a control, several for "Restore mine". */
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
  readonly shown: Msg;
}

const plain = (text: string): Msg => ({ id: "edit.value", values: { value: text } });

export function titleChange(title: string): Change {
  return {
    fields: ["title"],
    set: { title },
    overlay: { set: { title } },
    said: { id: "toast.title" },
    shown: plain(title),
  };
}

export function starChange(on: boolean, today: string): Change {
  return on
    ? {
        fields: ["focus"],
        set: { focus: true },
        overlay: { set: { focus_on: today } },
        said: { id: "toast.starred" },
        shown: { id: "edit.starOn" },
      }
    : {
        fields: ["focus"],
        clear: ["focus"],
        overlay: { set: {}, clear: ["focus_on"] },
        said: { id: "toast.unstarred" },
        shown: { id: "edit.starOff" },
      };
}

/** P1 to P3, or 4: no priority (A1: 4 is the default and means none). */
export function priorityChange(level: number): Change {
  const shown: Msg = level >= 1 && level <= 3 ? { id: "row.priority", values: { level } } : none;
  return {
    fields: ["priority"],
    set: { priority: level },
    overlay: { set: { priority: level } },
    said: level >= 1 && level <= 3 ? { id: "toast.priority", values: { value: shown } } : cleared,
    shown,
  };
}

const none: Msg = { id: "edit.none" };
const cleared: Msg = { id: "toast.priorityCleared" };

export function effortChange(effort: string | undefined): Change {
  return effort === undefined
    ? {
        fields: ["effort"],
        clear: ["effort"],
        overlay: { set: {}, clear: ["effort"] },
        said: { id: "toast.effortCleared" },
        shown: none,
      }
    : {
        fields: ["effort"],
        set: { effort },
        overlay: { set: { effort } },
        said: { id: "toast.effort", values: { value: effort } },
        shown: plain(effort),
      };
}

/** A due day (YYYY-MM-DD) in words, as the facts show it: the caller formats it. */
export function dueChange(date: string | undefined, words: Msg | undefined): Change {
  return date === undefined
    ? {
        fields: ["due"],
        clear: ["due"],
        overlay: { set: {}, clear: ["due_date", "due_at", "due_tz"] },
        said: { id: "toast.dueCleared" },
        shown: none,
      }
    : {
        fields: ["due"],
        set: { due: date },
        overlay: { set: { due_date: date }, clear: ["due_at", "due_tz"] },
        said: { id: "toast.due", values: { value: words ?? plain(date) } },
        shown: words ?? plain(date),
      };
}

const STATUS_WORDS: Readonly<Record<string, Msg["id"]>> = {
  open: "status.open",
  waiting: "status.waiting",
  review: "status.review",
  backlog: "status.backlog",
};

export const statusWords = (status: string): Msg => {
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
  };
}

/** Out of the Inbox, into Open (A5 3.7 "Move to Open"). */
export function triageChange(): Change {
  return {
    fields: ["inbox", "status"],
    set: { inbox: false, status: "open" },
    overlay: { set: { inbox: false, status: "open" } },
    said: { id: "toast.triaged" },
    shown: { id: "status.open" },
  };
}

export function waitingChange(person: string | undefined): Change {
  return person === undefined
    ? {
        fields: ["waiting_on"],
        clear: ["waiting_on"],
        overlay: { set: {}, clear: ["waiting_on"] },
        said: { id: "toast.waitingCleared" },
        shown: none,
      }
    : {
        fields: ["waiting_on"],
        set: { waiting_on: person },
        overlay: { set: { waiting_on: person } },
        said: { id: "toast.waiting", values: { value: person } },
        shown: plain(person),
      };
}

/** Into an area, or a project of it (the service moves the task with `task.move`). */
export function groupingChange(
  area: { id: string; title: string },
  project: { id: string; title: string } | undefined,
): Change {
  const shown: Msg =
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
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The edit that puts one field back to `value`, the value an undo would have set back (A1 3.10.1
 * `restore`, in storage's form: a column's value, or an object of a field's columns). Undefined for
 * a field no hand edit can set to that value: a due time (the service sets dates only), no area,
 * the lifecycle and every agent-only field. Then the toast offers no "Restore mine".
 */
export function restoreChange(field: string, value: unknown): Change | undefined {
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
        said: { id: "toast.restored" },
        shown: { id: "edit.restoredGroup" },
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
    ...(Object.keys(set).length > 0 ? { set: set as UpdateSet } : {}),
    ...(clear.length > 0 ? { clear } : {}),
    overlay: {
      set: overlaySet as Partial<Omit<TaskRow, "id">>,
      ...(overlayClear.length > 0 ? { clear: overlayClear } : {}),
    },
    said: { id: "toast.restored" },
    shown: { id: "edit.restoredMany", values: { count: changes.length } },
  };
}
