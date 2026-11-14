// The ledger grammar of TODO.md and DONE.md (A7 3.15.2, Text to Clauses).
//
// The text is split as Python's str.splitlines() splits it, and each piece is matched on its own.
// A line starting `## ` sets the group to the rest of the line, stripped; before any heading the
// group is `Other`. A task line matches `^- \[([ xX])\] \*\*(.+?)\*\*\s*(.*)$` (with Python's `\s`).
// The title is the bold text with every trailing dot stripped. The first ID marker anywhere in the
// line, the title included, gives the ID; without one the ID is the fallback ID. The body is the
// text after the title with every marker removed, then stripped. Every task line of DONE.md is
// done whatever its box says; in TODO.md `x` or `X` is done.

import { fallbackId } from "./fallback-id.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { problem, type Problem } from "./problems.ts";
import { byteLength, decode, eachLine, isIsoDate, PY_SPACE, pyStrip, type Source } from "./text.ts";

export const LEDGER_FILES = ["TODO.md", "DONE.md"] as const;
export type LedgerFile = (typeof LEDGER_FILES)[number];

export const DEFAULT_GROUP = "Other";

/** `(added YYYY-MM-DD, <agent>)`. */
export interface AddedClause {
  /** The day, left out when it is no calendar date (`date-invalid`). */
  readonly date?: string;
  readonly agent: string;
}

/** DONE.md's `(done YYYY-MM-DD; <evidence>)`, as reconcile writes it at the end of the body. */
export interface DoneClause {
  /** The day, left out when it is no calendar date (`date-invalid`). */
  readonly date?: string;
  readonly evidence: string;
}

export interface LedgerTask {
  readonly id: string;
  readonly file: LedgerFile;
  /** 1-based, in the str.splitlines() split. */
  readonly line: number;
  readonly group: string;
  readonly title: string;
  /** The text after the title, every marker removed, stripped. Clauses stay in it. */
  readonly body: string;
  /** Whether the line holds an ID marker. Without one, `id` is the fallback ID. */
  readonly marked: boolean;
  /** Whether the box holds `x` or `X`. */
  readonly checked: boolean;
  /** Every DONE.md line, and a checked TODO.md line. */
  readonly done: boolean;
  readonly added?: AddedClause;
  /** DONE.md only. */
  readonly completion?: DoneClause;
  /** The body's `Next:` clause up to the end of its sentence, when there is one. */
  readonly next?: string;
}

export interface LedgerParse {
  readonly file: LedgerFile;
  readonly present: boolean;
  readonly tasks: LedgerTask[];
  readonly problems: Problem[];
}

const TASK_LINE = new RegExp(`^- \\[([ xX])\\] \\*\\*(.+?)\\*\\*[${PY_SPACE}]*(.*)$`);
const MARKER = /<!-- task:([a-z0-9_-]+) -->/;
const MARKERS = /<!-- task:[a-z0-9_-]+ -->/g;
const ADDED = /\(added (\d{4}-\d{2}-\d{2}), ([^()]*)\)/;
const DONE_OPEN = /\(done (\d{4}-\d{2}-\d{2}); /g;
// The clause ends at the first dot before whitespace or the end, or before an `(added` or `(done`
// clause. Each lookahead reads a fixed number of characters, so the match stays linear.
const NEXT = new RegExp(
  `(?:^|[${PY_SPACE}])Next:[${PY_SPACE}]?(.*?)` +
    `(?:\\.(?=[${PY_SPACE}]|$)|(?=[${PY_SPACE}]\\((?:added|done) \\d{4}-)|$)`,
);

/** Parses one ledger. A missing file gives no tasks and `file-missing`. */
export function parseLedger(
  file: LedgerFile,
  source: Source | undefined,
  overrides?: Partial<Limits>,
): LedgerParse {
  const limits = limitsWith(overrides);
  if (source === undefined) {
    return { file, present: false, tasks: [], problems: [problem("file-missing", { file })] };
  }
  if (byteLength(source) > limits.ledgerBytes) {
    return { file, present: true, tasks: [], problems: [problem("file-too-large", { file })] };
  }
  const { text, problems } = decode(source, file);
  const tasks: LedgerTask[] = [];
  let group = DEFAULT_GROUP;
  // Lines are taken one at a time: a ledger of millions of blank lines never becomes an array.
  let lineNo = 0;
  for (const { text: line } of eachLine(text)) {
    lineNo += 1;
    if (line.length > limits.lineLength) {
      problems.push(problem("line-too-long", { file, line: lineNo }));
      continue;
    }
    if (line.startsWith("## ")) {
      group = pyStrip(line.slice(3));
      continue;
    }
    const match = TASK_LINE.exec(line);
    if (match === null) continue;
    if (tasks.length >= limits.taskLines) {
      problems.push(problem("too-many-task-lines", { file, line: lineNo }));
      break;
    }
    tasks.push(taskFrom(file, lineNo, group, line, match, problems));
  }
  return { file, present: true, tasks, problems };
}

function taskFrom(
  file: LedgerFile,
  line: number,
  group: string,
  text: string,
  match: RegExpExecArray,
  problems: Problem[],
): LedgerTask {
  const title = stripDots(match[2] ?? "");
  const marker = MARKER.exec(text)?.[1];
  const id = marker ?? fallbackId(group, title);
  const body = pyStrip((match[3] ?? "").replace(MARKERS, ""));
  const checked = match[1] !== " ";
  const task: {
    -readonly [K in keyof LedgerTask]: LedgerTask[K];
  } = {
    id,
    file,
    line,
    group,
    title,
    body,
    marked: marker !== undefined,
    checked,
    done: file === "DONE.md" || checked,
  };

  const added = ADDED.exec(body);
  if (added !== null) {
    const date = added[1] ?? "";
    const agent = added[2] ?? "";
    if (isIsoDate(date)) task.added = { date, agent };
    else {
      task.added = { agent };
      problems.push(problem("date-invalid", { file, line, task: id, field: "added" }));
    }
  }

  if (file === "DONE.md") {
    const done = doneClause(body);
    if (done !== undefined) {
      if (isIsoDate(done.date)) task.completion = done;
      else {
        task.completion = { evidence: done.evidence };
        problems.push(problem("date-invalid", { file, line, task: id, field: "done" }));
      }
    }
  }

  const next = pyStrip(NEXT.exec(body)?.[1] ?? "");
  if (next !== "") task.next = next;
  return task;
}

/** Python's `rstrip(".")`, as a loop: `/\.+$/` is quadratic on a long run of inner dots. */
function stripDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === ".") end -= 1;
  return value.slice(0, end);
}

/**
 * The `(done YYYY-MM-DD; ` clause that closes the body. When the final `)` closes a `(`, it is
 * that opener, so a clause quoted inside the evidence stays evidence, and there is none when that
 * `(` opens another clause (`(done …; old) notes (kept)`). When the final `)` closes nothing
 * (evidence such as `works :)`), it is the last opener. Evidence with a stray `(` (`see (draft`)
 * therefore gives no completion; the body keeps the clause verbatim either way.
 */
function doneClause(body: string): { date: string; evidence: string } | undefined {
  if (!body.endsWith(")")) return undefined;
  const openers = [...body.matchAll(DONE_OPEN)];
  if (openers.length === 0) return undefined;
  const open = matchingOpen(body);
  // When the final `)` closes some other `(`, no done clause closes the body.
  const chosen = open === -1 ? openers[openers.length - 1] : openers.find((m) => m.index === open);
  if (chosen === undefined) return undefined;
  return { date: chosen[1] ?? "", evidence: body.slice(chosen.index + chosen[0].length, -1) };
}

/** The index of the `(` that the body's final `)` closes, or -1 when none does. */
function matchingOpen(body: string): number {
  let depth = 0;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const c = body.charAt(i);
    if (c === ")") depth += 1;
    else if (c === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
