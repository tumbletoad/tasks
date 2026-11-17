// The row function (A5 3.6): every row in every view comes from `renderRow(row, ctx)`, a pure
// function of one task's data and the view it is shown in. It decides what the row shows, in which
// order, and what it leaves out because the view or its group already says it (`ctx.implied`); the
// accessible description leaves the same facts out. Its result holds message IDs with their values,
// never formatted text, so the catalogue decides the words (A5 3.23) and the cases are tests of
// plain data.
//
// Anatomy, inline start to end: marker, check, title (+ status chip) and summary (+ area dot and
// project on views that mix areas), then fixed columns: due, age, priority, effort, sources,
// folder, star, launch. Every column keeps its width when it is empty, so columns line up on every row.
import type { Instance, Receipt } from "../api.ts";
import type { MessageId } from "../i18n/intl.tsx";
import type { TaskRow } from "../store/rows.ts";
import { dayNumber, formatDay, formatInstant, localDate, type Clock } from "./dates.ts";
import { launchOf, type LaunchBlock, type LaunchModel } from "./launch.ts";

/** A message's values: plain values, or other messages that are formatted first. */
export type MsgValues = Readonly<Record<string, string | number | Msg>>;

/** A message of the catalogue with its values. */
export interface Msg {
  readonly id: MessageId;
  readonly values?: MsgValues;
}

/** The views a row appears in (A5 3.4, 3.5). Search joins with its step. */
export type RowView =
  "today" | "inbox" | "open" | "waiting" | "review" | "backlog" | "area" | "completed" | "agents";

/** How a list groups its rows: each grouping states some facts in its headings. */
export type Grouping =
  /** One flat list, or Today's sections: no fact is stated. */
  | "flat"
  /** Area headings, then project labels (Open, Backlog, the skeleton's lists). */
  | "area"
  /** Project labels inside one area (the area view). */
  | "project"
  /** Person labels (Waiting). */
  | "person";

/** A fact a view or group may already state, so the row leaves it out. */
export type Fact = "area" | "project" | "status" | "waiting_on" | "due";

export interface RowContext {
  readonly view: RowView;
  /** What the view or the row's group already states (A5 3.6 `ctx.implied`). */
  readonly implied: ReadonlySet<Fact>;
  /** The view mixes areas: the summary line starts with the area dot and the project. */
  readonly mixesAreas: boolean;
  /** The due column shows the follow-up day, in indigo (Waiting). */
  readonly followUp: boolean;
  readonly clock: Clock;
}

/** The status a view lists, which its rows therefore never repeat. */
const VIEW_STATUS: Readonly<Partial<Record<RowView, string>>> = {
  open: "open",
  waiting: "waiting",
  review: "review",
  backlog: "backlog",
};

/**
 * The row context of a view with its grouping (A5 3.5's table). A status view states its status;
 * area headings state the area and project, project labels the project (and the area view its
 * area), person labels the waiting person. A view whose rows come from several areas without area
 * headings mixes areas.
 */
export function contextFor(
  view: RowView,
  grouping: Grouping,
  clock: Clock,
  extra: readonly Fact[] = [],
): RowContext {
  const implied = new Set<Fact>(extra);
  if (VIEW_STATUS[view] !== undefined) implied.add("status");
  if (grouping === "area") implied.add("area").add("project");
  if (grouping === "project") implied.add("project");
  if (view === "area") implied.add("area");
  if (grouping === "person") implied.add("waiting_on");
  return {
    view,
    implied,
    mixesAreas: !implied.has("area"),
    followUp: view === "waiting",
    clock,
  };
}

/** A source of the task (A5 3.6 "Sources"), as the page will get it with its row. */
export interface SourceFact {
  /** mail, chat, ticket, pr, issue, doc, calendar, crash, book, session or link. */
  readonly kind: string;
  /** The source's own text: "Wrong appointment times since Sunday · Ana Reyes". */
  readonly text: string;
  readonly url?: string;
}

/** Where the task's folder is on this machine (A4 place resolution). */
export type PlaceFact =
  | { readonly kind: "here" }
  | { readonly kind: "missing" }
  | { readonly kind: "elsewhere"; readonly machine: string }
  | { readonly kind: "work_folder" };

/** The row's marker (A5 3.14): an agent changed the task, or a run needs the person's input. */
export type MarkerFact =
  | { readonly kind: "changed"; readonly by: string; readonly what?: string; readonly at: number }
  | { readonly kind: "needs_input"; readonly by: string };

/** Everything the row function reads about one task. */
export interface RowInput {
  readonly task: TaskRow;
  /** The task's area: its title and colour slot. */
  readonly area?: { readonly title: string; readonly slot: number };
  readonly project?: { readonly title: string };
  /** The instances pinned for the space, in order: the first is the effective one. */
  readonly instances: readonly Instance[];
  /** The task's launch receipts, oldest first. */
  readonly receipts: readonly Receipt[];
  readonly sources?: readonly SourceFact[];
  /** How many sources the task has beyond `sources` (the compact row carries the first three). */
  readonly sourcesMore?: number;
  readonly place?: PlaceFact;
  readonly marker?: MarkerFact;
  readonly launchBlock?: LaunchBlock;
  /** When the task's current wait began, in ms since the epoch: Waiting's age column counts from it. */
  readonly waitingSince?: number;
}

export type DueTone = "late" | "soon" | "later" | "planned" | "follow_up" | "done";

/**
 * A visible button on the row that moves the task out of the view (A5 3.5): "Move to Open" in the
 * Inbox clears the flag, "Back to open" in Review sets the status to open.
 */
export type RowMove = "triage" | "reopen";

export interface RowModel {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
  /** The checkbox's name: "Done: <title>", or "Dropped: <title>" for a dropped task. */
  readonly done: Msg;
  readonly marker?: { readonly kind: "changed" | "needs_input"; readonly tip: Msg };
  /** The inline status chip, when the view does not imply the status. */
  readonly chip?: {
    readonly kind: "waiting" | "review" | "backlog" | "other";
    readonly text: Msg;
    /** A waiting chip names its person, with the person glyph. */
    readonly person: boolean;
  };
  /** The summary line's prefix on views that mix areas: the area dot and the project or area. */
  readonly prefix?: { readonly slot?: number; readonly text: string };
  readonly summary?: string;
  /** A finished task's line in the place of the summary: how it ended (`TaskRow.ending`). */
  readonly ending?: string;
  readonly due?: {
    readonly text: Msg;
    readonly tone: DueTone;
    readonly tip: Msg;
  };
  /** Absent in Completed, whose row shows the completion date instead (A5 3.5). */
  readonly age?: { readonly text: Msg; readonly tip: Msg };
  readonly priority?: { readonly level: 1 | 2 | 3; readonly text: Msg };
  /** The effort estimate's key, as the space's scale names it. */
  readonly effort?: { readonly key: string; readonly tip: Msg };
  /** The view's own move out of it, as a visible button (A5 3.5). */
  readonly move?: { readonly kind: RowMove; readonly text: Msg };
  readonly sources: {
    readonly shown: readonly (SourceFact & { readonly href?: string; readonly tip: Msg })[];
    readonly more?: Msg;
  };
  readonly folder: {
    readonly state: "empty" | PlaceFact["kind"];
    readonly tip?: Msg;
  };
  readonly starred: boolean;
  readonly launch: LaunchModel & { readonly tip: Msg };
  /** The accessible description, in A5 3.22's fixed order. */
  readonly description: readonly Msg[];
}

const msg = (id: MessageId, values?: MsgValues): Msg =>
  values === undefined ? { id } : { id, values };

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/**
 * A date's parts as the catalogue orders them (A5 3.23: the compact forms come from the catalogue
 * per locale): Intl gives the names, the message gives the order.
 */
function parts(date: string, clock: Clock) {
  return {
    day: Number(date.slice(8, 10)),
    year: date.slice(0, 4),
    sameYear: date.slice(0, 4) === clock.today.slice(0, 4),
    weekday: formatDay(date, clock.locale, { weekday: "long" }),
    weekdayShort: formatDay(date, clock.locale, { weekday: "short" }),
    month: formatDay(date, clock.locale, { month: "long" }),
    monthShort: formatDay(date, clock.locale, { month: "short" }),
  };
}

/** "Friday 13 November", with the year when it is not this year. */
function fullDate(date: string, clock: Clock): Msg {
  const p = parts(date, clock);
  return p.sameYear
    ? msg("row.fullDate", { weekday: p.weekday, day: p.day, month: p.month })
    : msg("row.fullDateYear", { weekday: p.weekday, day: p.day, month: p.month, year: p.year });
}

/**
 * How many days off a date shows its month and year instead of its day and month: a day and month
 * alone read as the coming one, and past ten months the month says more than the day. The year
 * form is also what keeps every date inside the due column.
 */
const FAR_DAYS = 300;

/**
 * The compact day of a date relative to today (A5 3.6 "Due"): "Today", "Tomorrow", "Sat 14" within
 * six days, "21 Nov" later, "Sep 2027" from ten months off. Past days give their date.
 */
function compactDay(date: string, clock: Clock): { text: Msg; days: number } {
  const day = dayNumber(date) ?? 0;
  const days = day - (dayNumber(clock.today) ?? 0);
  if (days === 0) return { text: msg("row.today"), days };
  if (days === 1) return { text: msg("row.tomorrow"), days };
  const p = parts(date, clock);
  if (days > 1 && days <= 6) {
    return { text: msg("row.weekday", { weekday: p.weekdayShort, day: p.day }), days };
  }
  return {
    text:
      Math.abs(days) < FAR_DAYS
        ? msg("row.date", { day: p.day, month: p.monthShort })
        : msg("row.monthYear", { month: p.monthShort, year: p.year }),
    days,
  };
}

type DueModel = NonNullable<RowModel["due"]>;

/** The due column (A5 3.6): never colour alone, the text says late or soon. */
function dueOf(task: TaskRow, ctx: RowContext): { model: DueModel; describe: Msg } | undefined {
  const { clock } = ctx;
  const waitingRow = task.status === "waiting";
  // Waiting shows the follow-up day; elsewhere a due date wins over a planned day.
  const planned = (tone: DueTone) => {
    if (task.planned_for === undefined || dayNumber(task.planned_for) === undefined) {
      return undefined;
    }
    const { text } = compactDay(task.planned_for, clock);
    const full = fullDate(task.planned_for, clock);
    return {
      model: { text, tone, tip: msg("row.plannedTip", { date: full }) },
      describe: msg("row.desc.planned", { date: full }),
    };
  };
  if (ctx.followUp) {
    const followUp = planned("follow_up");
    if (followUp !== undefined) return followUp;
  }
  if (task.due_at !== undefined) {
    const date = localDate(task.due_at, clock.timeZone);
    const full = fullDate(date, clock);
    const time = formatInstant(task.due_at, clock, TIME);
    const days = (dayNumber(date) ?? 0) - (dayNumber(clock.today) ?? 0);
    const tip = msg("row.dueAtTip", { date: full, time });
    if (days === 0) {
      const late = task.due_at < clock.now;
      return {
        model: { text: msg("row.time", { time }), tone: late ? "late" : "soon", tip },
        describe: msg(late ? "row.desc.lateToday" : "row.desc.dueAt", { date: full, time }),
      };
    }
    return dueDay(date, full, days, tip, clock);
  }
  if (task.due_date !== undefined && dayNumber(task.due_date) !== undefined) {
    const full = fullDate(task.due_date, clock);
    const days = (dayNumber(task.due_date) ?? 0) - (dayNumber(clock.today) ?? 0);
    return dueDay(task.due_date, full, days, msg("row.dueTip", { date: full }), clock);
  }
  return planned(waitingRow ? "follow_up" : "planned");
}

/**
 * How late, in at most two digits so it fits the due column: days, then weeks from 100 days, then
 * years. The description says the days in full.
 */
function lateText(days: number): Msg {
  if (days < 100) return msg("row.late", { days });
  if (days < 700) return msg("row.lateWeeks", { weeks: Math.floor(days / 7) });
  return msg("row.lateYears", { years: Math.floor(days / 365) });
}

function dueDay(
  date: string,
  full: Msg,
  days: number,
  tip: Msg,
  clock: Clock,
): { model: DueModel; describe: Msg } {
  if (days < 0) {
    return {
      model: { text: lateText(-days), tone: "late", tip },
      describe: msg("row.desc.late", { days: -days, date: full }),
    };
  }
  return {
    model: { text: compactDay(date, clock).text, tone: days <= 6 ? "soon" : "later", tip },
    describe: msg("row.desc.due", { date: full }),
  };
}

/**
 * The age column (A5 3.6): "today", "1d"–"6d", "1w"–"8w", then months, then years. In Waiting it is
 * the time spent waiting, when the wait's start is known.
 */
function ageOf(
  row: RowInput,
  ctx: RowContext,
): { model: NonNullable<RowModel["age"]>; describe: Msg } {
  const { clock } = ctx;
  const waiting =
    ctx.view === "waiting" && row.task.status === "waiting" ? row.waitingSince : undefined;
  const since = localDate(waiting ?? row.task.created_at, clock.timeZone);
  const days = Math.max(0, (dayNumber(clock.today) ?? 0) - (dayNumber(since) ?? 0));
  let text: Msg;
  if (days === 0) text = msg("row.ageToday");
  else if (days < 7) text = msg("row.ageDays", { n: days });
  else if (days < 63) text = msg("row.ageWeeks", { n: Math.floor(days / 7) });
  else if (days < 365) text = msg("row.ageMonths", { n: Math.max(2, Math.floor(days / 30.4375)) });
  else text = msg("row.ageYears", { n: Math.max(1, Math.floor(days / 365.25)) });
  const full = fullDate(since, clock);
  return waiting === undefined
    ? {
        model: { text, tip: msg("row.createdTip", { date: full }) },
        describe: msg("row.desc.created", { date: full }),
      }
    : {
        model: { text, tip: msg("row.waitingTip", { date: full }) },
        describe: msg("row.desc.waitingSince", { date: full }),
      };
}

/**
 * The day a finished task was completed or dropped: its instant on the viewer's calendar, or the
 * day a search gave for it.
 */
export function finishedDayOf(task: TaskRow, timeZone: string): string | undefined {
  const at = task.finished_at ?? task.completed_at;
  if (at !== undefined) return localDate(at, timeZone);
  return task.completed_on !== undefined && dayNumber(task.completed_on) !== undefined
    ? task.completed_on
    : undefined;
}

/** Completed's due column: the day it was completed or dropped (A5 3.5), never a due date. */
function completedOf(
  task: TaskRow,
  ctx: RowContext,
): { model: DueModel; describe: Msg } | undefined {
  const day = finishedDayOf(task, ctx.clock.timeZone);
  if (day === undefined) return undefined;
  const full = fullDate(day, ctx.clock);
  const dropped = task.lifecycle === "archived";
  return {
    model: {
      text: compactDay(day, ctx.clock).text,
      tone: "done",
      tip: msg(dropped ? "row.droppedTip" : "row.completedTip", { date: full }),
    },
    describe: msg(dropped ? "row.desc.dropped" : "row.desc.completed", { date: full }),
  };
}

/** The view's visible move out of it (A5 3.5): an active task in the Inbox, or one in Review. */
function moveOf(task: TaskRow, ctx: RowContext): RowModel["move"] {
  if (task.lifecycle !== "active") return undefined;
  if (ctx.view === "inbox" && task.inbox) return { kind: "triage", text: msg("fact.moveToOpen") };
  if (ctx.view === "review" && task.status === "review" && !task.inbox) {
    return { kind: "reopen", text: msg("row.backToOpen") };
  }
  return undefined;
}

/** Schemes a source link may open (A5 3.26): anything else is shown as text. */
const LINK_SCHEMES = ["https:", "http:", "mailto:"];

/** A link a source or any text may open, or undefined: only `https:`, `http:` and `mailto:`. */
export function safeHref(url: string): { href: string; domain?: string } | undefined {
  try {
    const parsed = new URL(url);
    if (!LINK_SCHEMES.includes(parsed.protocol)) return undefined;
    return parsed.protocol === "mailto:"
      ? { href: parsed.href }
      : { href: parsed.href, domain: parsed.hostname };
  } catch {
    // Not a URL: it shows as text.
    return undefined;
  }
}

/** Up to three sources, then "+2" (A5 3.6 "Sources"). */
function sourcesOf(sources: readonly SourceFact[], more = 0): RowModel["sources"] {
  const shown = sources.slice(0, 3).map((source) => {
    const link = source.url === undefined ? undefined : safeHref(source.url);
    const tip =
      link?.domain === undefined
        ? msg("row.sourceTip", { text: source.text })
        : msg("row.sourceTipDomain", { text: source.text, domain: link.domain });
    return { ...source, ...(link === undefined ? {} : { href: link.href }), tip };
  });
  const rest = sources.length - shown.length + Math.max(0, more);
  return rest > 0 ? { shown, more: msg("row.moreSources", { n: rest }) } : { shown };
}

function folderOf(place: PlaceFact | undefined): RowModel["folder"] {
  switch (place?.kind) {
    case undefined:
      return { state: "empty" };
    case "here":
      return { state: "here", tip: msg("row.folderOpen") };
    case "missing":
      return { state: "missing", tip: msg("row.folderMissing") };
    case "elsewhere":
      return { state: "elsewhere", tip: msg("row.folderElsewhere", { machine: place.machine }) };
    case "work_folder":
      return { state: "work_folder", tip: msg("row.workFolder") };
  }
}

function chipOf(task: TaskRow, ctx: RowContext): RowModel["chip"] {
  // A finished task's status is history, not state: Completed shows no chip (A5 3.5).
  if (task.status === "open" || ctx.view === "completed") return undefined;
  // The person is the waiting chip's text, unless the row's group already names them. A view that
  // implies the status still shows the person when no group does.
  const person =
    task.status === "waiting" &&
    task.waiting_on !== undefined &&
    task.waiting_on !== "" &&
    !ctx.implied.has("waiting_on");
  if (ctx.implied.has("status") && !person) return undefined;
  switch (task.status) {
    case "waiting": {
      return {
        kind: "waiting",
        text: person
          ? msg("row.chipWaitingOn", { person: task.waiting_on ?? "" })
          : msg("row.chipWaiting"),
        person,
      };
    }
    case "review":
      return { kind: "review", text: msg("row.chipReview"), person: false };
    case "backlog":
      return { kind: "backlog", text: msg("row.chipBacklog"), person: false };
    default:
      return { kind: "other", text: msg("row.chipStatus", { status: task.status }), person: false };
  }
}

const LAUNCH_TIP: Readonly<Record<string, MessageId>> = {
  ready: "row.tile.ready",
  opening: "row.tile.opening",
  not_confirmed: "row.tile.notConfirmed",
  connected: "row.tile.connected",
  unavailable: "row.tile.unavailable",
  elsewhere: "row.tile.elsewhere",
  copy_only: "row.tile.copyOnly",
  none: "row.tile.none",
};

/** The row of one task in one view. Pure: the same row and context give the same model. */
export function renderRow(row: RowInput, ctx: RowContext): RowModel {
  const { task } = row;
  const description: Msg[] = [];

  // Line 2's prefix on views that mix areas: the area dot and the project, or the area alone.
  let prefix: RowModel["prefix"];
  if (ctx.mixesAreas && row.area !== undefined) {
    const text =
      row.project !== undefined && !ctx.implied.has("project") ? row.project.title : row.area.title;
    prefix = { slot: row.area.slot, text };
  } else if (!ctx.implied.has("project") && row.project !== undefined) {
    prefix = { text: row.project.title };
  }
  if (prefix !== undefined) description.push(msg("row.desc.project", { name: prefix.text }));

  const chip = chipOf(task, ctx);
  if (chip !== undefined) {
    description.push(
      chip.person ? msg("row.desc.waitingOn", { person: task.waiting_on ?? "" }) : chip.text,
    );
  }

  // Completed shows the completion date in the due column, and neither age nor priority (A5 3.5).
  const finished = ctx.view === "completed";
  const due = finished
    ? completedOf(task, ctx)
    : ctx.implied.has("due")
      ? undefined
      : dueOf(task, ctx);
  if (due !== undefined) description.push(due.describe);

  const level = task.priority;
  const priority: RowModel["priority"] =
    !finished && (level === 1 || level === 2 || level === 3)
      ? { level, text: msg("row.priority", { level }) }
      : undefined;
  if (priority !== undefined) description.push(msg("row.desc.priority", { level: priority.level }));

  const effort: RowModel["effort"] =
    !finished && task.effort !== undefined && task.effort !== ""
      ? { key: task.effort, tip: msg("row.effortTip", { effort: task.effort }) }
      : undefined;
  if (effort !== undefined) description.push(msg("row.desc.effort", { effort: effort.key }));

  const age = finished ? undefined : ageOf(row, ctx);
  if (age !== undefined) description.push(age.describe);

  const move = moveOf(task, ctx);

  const starred = task.focus_on !== undefined && task.focus_on <= ctx.clock.today;
  if (starred) description.push(msg("row.desc.starred"));

  let marker: RowModel["marker"];
  if (row.marker?.kind === "needs_input") {
    marker = { kind: "needs_input", tip: msg("row.markerNeedsInput", { by: row.marker.by }) };
    description.push(msg("row.desc.needsInput"));
  } else if (row.marker?.kind === "changed") {
    const time = formatInstant(row.marker.at, ctx.clock, TIME);
    marker = {
      kind: "changed",
      tip:
        row.marker.what === undefined
          ? msg("row.markerChanged", { by: row.marker.by, time })
          : msg("row.markerChangedWhat", { what: row.marker.what, time }),
    };
    description.push(msg("row.desc.changed", { by: row.marker.by }));
  }

  const launch = launchOf(row.instances, row.receipts, row.launchBlock);
  const label = launch.instance?.label ?? "";
  const tip = msg(LAUNCH_TIP[launch.state] ?? "row.tile.ready", {
    label,
    reason: launch.reason ?? "",
    machine: launch.machine ?? "",
  });
  if (launch.state !== "ready" && launch.state !== "none") description.push(tip);

  const summary = task.summary !== undefined && task.summary !== "" ? task.summary : undefined;
  const ending =
    task.lifecycle !== "active" && task.ending !== undefined && task.ending !== ""
      ? task.ending
      : undefined;
  return {
    id: task.id,
    ref: task.ref,
    title: task.title,
    done: msg(task.lifecycle === "archived" ? "row.dropped" : "row.done", { title: task.title }),
    ...(marker === undefined ? {} : { marker }),
    ...(chip === undefined ? {} : { chip }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(summary === undefined ? {} : { summary }),
    ...(ending === undefined ? {} : { ending }),
    ...(due === undefined ? {} : { due: due.model }),
    ...(age === undefined ? {} : { age: age.model }),
    ...(priority === undefined ? {} : { priority }),
    ...(effort === undefined ? {} : { effort }),
    ...(move === undefined ? {} : { move }),
    sources: sourcesOf(row.sources ?? [], row.sourcesMore),
    folder: folderOf(row.place),
    starred,
    launch: { ...launch, tip },
    description,
  };
}
