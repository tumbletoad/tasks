// What a phone may call: the calls the first app's five screens use (Today and a task, capture,
// check off and reopen, a page, a run watched, and Run and Stop behind their switch), each with the
// fields a phone may send and the fields it may see. The desktop's handlers answer with what a
// person at this computer may see: the folder a task opens in, the agent app a run uses, the
// person's skills. None of that is a phone's, so an answer reaches a phone only through its list
// here, and a call or a field not named here is refused, whatever the entry's `remote` class
// says, until a screen of the app needs it.
import { patterns } from "@ttasks/contracts";

/** Which of a phone's rights a call needs. */
export type PhoneRight = "edit" | "run";

export interface PhoneCall {
  readonly right: PhoneRight;
  /** The fields of the body a phone may send. */
  readonly input: readonly string[];
  /** Checks the body beyond its field names; a text is the refusal's reason. */
  readonly check?: (body: Record<string, unknown>) => string | undefined;
  /** The answer as a phone sees it. */
  readonly output: (result: unknown) => unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A record with only the named fields; anything that is no record is left out. */
function pick(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (value[field] !== undefined) out[field] = value[field];
  return out;
}

const list = (value: unknown, each: (item: unknown) => unknown): unknown[] | undefined =>
  Array.isArray(value) ? value.map(each) : undefined;

/** Fields set only when present. */
function some(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const NOTE = ["ref", "author", "for_agents", "at", "text", "edited", "cut", "slice", "removed"];
const LOG = ["ref", "kind", "author", "at", "text", "edited", "cut", "slice"];
const SOURCE = ["id", "key", "kind", "title", "who", "url", "at", "ref", "cut"];
const TASK = [
  "id",
  "ref",
  "title",
  "lifecycle",
  "status",
  "inbox",
  "priority",
  "effort",
  "due",
  "area",
  "project",
  "deleted",
  "summary",
  "context",
  "waiting_on",
  "focus",
  "created",
  "wrap_state",
  "outcome",
  "learnings",
  "more",
  "cut",
  "version",
];

const note = (n: unknown) => pick(n, NOTE);
const log = (l: unknown) => pick(l, LOG);
const source = (s: unknown) => pick(s, SOURCE);

/** A task as a phone sees it: its own texts and notes, never where it opens on this machine. */
function task(value: unknown): unknown {
  const picked = pick(value, TASK);
  if (picked === undefined || !isRecord(value)) return picked;
  return some({
    ...picked,
    instructions: list(value["instructions"], note),
    notes: list(value["notes"], note),
    log: list(value["log"], log),
    sources: list(value["sources"], source),
  });
}

function sections(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return some({
    instructions: list(value["instructions"], note),
    context: value["context"],
    context_slice: value["context_slice"],
    notes: list(value["notes"], note),
    log: list(value["log"], log),
    sources: list(value["sources"], source),
    outcome: pick(value["outcome"], ["outcome", "wrap_state", "learnings", "slice"]),
    history: value["history"],
  });
}

/** `task.get` without the launch's request, the session's binding and the person's skills. */
function taskGet(result: unknown): unknown {
  if (!isRecord(result)) return undefined;
  return some({
    view: result["view"],
    as_of: result["as_of"],
    task: task(result["task"]),
    sections: sections(result["sections"]),
    before: result["before"],
    notes: list(result["notes"], note),
    removed_notes: list(result["removed_notes"], note),
  });
}

const WRITE = ["as_of", "replayed"];
const ADDED = ["result", "id", "ref", "title", "project", "lifecycle"];

/** The fields of a captured task a phone may send: never a folder, a source or a log. */
export const DRAFT_FIELDS = [
  "title",
  "summary",
  "context",
  "area",
  "project",
  "status",
  "inbox",
  "priority",
  "effort",
  "due",
  "waiting_on",
  "focus",
];

function drafts(body: Record<string, unknown>): string | undefined {
  const tasks = body["tasks"];
  if (!Array.isArray(tasks)) return undefined;
  for (const draft of tasks) {
    if (!isRecord(draft)) continue;
    const extra = Object.keys(draft).find((k) => !DRAFT_FIELDS.includes(k));
    if (extra !== undefined) return `tasks[].${extra}`;
  }
  return undefined;
}

const RUN = [
  "id",
  "state",
  "reason",
  "waiting",
  "quiet_since",
  "queued_at",
  "started_at",
  "ended_at",
  "asked",
  "outcome",
  "answer",
  "answer_final",
  "answer_cut",
  "refused",
  "version",
];
/** A run as a phone sees it: never the agent app's key on this machine, or its cleanup. */
const run = (r: unknown) => pick(r, RUN);

const PAGE = [
  "view",
  "as_of",
  "id",
  "ref",
  "title",
  "brief",
  "owner",
  "last",
  "version",
  "body",
  "slice",
  "section",
  "headings",
  "cursor",
];

export const PHONE_CALLS: Readonly<Record<string, PhoneCall>> = {
  "/api/v1/op/task.get": {
    right: "edit",
    input: ["task", "sections", "log_limit", "before", "notes"],
    output: taskGet,
  },
  "/api/v1/op/task.add": {
    right: "edit",
    input: ["tasks", "request_id"],
    check: drafts,
    output: (r) =>
      some({
        ...pick(r, WRITE),
        tasks: list(isRecord(r) ? r["tasks"] : undefined, (t) => pick(t, ADDED)),
      }),
  },
  "/api/v1/op/task.finish": {
    right: "edit",
    input: ["task", "status", "outcome", "base", "request_id"],
    output: (r) => pick(r, ["result", "task", "lifecycle", "wrap_state", ...WRITE]),
  },
  "/api/v1/op/task.reopen": {
    right: "edit",
    input: ["task", "base", "request_id"],
    output: (r) => pick(r, ["task", "lifecycle", ...WRITE]),
  },
  "/api/v1/op/page.read": {
    right: "edit",
    input: ["target", "section", "cursor"],
    // A page only: a project's or the space's view lists what lies around it, for agents.
    check: (body) =>
      typeof body["target"] === "string" && patterns.taskRef.test(body["target"])
        ? undefined
        : "target",
    output: (r) => pick(r, PAGE),
  },
  "/api/v1/launch/runs": {
    right: "edit",
    input: ["task"],
    output: (r) => ({ runs: list(isRecord(r) ? r["runs"] : undefined, run) ?? [] }),
  },
  "/api/v1/launch/run": {
    right: "run",
    input: ["task", "text", "request_id"],
    output: (r) => ({ run: run(isRecord(r) ? r["run"] : undefined) }),
  },
  "/api/v1/launch/stop": {
    right: "run",
    input: ["run"],
    output: (r) => ({ run: run(isRecord(r) ? r["run"] : undefined) }),
  },
};
