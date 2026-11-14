// The synthetic Planning prototype (A7 3.14 M7.01, 3.15): an invented prototype folder for Mira
// Okafor, written in the prototype's formats, with every edge case the importer must handle.
// Deterministic: no clock, no locale, and a seeded random source for the markers and browser event
// IDs. Fixture text only: every name, title, URL, path and date is made up, and every host is a
// reserved example domain (RFC 2606).
//
// `pnpm seed --planning` writes it to fixtures/planning-prototype/, with an index beside it
// (fixtures/planning-prototype.index.json) that names the file and line of every edge case, so the
// parser tests of M7.02 and the mapping tests of M7.03 can assert on each case by name.
//
// The format rules are the prototype's own, read from its code (A7 3.15.2). The index states them
// under `conventions`.
import { createHash } from "node:crypto";
import { DEFAULT_SEED, DEFAULT_TASKS, MIRA } from "./mira.ts";
import { Rng } from "./rng.ts";

/** Where the fixture lives, and the importer options its tests pass (A7 3.15.4). */
export const PLANNING = {
  /** The fixture folder, under the repository's fixtures/. */
  folder: "planning-prototype",
  /** The index file, beside the folder. */
  index: "planning-prototype.index.json",
  /** The page's actions export (`--actions`), beside the folder: a downloaded file, not in it. */
  actions: "planning-prototype.actions.json",
  /** `--me`: the owner name that means the user. */
  me: MIRA.owner,
  /** `--roots`: the roots the fixture's paths are under, or deliberately not. */
  roots: { work: "/home/mira/work", oss: "/home/mira/oss" },
} as const;

/** A line end: each separator Python's str.splitlines() splits at. CRLF is one separator. */
type Eol =
  "\n" | "\r\n" | "\r" | "\v" | "\f" | "\x1c" | "\x1d" | "\x1e" | "\x85" | "\u2028" | "\u2029";

const EOL_NAMES: Record<Eol, string> = {
  "\n": "LF",
  "\r\n": "CRLF",
  "\r": "CR",
  "\v": "U+000B",
  "\f": "U+000C",
  "\x1c": "U+001C",
  "\x1d": "U+001D",
  "\x1e": "U+001E",
  "\x85": "U+0085",
  "\u2028": "U+2028",
  "\u2029": "U+2029",
};
/** The single characters that end a line. */
const BREAKS = new Set(Object.keys(EOL_NAMES).filter((eol) => eol.length === 1));

/** One place an edge case is found. `line` is 1-based, in the str.splitlines() split. */
export interface CaseLocation {
  file: string;
  line?: number;
  /** The task ID (marker, or the fallback ID for an unmarked line). */
  task?: string;
  /** The metadata key the case is about. */
  key?: string;
  /** The event ID the case is about. */
  event?: string;
  note?: string;
  /** What a correct parse or fold gives, where the case decides it. */
  expect?: Record<string, unknown>;
}

export interface IndexedTask {
  id: string;
  file: "TODO.md" | "DONE.md";
  line: number;
  group: string;
  /** The bold text with every trailing dot stripped. */
  title: string;
  /** The text after the title with every marker removed, trimmed. */
  body: string;
  marked: boolean;
  /** The checkbox holds `x` or `X`. */
  checked: boolean;
  /** Every line in DONE.md, and a checked line in TODO.md. */
  done: boolean;
  metadata: boolean;
}

export interface PlanningIndex {
  fixture: string;
  generator: string;
  conventions: Record<string, string>;
  me: string;
  roots: Record<string, string>;
  /** The task of the Mira sample space that already holds a legacy task's source key. */
  spaceTask: { seed: string; tasks: number; ref: string; title: string; key: string };
  counts: {
    todoTaskLines: number;
    doneTaskLines: number;
    taskLines: number;
    metadataEntries: number;
    metadataOrphans: number;
    taskLinesWithoutMetadata: number;
    eventFiles: number;
    readyFiles: number;
    countedEventFiles: number;
    /** web- event files without their .ready file. */
    eventsNotReady: number;
  };
  /** The page's actions export beside the folder (`--actions`). */
  actions: {
    file: string;
    /** Events in it. */
    events: number;
    /** Events it adds to those of events/: their IDs. */
    added: string[];
  };
  tasks: IndexedTask[];
  cases: Record<string, { description: string; where: CaseLocation[] }>;
}

export interface PlanningFixture {
  /** Every file of the prototype folder by its POSIX path, as text written as UTF-8. */
  files: ReadonlyMap<string, string>;
  /** The page's actions export, which lies beside the folder, not in it. */
  actions: string;
  index: PlanningIndex;
}

/** 32-bit FNV-1a over a sequence of units, each XORed in whole and then multiplied. */
function fnv1a32Over(units: Iterable<number>): number {
  let hash = 0x811c9dc5;
  for (const unit of units) hash = Math.imul(hash ^ unit, 0x01000193) >>> 0;
  return hash;
}

const codePoints = (text: string): number[] => Array.from(text).map((c) => c.codePointAt(0) ?? 0);
const hexId = (hash: number): string => `t-${hash.toString(16).padStart(8, "0")}`;

/** 32-bit FNV-1a over the Unicode code points of `text`, as the prototype computes it. */
export const fnv1a32 = (text: string): number => fnv1a32Over(codePoints(text));

/**
 * The prototype's fallback ID: `t-` and eight lower-case hex digits of FNV-1a over the code points
 * of `<group>|<title>`, the title with its trailing dots already stripped.
 */
export const fallbackId = (group: string, title: string): string =>
  hexId(fnv1a32(`${group}|${title}`));

/** What a port that hashed UTF-8 bytes or UTF-16 units would give instead (index only). */
const wrongFallbackIds = (group: string, title: string) => {
  const key = `${group}|${title}`;
  return {
    utf8BytesWouldGive: hexId(fnv1a32Over(Buffer.from(key, "utf8"))),
    utf16UnitsWouldGive: hexId(
      fnv1a32Over(Array.from({ length: key.length }, (_, i) => key.charCodeAt(i))),
    ),
  };
};

// ---------------------------------------------------------------------------------------------
// The edge cases. Every name used below must be described here, and the A7 row's cases must each
// have a location (planning.test.ts).

const CASES: Record<string, string> = {
  // The A7 3.14 M7.01 row.
  crlf: "A line that ends in CRLF. DONE.md is CRLF throughout; TODO.md mixes LF and CRLF",
  "trailing-dots": "A bold title ending in one or more dots: the title is stored without them",
  "unmarked-task-line": "A task line without an ID marker: the ID is the fallback ID",
  "non-task-line":
    "A line that is neither a heading nor a task line: prose, a plain bullet, a bullet without bold",
  "checked-in-todo": "A checked task line ([x] or [X]) still in TODO.md: done",
  "ticked-in-file":
    "A [x] box in TODO.md that no event checks or unchecks. The page does not show it checked " +
    "(only events check a task there); the import completes it as the person's own statement",
  "ticked-unchecked":
    "A [x] box in TODO.md whose last check event is an uncheck: the page shows it unchecked, " +
    "and the import keeps it active",
  "metadata-state-key":
    "A metadata key checked, focus or ticked, which the page applies to a task without events: " +
    "kept in ext.planning, reported, and neither checks nor stars the task",
  "in-both-ledgers":
    "One ID on a TODO.md line and a DONE.md line: the page shows the DONE.md line and hides the " +
    "open one, so the DONE.md line is the task",
  "source-file-link":
    "A file: link: a path on the machine that wrote it, kept with the task's paths, not a source",
  "source-session": "A t3-thread: link, which names an agent thread: a source of kind session",
  "actions-export":
    "The page's actions export beside the folder (planning-prototype.actions.json): every event " +
    "the page knew, those of events/ too. Merged by event ID, it adds the browser's own events " +
    "and the web- event whose .ready file is missing",
  "repeated-heading": "A `## ` heading that appears a second time in the same file",
  u2028:
    "U+2028 in a task body before the marker ends the line there (str.splitlines()). The task keeps " +
    "the cut body, has no marker and so gets the fallback ID. The marker sits on the next line, " +
    "which is no task line",
  "done-with-suffix": "A DONE.md line with `(done YYYY-MM-DD; <evidence>)` before the marker",
  "done-without-suffix": "A DONE.md line without the (done ...) clause",
  "status-open": "Metadata status open",
  "status-waiting": "Metadata status waiting",
  "status-needs-review": "Metadata status needs_review",
  "status-delegated": "Metadata status delegated",
  "status-backlog": "Metadata status backlog",
  "status-missing-waiting-title": 'No status, and the title starts "Waiting on ": waiting',
  "status-missing-open": 'No status, and the title does not start "Waiting on ": open',
  "rank-set": "A rank",
  "rank-tie": "Two tasks of one project with the same rank: file order decides",
  "rank-missing": "No rank in a project where other tasks have one",
  "confidence-word": "confidence as a word",
  "confidence-number": "confidence as a number in text",
  "confidence-free-text": "confidence as a sentence",
  "confidence-missing": "No confidence",
  "reviewed-valid": "A valid reviewed date",
  "reviewed-invalid": "An invalid reviewed date",
  "reviewed-missing": "No reviewed date",
  "source-date-valid": "A valid source_date",
  "source-date-invalid": "An invalid source_date",
  "source-date-missing": "No source_date",
  "invalid-date": "Any invalid date: due, reviewed, source_date, added or done",
  "generic-source-label": 'A source label that only names the kind ("Email", "Chat")',
  "path-outside-roots": "A path under none of the roots in `roots`",
  "metadata-orphan": "A metadata entry with no task line",
  "event-ready": "A file named web-* with its .ready file: it counts",
  "event-web-without-ready":
    "A file named web-* without .ready: it does not count, and is reported",
  "event-non-web": "A file not named web-*, without .ready: it counts as soon as it exists",
  "shared-source-legacy": "Two active legacy tasks naming one ticket URL",
  "shared-source-space":
    "A legacy task whose source key the Mira sample space's task already has (`spaceTask`)",
  "rollback-checked": "A task a folded check event completes",
  "rollback-unchecked": "A task checked, then unchecked: it stays active",
  "rollback-focus": "A focus event: the task is starred",
  "rollback-unfocus": "A focus, then an unfocus event: the star is cleared",
  // The line rules of the prototype's parser.
  "u2028-in-title":
    "U+2028 inside the bold title: the first piece has no closing ** and the second does not " +
    "start with '- [', so neither is a task line and the task is not there at all",
  "line-separators":
    "A line ended by a separator other than LF or CRLF: CR alone, U+000B, U+000C, U+001C, " +
    "U+001D, U+001E, U+0085, U+2028 or U+2029. Each ends the line, like LF",
  "heading-trimmed": "A heading with whitespace after its name: the group is the name, trimmed",
  "marker-in-title":
    "A marker inside the bold title: the first marker anywhere in the line gives the ID, and " +
    "the title keeps the marker text",
  "two-markers":
    "Two markers in the body: the first gives the ID, and both are removed from the body. The " +
    "spaces around a removed marker stay; only the ends are trimmed",
  // DONE.md as the prototype's reconcile writes it.
  "done-reconciled":
    "A DONE.md line exactly as reconcile writes it from the TODO line in `expect.from`: marker " +
    "removed, '- [ ]' turned into '- [x]', right-trimmed, then ' (done <date>; <evidence>) " +
    "<!-- task:<id> -->'. It sits after the first line, between blank lines, before any heading",
  "done-reconciled-fallback":
    "A reconciled line whose TODO line had no marker: reconcile writes the fallback ID it had in " +
    "TODO.md as the marker, so the ID survives the move to group Other",
  "done-unchecked-box": "A DONE.md line with an empty checkbox: done all the same",
  // The mapping rows of A7 3.15.3 and the report of 3.15.4, for M7.03 and M7.04.
  marked: "A task line with an ID marker",
  "default-group": "A task line before the first heading: group Other",
  "same-title-two-groups": "One title, unmarked, under two groups: two different fallback IDs",
  "non-ascii-fallback":
    "An unmarked title with characters between U+0080 and U+07FF: code points and UTF-16 units " +
    "give the same fallback ID, UTF-8 bytes another",
  "astral-fallback":
    "An unmarked title with a character above U+FFFF: code points, UTF-16 units and UTF-8 bytes " +
    "each give another fallback ID. Only the code points are right",
  "metadata-on-fallback-id": "A metadata entry keyed by an unmarked line's fallback ID",
  "task-line-without-metadata": "A task line with no metadata entry",
  "long-title": "A title over 300 characters",
  "empty-body": "A task line with nothing after the title but the marker",
  "group-as-area": "A task whose metadata has no category: the group becomes the area",
  "no-project": "A task with a category and no project",
  "project-paren-suffix": "A project name ending in (...): the slug ignores it",
  "added-clause": "A body with `(added YYYY-MM-DD, <agent>)`",
  "no-added-clause": "A body without an (added ...) clause",
  "next-set": "Metadata next",
  "next-from-body": "No metadata next, and the body has a Next: clause",
  "next-empty": "No metadata next and no Next: clause",
  "refs-clause": "A body with a Refs: clause",
  evidence: "Metadata evidence",
  "owner-me": "The owner is the user (`me`)",
  "owner-other-open": "Another person owns an open task: owner",
  "owner-other-waiting": "Another person on a waiting task: waiting_on",
  "owner-other-delegated": "Another person on a delegated task: waiting_on",
  "owner-missing": "No owner",
  "priority-p1": "Priority P1",
  "priority-p2": "Priority P2",
  "priority-p3": "Priority P3",
  "priority-missing": "No priority: imported as 3",
  "due-valid": "A valid due date",
  "due-invalid": "An invalid due date: dropped and reported",
  "due-missing": "No due date",
  "source-ticket": "A ticket source: /browse/<KEY>-<n>",
  "source-email": "A mail source",
  "source-chat": "A chat source",
  "source-doc": "A document source",
  "source-drive": "A drive source",
  "source-calendar": "A calendar source",
  "source-pr": "A code-host pull request",
  "source-issue": "A code-host issue",
  "source-web": "A web source of no other kind",
  "multiple-sources": "Two sources on one task",
  "path-in-root": "A first path under a root",
  "paths-extra": "More than one path: paths[1...] go to ext.planning.paths",
  "unknown-metadata-key": "A metadata key the importer does not know: ext.planning.<key>",
  "event-tie-by-id": "Two events with the same instant: the event ID, as text, orders them",
  "event-zone-order":
    "Two events whose times have different zones: instant order and text order disagree",
  "event-time-forms":
    "A time without seconds and one with a nine-digit fraction, both valid: instant order and " +
    "text order disagree",
  "event-on-fallback-id": "An event for an unmarked task, by its fallback ID",
  "event-unknown-task": "An event for a task ID no ledger has",
  "event-import-web":
    "A web- event brought in by the prototype's import command: two-space JSON, and a .ready file",
  "event-file-shape":
    "The page's compact JSON without a final newline, and the import command's two-space JSON " +
    "with one",
  "optional-jira": "data/jira.json, the ticket inventory: a list of ticket rows",
  "jira-row-without-key": "A data/jira.json row without key: skipped",
  "optional-audit": "data/audit.json, one free-form object with the scalar reviewed time",
  "not-imported":
    "A file or folder the importer copies or leaves frozen but never imports or runs (A7 3.15.7)",
};

/** The cases the A7 row names: each must have a location. */
export const ROW_CASES: readonly string[] = [
  "crlf",
  "trailing-dots",
  "unmarked-task-line",
  "non-task-line",
  "checked-in-todo",
  "repeated-heading",
  "u2028",
  "done-with-suffix",
  "done-without-suffix",
  "status-open",
  "status-waiting",
  "status-needs-review",
  "status-delegated",
  "status-backlog",
  "status-missing-waiting-title",
  "status-missing-open",
  "rank-set",
  "rank-tie",
  "rank-missing",
  "confidence-word",
  "confidence-number",
  "confidence-free-text",
  "confidence-missing",
  "reviewed-valid",
  "reviewed-invalid",
  "reviewed-missing",
  "source-date-valid",
  "source-date-invalid",
  "source-date-missing",
  "invalid-date",
  "generic-source-label",
  "path-outside-roots",
  "metadata-orphan",
  "event-ready",
  "event-web-without-ready",
  "event-non-web",
  "shared-source-legacy",
  "shared-source-space",
  "rollback-checked",
  "rollback-unchecked",
  "rollback-focus",
  "rollback-unfocus",
];

// ---------------------------------------------------------------------------------------------

type Meta = Record<string, unknown>;
type Mark = " " | "x" | "X";
/** Expectations per case name, for the locations of that case on this line. */
type Expects = Partial<Record<string, Record<string, unknown>>>;

interface TaskInput {
  /** The bold text as written, trailing dots included. */
  bold: string;
  mark?: Mark;
  /** The body without the marker. */
  body?: string;
  /** The marker ID. Undefined draws one; null writes the line without a marker. */
  marker?: string | null;
  meta?: Meta;
  eol?: Eol;
  /** Line cases, and metadata cases as `case@key`. */
  cases?: string[];
  expect?: Expects;
  /** The marker is one a line of the other ledger already has (`in-both-ledgers`). */
  again?: boolean;
}

/** A task line written exactly as `line`, with the parse it must give stated by hand. */
interface RawTaskInput {
  line: string;
  id: string;
  title: string;
  body: string;
  mark: Mark;
  cases: string[];
  expect?: Expects;
}

interface EventInput {
  id: string;
  task: string;
  action: "check" | "uncheck" | "focus" | "unfocus";
  at: string;
  /**
   * Who wrote the file. The page writes events/web-<uuid>.json, then its .ready file. The import
   * command writes two-space JSON with a final newline, and .ready only for a web- ID.
   */
  writer: "page" | "import";
  /** Page only: false leaves the write unfinished, without its .ready file. */
  ready?: boolean;
  cases?: string[];
  expect?: Record<string, unknown>;
}

const HOME = "/home/mira";
const WORK = PLANNING.roots.work;
const OSS = PLANNING.roots.oss;

class Builder {
  readonly #rng = new Rng(`tasks-planning:${DEFAULT_SEED}`);
  readonly files = new Map<string, string>();
  readonly tasks: IndexedTask[] = [];
  readonly metadata = new Map<string, Meta>();
  readonly cases = new Map<string, CaseLocation[]>();
  readonly #ids = new Set<string>();
  #lines: { text: string; eol: Eol }[] = [];
  #file: "TODO.md" | "DONE.md" = "TODO.md";
  #eol: Eol = "\n";
  #group = "Other";
  #headings = new Set<string>();
  orphans = 0;
  eventFiles = 0;
  readyFiles = 0;
  countedEventFiles = 0;
  notReady = 0;
  /** Every event the page knows: each one written to events/, and its browser's own. */
  readonly known: { id: string; task: string; action: string; at: string }[] = [];

  /** A marker drawn from the seeded source, in the prototype's `t-` plus eight hex digits form. */
  marker(): string {
    return `t-${this.#rng.u32().toString(16).padStart(8, "0")}`;
  }

  /** A browser event ID as the page makes it: `web-` and a lower-case version 4 UUID. */
  webId(): string {
    const hex = [0, 1, 2, 3].map(() => this.#rng.u32().toString(16).padStart(8, "0")).join("");
    const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
    return (
      `web-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
      `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    );
  }

  mark(name: string, where: CaseLocation): void {
    if (!(name in CASES)) throw new Error(`undescribed case ${name}`);
    const list = this.cases.get(name) ?? [];
    list.push(where);
    this.cases.set(name, list);
  }

  begin(file: "TODO.md" | "DONE.md", eol: Eol): void {
    this.#file = file;
    this.#eol = eol;
    this.#lines = [];
    this.#group = "Other";
    this.#headings = new Set();
  }

  end(): void {
    this.files.set(this.#file, this.#lines.map((l) => l.text + l.eol).join(""));
  }

  /** Adds one line, marks its line-end case and `cases`, and returns its 1-based number. */
  #add(
    text: string,
    eol: Eol,
    cases: readonly string[],
    base: Partial<CaseLocation> = {},
    expects: Expects = {},
  ): number {
    if (Array.from(text).some((c) => BREAKS.has(c))) throw new Error(`a line end inside ${text}`);
    // A lone CR followed by an empty LF line would read as one CRLF.
    if (this.#lines.at(-1)?.eol === "\r" && text === "" && eol === "\n") {
      throw new Error("CR then an empty LF line");
    }
    this.#lines.push({ text, eol });
    const line = this.#lines.length;
    const at: CaseLocation = { file: this.#file, line, ...base };
    if (eol === "\r\n") this.mark("crlf", at);
    else if (eol !== "\n") this.mark("line-separators", { ...at, expect: { end: EOL_NAMES[eol] } });
    for (const name of cases) {
      const expect = expects[name];
      this.mark(name, expect === undefined ? at : { ...at, expect });
    }
    return line;
  }

  text(
    text: string,
    cases: readonly string[] = [],
    options: { eol?: Eol; expect?: Expects } = {},
  ): void {
    this.#add(text, options.eol ?? this.#eol, cases, {}, options.expect);
  }

  /** A `## ` heading. `trailing` is whitespace written after the name, which the parser trims. */
  heading(name: string, options: { eol?: Eol; trailing?: string } = {}): void {
    const cases: string[] = [];
    if (this.#headings.has(name)) cases.push("repeated-heading");
    if (options.trailing !== undefined) cases.push("heading-trimmed");
    this.#headings.add(name);
    this.#group = name;
    this.#add(
      `## ${name}${options.trailing ?? ""}`,
      options.eol ?? this.#eol,
      cases,
      {},
      {
        "heading-trimmed": { group: name },
      },
    );
  }

  /** Writes one task line and its metadata entry, and returns its ID. */
  task(input: TaskInput): string {
    const marker = input.marker === undefined ? this.marker() : input.marker;
    const title = input.bold.replace(/\.+$/, "");
    const mark = input.mark ?? (this.#file === "DONE.md" ? "x" : " ");
    const parts = [`- [${mark}] **${input.bold}**`];
    if (input.body !== undefined && input.body !== "") parts.push(input.body);
    if (marker !== null) parts.push(`<!-- task:${marker} -->`);
    return this.#task(parts.join(" "), {
      id: marker ?? fallbackId(this.#group, title),
      title,
      body: (input.body ?? "").trim(),
      marked: marker !== null,
      mark,
      meta: input.meta,
      eol: input.eol,
      cases: input.cases ?? [],
      expect: input.expect,
      again: input.again === true,
    });
  }

  rawTask(input: RawTaskInput): string {
    return this.#task(input.line, {
      ...input,
      expect: input.expect,
      marked: true,
      meta: undefined,
      eol: undefined,
    });
  }

  #task(
    text: string,
    t: {
      id: string;
      title: string;
      body: string;
      marked: boolean;
      mark: Mark;
      meta: Meta | undefined;
      eol: Eol | undefined;
      cases: readonly string[];
      expect: Expects | undefined;
      again?: boolean;
    },
  ): string {
    if (this.#ids.has(t.id) !== (t.again === true)) throw new Error(`task ID ${t.id}`);
    if (!/^[a-z0-9_-]+$/.test(t.id)) throw new Error(`bad task ID ${t.id}`);
    this.#ids.add(t.id);
    // Metadata is keyed by ID: a line whose ID another line gave an entry has metadata too.
    const hasMeta = t.meta !== undefined || this.metadata.has(t.id);
    const lineCases = t.cases.filter((c) => !c.includes("@"));
    lineCases.push(t.marked ? "marked" : "unmarked-task-line");
    if (!hasMeta) lineCases.push("task-line-without-metadata");
    const line = this.#add(text, t.eol ?? this.#eol, lineCases, { task: t.id }, t.expect);
    for (const c of t.cases.filter((c) => c.includes("@"))) {
      const [name = "", key = ""] = c.split("@");
      this.mark(name, { file: "data/metadata.json", task: t.id, key });
    }
    this.tasks.push({
      id: t.id,
      file: this.#file,
      line,
      group: this.#group,
      title: t.title,
      body: t.body,
      marked: t.marked,
      checked: t.mark !== " ",
      done: this.#file === "DONE.md" || t.mark !== " ",
      metadata: hasMeta,
    });
    if (t.meta !== undefined) {
      if (this.metadata.has(t.id)) throw new Error(`two metadata entries for ${t.id}`);
      this.metadata.set(t.id, t.meta);
    }
    return t.id;
  }

  orphan(id: string, meta: Meta, note?: string): string {
    if (this.#ids.has(id) || this.metadata.has(id)) throw new Error(`duplicate ID ${id}`);
    this.metadata.set(id, meta);
    this.orphans += 1;
    this.mark("metadata-orphan", {
      file: "data/metadata.json",
      task: id,
      ...(note === undefined ? {} : { note }),
    });
    return id;
  }

  /** One event file in its writer's shape, and its .ready file where the writer makes one. */
  event(input: EventInput): void {
    const body = { id: input.id, task: input.task, action: input.action, at: input.at };
    const web = input.id.startsWith("web-");
    if (input.writer === "page" && !web) throw new Error(`a page event is web-: ${input.id}`);
    this.files.set(
      `events/${input.id}.json`,
      input.writer === "page" ? JSON.stringify(body) : `${JSON.stringify(body, null, 2)}\n`,
    );
    this.eventFiles += 1;
    this.known.push(body);
    const ready = input.writer === "page" ? input.ready !== false : web;
    if (ready) {
      this.files.set(`events/${input.id}.ready`, "");
      this.readyFiles += 1;
    }
    if (!web || ready) this.countedEventFiles += 1;
    else this.notReady += 1;
    const cases = [...(input.cases ?? [])];
    if (web) cases.push(ready ? "event-ready" : "event-web-without-ready");
    else cases.push("event-non-web");
    if (web && input.writer === "import") cases.push("event-import-web");
    for (const name of cases) {
      this.mark(name, {
        file: `events/${input.id}.json`,
        event: input.id,
        task: input.task,
        ...(input.expect === undefined ? {} : { expect: input.expect }),
      });
    }
  }
}

const LONG_TITLE =
  "Collect every garden idea from the green notebook, the photos on the kitchen board and the " +
  "notes from the allotment meeting into one plan for the spring, with the beds along the fence, " +
  "the herbs by the back door, the compost corner, the rain barrel and the new path to the shed, " +
  "and decide which of them fit the budget this year";

/** Builds the synthetic prototype folder and its index. Pure and deterministic. */
export function buildPlanningFixture(): PlanningFixture {
  const b = new Builder();
  const me = PLANNING.me;

  // TODO.md: LF, with a CRLF block under "Clinic sync" and a run of other line ends in "Errands".
  b.begin("TODO.md", "\n");
  b.text("# Planning", ["non-task-line"]);
  b.text("");
  b.text(
    "Open work for Mira. Agents update this file through planning.py; check-offs come from the page.",
    ["non-task-line"],
  );
  b.text("");
  b.task({
    bold: "Order printer toner",
    body: "For the home office. (added 2026-10-03, codex)",
    marker: null,
    cases: ["default-group", "same-title-two-groups", "added-clause"],
  });
  b.text("");

  b.heading("Lumen");
  b.task({
    bold: "Follow up on the time zone fix for the clinic",
    body:
      "The clinic still sees shifted times in two reports. Next: compare the November exports. " +
      "Refs: LUM-1000. (added 2026-10-05, claude)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "open",
      owner: me,
      priority: "P1",
      rank: 1,
      next: "Compare the November exports with the clinic's copy",
      evidence: "Reproduced with the fixture export: 3 of 40 rows shifted.",
      source_date: "2026-10-04",
      reviewed: "2026-11-01",
      confidence: "high",
      due: "2026-11-20",
      sources: [
        {
          label: "LUM-1000 Appointment times shift after DST",
          url: "https://tickets.lumen.example/browse/LUM-1000",
        },
      ],
      paths: [`${WORK}/lumen/portal`],
    },
    cases: [
      "added-clause",
      "refs-clause",
      "status-open@status",
      "owner-me@owner",
      "priority-p1@priority",
      "rank-set@rank",
      "next-set@next",
      "evidence@evidence",
      "source-date-valid@source_date",
      "reviewed-valid@reviewed",
      "confidence-word@confidence",
      "due-valid@due",
      "source-ticket@sources",
      "shared-source-space@sources",
      "path-in-root@paths",
    ],
  });
  b.task({
    bold: "Review the invoice export",
    body: "Tomas sends the corrected file. Refs: mail thread. (added 2026-10-07, codex)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "waiting",
      owner: "Tomas",
      priority: "P2",
      rank: 2,
      next: "Wait for the corrected export",
      source_date: "2026-02-30",
      confidence: "medium",
      sources: [
        { label: "Email", url: "https://mail.lumen.example/mail/u/0/#inbox/FMfcgzFixture0001" },
      ],
    },
    cases: [
      "status-waiting@status",
      "owner-other-waiting@owner",
      "priority-p2@priority",
      "rank-tie@rank",
      "source-date-invalid@source_date",
      "invalid-date@source_date",
      "reviewed-missing@reviewed",
      "confidence-word@confidence",
      "due-missing@due",
      "generic-source-label@sources",
      "source-email@sources",
    ],
  });
  const roadmap = b.task({
    bold: "Draft the Q1 portal roadmap",
    body: "Outline is in the shared doc. (added 2026-10-09, claude)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "open",
      owner: me,
      priority: "P2",
      rank: 2,
      next: "Turn the outline into three themes",
      source_date: "2026-10-08",
      reviewed: "2026-10-30",
      confidence: "medium",
      sources: [
        {
          label: "Q1 roadmap draft",
          url: "https://docs.lumen.example/document/d/1FixtureRoadmapDoc/edit",
        },
      ],
      paths: [`${WORK}/lumen/portal/docs/roadmap`],
    },
    cases: ["rank-tie@rank", "source-doc@sources"],
  });
  b.task({
    bold: "Answer the clinic about sync delays",
    body: "Draft reply is in the chat.",
    meta: {
      category: "Lumen",
      project: "Clinic sync (Q4)",
      status: "needs_review",
      owner: me,
      priority: "P1",
      next: "Send the reply after Aiko's check",
      reviewed: "last week",
      confidence: "0.6",
      sources: [
        { label: "Chat", url: "https://chat.lumen.example/room/clinic-sync/thread/Fixture42" },
      ],
    },
    cases: [
      "no-added-clause",
      "status-needs-review@status",
      "project-paren-suffix@project",
      "reviewed-invalid@reviewed",
      "invalid-date@reviewed",
      "source-date-missing@source_date",
      "confidence-number@confidence",
      "generic-source-label@sources",
      "source-chat@sources",
    ],
  });
  b.task({
    bold: "Update the onboarding checklist",
    body: "Aiko took this over. (added 2026-10-12, codex)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "delegated",
      owner: "Aiko",
      priority: "P3",
      next: "Check Aiko's draft on Friday",
      confidence: "low: Aiko may change the scope",
      sources: [
        {
          label: "Onboarding checklist",
          url: "https://drive.lumen.example/file/d/1FixtureChecklist/view",
        },
      ],
      paths: [`${WORK}/lumen/onboarding`, `${WORK}/lumen/portal/docs`, `${OSS}/notes`],
    },
    cases: [
      "status-delegated@status",
      "owner-other-delegated@owner",
      "priority-p3@priority",
      "confidence-free-text@confidence",
      "source-drive@sources",
      "paths-extra@paths",
    ],
  });
  b.task({
    bold: "Prepare the sprint demo",
    body: "Next: book the demo room and send the agenda. (added 2026-10-14, claude)",
    meta: { category: "Lumen", project: "Lumen portal", status: "backlog" },
    cases: [
      "status-backlog@status",
      "owner-missing@owner",
      "priority-missing@priority",
      "rank-missing@rank",
      "next-from-body@next",
      "confidence-missing@confidence",
    ],
  });
  b.task({
    bold: "Waiting on design sign-off for the portal header",
    body: "Noor reviews the mock-ups.",
    meta: { category: "Lumen", project: "Lumen portal", owner: "Noor", priority: "P2" },
    cases: ["status-missing-waiting-title@status", "owner-other-waiting@owner"],
  });
  b.task({
    bold: "Clean up the flags from v2.1...",
    meta: { category: "Lumen", project: "Lumen portal", owner: "Noor", priority: "P3" },
    cases: [
      "trailing-dots",
      "empty-body",
      "status-missing-open@status",
      "owner-other-open@owner",
      "next-empty@next",
    ],
    expect: { "trailing-dots": { title: "Clean up the flags from v2.1" } },
  });
  b.task({
    bold: "Write the release notes for 2.3",
    mark: "x",
    body: "Notes merged, waiting for reconcile. (added 2026-10-15, codex)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "open",
      owner: me,
      priority: "P2",
      evidence: "Release notes merged in the portal repository.",
      source_date: "2026-10-15",
    },
    cases: ["checked-in-todo", "ticked-in-file"],
  });
  b.task({
    bold: "Check the backup restore drill.",
    mark: "X",
    body: "Ran it on staging.",
    meta: { category: "Lumen", project: "Lumen portal", status: "open", owner: me, priority: "P2" },
    cases: ["checked-in-todo", "ticked-in-file", "trailing-dots"],
    expect: { "trailing-dots": { title: "Check the backup restore drill" } },
  });
  const certificate = b.task({
    bold: "Renew the staging certificate",
    mark: "x",
    marker: "lum-staging-cert",
    body: "Ticked too early: the renewal failed.",
    meta: { category: "Lumen", project: "Lumen portal", status: "open", owner: me, priority: "P2" },
    cases: ["ticked-unchecked"],
  });
  const invoice = b.task({
    bold: "Send the November invoice",
    body: "Waiting for the hours from Tomas.",
    marker: "lum-invoice-nov",
    meta: { category: "Lumen", project: "Lumen portal", status: "open", owner: me, priority: "P2" },
    cases: ["in-both-ledgers"],
    expect: { "in-both-ledgers": { hidden: true } },
  });
  b.text("- Ask Aiko about the staging access next week", ["non-task-line"]);
  b.text("- [ ] Plain checkbox without a bold title", ["non-task-line"]);
  b.text("");

  // A CRLF block inside the LF file.
  b.heading("Clinic sync", { eol: "\r\n" });
  b.task({
    bold: "Migrate the reports to the new API",
    body: "Two reports left. Refs: LUM-1042. (added 2026-10-16, claude)",
    marker: "lum_report-api",
    eol: "\r\n",
    meta: {
      category: "Lumen",
      project: "Clinic sync (Q4)",
      status: "open",
      owner: me,
      priority: "P1",
      rank: 1,
      sources: [
        {
          label: "LUM-1042 Report API migration",
          url: "https://tickets.lumen.example/browse/LUM-1042",
        },
      ],
    },
    cases: ["shared-source-legacy@sources", "source-ticket@sources"],
  });
  b.task({
    bold: "Read the accessibility audit",
    body: "Section 4 covers the report pages. Refs: LUM-1042.",
    eol: "\r\n",
    meta: {
      category: "Lumen",
      project: "Clinic sync (Q4)",
      status: "open",
      owner: me,
      priority: "P2",
      rank: 2,
      sources: [
        { label: "Report API migration", url: "https://tickets.lumen.example/browse/LUM-1042" },
      ],
      estimate: "2h",
    },
    cases: ["shared-source-legacy@sources", "unknown-metadata-key@estimate"],
  });
  b.text("", [], { eol: "\r\n" });

  b.heading("Home");
  b.task({
    bold: "Book the dentist.",
    body: "Ask for an early slot.",
    meta: {
      category: "Home",
      status: "open",
      owner: me,
      priority: "P3",
      due: "2026-13-01",
      paths: [`${HOME}/Documents/health`],
      checked: true,
      focus: true,
    },
    cases: [
      "trailing-dots",
      "no-project@project",
      "due-invalid@due",
      "invalid-date@due",
      "path-outside-roots@paths",
      "metadata-state-key@checked",
      "metadata-state-key@focus",
    ],
    expect: { "trailing-dots": { title: "Book the dentist" } },
  });
  const passport = b.task({
    bold: "Renew the passport",
    body: "Photos are done. Book the appointment at the town hall.",
    meta: {
      category: "Home",
      status: "open",
      owner: me,
      priority: "P2",
      due: "next Friday",
      sources: [
        {
          label: "Passport appointment",
          url: "https://calendar.mira.example/calendar/event?eid=FixturePassport",
        },
      ],
      ticked: true,
    },
    cases: [
      "due-invalid@due",
      "invalid-date@due",
      "source-calendar@sources",
      "metadata-state-key@ticked",
    ],
  });
  const bulbs = b.task({
    bold: "Plant the spring bulbs",
    body: "Tulips along the fence. (added 2026-10-20, codex)",
    meta: {
      category: "Home",
      project: "Garden",
      status: "open",
      owner: me,
      priority: "P3",
      rank: 1,
      sources: [
        { label: "Bulb planting guide", url: "https://www.example.org/garden/spring-bulbs" },
      ],
    },
    cases: ["source-web@sources"],
  });
  const fence = b.task({
    bold: "Repair the garden fence",
    body: "Two posts are loose.",
    marker: "home-fence",
    meta: {
      category: "Home",
      project: "Garden",
      status: "waiting",
      owner: me,
      priority: "P2",
      rank: 2,
      paths: ["/mnt/shed/fence-plans"],
    },
    cases: ["owner-me@owner", "path-outside-roots@paths"],
  });
  const zoe = "Reply to Zoë about the café booking";
  b.task({
    bold: zoe,
    body: "(added 2026-10-21, claude)",
    marker: null,
    cases: ["non-ascii-fallback", "added-clause"],
    expect: {
      "non-ascii-fallback": {
        id: fallbackId("Home", zoe),
        utf8BytesWouldGive: wrongFallbackIds("Home", zoe).utf8BytesWouldGive,
      },
    },
  });
  const cake = "Pick up the \u{1F382} for Aiko's birthday";
  b.task({
    bold: cake,
    body: "Order it at the bakery on Main Street first.",
    marker: null,
    cases: ["astral-fallback"],
    expect: {
      "astral-fallback": { id: fallbackId("Home", cake), ...wrongFallbackIds("Home", cake) },
    },
  });
  const photos = b.task({
    bold: "Sort the photo archive",
    body: "Started with 2019. (added 2026-09-31, codex)",
    marker: null,
    meta: { category: "Home", status: "backlog", owner: me, priority: "P3" },
    cases: ["invalid-date", "metadata-on-fallback-id@category"],
  });
  const garden = b.task({
    bold: LONG_TITLE,
    body: "Start with the beds along the fence.",
    meta: { category: "Home", project: "Garden", status: "open", owner: me, priority: "P3" },
    cases: ["long-title"],
  });
  // U+2028 in the body, before the marker: the task line ends there, and the marker's line
  // that follows is no task line, so the marker's metadata has no task line either.
  const cutMarker = b.marker();
  const cut = b.task({
    bold: "Renew the library card",
    body: "Bring the old card.",
    marker: null,
    eol: "\u2028",
    cases: ["u2028"],
    expect: {
      u2028: {
        taskLine: true,
        title: "Renew the library card",
        body: "Bring the old card.",
        marked: false,
        note: "the marker is on the next line",
      },
    },
  });
  b.text(`Ask about the e-book app. <!-- task:${cutMarker} -->`, ["u2028", "non-task-line"], {
    expect: { u2028: { taskLine: false, marker: cutMarker, note: `the rest of ${cut}'s line` } },
  });
  b.orphan(
    cutMarker,
    { category: "Home", status: "open", owner: me, priority: "P3" },
    "keyed by the marker of the U+2028 line, which is on no task line",
  );
  // U+2028 inside the bold title: neither piece is a task line.
  const lostMarker = b.marker();
  b.text("- [ ] **Call the", ["u2028-in-title", "non-task-line"], {
    eol: "\u2028",
    expect: { "u2028-in-title": { taskLine: false, note: "no closing **" } },
  });
  b.text(
    `window cleaner** Before the spring. <!-- task:${lostMarker} -->`,
    ["u2028-in-title", "non-task-line"],
    { expect: { "u2028-in-title": { taskLine: false, marker: lostMarker } } },
  );
  b.rawTask({
    line: "- [ ] **Fix the bike light <!-- task:home-bike -->** The rear one flickers.",
    id: "home-bike",
    title: "Fix the bike light <!-- task:home-bike -->",
    body: "The rear one flickers.",
    mark: " ",
    cases: ["marker-in-title"],
    expect: {
      "marker-in-title": {
        id: "home-bike",
        title: "Fix the bike light <!-- task:home-bike -->",
        body: "The rear one flickers.",
      },
    },
  });
  b.rawTask({
    line:
      "- [ ] **Sort the receipts** Start with October. <!-- task:home-receipts --> " +
      "Then file them by month. <!-- task:home-receipts-2025 -->",
    id: "home-receipts",
    title: "Sort the receipts",
    body: "Start with October.  Then file them by month.",
    mark: " ",
    cases: ["two-markers"],
    expect: {
      "two-markers": { id: "home-receipts", body: "Start with October.  Then file them by month." },
    },
  });
  b.text("");

  b.heading("Errands", { trailing: " \t" });
  const library = b.task({
    bold: "Return the library books",
    body: "Due back at the branch on Main Street.",
    meta: { status: "open", owner: me, priority: "P3", due: "2026-11-15" },
    cases: ["group-as-area@category", "due-valid@due"],
  });
  // One task line per line end other than LF and CRLF: each ends its line like LF.
  const errands: [string, Eol][] = [
    ["Buy coffee beans", "\v"],
    ["Buy oat milk", "\f"],
    ["Buy batteries", "\x1c"],
    ["Buy light bulbs", "\x1d"],
    ["Buy stamps", "\x1e"],
    ["Buy bin bags", "\x85"],
    ["Buy dish soap", "\u2029"],
    ["Buy rice", "\r"],
  ];
  for (const [bold, eol] of errands) b.task({ bold, body: "From the corner shop.", eol });
  const tea = b.task({ bold: "Buy tea", body: "From the corner shop." });
  b.text("");

  b.heading("Lumen");
  const offsite = b.task({
    bold: "Plan the team offsite",
    body: "Venue shortlist is in the doc. (added 2026-10-22, claude)",
    meta: {
      category: "Lumen",
      status: "open",
      owner: me,
      priority: "P2",
      sources: [
        { label: "Folder", url: `file://${WORK}/lumen/offsite` },
        { label: "Planning thread", url: "t3-thread:fixture-thread-0001" },
      ],
    },
    cases: ["no-project@project", "source-file-link@sources", "source-session@sources"],
  });
  b.task({
    bold: "Order printer toner",
    body: "For the office printer on the second floor.",
    marker: null,
    cases: ["same-title-two-groups", "no-added-clause"],
  });
  b.text("");

  b.heading("Open source");
  const issue = b.task({
    bold: "Answer the tidy-md issue about tables",
    body: "A user reports broken column alignment. (added 2026-10-25, codex)",
    meta: {
      category: "Open source",
      project: "tidy-md (oss)",
      status: "open",
      owner: me,
      priority: "P3",
      rank: 1,
      sources: [
        {
          label: "Issue 9: tables lose alignment",
          url: "https://git.example.org/mira/tidy-md/issues/9",
        },
        { label: "PR 14: keep column widths", url: "https://git.example.org/mira/tidy-md/pull/14" },
      ],
      paths: [`${OSS}/tidy-md`],
    },
    cases: [
      "project-paren-suffix@project",
      "source-issue@sources",
      "source-pr@sources",
      "multiple-sources@sources",
      "path-in-root@paths",
    ],
  });
  b.end();

  // DONE.md: CRLF throughout. reconcile puts new lines after the first line, between blank
  // lines, so the newest two sit before any heading (group Other). Older lines are grouped.
  b.begin("DONE.md", "\r\n");
  b.text("# Done");
  b.text("");
  const balcony = "Water the balcony plants";
  const balconyId = fallbackId("Home", balcony);
  b.task({
    bold: balcony,
    body: "Every other day. (added 2026-10-26, codex) (done 2026-11-07; set up the drip tray)",
    marker: balconyId,
    cases: ["done-reconciled", "done-reconciled-fallback", "done-with-suffix", "default-group"],
    expect: {
      "done-reconciled": {
        from: `- [ ] **${balcony}** Every other day. (added 2026-10-26, codex)`,
        date: "2026-11-07",
        evidence: "set up the drip tray",
      },
      "done-reconciled-fallback": {
        id: balconyId,
        todoGroup: "Home",
        fallbackHere: fallbackId("Other", balcony),
      },
    },
  });
  b.text("");
  const timeline = b.marker();
  const timelineTitle = "Send the clinic the sync timeline";
  b.task({
    bold: timelineTitle,
    mark: "X",
    body:
      "Shared in the clinic chat. (added 2026-10-28, claude) " +
      "(done 2026-11-06; sent in the clinic chat)",
    marker: timeline,
    meta: { category: "Lumen", project: "Clinic sync (Q4)", status: "open", owner: me },
    cases: ["done-reconciled", "done-with-suffix", "default-group"],
    expect: {
      "done-reconciled": {
        from:
          `- [X] **${timelineTitle}** Shared in the clinic chat. (added 2026-10-28, claude) ` +
          `<!-- task:${timeline} -->`,
        date: "2026-11-06",
        evidence: "sent in the clinic chat",
        note: "a [X] line has no '- [ ]' to turn, so it stays [X]",
      },
    },
  });
  b.text("");
  b.heading("Lumen");
  b.task({
    bold: "Ship the 2.2 hotfix",
    body: "Patched the token refresh. (added 2026-09-20, codex) (done 2026-09-24; released as 2.2.1)",
    meta: {
      category: "Lumen",
      project: "Lumen portal",
      status: "open",
      owner: me,
      priority: "P1",
      evidence: "Released as 2.2.1.",
      source_date: "2026-09-19",
    },
    cases: ["done-with-suffix"],
  });
  b.task({
    bold: "Retire the old status page",
    body: "(done 2026-10-01; archived: replaced by the portal banner)",
    cases: ["done-with-suffix"],
  });
  b.task({
    bold: "Rename the staging bucket",
    body: "Renamed, links updated.",
    meta: { category: "Lumen", project: "Lumen portal", status: "open", owner: me, priority: "P3" },
    cases: ["done-without-suffix"],
  });
  b.task({
    bold: "Fix the login redirect.",
    body: "(done 2026-02-30; fixed in 2.1)",
    meta: { category: "Lumen", project: "Lumen portal", status: "open", owner: me, priority: "P2" },
    cases: ["done-with-suffix", "invalid-date", "trailing-dots"],
    expect: { "trailing-dots": { title: "Fix the login redirect" } },
  });
  b.task({
    bold: "Send the November invoice",
    body: "Waiting for the hours from Tomas. (done 2026-11-08; sent to the clinic)",
    marker: invoice,
    again: true,
    cases: ["in-both-ledgers", "done-with-suffix"],
    expect: { "in-both-ledgers": { hidden: false } },
  });
  b.text("");
  b.heading("Home");
  b.task({
    bold: "Pay the water bill",
    body: "(done 2026-10-12; paid online)",
    meta: { category: "Home", status: "open", owner: me, priority: "P2" },
    cases: ["done-with-suffix"],
  });
  b.task({
    bold: "Archive the 2025 invoices",
    body: "Filed in the cabinet. (done 2026-10-18; scanned and filed)",
    marker: null,
    cases: ["done-with-suffix"],
  });
  b.text("");
  b.heading("Lumen");
  b.task({
    bold: "Close the Q3 survey",
    mark: " ",
    body: "Results shared with the team.",
    meta: { category: "Lumen", status: "open", owner: me, priority: "P3" },
    cases: ["done-without-suffix", "done-unchecked-box"],
    expect: { "done-unchecked-box": { checked: false, done: true } },
  });
  b.end();

  // Metadata entries without a task line.
  b.orphan(b.marker(), {
    category: "Lumen",
    project: "Lumen portal",
    status: "backlog",
    owner: me,
    priority: "P3",
    next: "Collect feedback on the new dashboard",
  });
  b.orphan(b.marker(), { category: "Home", status: "open", owner: "Tomas", priority: "P2" });

  // Events: the rollback cases, the .ready rule and the folding order. The page writes UTC times
  // with milliseconds; the import command keeps the time it was given.
  b.event({
    id: b.webId(),
    writer: "page",
    task: offsite,
    action: "check",
    at: "2026-11-03T09:15:00.000Z",
    cases: ["rollback-checked"],
    expect: { checked: true },
  });
  b.event({
    id: "cli-0001",
    writer: "import",
    task: roadmap,
    action: "check",
    at: "2026-11-03T10:00:00Z",
    cases: ["rollback-unchecked"],
  });
  b.event({
    id: b.webId(),
    writer: "page",
    task: roadmap,
    action: "uncheck",
    at: "2026-11-03T11:30:00.000Z",
    cases: ["rollback-unchecked"],
    expect: { checked: false },
  });
  b.event({
    id: b.webId(),
    writer: "page",
    task: roadmap,
    action: "check",
    at: "2026-11-04T08:00:00.000Z",
    ready: false,
    expect: { counted: false, checked: false },
  });
  b.event({
    id: b.webId(),
    writer: "page",
    task: bulbs,
    action: "focus",
    at: "2026-11-02T08:00:00.000Z",
    cases: ["rollback-unfocus", "event-file-shape"],
  });
  b.event({
    id: "cli-0002",
    writer: "import",
    task: bulbs,
    action: "unfocus",
    at: "2026-11-02T16:00:00Z",
    cases: ["rollback-unfocus", "event-file-shape"],
    expect: { starred: false },
  });
  b.event({
    id: "cli-0003",
    writer: "import",
    task: fence,
    action: "focus",
    at: "2026-11-03T07:00:00Z",
    cases: ["rollback-focus"],
    expect: { starred: true, focusOn: "2026-11-03" },
  });
  b.event({
    id: "cli-0004",
    writer: "import",
    task: photos,
    action: "check",
    at: "2026-11-04T18:00:00Z",
    cases: ["event-on-fallback-id"],
    expect: { checked: true },
  });
  b.event({
    id: "cli-0005",
    writer: "import",
    task: "t-0badc0de",
    action: "check",
    at: "2026-11-04T18:05:00Z",
    cases: ["event-unknown-task"],
  });
  b.event({
    id: "cli-0007",
    writer: "import",
    task: passport,
    action: "focus",
    at: "2026-11-05T10:00:00Z",
    cases: ["event-tie-by-id"],
    expect: { starred: true },
  });
  b.event({
    id: "cli-0006",
    writer: "import",
    task: passport,
    action: "unfocus",
    at: "2026-11-05T10:00:00Z",
    cases: ["event-tie-by-id"],
  });
  b.event({
    id: "cli-0009",
    writer: "import",
    task: issue,
    action: "focus",
    at: "2026-11-05T09:30:00+02:00",
    cases: ["event-zone-order"],
  });
  b.event({
    id: "cli-0008",
    writer: "import",
    task: issue,
    action: "unfocus",
    at: "2026-11-05T08:00:00Z",
    cases: ["event-zone-order"],
    expect: {
      starred: false,
      note: "as instants the focus (07:30Z) comes first; as text it sorts last",
    },
  });
  b.event({
    id: "cli-0010",
    writer: "import",
    task: library,
    action: "focus",
    at: "2026-11-06T07:45Z",
    cases: ["event-time-forms"],
  });
  b.event({
    id: "cli-0011",
    writer: "import",
    task: library,
    action: "unfocus",
    at: "2026-11-06T07:45:00.123456789Z",
    cases: ["event-time-forms"],
    expect: {
      starred: false,
      note: "as instants the focus (07:45:00) comes first; as text it sorts last",
    },
  });
  b.event({
    id: b.webId(),
    writer: "import",
    task: garden,
    action: "focus",
    at: "2026-11-06T12:00:00Z",
    expect: { counted: true, starred: true },
  });
  b.event({
    id: "cli-0012",
    writer: "import",
    task: certificate,
    action: "uncheck",
    at: "2026-11-05T15:00:00Z",
    cases: ["ticked-unchecked"],
    expect: { checked: false },
  });

  // The page's actions export: every event it knows, those of events/ (the web- one without its
  // .ready file too, which is the browser's own) and one only the browser holds, de-duplicated and
  // sorted by time, then ID, saved on 7 November.
  const browserOnly = {
    id: b.webId(),
    task: tea,
    action: "check",
    at: "2026-11-06T18:00:00.000Z",
  };
  const exported = [...b.known, browserOnly].sort(
    (x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  const actions = `${JSON.stringify(
    { version: 1, exported: "2026-11-07T19:30:00.000Z", events: exported },
    null,
    2,
  )}\n`;
  const notReadyIds = [...b.files.keys()]
    .filter((p) => /^events\/web-.*\.json$/.test(p) && !b.files.has(p.replace(/json$/, "ready")))
    .map((p) => p.slice("events/".length, -".json".length));
  b.mark("actions-export", {
    file: PLANNING.actions,
    task: tea,
    event: browserOnly.id,
    note: "the browser's own check, and the web- event without .ready, are added",
  });

  // data/metadata.json: one object keyed by task ID, ledger order, then the orphans.
  b.files.set("data/metadata.json", `${JSON.stringify(Object.fromEntries(b.metadata), null, 2)}\n`);

  // Optional files (A7 3.15.7): jira.json is a list of rows, audit.json one free-form object.
  b.files.set(
    "data/jira.json",
    `${JSON.stringify(
      [
        {
          key: "LUM-1000",
          summary: "Appointment times shift after the DST change",
          status: "In Progress",
          url: "https://tickets.lumen.example/browse/LUM-1000",
        },
        {
          key: "LUM-1042",
          summary: "Move the clinic reports to the v2 API",
          status: "To Do",
          labels: ["clinic", "reports"],
          url: "https://tickets.lumen.example/browse/LUM-1042",
        },
        {
          summary: "Draft row without a key",
          url: "https://tickets.lumen.example/browse/LUM-1099",
        },
      ],
      null,
      2,
    )}\n`,
  );
  b.mark("optional-jira", { file: "data/jira.json", expect: { keys: ["LUM-1000", "LUM-1042"] } });
  b.mark("jira-row-without-key", {
    file: "data/jira.json",
    note: "the third row",
    expect: { skipped: true },
  });
  const reviewed = "2026-10-30T09:10:00Z";
  b.files.set(
    "data/audit.json",
    `${JSON.stringify(
      {
        reviewed,
        coverage: { mail: true, chat: true, tickets: true },
        reviews: [
          { started_at: "2026-10-30T08:00:00Z", completed_at: reviewed, complete: true },
          { started_at: "2026-11-01T08:00:00Z", completed_at: null, complete: false },
        ],
      },
      null,
      2,
    )}\n`,
  );
  b.mark("optional-audit", {
    file: "data/audit.json",
    expect: { reviewed, note: "the scalar reviewed time: the Refresh watermark" },
  });

  // Files the importer never imports or runs (A7 3.15.7): small stand-ins, not the prototype's.
  const stubs: Record<string, string> = {
    "planning.py":
      "# Fixture stand-in, not the prototype's code. Tasks never runs any file in this folder.\n" +
      'raise SystemExit("fixture stand-in")\n',
    "index.html":
      "<!doctype html>\n<!-- Fixture stand-in for the prototype's page. Never opened by Tasks. -->\n" +
      "<title>Planning</title>\n",
    "AGENTS.md": "# Planning\n\nFixture stand-in for the prototype's agent rules. Not imported.\n",
    "context/clinic-sync.md":
      "# Clinic sync\n\nBackground: the clinic exports local times without a zone.\n",
    "reviews/2026-10-30.md":
      "# Review 2026-10-30\n\nMail, chat and tickets covered. Two new tasks.\n",
    "snapshots/TODO-2026-10-01.md":
      "# Planning\n\n## Lumen\n- [ ] **An old snapshot line** Never imported. <!-- task:t-5a5a5a5a -->\n",
  };
  for (const [path, text] of Object.entries(stubs)) {
    b.files.set(path, text);
    b.mark("not-imported", { file: path });
  }

  const sortedFiles = new Map([...b.files].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)));
  const cases: PlanningIndex["cases"] = {};
  for (const name of Object.keys(CASES).sort()) {
    const where = b.cases.get(name);
    if (where !== undefined) cases[name] = { description: CASES[name] ?? "", where };
  }
  const todo = b.tasks.filter((t) => t.file === "TODO.md").length;
  const done = b.tasks.length - todo;
  return {
    files: sortedFiles,
    actions,
    index: {
      fixture: `fixtures/${PLANNING.folder}`,
      generator: "pnpm seed --planning",
      conventions: {
        source: "Every rule here is the prototype's own, read from its code (A7 3.15.2)",
        lines:
          "Each ledger is split as Python's str.splitlines() splits: at LF, CRLF, CR, U+000B, " +
          "U+000C, U+001C, U+001D, U+001E, U+0085, U+2028 and U+2029. Each piece is matched on its " +
          "own. Line numbers are 1-based in that split. A line never holds its line end",
        grammar:
          "Task line ^- \\[([ xX])\\] \\*\\*(.+?)\\*\\*\\s*(.*)$. The title is the bold text with every " +
          "trailing dot stripped. A line starting '## ' sets the group to the rest of the line, " +
          "trimmed; before any heading the group is Other. After the split no line holds a line " +
          "terminator, so JavaScript's `.` matches what Python's does without the s flag",
        done: "Every task line in DONE.md is done whatever its checkbox. In TODO.md x or X is done",
        markers:
          "<!-- task:ID --> with ID [a-z0-9_-]+. The first marker anywhere in the line, title " +
          "included, gives the ID. The body is the text after the title with every marker " +
          "removed, then trimmed",
        fallbackId:
          "t- and eight lower-case hex digits of 32-bit FNV-1a (offset basis 2166136261, prime " +
          "16777619, modulo 2^32) over the Unicode code points of <group>|<title>, the title " +
          "without its trailing dots. Each whole code point is XORed in, then multiplied. Not " +
          "UTF-8 bytes, not UTF-16 units",
        events:
          "Every events/*.json is read, in sorted file-name order. A file whose name starts with " +
          "web- counts only when events/<same stem>.ready (an empty file) exists. Any other file " +
          "counts as soon as it exists. Neither the page nor planning.py checks that a file's name " +
          "is its event's id. An event is an object {id, task, action, at}: action " +
          "check, uncheck, focus or unfocus; id and task [a-zA-Z0-9_-]{1,100}; at " +
          "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2}). An invalid " +
          "file makes planning.py's read fail as a whole, and the page drops it: every event file " +
          "here is valid. An event's task may hold upper-case letters; a ledger ID never does",
        eventOrder:
          "Events are de-duplicated by id, then apply in order of the instant of at, then id: " +
          "planning.py compares ids by code point, the page with localeCompare. The last check or " +
          "uncheck per task wins, and the last focus or unfocus sets the star. No two times here " +
          "differ by less than a microsecond",
        checkOff:
          "Only events check a task on the page. A [x] box in TODO.md does not: the page shows the " +
          "line with a note that it was ticked in the file and leaves it unchecked unless an event " +
          "checks it, and a later uncheck event leaves it unchecked. reconcile archives a task whose " +
          "last check event is a check and ignores a [x] box. Events fold onto DONE.md tasks with no " +
          "visible effect: a done task shows checked, without a star, and nothing reopens it. A " +
          "metadata key checked, focus or ticked takes effect on the page for a task with no events, " +
          "since the page copies every metadata key onto its task",
        groups:
          "The page shows a task under its metadata category, Small todos without one, and in it " +
          "under its group: metadata project, else the heading without a trailing (...)",
        bothLedgers:
          "An id on a TODO.md line and a DONE.md line: the page shows the DONE.md line and hides the " +
          "open one; planning.py's build refuses the duplicate id",
        next:
          "The page reads next from metadata, else from the body as Next:\\s*(.*?)(?=\\sRefs:|" +
          "\\s\\(added|$), else it shows a placeholder",
        links:
          "The page gives a link a kind, first match wins: no URL, link; file:, folder; host " +
          "mail.google.com, mail; chat.google.com, chat; a host ending in atlassian.net, wiki when " +
          "the path starts with /wiki, else ticket; docs.google.com, doc; drive.google.com, drive; a " +
          "host containing gitlab or github, code; else link. It shows links only for http:, " +
          "https:, file: and t3-thread:, each URL once, and a folder for the first path starting " +
          "with /. A label is the link's own, else the kind's name; a label that is the ticket's " +
          "key is not the ticket's title. The fixture's hosts stay RFC 2606 names, so the hosts " +
          "of real services are tested on inline URLs",
        actions:
          "The page saves its actions export as planning-actions-YYYY-MM-DD.json: {version: 1, " +
          "exported, events}, events holding every event the page knows, those of events/ too, " +
          "de-duplicated and sorted. The prototype's import command reads only events, at most " +
          "10,000, checks all of them before it writes (action one of the four, id and task " +
          "[a-zA-Z0-9_-]{1,100}, at RFC 3339 with Z or an offset and up to nine fraction digits, " +
          "extra fields allowed), and refuses an event file it would change. The export carries " +
          "the times of events/ as written, so the importer reads them with the events grammar",
        eventWriters:
          "The page writes events/web-<lower-case UUID>.json, then the .ready file. Its JSON is " +
          "written compactly here with a millisecond UTC time (the fixture's choice). The " +
          "prototype's import command writes <id>.json as two-space JSON with a final newline, " +
          "and a .ready file only when the id starts with web-",
        reconcile:
          "reconcile writes a DONE line as the TODO line with its marker removed, '- [ ]' turned " +
          "into '- [x]', right-trimmed, then ' (done YYYY-MM-DD; <evidence>) <!-- task:<id> -->'. " +
          "New lines go after the first line of DONE.md, separated by blank lines",
        optionalFiles:
          "data/metadata.json: one object keyed by task ID (missing: {}); an entry that is no " +
          "object is ignored. The page keeps due only when it starts with YYYY-MM-DD, keeps the " +
          "sources whose url is text, shows each path once, sorts rank 0 last with the tasks " +
          "without a rank, defaults a missing owner to a fixed first name in its code, and files a " +
          "task without a category under Small todos. data/jira.json: a list " +
          "of ticket rows (missing: []); a row without key is skipped, key and url (path " +
          "/browse/<KEY>) are read, other fields are free. data/audit.json: one free-form object " +
          "(missing: {}) with a scalar reviewed time and nested objects or lists the page only " +
          "displays",
        hosts: "Every URL host is a reserved example domain (RFC 2606)",
      },
      me: PLANNING.me,
      roots: { ...PLANNING.roots },
      spaceTask: {
        seed: DEFAULT_SEED,
        tasks: DEFAULT_TASKS,
        ref: "M-1",
        title: "Fix appointment time zones",
        key: "jira:LUM-1000",
      },
      counts: {
        todoTaskLines: todo,
        doneTaskLines: done,
        taskLines: b.tasks.length,
        metadataEntries: b.metadata.size,
        metadataOrphans: b.orphans,
        taskLinesWithoutMetadata: b.tasks.filter((t) => !t.metadata).length,
        eventFiles: b.eventFiles,
        readyFiles: b.readyFiles,
        countedEventFiles: b.countedEventFiles,
        eventsNotReady: b.notReady,
      },
      actions: {
        file: `fixtures/${PLANNING.actions}`,
        events: exported.length,
        added: [...notReadyIds, browserOnly.id].sort(),
      },
      tasks: b.tasks,
      cases,
    },
  };
}

/** The index file's text. */
export const serializeIndex = (index: PlanningIndex): string =>
  `${JSON.stringify(index, null, 2)}\n`;

/** A SHA-256 over every path and its bytes, in path order: one line for the seed output. */
export function digestPlanningFixture(fixture: PlanningFixture): string {
  const hash = createHash("sha256");
  for (const [path, text] of fixture.files) {
    hash.update(`${path}\0${String(Buffer.byteLength(text, "utf8"))}\0`);
    hash.update(text, "utf8");
  }
  hash.update(fixture.actions, "utf8");
  hash.update(serializeIndex(fixture.index), "utf8");
  return hash.digest("hex");
}
