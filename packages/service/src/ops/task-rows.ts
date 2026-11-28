// A task's compact row: the form the change feed carries and the page's lists draw (A5 3.6,
// 3.15), and the read of finished tasks behind the page's Completed view, which gives the same
// rows and one line of how each task ended. A column that is null in the space is left out. No
// context, outcome or other long text is in it: only what a row shows of the task's children,
// its first three sources, where it opens on the machine that serves it, whether a background run
// works or waits for the person's answer, and the start of each question agents asked that waits
// for the person, logged or a run's last words.
import {
  isOpenRun,
  RECORDED,
  type LastUsed,
  type RowRunState,
  type RunState,
} from "@ttasks/contracts/runs";
import {
  decideLaunchFolder,
  FINISHED_AT_SQL,
  type FolderView,
  type Id,
  OPEN_RUN,
  READ_ONLY_COPY,
  RUN_WAITS,
  runAsked,
  WAITS,
  type Row,
  type WorkerConnection,
} from "@ttasks/storage";
import { folderState } from "./folders.ts";
import { hasFolderTable } from "./read.ts";

const PREFIX_SQL = "SELECT ref_prefix FROM space WHERE one = 1";

/** A source as a task's row shows it: its kind and its own text, never a label (A5 3.6). */
export interface CompactSource {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly who?: string;
  /** The source's own key in its system ("LUM-212"), shown in mono. */
  readonly ref?: string;
  readonly url?: string;
}

/**
 * Where a task opens, as its row shows it on the machine that serves the feed (storage's
 * `decideLaunchFolder`): its own folder or its project's here, there now or missing, or another
 * machine, named. A task that opens in the space's work folder has none.
 */
export type CompactPlace =
  | { readonly state: "here" | "missing" }
  | { readonly state: "elsewhere"; readonly machine: string };

/**
 * The task's background run as its row shows it: the newest that works (queued, running, stopping,
 * or not confirmed ended), or, in a restored copy that is not claimed, worked when the backup was
 * made (`recorded`); else the newest that ended asking the person something still unanswered
 * (`RUN_WAITS`). Absent otherwise.
 */
export interface CompactRun {
  /** The run's ID: the Agents page pairs it with the agent the Agent Monitor sees for it. */
  readonly id: string;
  readonly state: RowRunState;
  /** The run's agent instance: machine.toml's key. */
  readonly instance: string;
}

/** A question an agent asked on the task that waits for the person (`WAITS`, `RUN_WAITS`). */
export interface CompactQuestion {
  /** The log entry, such as `l3`, or the run that ended with it. */
  readonly ref: string;
  /** The agent's label; a run's instance key, which the page names by `instance`. */
  readonly by: string;
  /** A run's instance key: machine.toml's. */
  readonly instance?: string;
  /** Its first `QUESTION_CHARS` characters. */
  readonly text: string;
  readonly at: number;
}

export type CompactValue =
  | string
  | number
  | boolean
  | readonly CompactSource[]
  | CompactPlace
  | CompactRun
  | LastUsed
  | readonly CompactQuestion[];
export type CompactRow = Readonly<Record<string, CompactValue>>;

/** The machine the feed looks at folders on: its ID, the person's home there, its platform. */
export interface FeedHere {
  readonly machine: string;
  readonly home: string | undefined;
  readonly platform: NodeJS.Platform;
}

/** At most this many sources ride on a task's row: the row shows three, then "+2" (A5 3.6). */
export const ROW_SOURCES = 3;

/** An owner's live folders as JSON, newest first, with their machine's name. */
const foldersOf = (kind: "task" | "project", owner: string): string =>
  "(SELECT json_group_array(json_object('id', x.id, 'machine', x.machine_id, 'name', x.name, " +
  "'path', x.path, 'version', x.version)) FROM (SELECT f.id, f.machine_id, m.name, f.path, " +
  "f.version FROM folders f JOIN machines m ON m.id = f.machine_id WHERE " +
  `f.owner_kind = '${kind}' AND f.owner_id = ${owner} AND f.deleted_at IS NULL ` +
  "ORDER BY f.created_seq DESC, f.id) x)";

/** How much of a waiting question a row carries: the thread has the rest. */
export const QUESTION_CHARS = 300;
/** At most this many waiting questions ride on a task's row, newest first; it counts the rest. */
export const ROW_QUESTIONS = 10;

const CUT = String(QUESTION_CHARS + 1);

/**
 * The task's waiting questions as JSON, newest first, and how many there are: those logged, and,
 * where the space has runs, each run's last words while its question waits.
 */
function waitingQuestions(runs: boolean): string {
  const logged =
    "SELECT q.created_seq AS seq, q.ordinal AS o, 'l' || q.ordinal AS ref, (SELECT label FROM " +
    `actors WHERE id = q.author_id) AS label, NULL AS instance, substr(q.body, 1, ${CUT}) AS text, ` +
    `q.created_at AS at FROM log_entries q WHERE ${WAITS}`;
  const asked =
    `SELECT ${runAsked("r")} AS seq, 0 AS o, r.id AS ref, r.instance_id AS label, r.instance_id ` +
    `AS instance, substr(COALESCE(json_extract(r.result, '$.text'), ''), 1, ${CUT}) AS text, ` +
    `COALESCE(r.ended_at, r.queued_at) AS at FROM runs r WHERE ${RUN_WAITS}`;
  const all = runs ? `${logged} UNION ALL ${asked}` : logged;
  return (
    "(SELECT json_group_array(json_object('seq', x.seq, 'o', x.o, 'ref', x.ref, 'by', x.label, " +
    "'instance', x.instance, 'text', x.text, 'at', x.at)) FROM (SELECT * FROM (" +
    `${all}) ORDER BY seq DESC, o DESC LIMIT ${String(ROW_QUESTIONS)}) x) AS x_questions, ` +
    `((SELECT count(*) FROM log_entries q WHERE ${WAITS})` +
    `${runs ? ` + (SELECT count(*) FROM runs r WHERE ${RUN_WAITS})` : ""}) AS x_question_count`
  );
}

/** The space read is a restored copy that is not claimed: storage's restore mark. */
const RESTORED_COPY = `(SELECT json_extract(transfer, '$.state') FROM space WHERE one = 1) = '${READ_ONLY_COPY}'`;

/**
 * The task's newest run of those `where` admits, by `order` (queued last unless it says otherwise),
 * as JSON: its ID, state, reason and instance. In a restored copy that is not claimed an open run
 * is `recorded`: nothing of it runs now.
 */
const newestRun = (where: string, order = "r.queued_at DESC, r.id DESC") =>
  "(SELECT json_object('id', r.id, 'state', " +
  `CASE WHEN ${OPEN_RUN} AND ${RESTORED_COPY} THEN '${RECORDED}' ELSE r.state END, ` +
  "'reason', r.reason, 'instance', r.instance_id) " +
  `FROM runs r WHERE r.task_id = t.id${where} ORDER BY ${order} LIMIT 1)`;

/**
 * The instances the task was last opened in and last ran with: what its Open and Run use. A copy of
 * the brief opens no agent, and a refused Open is not the person's choice of agent.
 */
const LAST_OPEN =
  "FROM launches l WHERE l.task_id = t.id AND l.route <> 'clipboard' AND l.state <> 'failed' " +
  "ORDER BY l.created_at DESC, l.id DESC LIMIT 1";
const LAST_USED =
  `json_object('open', (SELECT l.instance_id ${LAST_OPEN}), ` +
  "'run', (SELECT r.instance_id FROM runs r WHERE r.task_id = t.id " +
  "ORDER BY r.queued_at DESC, r.id DESC LIMIT 1)) AS x_last";

/**
 * The node a task `t` sits under in the tree, from today's columns: its project, else its area,
 * else the space. Part of the feed's adapter (http/feed.ts), until the tree is the space's own.
 */
export const PARENT_OF_TASK =
  "COALESCE(t.project_id, t.area_id, (SELECT space_id FROM space WHERE one = 1))";

/**
 * A task row's columns. `folders`: the space has the folders and runs tables (schema 0.5 on); a
 * space served read-only at an older revision may have neither, and its rows show no folder and
 * no run.
 */
export function taskColumns(folders: boolean): string {
  return (
    "t.id, t.ref, t.title, t.summary, t.lifecycle, t.status, t.inbox, t.priority, t.effort, " +
    "t.due_date, t.due_at, t.due_tz, t.planned_for, t.focus_on, t.owner, t.waiting_on, " +
    `${PARENT_OF_TASK} AS parent, t.position, t.wrap_state, t.completed_at, t.deleted_at, ` +
    "t.created_at, t.version, t.touched, " +
    `CASE WHEN t.lifecycle <> 'active' THEN ${FINISHED_AT_SQL} END AS finished_at, ` +
    // When a waiting task's wait began (the Waiting view's age): the commit whose write its status
    // holds, or its creation. An undo writes the status back as a write of its own: the wait it
    // brings back began where the status it undid had come from. A new person waited on is the
    // same wait.
    "CASE WHEN t.status = 'waiting' THEN COALESCE((SELECT CASE WHEN c.kind = 'undo' THEN " +
    "(SELECT w.at FROM changes u JOIN commits w ON w.seq = u.before_prov WHERE u.seq = c.undo_of " +
    "AND u.entity = 'tasks' AND u.entity_id = t.id AND u.field = 'status' " +
    "AND w.seq <> t.created_seq) ELSE c.at END FROM commits c " +
    "WHERE c.seq = json_extract(t.fp, '$.status') AND c.seq <> t.created_seq), t.created_at) " +
    "END AS waiting_since, " +
    // What the row shows of the task's children (A5 3.6), turned into `sources`, `sources_more`
    // and `place` by `taskRows`.
    "(SELECT json_group_array(json_object('p', x.position, 'id', x.id, 'kind', x.kind, " +
    "'title', x.title, 'who', x.who, 'ref', x.ref, 'key', x.source_key, 'url', x.url)) FROM " +
    "(SELECT ts.position, s.id, s.kind, s.title, s.who, s.ref, s.source_key, s.url FROM " +
    "task_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.task_id = t.id " +
    `AND ts.removed_at IS NULL AND s.deleted_at IS NULL ORDER BY ts.position LIMIT ${String(ROW_SOURCES)}) x) ` +
    "AS x_sources, " +
    "(SELECT count(*) FROM task_sources ts JOIN sources s ON s.id = ts.source_id WHERE " +
    "ts.task_id = t.id AND ts.removed_at IS NULL AND s.deleted_at IS NULL) AS x_source_count, " +
    waitingQuestions(folders) +
    (folders
      ? `, ${foldersOf("task", "t.id")} AS x_folders_own, ` +
        `${foldersOf("project", "t.project_id")} AS x_folders_project, ` +
        `${newestRun(` AND ${OPEN_RUN}`)} AS x_run_open, ` +
        `${newestRun(` AND ${RUN_WAITS}`, `${runAsked("r")} DESC`)} AS x_run_asks, ` +
        LAST_USED
      : "")
  );
}

/** A row without its nulls, booleans as booleans. */
export function compact(row: Row, booleans: readonly string[] = []): CompactRow {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (booleans.includes(name)) out[name] = value === 1 || value === true;
    else if (typeof value === "string" || typeof value === "number") out[name] = value;
    else if (typeof value === "bigint") out[name] = Number(value);
  }
  return out;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** The kinds whose key names the item in its own system, shown before the title: LUM-212. */
const KEYED_KINDS: ReadonlySet<string> = new Set(["ticket", "issue", "pr"]);

/**
 * A ticket's, issue's or pull request's own key from its source key (`jira:LUM-212` gives
 * `LUM-212`), when the source records none: a short single line after the namespace, else none.
 */
function keyRef(kind: unknown, key: unknown): string | undefined {
  if (typeof kind !== "string" || !KEYED_KINDS.has(kind) || typeof key !== "string") {
    return undefined;
  }
  const at = key.indexOf(":");
  const ref = at < 0 ? "" : key.slice(at + 1);
  return ref !== "" && ref.length <= 40 && !/\s/u.test(ref) ? ref : undefined;
}

/** The row's sources from `x_sources`, in their order, each without its empty fields. */
function sourcesOf(value: unknown): CompactSource[] {
  const list = parsed(value);
  if (!Array.isArray(list)) return [];
  const sorted = list
    .filter(isPlain)
    .sort((a, b) =>
      String(a["p"]) < String(b["p"]) ? -1 : String(a["p"]) > String(b["p"]) ? 1 : 0,
    );
  const out: CompactSource[] = [];
  for (const s of sorted) {
    if (
      typeof s["id"] !== "string" ||
      typeof s["kind"] !== "string" ||
      typeof s["title"] !== "string"
    ) {
      continue;
    }
    const source: { -readonly [K in keyof CompactSource]: CompactSource[K] } = {
      id: s["id"],
      kind: s["kind"],
      title: s["title"],
    };
    for (const key of ["who", "ref", "url"] as const) {
      const v = s[key];
      if (typeof v === "string" && v !== "") source[key] = v;
    }
    const ref = source.ref ?? keyRef(s["kind"], s["key"]);
    if (ref !== undefined) source.ref = ref;
    out.push(source);
  }
  return out;
}

/** A run of `x_run_open` or `x_run_asks` as the row shows it on its own, or nothing. */
function rowRun(value: unknown): CompactRun | undefined {
  const run = parsed(value);
  if (!isPlain(run) || typeof run["instance"] !== "string" || typeof run["id"] !== "string") {
    return undefined;
  }
  const { id, state, reason, instance } = run;
  if (state === RECORDED) return { id, state: RECORDED, instance };
  if (
    typeof state === "string" &&
    isOpenRun({ state: state as RunState, reason: typeof reason === "string" ? reason : null })
  ) {
    return { id, state: "working", instance };
  }
  if (state === "failed" && reason === "needs_input") return { id, state: "needs_you", instance };
  return undefined;
}

/**
 * What the row shows of a task's runs: the newest that may still hold processes, else the newest
 * whose question waits for the person. That question is among the row's questions too, so a run
 * that works never hides it.
 */
export function runOf(open: unknown, asks?: unknown): CompactRun | undefined {
  return rowRun(open) ?? rowRun(asks);
}

/** `x_last` as the row's `last`, or nothing when the task was never opened in an agent or run. */
function lastOf(value: unknown): LastUsed | undefined {
  const used = parsed(value);
  if (!isPlain(used)) return undefined;
  const { open, run } = used;
  if (typeof open !== "string" && typeof run !== "string") return undefined;
  return {
    ...(typeof open === "string" ? { open } : {}),
    ...(typeof run === "string" ? { run } : {}),
  };
}

/** A question's start, at most `QUESTION_CHARS` UTF-16 units, cut between graphemes. */
function cutQuestion(text: string): string {
  if (text.length <= QUESTION_CHARS) return text;
  let cut = "";
  for (const { segment } of graphemes.segment(text)) {
    if (cut.length + segment.length > QUESTION_CHARS - 1) break;
    cut += segment;
  }
  return `${cut}…`;
}

/** The waiting questions of `x_questions`, newest first. */
function questionsOf(value: unknown): CompactQuestion[] {
  const list = parsed(value);
  if (!Array.isArray(list)) return [];
  return list
    .filter(isPlain)
    .sort((a, b) => Number(b["seq"]) - Number(a["seq"]) || Number(b["o"]) - Number(a["o"]))
    .flatMap(({ ref, by, instance, text, at }) =>
      typeof ref === "string" &&
      typeof by === "string" &&
      typeof text === "string" &&
      typeof at === "number"
        ? [
            {
              ref,
              by,
              ...(typeof instance === "string" ? { instance } : {}),
              text: cutQuestion(text),
              at,
            },
          ]
        : [],
    );
}

/** The folders of `x_folders_own` or `x_folders_project`, newest first, with machine names. */
function foldersFrom(value: unknown, names: Map<string, string>): FolderView[] {
  const list = parsed(value);
  if (!Array.isArray(list)) return [];
  const out: FolderView[] = [];
  for (const f of list.filter(isPlain)) {
    const { id, machine, name, path, version } = f;
    if (typeof machine !== "string" || typeof path !== "string") continue;
    if (typeof name === "string") names.set(machine, name);
    out.push({
      id: String(id) as Id<"fo">,
      machine: machine as Id<"m">,
      path,
      version: Number(version),
    });
  }
  return out;
}

/**
 * The tasks' compact rows, with what each row shows of its children: its first sources, how many
 * more, and where it opens on `here`'s machine (`decideLaunchFolder`, the launch's rule), each
 * folder looked at once now. Without `here`, none is shown.
 */
export async function taskRows(
  rows: readonly Row[],
  prefix: string,
  here?: FeedHere,
): Promise<CompactRow[]> {
  const states = new Map<string, Promise<"here" | "missing">>();
  const stateOf = (stored: string): Promise<"here" | "missing"> => {
    let found = states.get(stored);
    if (found === undefined) {
      found =
        here === undefined
          ? Promise.resolve("missing")
          : folderState(stored, here.home, here.platform).catch(() => "missing" as const);
      states.set(stored, found);
    }
    return found;
  };
  return Promise.all(
    rows.map(async (row) => {
      const {
        x_sources: sources,
        x_source_count: count,
        x_folders_own: ownFolders,
        x_folders_project: projectFolders,
        x_run_open: open,
        x_run_asks: asks,
        x_last: used,
        x_questions: asked,
        x_question_count: askedCount,
        x_reason: reason,
        x_outcome: outcome,
        ref,
        ...own
      } = row;
      const out: Record<string, CompactValue> = compact(
        { ...own, ref: typeof ref === "number" ? `${prefix}-${String(ref)}` : ref },
        ["inbox"],
      );
      const shown = sourcesOf(sources);
      if (shown.length > 0) out["sources"] = shown;
      const more = Number(count ?? 0) - shown.length;
      if (more > 0) out["sources_more"] = more;
      const ended = endingOf(
        endingText({
          lifecycle: own["lifecycle"],
          wrap_state: own["wrap_state"],
          archived_reason: reason,
          outcome,
        }),
      );
      if (ended !== undefined) out["ending"] = ended;
      const run = runOf(open, asks);
      if (run !== undefined) out["run"] = run;
      const last = lastOf(used);
      if (last !== undefined) out["last"] = last;
      const questions = questionsOf(asked);
      if (questions.length > 0) out["questions"] = questions;
      const unshown = Number(askedCount ?? 0) - questions.length;
      if (unshown > 0) out["questions_more"] = unshown;
      if (here !== undefined) {
        const names = new Map<string, string>();
        const decided = decideLaunchFolder(
          foldersFrom(ownFolders, names),
          foldersFrom(projectFolders, names),
          here.machine,
          (id) => names.get(id),
        );
        if (decided.kind === "task" || decided.kind === "project") {
          out["place"] = { state: await stateOf(decided.folder.path) };
        } else if (decided.kind === "other_machine") {
          out["place"] = { state: "elsewhere", machine: decided.machine.name };
        }
      }
      return out;
    }),
  );
}

/** A page of finished tasks: which of them, how many, and the last row of the page before. */
export interface FinishedRequest {
  /** Only the checked-off list (true), every other finished task (false), or all of them. */
  readonly checkedOff?: boolean | undefined;
  readonly limit: number;
  readonly after?: { readonly at: number; readonly id: string } | undefined;
}

const CHECKED_OFF = "(t.lifecycle = 'completed' AND t.wrap_state IS 'pending')";

/** What `endingOf` reads of a finished task: only their start, since a row shows one line. */
const ENDING_COLUMNS =
  "substr(t.archived_reason, 1, 2000) AS x_reason, substr(t.outcome, 1, 2000) AS x_outcome";

/**
 * The text a finished task's row says it ended with: why it was dropped, else its outcome once it
 * is wrapped up. A reopen keeps the outcome as the previous result and clears the wrap state, so an
 * outcome without one is an earlier finish's, not this one's. An active task has none.
 */
export function endingText(task: Readonly<Record<string, unknown>>): string | undefined {
  const { lifecycle, wrap_state: wrap, archived_reason: reason, outcome } = task;
  if (lifecycle !== "completed" && lifecycle !== "archived") return undefined;
  if (lifecycle === "archived" && typeof reason === "string" && reason.trim() !== "") {
    return reason;
  }
  return wrap === "wrapped" && typeof outcome === "string" ? outcome : undefined;
}

/** The most UTF-16 code units of an ending a row carries, its ellipsis included. */
export const ENDING_MAX = 300;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The ending's first line with text, without a Markdown heading, list or quote mark, cut to
 * `ENDING_MAX` with an ellipsis between two characters, never inside one.
 */
export function endingOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)?/u, "").trim();
    if (line === "") continue;
    if (line.length <= ENDING_MAX) return line;
    let cut = "";
    for (const { segment } of graphemes.segment(line)) {
      if (cut.length + segment.length > ENDING_MAX - 1) break;
      cut += segment;
    }
    return `${cut.trimEnd()}…`;
  }
  return undefined;
}

/**
 * Finished tasks newest first, from a key. The page's keys are chosen first and the rows built
 * only for them: a row's sources and place cost a read each, and a space finishes tasks for years.
 */
function finishedSql(request: FinishedRequest, folders: boolean): string {
  const where = ["t.lifecycle IN ('completed', 'archived')", "t.deleted_at IS NULL"];
  if (request.checkedOff === true) where.push(CHECKED_OFF);
  if (request.checkedOff === false) where.push(`NOT ${CHECKED_OFF}`);
  const from = request.after === undefined ? "" : "WHERE k.at < $at OR (k.at = $at AND k.id < $id)";
  return (
    `SELECT ${taskColumns(folders)}, ${ENDING_COLUMNS} FROM (SELECT k.id, k.at FROM (SELECT ` +
    `t.id AS id, ${FINISHED_AT_SQL} AS at FROM tasks t WHERE ${where.join(" AND ")}) k ${from} ORDER BY k.at DESC, k.id DESC ` +
    "LIMIT $limit) p JOIN tasks t ON t.id = p.id ORDER BY p.at DESC, p.id DESC"
  );
}

/**
 * A page of the space's finished tasks (completed or dropped, not deleted), newest first by the
 * time each was finished, then by ID: up to `limit` compact rows, and whether more follow.
 */
export async function readFinished(
  reader: WorkerConnection,
  request: FinishedRequest,
  here?: FeedHere,
): Promise<{ rows: CompactRow[]; more: boolean }> {
  const folders = await hasFolderTable(reader);
  const [space, rows] = await reader.transaction("deferred", [
    { sql: PREFIX_SQL, mode: "get" },
    {
      sql: finishedSql(request, folders),
      mode: "all",
      params: {
        limit: request.limit + 1,
        ...(request.after === undefined ? {} : { at: request.after.at, id: request.after.id }),
      },
    },
  ]);
  const found = rows as Row[];
  const prefix = (space as Row | null)?.["ref_prefix"];
  const page = await taskRows(
    found.slice(0, request.limit),
    typeof prefix === "string" ? prefix : "",
    here,
  );
  return { rows: page, more: found.length > request.limit };
}
