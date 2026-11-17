// The rows the live store holds and the feed's messages as the page reads them (A5 3.15; the
// service's forms are packages/service/src/http/feed.ts and ws.ts). Everything
// that arrives over the socket is checked by its shape here, once, before the store sees it: a
// message or row the page cannot read is no message or row.
//
// Rows are the service's compact rows: a field that is null in the space is absent.
import type { Instance } from "../api.ts";

export interface TaskRow {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  readonly summary?: string;
  readonly status: string;
  readonly inbox: boolean;
  readonly lifecycle: string;
  readonly priority?: number;
  readonly effort?: string;
  readonly due_date?: string;
  /** A due time, in milliseconds since the epoch (with `due_tz`). */
  readonly due_at?: number;
  readonly due_tz?: string;
  readonly planned_for?: string;
  readonly focus_on?: string;
  readonly owner?: string;
  readonly waiting_on?: string;
  readonly area_id?: string;
  readonly project_id?: string;
  readonly parent_id?: string;
  readonly position: string;
  readonly wrap_state?: string;
  readonly completed_at?: number;
  /** When a finished task was completed or dropped (a dropped one keeps no completion time). */
  readonly finished_at?: number;
  /**
   * The day it was completed, as a search gives it (`task.search`'s `completed`) for a finished
   * task the live store does not hold. Not a compact row's column: `finished_at` wins when present.
   */
  readonly completed_on?: string;
  /**
   * When its current wait began, in milliseconds since the epoch (A5 3.5, 3.6): the Waiting view's
   * age. Absent until the service's compact row carries it.
   */
  readonly waiting_since?: number;
  /**
   * How a finished task ended, one line: why it was dropped, or its outcome once wrapped up. Only
   * a read gives it (Completed, a search); the feed's rows never carry it, so a feed row leaves it
   * while the task stays finished the same way (`withTaskRow`).
   */
  readonly ending?: string;
  readonly deleted_at?: number;
  readonly created_at: number;
  readonly version: number;
  readonly touched?: number;
  /** Its first three sources, with their own text and URL (A5 3.6). Absent: none. */
  readonly sources?: readonly RowSource[];
  /** How many more sources it has than `sources` shows. */
  readonly sources_more?: number;
  /** Its place's state on this machine. Absent: it has no place (A5 3.6). */
  readonly place?: RowPlace;
}

/** A source as the row shows it: its kind and its own text, never a label. */
export interface RowSource {
  readonly kind: string;
  readonly title: string;
  readonly who?: string;
  /** Its key in its own system ("LUM-212"). */
  readonly ref?: string;
  readonly url?: string;
}

/** A task's place on this machine: here and found, here and not found, or on another machine. */
export type RowPlace =
  | { readonly state: "here" | "missing" }
  | { readonly state: "elsewhere"; readonly machine: string };

/**
 * A task's logical fields and their columns (A1 3.4). A feed entity's `changed` names logical
 * fields, never columns: clearing `due` clears `due_date`, `due_at` and `due_tz` together. This is
 * storage's TASK_FIELDS as the page needs it; a test holds the two equal.
 */
export const TASK_FIELD_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  title: ["title"],
  summary: ["summary"],
  context: ["context"],
  status: ["status"],
  inbox: ["inbox"],
  priority: ["priority"],
  effort: ["effort"],
  planned_for: ["planned_for"],
  focus: ["focus_on"],
  owner: ["owner"],
  waiting_on: ["waiting_on"],
  source_at: ["source_at"],
  reviewed_at: ["reviewed_at"],
  due: ["due_date", "due_at", "due_tz"],
  grouping: ["area_id", "project_id", "position"],
  lifecycle: ["lifecycle", "completed_at", "completed_by", "archived_reason"],
  wrap: ["wrap_state", "outcome", "wrapped_at", "wrapped_by"],
  deleted: ["deleted_at", "deleted_by"],
};

/**
 * Every column a logical field of a task stands for, what the compact row carries of the task's
 * children (A5 3.6), and the times it derives: each is the compact row's, present or left out.
 */
const TASK_COLUMNS: ReadonlySet<string> = new Set([
  ...Object.values(TASK_FIELD_COLUMNS).flat(),
  "sources",
  "sources_more",
  "place",
  "waiting_since",
  "finished_at",
]);

/**
 * A row a paged query shows, brought up to a task's post-change compact row from the feed. The
 * compact row leaves out what is null, so each task column is taken from it or removed; what else
 * the shown row carries (a search snippet) stays. Its `ending` stays only while the task is finished
 * the same way: a reopen or a new wrap-up makes it an earlier finish's, which the feed cannot
 * replace. A row at a newer version than the feed's stays as it is: the feed brings the newer change
 * too.
 */
export function withTaskRow<R>(shown: R, after: Readonly<Record<string, unknown>>): R {
  const row = shown as Readonly<Record<string, unknown>>;
  const have = row["version"];
  const next = after["version"];
  if (typeof have === "number" && typeof next === "number" && have >= next) return shown;
  const same = row["lifecycle"] === after["lifecycle"] && row["wrap_state"] === after["wrap_state"];
  const kept = Object.entries(row).filter(
    ([column]) => !TASK_COLUMNS.has(column) && (same || column !== "ending"),
  );
  return { ...Object.fromEntries(kept), ...after } as R;
}

export interface AreaRow {
  readonly id: string;
  readonly title: string;
  readonly position: string;
  readonly color?: number | string;
  readonly deleted_at?: number;
}

export interface ProjectRow {
  readonly id: string;
  readonly area_id?: string;
  readonly title: string;
  readonly position: string;
  readonly deleted_at?: number;
}

export interface SpaceHead {
  readonly id: string;
  readonly name: string;
  readonly ref_prefix: string;
}

/** The applied-through cursor (A1 3.7): the space's authority and the last seq accounted for. */
export interface Cursor {
  readonly epoch: number;
  readonly incarnation: string;
  readonly seq: number;
}

/** The kinds of row the open working set holds. */
export type RowType = "task" | "area" | "project";

export type AnyRow = TaskRow | AreaRow | ProjectRow;

export interface FeedEntity {
  readonly type: string;
  readonly id: string;
  /** The task a child entity (a note, a log entry, a launch) belongs to. */
  readonly task?: string;
  /**
   * The compact post-change row as of the batch's `through`, for a task, area or project. Null
   * for the other kinds, and for a working-set row the service withholds (A5 3.15).
   */
  readonly row: Readonly<Record<string, unknown>> | null;
  readonly changed: readonly string[];
  readonly created: boolean;
}

export interface FeedEvent {
  readonly seq: number;
  /** The commit's ID (`op_`): what a toast's Undo names (A5 3.12). */
  readonly op_id?: string;
  readonly request_id: string;
  readonly actor: { readonly kind: string; readonly label: string };
  readonly kind: string;
  readonly entities: readonly FeedEntity[];
}

export interface SnapshotMessage {
  readonly type: "snapshot";
  readonly space: SpaceHead;
  readonly cursor: Cursor;
  readonly tasks: readonly TaskRow[];
  readonly areas: readonly AreaRow[];
  readonly projects: readonly ProjectRow[];
  readonly instances: readonly Instance[];
}

export interface BatchMessage {
  readonly type: "batch";
  readonly space_id: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly from: number;
  readonly through: number;
  readonly events: readonly FeedEvent[];
}

export interface ErrorMessage {
  readonly type: "error";
  readonly code: string;
}

export interface HelloMessage {
  readonly type: "hello";
  readonly build: string;
  /** The service's version. */
  readonly version: string | undefined;
  /** The installed version, when the service runs another one. */
  readonly installed: string | undefined;
}

/** The install's version changed while the service runs: undefined when it is the service's again. */
export interface InstalledMessage {
  readonly type: "installed";
  readonly version: string | undefined;
}

export type FeedMessage =
  SnapshotMessage | BatchMessage | ErrorMessage | HelloMessage | InstalledMessage;

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const versionOf = (value: unknown): string | undefined =>
  isString(value) && VERSION.test(value) ? value : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isSeq = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isString = (v: unknown): v is string => typeof v === "string";
const optional = (v: unknown, check: (v: unknown) => boolean): boolean =>
  v === undefined || check(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isSource = (v: unknown): boolean =>
  isRecord(v) &&
  isString(v["kind"]) &&
  isString(v["title"]) &&
  optional(v["who"], isString) &&
  optional(v["ref"], isString) &&
  optional(v["url"], isString);

const isSources = (v: unknown): boolean => Array.isArray(v) && v.every(isSource);

const isPlace = (v: unknown): boolean =>
  isRecord(v) &&
  (v["state"] === "here" ||
    v["state"] === "missing" ||
    (v["state"] === "elsewhere" && isString(v["machine"])));

/**
 * A task's compact row, when it has the fields the page relies on with their types. Its other
 * fields are the service's and are taken as they come: a column the page does not read yet must
 * not make a row unreadable, or every change to it would cost a fresh snapshot.
 */
export function taskRow(value: unknown): TaskRow | undefined {
  if (!isRecord(value)) return undefined;
  const v = value;
  if (
    !isString(v["id"]) ||
    !isString(v["ref"]) ||
    !isString(v["title"]) ||
    !isString(v["status"]) ||
    !isString(v["lifecycle"]) ||
    !isString(v["position"]) ||
    typeof v["inbox"] !== "boolean" ||
    !isNumber(v["created_at"]) ||
    !isNumber(v["version"]) ||
    !optional(v["area_id"], isString) ||
    !optional(v["project_id"], isString) ||
    !optional(v["deleted_at"], isNumber) ||
    !optional(v["touched"], isNumber) ||
    !optional(v["waiting_since"], isNumber) ||
    !optional(v["finished_at"], isNumber) ||
    !optional(v["ending"], isString) ||
    !optional(v["sources"], isSources) ||
    !optional(v["sources_more"], isNumber) ||
    !optional(v["place"], isPlace)
  ) {
    return undefined;
  }
  return v as unknown as TaskRow;
}

export function areaRow(value: unknown): AreaRow | undefined {
  if (!isRecord(value)) return undefined;
  const v = value;
  if (
    !isString(v["id"]) ||
    !isString(v["title"]) ||
    !isString(v["position"]) ||
    !optional(v["color"], (c) => isString(c) || isNumber(c)) ||
    !optional(v["deleted_at"], isNumber)
  ) {
    return undefined;
  }
  return v as unknown as AreaRow;
}

export function projectRow(value: unknown): ProjectRow | undefined {
  if (!isRecord(value)) return undefined;
  const v = value;
  if (
    !isString(v["id"]) ||
    !isString(v["title"]) ||
    !isString(v["position"]) ||
    !optional(v["area_id"], isString) ||
    !optional(v["deleted_at"], isNumber)
  ) {
    return undefined;
  }
  return v as unknown as ProjectRow;
}

/** The checker for each kind of row the working set holds. */
export const ROW_OF: Readonly<Record<RowType, (value: unknown) => AnyRow | undefined>> = {
  task: taskRow,
  area: areaRow,
  project: projectRow,
};

export const isRowType = (type: string): type is RowType =>
  type === "task" || type === "area" || type === "project";

/**
 * Whether a row belongs to the open working set, exactly as the service's snapshot chooses it:
 * active tasks that are not deleted, and live areas and projects.
 */
export function inWorkingSet(type: RowType, row: AnyRow): boolean {
  if (row.deleted_at !== undefined) return false;
  return type !== "task" || (row as TaskRow).lifecycle === "active";
}

export function cursorOf(value: unknown): Cursor | undefined {
  if (!isRecord(value)) return undefined;
  const { epoch, incarnation, seq } = value;
  return isSeq(epoch) && isString(incarnation) && isSeq(seq)
    ? { epoch, incarnation, seq }
    : undefined;
}

export const sameAuthority = (a: Cursor, b: Cursor): boolean =>
  a.epoch === b.epoch && a.incarnation === b.incarnation;

function instancesOf(value: unknown): Instance[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (i): i is Instance =>
      isRecord(i) &&
      isString(i["key"]) &&
      isString(i["label"]) &&
      isString(i["glyph"]) &&
      typeof i["ring"] === "number" &&
      isString(i["route"]),
  );
}

function rowsOf<T>(value: unknown, check: (v: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const row = check(item);
    if (row !== undefined) out.push(row);
  }
  return out;
}

function entityOf(value: unknown): FeedEntity | undefined {
  if (!isRecord(value) || !isString(value["type"]) || !isString(value["id"])) return undefined;
  const { type, id, task, row, changed } = value;
  if (!optional(task, isString)) return undefined;
  if (row !== null && row !== undefined && !isRecord(row)) return undefined;
  const fields = Array.isArray(changed) ? changed.filter(isString) : [];
  return {
    type,
    id,
    ...(isString(task) ? { task } : {}),
    row: isRecord(row) ? row : null,
    changed: fields,
    created: value["created"] === true,
  };
}

function eventOf(value: unknown): FeedEvent | undefined {
  if (!isRecord(value) || !isSeq(value["seq"])) return undefined;
  const actor = isRecord(value["actor"]) ? value["actor"] : {};
  const entities: FeedEntity[] = [];
  for (const item of Array.isArray(value["entities"]) ? value["entities"] : []) {
    const entity = entityOf(item);
    // An entity the page cannot read makes the event unreadable: applying the rest would apply
    // part of a commit.
    if (entity === undefined) return undefined;
    entities.push(entity);
  }
  return {
    seq: value["seq"],
    ...(isString(value["op_id"]) ? { op_id: value["op_id"] } : {}),
    request_id: isString(value["request_id"]) ? value["request_id"] : "",
    actor: {
      kind: isString(actor["kind"]) ? actor["kind"] : "",
      label: isString(actor["label"]) ? actor["label"] : "",
    },
    kind: isString(value["kind"]) ? value["kind"] : "",
    entities,
  };
}

/**
 * A message from the feed, checked by its shape, or undefined when it is none the page takes. A
 * batch the page cannot read in full is `unreadable`: its coverage may hide a gap, so the store
 * takes a fresh snapshot rather than apply part of it.
 */
export function parseMessage(text: unknown): FeedMessage | { type: "unreadable" } | undefined {
  if (typeof text !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  switch (value["type"]) {
    case "hello":
      return {
        type: "hello",
        build: isString(value["build"]) ? value["build"] : "",
        version: versionOf(value["version"]),
        installed: versionOf(value["installed"]),
      };
    case "installed":
      return { type: "installed", version: versionOf(value["version"]) };
    case "error":
      return { type: "error", code: isString(value["code"]) ? value["code"] : "" };
    case "snapshot": {
      const space = value["space"];
      const cursor = cursorOf(value["cursor"]);
      if (!isRecord(space) || !isString(space["id"]) || cursor === undefined) return undefined;
      return {
        type: "snapshot",
        space: {
          id: space["id"],
          name: isString(space["name"]) ? space["name"] : "",
          ref_prefix: isString(space["ref_prefix"]) ? space["ref_prefix"] : "",
        },
        cursor,
        tasks: rowsOf(value["tasks"], taskRow),
        areas: rowsOf(value["areas"], areaRow),
        projects: rowsOf(value["projects"], projectRow),
        instances: instancesOf(value["instances"]),
      };
    }
    case "batch": {
      const { space_id, epoch, incarnation, from, through } = value;
      if (
        !isString(space_id) ||
        !isSeq(epoch) ||
        !isString(incarnation) ||
        !isSeq(from) ||
        !isSeq(through) ||
        !Array.isArray(value["events"])
      ) {
        // A batch whose coverage the page cannot read: it may hide a gap.
        return { type: "unreadable" };
      }
      const events: FeedEvent[] = [];
      for (const item of value["events"]) {
        const event = eventOf(item);
        if (event === undefined) return { type: "unreadable" };
        events.push(event);
      }
      return { type: "batch", space_id, epoch, incarnation, from, through, events };
    }
    default:
      return undefined;
  }
}
