// The mapping from a parsed prototype folder to an import plan (A7 3.15.3). Pure: a PrototypeParse
// and the options in, a plan of A1 operations and problems out. It reads no file and no clock and
// draws nothing at random, so one input gives one plan (plan.ts).
//
// Every text passes SafeText (A3 3.10: contracts' normaliseText, and normaliseLine for one-line
// fields) before it is planned, and each field it changed gives `text-sanitised`, which the report
// counts. A text over its limit in the space is cut at a word boundary and reported.

import { normaliseLine, normaliseText } from "@tasks/contracts";
import type { LedgerTask } from "./ledger.ts";
import { eventMillis, inDayRange, isTimeZone, localDay, nineOClock } from "./local-time.ts";
import { METADATA_FILE, type MetadataEntry, type PrototypeStatus } from "./metadata.ts";
import {
  CHECKED_AS,
  IMPORT_LOG,
  PLANNING_EXT_KEYS,
  type CheckedAs,
  type ImportPlan,
  type PlannedArea,
  type PlannedOp,
  type PlannedOwner,
  type PlannedProject,
  type PlannedSource,
  type PlannedSourceFields,
  type PlannedTask,
  type PlannedTaskCreate,
  type PlanningExt,
} from "./plan.ts";
import { isAbsolutePath, placeFor, ROOT_ID, type Roots } from "./places.ts";
import { problem, type Problem, type ProblemCode, type ProblemField } from "./problems.ts";
import type { PrototypeParse } from "./prototype.ts";
import { groupKey, groupSlug, numberedSlug } from "./slug.ts";
import {
  classifyUrl,
  isGenericLabel,
  shortUrl,
  type PlannedSourceKind,
  type UrlClass,
} from "./sources.ts";

export interface MappingOptions {
  /** `--me`: the owner name that is the user, compared without case and outer spaces. */
  readonly me?: string;
  /** `--roots`, or the proposed roots the user named: root ID to absolute folder. */
  readonly roots?: Roots;
  /** `--checked-as`: a checked task is completed (the default) or kept active in Review. */
  readonly checkedAs?: CheckedAs;
  /** `--include-orphans`: create metadata entries without a task line, in Backlog. */
  readonly includeOrphans?: boolean;
  /** The import machine's IANA time zone: days become 09:00 there, and a star's day is local. */
  readonly timeZone: string;
}

/** The space's limits on what an import writes (A1 3.7: WRITE_LIMITS). */
export const MAPPING_LIMITS = {
  /** Characters. */
  title: 300,
  summary: 400,
  line: 300,
  sourceTitle: 300,
  url: 2_048,
  /** UTF-8 bytes. */
  context: 64 * 1024,
  log: 16 * 1024,
  outcome: 4 * 1024,
  /** Levels of an unknown metadata key's value. */
  extraDepth: 32,
} as const;

/**
 * The IDs a task line can carry: a marker's grammar, which holds every fallback ID (A7 3.15.2).
 * A metadata entry without a task line is created (`--include-orphans`) only with such an ID: any
 * other key is no prototype task, and as an alias it would not pass SafeText unchanged.
 */
const LEGACY_ID = /^[a-z0-9_-]+$/;

/** Thrown for options the caller should have checked; the message never quotes a value. */
export class MappingOptionsError extends Error {
  override readonly name = "MappingOptionsError";
}

function checkOptions(options: MappingOptions): void {
  if (!isTimeZone(options.timeZone)) {
    throw new MappingOptionsError("timeZone is not an IANA time zone this runtime knows");
  }
  if (options.checkedAs !== undefined && !CHECKED_AS.includes(options.checkedAs)) {
    throw new MappingOptionsError("checkedAs is completed or review");
  }
  for (const [id, folder] of Object.entries(options.roots ?? {})) {
    if (!ROOT_ID.test(id)) throw new MappingOptionsError("A root ID is a-z, 0-9, _ and -");
    if (typeof folder !== "string" || !isAbsolutePath(folder)) {
      throw new MappingOptionsError("A root's folder is an absolute path");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text

const codePoints = (text: string): number => Array.from(text).length;
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const SPACE = /\s/u;

/**
 * The text cut to `max` code points or UTF-8 bytes, at the last whitespace inside the limit when
 * there is one in its second half, else at the limit. Trailing whitespace goes.
 */
export function cutAtWord(text: string, max: number, unit: "chars" | "bytes"): string {
  const chars = Array.from(text);
  let keep = 0;
  let size = 0;
  for (const c of chars) {
    const add = unit === "chars" ? 1 : utf8Bytes(c);
    if (size + add > max) break;
    size += add;
    keep += 1;
  }
  if (keep === chars.length) return text;
  let cut = keep;
  while (cut > keep / 2 && !SPACE.test(chars[cut] ?? "")) cut -= 1;
  if (cut <= keep / 2) cut = keep;
  return chars.slice(0, cut).join("").trimEnd();
}

const fold = (name: string): string => name.normalize("NFC").trim().toLowerCase();

interface Place {
  readonly file: string;
  readonly line?: number;
  readonly task?: string;
}

class Report {
  readonly problems: Problem[] = [];

  add(code: ProblemCode, at: Place, field?: ProblemField, index?: number): void {
    this.problems.push(problem(code, { ...at, field, index }));
  }

  /** SafeText for one line or a multi-line text, reporting a change. */
  clean(text: string, kind: "line" | "text", at: Place, field: ProblemField, index?: number) {
    const out = kind === "line" ? normaliseLine(text) : normaliseText(text);
    if (out !== text) this.add("text-sanitised", at, field, index);
    return out;
  }

  /** The text within its limit, cut and reported when over it. */
  fit(text: string, max: number, unit: "chars" | "bytes", at: Place, field: ProblemField) {
    const over = unit === "chars" ? codePoints(text) > max : utf8Bytes(text) > max;
    if (!over) return text;
    this.add("text-cut", at, field);
    return cutAtWord(text, max, unit);
  }
}

// ---------------------------------------------------------------------------------------------
// Entries: the tasks the plan creates

interface Entry {
  readonly id: string;
  /** Absent for a metadata entry without a task line. */
  readonly line?: LedgerTask;
  readonly meta?: MetadataEntry;
  /** Where its problems point. */
  readonly at: Place;
  readonly metaAt: Place;
}

function entriesOf(
  parse: PrototypeParse,
  includeOrphans: boolean,
  report: Report,
): {
  entries: Entry[];
  duplicates: number;
} {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const metaAt = (id: string): Place => ({ file: METADATA_FILE, task: id });
  for (const t of parse.tasks) {
    // A later line with an ID an earlier line has is an error the parse reports (duplicate-id).
    // It is left out of the plan, so one legacy ID is one task and one alias.
    if (seen.has(t.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(t.id);
    const meta = parse.metadata.get(t.id);
    entries.push({
      id: t.id,
      line: t,
      ...(meta === undefined ? {} : { meta }),
      at: { file: t.file, line: t.line, task: t.id },
      metaAt: metaAt(t.id),
    });
  }
  if (includeOrphans) {
    for (const id of parse.orphans) {
      if (!LEGACY_ID.test(id)) {
        report.add("orphan-id-invalid", metaAt(id));
        continue;
      }
      const meta = parse.metadata.get(id);
      entries.push({
        id,
        ...(meta === undefined ? {} : { meta }),
        at: metaAt(id),
        metaAt: metaAt(id),
      });
    }
  }
  return { entries, duplicates };
}

// ---------------------------------------------------------------------------------------------
// Groups: areas and projects, by slug

interface Groups {
  readonly areas: Map<string, PlannedArea>;
  readonly projects: Map<string, PlannedProject>;
  /** Per entry: its area slug and project slug. */
  readonly of: Map<Entry, { area: string; project?: string }>;
}

function groupsOf(entries: readonly Entry[], report: Report): Groups {
  // By identity (slug.ts: groupKey), each with its slug. A slug is ASCII, so distinct titles can
  // share one ("Работа" and "Дом" are both `area`): the later title takes the next free number.
  const areas = new Map<string, PlannedArea>();
  const areaSlugs = new Set<string>();
  const projects = new Map<string, PlannedProject>();
  const projectSlugs = new Set<string>();
  // The next number to try per slug, so many groups with one slug cost linear time.
  const nextArea = new Map<string, number>();
  const nextProject = new Map<string, number>();
  const of = new Map<Entry, { area: string; project?: string }>();
  // A text is cleaned and reported once, where it first appears. Its identity comes from the whole
  // cleaned text, its title is that text cut to fit: two long titles that differ only past the
  // cut stay two groups.
  interface GroupText {
    readonly full: string;
    readonly title: string;
  }
  const seen = new Map<string, GroupText>();
  const once = (raw: string, field: ProblemField, at: Place): GroupText => {
    const key = `${field}\u0000${raw}`;
    let text = seen.get(key);
    if (text === undefined) {
      const full = report.clean(raw, "line", at, field).trim();
      text = { full, title: report.fit(full, MAPPING_LIMITS.title, "chars", at, field) };
      seen.set(key, text);
    }
    return text;
  };
  const OTHER: GroupText = { full: "Other", title: "Other" };
  for (const e of entries) {
    const category = once(e.meta?.category ?? "", "category", e.metaAt);
    // The ledger's group, only when metadata has no category. An orphan has no group: `Other`.
    const group = e.line === undefined ? OTHER : once(e.line.group, "group", e.at);
    const areaText = category.full !== "" ? category : group.full !== "" ? group : OTHER;
    const areaKey = groupKey(areaText.full, "area");
    let planned = areas.get(areaKey);
    if (planned === undefined) {
      const slug = numberedSlug(groupSlug(areaText.full, "area"), areaSlugs, nextArea);
      areaSlugs.add(slug);
      planned = { slug, title: areaText.title };
      areas.set(areaKey, planned);
    }
    const area = planned.slug;

    const projectText = once(e.meta?.project ?? "", "project", e.metaAt);
    if (projectText.full === "") {
      of.set(e, { area });
      continue;
    }
    const key = `${area}\u0000${groupKey(projectText.full, "project")}`;
    let project = projects.get(key);
    if (project === undefined) {
      // Project slugs are unique in a space, not per area (A1 3.4): another project with the same
      // slug gets the next free number.
      const slug = numberedSlug(groupSlug(projectText.full, "project"), projectSlugs, nextProject);
      projectSlugs.add(slug);
      project = { slug, title: projectText.title, area };
      projects.set(key, project);
    }
    of.set(e, { area, project: project.slug });
  }
  return { areas, projects, of };
}

// ---------------------------------------------------------------------------------------------
// Sources

interface Link {
  readonly entry: Entry;
  readonly index: number;
  readonly url: string;
  readonly label: string;
  readonly cls: UrlClass;
}

interface SourceRow {
  readonly fields: PlannedSourceFields;
  readonly generic: boolean;
  readonly links: Link[];
}

/** A ticket's title from data/jira.json: as written, and through SafeText. */
interface TicketTitle {
  readonly raw: string;
  readonly clean: string;
}

function sourcesOf(
  entries: readonly Entry[],
  jira: ReadonlyMap<string, TicketTitle>,
  report: Report,
): { rows: SourceRow[]; byEntry: Map<Entry, SourceRow[]> } {
  // Pass 1: every usable source of every entry. `links` holds one per key per entry, the links the
  // plan makes; `named` holds every one, whose labels can title the row.
  interface Group {
    readonly links: Link[];
    readonly named: Link[];
  }
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  for (const e of entries) {
    const keys = new Set<string>();
    for (const s of e.meta?.sources ?? []) {
      // Its place in the file's list, which an invalid item before it does not shift.
      const index = s.index;
      const url = report.clean(s.url, "line", e.metaAt, "sources", index).trim();
      if (url === "" || codePoints(url) > MAPPING_LIMITS.url) {
        report.add("source-dropped", e.metaAt, "sources", index);
        continue;
      }
      const label = report.clean(s.label, "line", e.metaAt, "sources", index).trim();
      const cls = classifyUrl(url);
      if (cls.keyProblem !== undefined) {
        report.add("source-key-unavailable", e.metaAt, "sources", index);
      }
      const link: Link = { entry: e, index, url, label, cls };
      if (cls.key === undefined) {
        order.push({ links: [link], named: [link] });
        continue;
      }
      let group = groups.get(cls.key);
      if (group === undefined) {
        group = { links: [], named: [] };
        groups.set(cls.key, group);
        order.push(group);
      }
      group.named.push(link);
      if (keys.has(cls.key)) continue;
      keys.add(cls.key);
      group.links.push(link);
    }
  }

  // Pass 2: one row per key, its title from the first label that names more than the kind, then
  // a ticket's title in data/jira.json, else a short form of the first URL, flagged generic.
  const rows: SourceRow[] = [];
  const linked = new Map<Entry, { index: number; row: SourceRow }[]>();
  for (const { links, named: labelled } of order) {
    const first = links[0];
    if (first === undefined) continue;
    const named = labelled.find((l) => !isGenericLabel(l.label));
    const ticket = first.cls.ref === undefined ? undefined : jira.get(first.cls.ref);
    let title: string;
    let generic = false;
    if (named !== undefined) title = named.label;
    else if (ticket !== undefined && ticket.clean.trim() !== "") {
      title = ticket.clean.trim();
      // The title lands on this task's source: its change is reported there. Compared before
      // the trim, which would hide a removed byte-order mark.
      if (ticket.clean !== ticket.raw) {
        report.add("text-sanitised", first.entry.metaAt, "sources", first.index);
      }
    } else {
      title = shortUrl(first.url);
      generic = true;
      report.add("source-title-generic", first.entry.metaAt, "sources", first.index);
    }
    if (codePoints(title) > MAPPING_LIMITS.sourceTitle) {
      const where = named ?? first;
      report.add("text-cut", where.entry.metaAt, "sources", where.index);
      title = cutAtWord(title, MAPPING_LIMITS.sourceTitle, "chars");
    }
    const fields: PlannedSourceFields = {
      kind: first.cls.kind,
      title,
      ...(first.cls.key === undefined ? {} : { key: first.cls.key }),
      url: first.url,
      ...(first.cls.ref === undefined ? {} : { ref: first.cls.ref }),
    };
    const row: SourceRow = { fields, generic, links };
    rows.push(row);
    for (const link of links) {
      if (links.length > 1)
        report.add("source-key-shared", link.entry.metaAt, "sources", link.index);
      const list = linked.get(link.entry) ?? [];
      list.push({ index: link.index, row });
      linked.set(link.entry, list);
    }
  }
  // Each task links its sources in its own order.
  const byEntry = new Map<Entry, SourceRow[]>();
  for (const [entry, list] of linked) {
    byEntry.set(
      entry,
      list.sort((a, b) => a.index - b.index).map((l) => l.row),
    );
  }
  return { rows, byEntry };
}

// ---------------------------------------------------------------------------------------------
// One task

/** The prototype status as the space's status (A7 3.15.3). */
function statusOf(status: PrototypeStatus | undefined, title: string): PlannedTaskCreate["status"] {
  switch (status) {
    case "open":
    case "waiting":
    case "backlog":
      return status;
    case "needs_review":
      return "review";
    case "delegated":
      return "waiting";
    case undefined:
      // The prototype's default.
      return title.startsWith("Waiting on ") ? "waiting" : "open";
  }
}

interface Context {
  readonly parse: PrototypeParse;
  readonly options: MappingOptions;
  readonly report: Report;
  readonly groups: Groups;
  readonly sources: Map<Entry, SourceRow[]>;
  readonly owners: Map<string, { name: string; me: boolean; tasks: number }>;
}

function mapEntry(e: Entry, cx: Context): PlannedTask {
  const { report, options } = cx;
  const tz = options.timeZone;
  const draft = { draft: e.id };
  const meta = e.meta;
  const line = e.line;
  if (line !== undefined && !line.marked) report.add("fallback-id", e.at);

  // Title, trimmed, and the full text at the top of the context when it is over 300 characters, so
  // a cut keeps words, never only leading spaces. An orphan is titled by its legacy ID. A legacy
  // ID is of the marker grammar, so SafeText keeps it.
  const rawTitle = line?.title ?? e.id;
  let title = report.clean(rawTitle, "line", e.at, "title").trim();
  if (title === "") {
    report.add("title-empty", e.at, "title");
    title = e.id;
  }
  let head: string | undefined;
  if (codePoints(title) > MAPPING_LIMITS.title) {
    report.add("title-cut", e.at, "title");
    head = title;
    title = cutAtWord(title, MAPPING_LIMITS.title, "chars");
  }
  const body = line === undefined ? "" : report.clean(line.body, "text", e.at, "body");
  let context = head === undefined ? body : body === "" ? head : `${head}\n\n${body}`;
  context = report.fit(context, MAPPING_LIMITS.context, "bytes", e.at, "body");

  // Status and people. An orphan goes to Backlog.
  const mapped = line === undefined ? "backlog" : statusOf(meta?.status, rawTitle);
  let status: PlannedTaskCreate["status"] = mapped;
  const ownerText = report.fit(
    report.clean(meta?.owner ?? "", "line", e.metaAt, "owner").trim(),
    MAPPING_LIMITS.line,
    "chars",
    e.metaAt,
    "owner",
  );
  const isMe = options.me !== undefined && fold(ownerText) === fold(options.me);
  if (ownerText !== "") {
    const key = fold(ownerText);
    const seen = cx.owners.get(key) ?? { name: ownerText, me: isMe, tasks: 0 };
    seen.tasks += 1;
    cx.owners.set(key, seen);
  }
  const person = ownerText === "" || isMe ? undefined : ownerText;
  const people =
    person === undefined ? {} : mapped === "waiting" ? { waiting_on: person } : { owner: person };

  // Summary: metadata `next`, else (absent or empty) the body's `Next:` clause, one line.
  const metaNext =
    meta?.next === undefined ? "" : report.clean(meta.next, "line", e.metaAt, "next").trim();
  const next =
    metaNext !== "" || line?.next === undefined
      ? metaNext
      : report.clean(line.next, "line", e.at, "next").trim();
  const summary = report.fit(next, MAPPING_LIMITS.summary, "chars", e.metaAt, "next");

  // Days at 09:00 in the import's zone; one outside the space's range is dropped.
  const at = (date: string | undefined, where: Place, field: ProblemField): number | undefined => {
    if (date === undefined) return undefined;
    const ms = nineOClock(date, tz);
    if (ms === undefined) report.add("date-out-of-range", where, field);
    return ms;
  };
  const sourceAt = at(meta?.sourceDate, e.metaAt, "source_date");
  const reviewedAt = at(meta?.reviewed, e.metaAt, "reviewed");
  const createdAt = at(line?.added?.date, e.at, "added");
  // A due date is a day, held to the same range: the writer refuses a year before 100.
  let due = meta?.due;
  if (due !== undefined && !inDayRange(due)) {
    report.add("date-out-of-range", e.metaAt, "due");
    due = undefined;
  }

  // The star: the day of the last focus event's instant in the import's zone, a day the space
  // holds. An instant near either end of the range can fall on a day outside it there.
  const state = cx.parse.events.state.get(e.id);
  let focus: string | undefined;
  if (state?.star?.starred === true) {
    const ms = eventMillis(state.star.at);
    const day = ms === undefined ? undefined : localDay(ms, tz);
    if (day === undefined || !inDayRange(day)) report.add("date-out-of-range", e.at, "focus");
    else focus = day;
  }

  // ext.planning.
  const ext: Record<string, unknown> = { legacy_id: e.id };
  ext["file"] = line?.file ?? METADATA_FILE;
  if (line !== undefined) ext["line"] = line.line;
  if (line?.added !== undefined) {
    const agent = report.clean(line.added.agent, "line", e.at, "added").trim();
    if (agent !== "")
      ext["added_by"] = report.fit(agent, MAPPING_LIMITS.line, "chars", e.at, "added");
  }
  if (meta?.status === "delegated") ext["status"] = "delegated";
  if (meta?.rank !== undefined) ext["rank"] = meta.rank;
  if (meta?.confidence !== undefined) {
    ext["confidence"] = report.clean(meta.confidence, "text", e.metaAt, "confidence");
  }

  // The place from paths[0]; every other path goes to ext.planning.paths. Problems name a path's
  // place in the file's list, which a path the parser left out does not shift.
  const paths = meta?.paths ?? [];
  const pathAt = (i: number): number => meta?.pathIndexes?.[i] ?? i;
  let place: { root: string; path: string } | undefined;
  const others: string[] = [];
  const first = paths[0];
  if (first !== undefined) {
    place = placeFor(first, options.roots ?? {});
    if (place === undefined) {
      report.add("path-outside-roots", e.metaAt, "paths", pathAt(0));
      others.push(report.clean(first, "text", e.metaAt, "paths", pathAt(0)));
    }
  }
  if (paths.length > 1) report.add("paths-extra", e.metaAt, "paths", pathAt(1));
  for (const [i, p] of paths.slice(1).entries()) {
    others.push(report.clean(p, "text", e.metaAt, "paths", pathAt(i + 1)));
  }
  if (others.length > 0) ext["paths"] = others;

  // The completion.
  let lifecycle: "active" | "completed" = "active";
  let complete: { outcome?: string; at?: number } | undefined;
  const check = state?.check;
  if (line?.file === "DONE.md") {
    const clause = line.completion;
    const outcome =
      clause === undefined
        ? ""
        : report.fit(
            report.clean(clause.evidence, "text", e.at, "done").trim(),
            MAPPING_LIMITS.outcome,
            "bytes",
            e.at,
            "done",
          );
    const doneAt = clause?.date === undefined ? undefined : at(clause.date, e.at, "done");
    if (clause?.date === undefined) report.add("done-date-unknown", e.at, "done");
    if (doneAt === undefined) ext["done_date_unknown"] = true;
    complete = {
      ...(outcome === "" ? {} : { outcome }),
      ...(doneAt === undefined ? {} : { at: doneAt }),
    };
  } else if (line?.checked === true || check?.checked === true) {
    report.add("checked-item", e.at, "check");
    if (options.checkedAs === "review") status = "review";
    else {
      // The check's own time when an event checked it, else the import time.
      let checkedAt: number | undefined;
      if (check?.checked === true) {
        checkedAt = eventMillis(check.at);
        if (checkedAt === undefined) report.add("date-out-of-range", e.at, "check");
      }
      complete = checkedAt === undefined ? {} : { at: checkedAt };
    }
  }
  if (complete !== undefined) lifecycle = "completed";

  // Unknown metadata keys, each as ext.planning.<key>. A value holding a number JSON.parse could
  // not keep as written is not what the file says: left out like one nested too deep.
  const inexact = new Set(meta?.inexact ?? []);
  for (const [index, [key, value]] of Object.entries(meta?.extra ?? {}).entries()) {
    if (PLANNING_EXT_KEYS.has(key)) {
      report.add("extra-key-reserved", e.metaAt, "extra", index);
      continue;
    }
    const clean = inexact.has(key) ? undefined : cleanJson(value, 0);
    if (clean === undefined) {
      report.add("extra-dropped", e.metaAt, "extra", index);
      continue;
    }
    if (clean.changed) report.add("text-sanitised", e.metaAt, "extra", index);
    // defineProperty, so a key such as `__proto__` stays an own key and never a prototype.
    Object.defineProperty(ext, key, {
      value: clean.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const group = cx.groups.of.get(e) ?? { area: "other" };
  const create: PlannedTaskCreate = {
    kind: "task.create",
    task: draft,
    title,
    ...(summary === "" ? {} : { summary }),
    ...(context === "" ? {} : { context }),
    status,
    priority: meta?.priority ?? 3,
    ...people,
    ...(sourceAt === undefined ? {} : { source_at: sourceAt }),
    ...(reviewedAt === undefined ? {} : { reviewed_at: reviewedAt }),
    ...(due === undefined ? {} : { due: { date: due } }),
    ...(focus === undefined ? {} : { focus }),
    area: group.area,
    ...(group.project === undefined ? {} : { project: group.project }),
    dedupe: "none",
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ext: { planning: ext as unknown as PlanningExt },
  };

  const ops: PlannedOp[] = [create];
  ops.push({ kind: "alias.add", task: draft, namespace: "planning", alias: e.id });
  for (const row of cx.sources.get(e) ?? []) {
    ops.push({ kind: "source.add", task: draft, source: row.fields, role: "origin" });
  }
  if (place !== undefined) ops.push({ kind: "place.set", task: draft, ...place });
  if (meta?.evidence !== undefined) {
    const evidence = report.fit(
      report.clean(meta.evidence, "text", e.metaAt, "evidence"),
      MAPPING_LIMITS.log,
      "bytes",
      e.metaAt,
      "evidence",
    );
    if (evidence.trim() !== "") {
      ops.push({
        kind: "log.add",
        task: draft,
        body: evidence,
        log_kind: "evidence",
        ...(sourceAt === undefined ? {} : { at: sourceAt }),
      });
    }
  }
  ops.push({ kind: "log.add", task: draft, body: IMPORT_LOG, log_kind: "progress" });
  if (complete !== undefined) ops.push({ kind: "task.complete", task: draft, ...complete });

  return {
    legacyId: e.id,
    file: line?.file ?? METADATA_FILE,
    ...(line === undefined ? {} : { line: line.line }),
    marked: line?.marked ?? true,
    area: group.area,
    ...(group.project === undefined ? {} : { project: group.project }),
    status,
    lifecycle,
    ...(complete === undefined
      ? {}
      : { wrap: complete.outcome === undefined ? ("pending" as const) : ("wrapped" as const) }),
    ...(place === undefined ? {} : { place }),
    ops,
  };
}

/**
 * A JSON value with every string through SafeText, or undefined when it nests deeper than
 * MAPPING_LIMITS.extraDepth. Keys stay as written; `__proto__` stays an own key.
 */
function cleanJson(
  value: unknown,
  depth: number,
): { value: unknown; changed: boolean } | undefined {
  if (depth > MAPPING_LIMITS.extraDepth) return undefined;
  // JSON holds no Infinity: it would be written as null.
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (typeof value === "string") {
    const out = normaliseText(value);
    return { value: out, changed: out !== value };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let changed = false;
    for (const item of value as unknown[]) {
      const c = cleanJson(item, depth + 1);
      if (c === undefined) return undefined;
      changed ||= c.changed;
      out.push(c.value);
    }
    return { value: out, changed };
  }
  if (typeof value === "object" && value !== null) {
    const entries: [string, unknown][] = [];
    let changed = false;
    for (const [k, v] of Object.entries(value)) {
      const c = cleanJson(v, depth + 1);
      if (c === undefined) return undefined;
      changed ||= c.changed;
      entries.push([k, c.value]);
    }
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
}

// ---------------------------------------------------------------------------------------------

/** Maps a parsed prototype folder to an import plan (A7 3.15.3). */
export function mapPrototype(parse: PrototypeParse, options: MappingOptions): ImportPlan {
  checkOptions(options);
  const report = new Report();
  const { entries, duplicates } = entriesOf(parse, options.includeOrphans === true, report);
  const groups = groupsOf(entries, report);
  const jira = new Map<string, TicketTitle>();
  for (const t of parse.jira.tickets) {
    const key = t.key.toUpperCase();
    if (t.title !== undefined && !jira.has(key)) {
      jira.set(key, { raw: t.title, clean: normaliseLine(t.title) });
    }
  }
  const { rows, byEntry } = sourcesOf(entries, jira, report);
  const owners = new Map<string, { name: string; me: boolean; tasks: number }>();
  const cx: Context = { parse, options, report, groups, sources: byEntry, owners };
  const mapped = entries.map((e) => ({ e, task: mapEntry(e, cx) }));

  // Creation order: groups in order of first appearance; within one, ranked tasks by rank, then
  // the others, each in file order.
  const groupOrder = new Map<string, number>();
  const groupKey = (t: PlannedTask) => `${t.area}\u0000${t.project ?? ""}`;
  for (const { task } of mapped) {
    if (!groupOrder.has(groupKey(task))) groupOrder.set(groupKey(task), groupOrder.size);
  }
  const ranked = mapped.map(({ e, task }, file) => ({ task, file, rank: e.meta?.rank }));
  ranked.sort(
    (a, b) =>
      (groupOrder.get(groupKey(a.task)) ?? 0) - (groupOrder.get(groupKey(b.task)) ?? 0) ||
      (a.rank === undefined ? 1 : 0) - (b.rank === undefined ? 1 : 0) ||
      (a.rank ?? 0) - (b.rank ?? 0) ||
      a.file - b.file,
  );
  const tasks = ranked.map((r) => r.task);

  const sources: PlannedSource[] = rows.map((row) => ({
    ...row.fields,
    generic: row.generic,
    tasks: [...new Set(row.links.map((l) => l.entry.id))],
  }));
  // Counted in Maps: a root may be called `constructor`, which a plain object already has.
  const byKind = new Map<PlannedSourceKind, number>();
  for (const s of sources) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const byRoot = new Map<string, number>();
  for (const t of tasks) {
    if (t.place !== undefined) byRoot.set(t.place.root, (byRoot.get(t.place.root) ?? 0) + 1);
  }
  const sourcesByKind = Object.fromEntries(byKind) as Partial<Record<PlannedSourceKind, number>>;
  const placesByRoot: Record<string, number> = Object.fromEntries(byRoot);
  const completed = tasks.filter((t) => t.lifecycle === "completed");
  const ownerList: PlannedOwner[] = [...owners.values()];

  return {
    areas: [...groups.areas.values()],
    projects: [...groups.projects.values()],
    sources,
    tasks,
    owners: ownerList,
    counts: {
      tasks: tasks.length,
      active: tasks.length - completed.length,
      completed: completed.length,
      wrapped: completed.filter((t) => t.wrap === "wrapped").length,
      aliases: tasks.length,
      areas: groups.areas.size,
      projects: groups.projects.size,
      sources: sources.length,
      sourcesByKind,
      links: sources.reduce((n, s) => n + s.tasks.length, 0),
      places: tasks.filter((t) => t.place !== undefined).length,
      placesByRoot,
      duplicatesLeftOut: duplicates,
      orphansIncluded: entries.filter((e) => e.line === undefined).length,
    },
    problems: report.problems,
  };
}
