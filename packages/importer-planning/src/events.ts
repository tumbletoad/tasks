// The check and focus events in events/ (A7 3.15.2, Events).
//
// Every events/*.json is read in sorted file-name order. A file whose name starts with `web-` counts
// only when events/<same stem>.ready exists; any other file counts as soon as it exists. An event is
// an object {id, task, action, at}: action check, uncheck, focus or unfocus; id of 1 to 100
// characters from [a-zA-Z0-9_-]; task of one or more of those characters, since a ledger ID has no
// length bound; at an RFC 3339 time with a zone, where the seconds may be left out
// and the fraction has up to nine digits. Counted events apply in order of the instant of `at`, then
// `id` as text. The last check or uncheck per task wins, and the last focus or unfocus sets the star.
//
// The prototype fails its whole read on one invalid file. The importer instead leaves that file out
// with `event-invalid` (an error), so the report can name every bad file at once.

import { isObject, readJson } from "./json.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { isSafeFile, problem, type Problem } from "./problems.ts";
import { compareCodePoints, daysIn, type Source } from "./text.ts";

export const EVENTS_DIR = "events";

export const ACTIONS = ["check", "uncheck", "focus", "unfocus"] as const;
export type EventAction = (typeof ACTIONS)[number];

/** One file of events/: its name in the folder, and its bytes for a `.json` file. */
export interface EventFileInput {
  readonly name: string;
  readonly bytes?: Source;
}

export interface PrototypeEvent {
  readonly id: string;
  readonly task: string;
  readonly action: EventAction;
  /** As written. */
  readonly at: string;
  /** The file name in events/. */
  readonly file: string;
}

export interface EventFileResult {
  readonly name: string;
  /** Present when the file holds a valid event. */
  readonly event?: PrototypeEvent;
  readonly counted: boolean;
}

/** The folded state of one task. */
export interface TaskEventState {
  /** The last check or uncheck. */
  readonly check?: { readonly checked: boolean; readonly at: string; readonly event: string };
  /** The last focus or unfocus. `day` is the date of a focus as its time writes it. */
  readonly star?: {
    readonly starred: boolean;
    readonly at: string;
    readonly event: string;
    readonly day?: string;
  };
}

export interface EventsParse {
  /** Every events/*.json, in sorted file-name order. */
  readonly files: readonly EventFileResult[];
  readonly readyFiles: number;
  /** The counted events in the order they apply. */
  readonly applied: readonly PrototypeEvent[];
  /** The fold, per task ID. */
  readonly state: ReadonlyMap<string, TaskEventState>;
  readonly problems: Problem[];
}

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The task an event names: any ledger ID. A marker ID has no length bound, so neither has this;
 * the event file's own size bound holds it. */
const TASK = /^[a-zA-Z0-9_-]+$/;

/**
 * Where a problem about an event file points: `events/<name>` when the name follows the event
 * grammar, otherwise the folder and the file's position in the sorted list (problems.ts).
 */
export function eventPlace(name: string, index: number): { file: string; index?: number } {
  const file = `${EVENTS_DIR}/${name}`;
  return isSafeFile(file) ? { file } : { file, index };
}
const AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instant of an event time in microseconds since 0001-01-01, or undefined when the text is no
 * valid time. A fraction beyond six digits is cut, as Python's datetime does, so two times that
 * differ by less than a microsecond are one instant and their IDs order them.
 */
export function eventInstant(at: string): bigint | undefined {
  const m = AT.exec(at);
  if (m === null) return undefined;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = Number(m[6] ?? "0");
  if (y === undefined || mo === undefined || d === undefined || h === undefined) return undefined;
  if (mi === undefined || y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    return undefined;
  }
  if (h > 23 || mi > 59 || s > 59) return undefined;
  let offset = 0;
  if (m[8] !== undefined) {
    const [oh, om] = [Number(m[9]), Number(m[10])];
    if (oh > 23 || om > 59) return undefined;
    offset = (m[8] === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const seconds = BigInt(daysBefore(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - offset);
  return seconds * 1_000_000n + BigInt((m[7] ?? "").padEnd(6, "0").slice(0, 6));
}

/** Days from 0001-01-01 to the date, in the proleptic Gregorian calendar. */
function daysBefore(year: number, month: number, day: number): number {
  const y = year - 1;
  let days = y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
  for (let m = 1; m < month; m += 1) days += daysIn(year, m);
  return days + day - 1;
}

function eventFrom(value: unknown, file: string): PrototypeEvent | undefined {
  if (!isObject(value)) return undefined;
  const { id, task, action, at } = value;
  if (typeof id !== "string" || !ID.test(id)) return undefined;
  if (typeof task !== "string" || !TASK.test(task)) return undefined;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return undefined;
  }
  if (typeof at !== "string" || eventInstant(at) === undefined) return undefined;
  return { id, task, action: action as EventAction, at, file };
}

export function parseEvents(
  files: readonly EventFileInput[],
  overrides?: Partial<Limits>,
): EventsParse {
  const limits = limitsWith(overrides);
  const problems: Problem[] = [];

  const names = files.map((f) => f.name);
  if (names.length > limits.eventFiles) {
    problems.push(problem("too-many-event-files", { file: EVENTS_DIR }));
  }
  const bounded = files.slice(0, limits.eventFiles);
  const ready = new Set(bounded.filter((f) => f.name.endsWith(".ready")).map((f) => f.name));
  const json = bounded
    .filter((f) => f.name.endsWith(".json"))
    .sort((a, b) => compareCodePoints(a.name, b.name));

  const results: EventFileResult[] = [];
  const counted: { event: PrototypeEvent; instant: bigint }[] = [];
  const position = new Map<string, number>();
  for (const [index, file] of json.entries()) {
    position.set(file.name, index);
    const place = eventPlace(file.name, index);
    const stem = file.name.slice(0, -".json".length);
    const waits = stem.startsWith("web-") && !ready.has(`${stem}.ready`);
    let event: PrototypeEvent | undefined;
    if (file.bytes === undefined) {
      if (!waits) problems.push(problem("event-invalid", place));
    } else {
      const read = readJson(file.bytes, place.file, limits.eventBytes);
      if (read.ok) event = eventFrom(read.value, file.name);
      // A web- file without .ready may still be half written: it is not checked, only reported.
      if (!waits) {
        for (const p of read.problems) {
          const code = p.code === "file-too-large" ? "event-too-large" : p.code;
          problems.push(problem(code, place));
        }
        if (read.ok && event === undefined) problems.push(problem("event-invalid", place));
      }
    }
    if (waits) problems.push(problem("event-not-ready", { ...place, task: event?.task }));
    if (event === undefined) {
      results.push({ name: file.name, counted: false });
    } else {
      results.push({ name: file.name, event, counted: !waits });
      if (!waits) counted.push({ event, instant: eventInstant(event.at) ?? 0n });
    }
  }

  // A stable sort: two events with one instant and one ID keep their file order.
  counted.sort((a, b) =>
    a.instant < b.instant
      ? -1
      : a.instant > b.instant
        ? 1
        : compareCodePoints(a.event.id, b.event.id),
  );
  const applied = counted.map((c) => c.event);

  const seen = new Set<string>();
  const state = new Map<string, TaskEventState>();
  for (const e of applied) {
    if (seen.has(e.id)) {
      const place = eventPlace(e.file, position.get(e.file) ?? 0);
      problems.push(problem("event-duplicate-id", { ...place, task: e.task }));
    }
    seen.add(e.id);
    const prev = state.get(e.task) ?? {};
    if (e.action === "check" || e.action === "uncheck") {
      state.set(e.task, {
        ...prev,
        check: { checked: e.action === "check", at: e.at, event: e.id },
      });
    } else {
      const star =
        e.action === "focus"
          ? { starred: true, at: e.at, event: e.id, day: e.at.slice(0, 10) }
          : { starred: false, at: e.at, event: e.id };
      state.set(e.task, { ...prev, star });
    }
  }
  return { files: results, readyFiles: ready.size, applied, state, problems };
}
