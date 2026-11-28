// What a phone may call and what it is told. The calls are the ones the first app's five screens
// use (Today and a task, capture, check off and reopen, a page, a run watched, and Run and Stop
// behind their switch), each with the fields a phone may send. Everything a phone is told, a
// call's answer or error and every row of its feed, is built here from a spec of the fields it may
// see: a field not named in a spec never reaches a phone, and a field that names who wrote
// something is an `author`, which a phone sees as the person, an import, or the agent app's name,
// never the agent's instance key on this computer or its session. The desktop's handlers answer
// with more (the folder a task opens in, the instances here, the person's skills, a backup's
// name); none of that is a phone's.
import { AppError, patterns, type ErrorBody, type ErrorCode } from "@ttasks/contracts";

/** What a field of an answer is to a phone. */
export type Spec =
  /** A value of the space's own, passed as it is. */
  | "keep"
  /** Who wrote something: the person, an import, or an agent app's name. */
  | "author"
  /** A list, each item by the spec. */
  | readonly [Spec]
  /** A record of exactly these fields. */
  | { readonly [field: string]: Spec };

/** How a phone names who wrote something, from the label the change was written under. */
export type Authors = (label: string) => string;

/**
 * The person (`user`), an import, or an agent app's name, from an actor's label (`user`,
 * `import`, `agent:<instance>` or `agent:<instance>:<session>`) and this space's instances.
 * Anything else is `agent`.
 */
export function authorsFrom(
  instances: readonly { readonly key: string; readonly app: string }[],
): Authors {
  return (label) => {
    if (label === "user" || label === "import") return label;
    const key = label.startsWith("agent:") ? (label.split(":")[1] ?? "") : label;
    return instances.find((i) => i.key === key)?.app ?? "agent";
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` as `spec` lets a phone see it. */
export function project(value: unknown, spec: Spec, authors: Authors): unknown {
  if (value === undefined || value === null) return value;
  if (spec === "keep") return value;
  if (spec === "author") return typeof value === "string" ? authors(value) : undefined;
  if (Array.isArray(spec)) {
    const item = (spec as readonly [Spec])[0];
    return Array.isArray(value) ? value.map((v) => project(v, item, authors)) : undefined;
  }
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, sub] of Object.entries(spec as Record<string, Spec>)) {
    const projected = project(value[field], sub, authors);
    if (projected !== undefined) out[field] = projected;
  }
  return out;
}

const keep = (...fields: string[]): Record<string, Spec> =>
  Object.fromEntries(fields.map((f) => [f, "keep"]));

const BY: Spec = { ...keep("at", "change"), by: "author" };
const NOTE: Spec = {
  ...keep("ref", "for_agents", "at", "text", "cut", "slice"),
  author: "author",
  edited: BY,
  removed: BY,
};
const LOG: Spec = {
  ...keep("ref", "kind", "at", "text", "cut", "slice"),
  author: "author",
  edited: BY,
};
const SOURCE: Spec = keep("id", "key", "kind", "title", "who", "url", "at", "ref", "cut");
const TASK: Spec = {
  ...keep(
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
  ),
  deleted: BY,
  instructions: [NOTE],
  notes: [NOTE],
  log: [LOG],
  sources: [SOURCE],
};
const TASK_GET: Spec = {
  ...keep("view", "as_of", "before"),
  task: TASK,
  sections: {
    ...keep("context", "context_slice"),
    instructions: [NOTE],
    notes: [NOTE],
    log: [LOG],
    sources: [SOURCE],
    outcome: keep("outcome", "wrap_state", "learnings", "slice"),
    history: [{ ...keep("seq", "what"), actor: "author" }],
  },
  notes: [NOTE],
  removed_notes: [NOTE],
};
const RUN: Spec = keep(
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
);

/** A task's row in a phone's feed: its own fields, never where it opens or its last agents. */
export const FEED_TASK: Spec = {
  ...keep(
    "id",
    "ref",
    "title",
    "summary",
    "lifecycle",
    "status",
    "inbox",
    "priority",
    "effort",
    "due_date",
    "due_at",
    "due_tz",
    "planned_for",
    "focus_on",
    "owner",
    "waiting_on",
    "parent",
    "position",
    "wrap_state",
    "completed_at",
    "deleted_at",
    "created_at",
    "finished_at",
    "waiting_since",
    "version",
    "touched",
    "sources_more",
    "ending",
    "questions_more",
  ),
  sources: [keep("id", "kind", "title", "who", "ref", "url")],
  run: keep("id", "state"),
  questions: [{ ...keep("ref", "text", "at"), by: "author" }],
};
/** A node of the space's tree in a phone's feed: the space or a project, as the page gets it. */
export const FEED_NODE: Spec = keep(
  "id",
  "kind",
  "parent",
  "title",
  "position",
  "color",
  "state",
  "deleted_at",
);

/** Which of a phone's rights a call needs. */
export type PhoneRight = "edit" | "run";

export interface PhoneCall {
  readonly right: PhoneRight;
  /** The fields of the body a phone may send. */
  readonly input: readonly string[];
  /** Checks the body beyond its field names; a text names the field refused. */
  readonly check?: (body: Record<string, unknown>) => string | undefined;
  /** What a phone may see of the answer. */
  readonly output: Spec;
}

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

const WRITE = keep("as_of", "replayed");

export const PHONE_CALLS: Readonly<Record<string, PhoneCall>> = {
  "/api/v1/op/task.get": {
    right: "edit",
    input: ["task", "sections", "log_limit", "before", "notes"],
    output: TASK_GET,
  },
  "/api/v1/op/task.add": {
    right: "edit",
    input: ["tasks", "request_id"],
    check: drafts,
    output: { ...WRITE, tasks: [keep("result", "id", "ref", "title", "project", "lifecycle")] },
  },
  "/api/v1/op/task.finish": {
    right: "edit",
    input: ["task", "status", "outcome", "base", "request_id"],
    output: { ...WRITE, ...keep("result", "task", "lifecycle", "wrap_state") },
  },
  "/api/v1/op/task.reopen": {
    right: "edit",
    input: ["task", "base", "request_id"],
    output: { ...WRITE, ...keep("task", "lifecycle") },
  },
  "/api/v1/op/page.read": {
    right: "edit",
    input: ["target", "section", "cursor"],
    // A page only: a project's or the space's view lists what lies around it, for agents.
    check: (body) =>
      typeof body["target"] === "string" && patterns.taskRef.test(body["target"])
        ? undefined
        : "target",
    output: {
      ...keep("view", "as_of", "id", "ref", "title", "brief", "version", "body", "slice"),
      ...keep("section", "headings", "cursor"),
      owner: keep("kind", "id", "title"),
      last: { ...keep("at", "why"), by: "author" },
    },
  },
  "/api/v1/launch/runs": { right: "edit", input: ["task"], output: { runs: [RUN] } },
  "/api/v1/launch/run": {
    right: "run",
    input: ["task", "text", "request_id"],
    output: { run: RUN },
  },
  "/api/v1/launch/stop": { right: "run", input: ["run"], output: { run: RUN } },
};

/** Refusals of the link's own, whose words and rule a phone may see. */
const OWN = new WeakSet<AppError>();

/** An error of the link's own: its message and its `rule` and `field` reach the phone. */
export function phoneRefusal(
  code: ErrorCode,
  message: string,
  data: { readonly rule?: string; readonly field?: string; readonly retryable?: boolean } = {},
): AppError {
  const error = new AppError({ code, message, data });
  OWN.add(error);
  return error;
}

/** What a phone is told of an error the computer's handlers raised: its kind, in fixed words. */
const WORDS: Partial<Record<ErrorCode, string>> = {
  invalid_input: "The computer could not take this request.",
  not_found: "This is not on the computer.",
  conflict: "This changed on the computer meanwhile. Look again, then try once more.",
  applied_earlier: "This changed on the computer meanwhile. Look again, then try once more.",
  forbidden: "The computer refused this.",
  too_large: "This is too long.",
  read_only: "This space takes no change on the computer now.",
  space_unavailable: "This space is not open on the computer now.",
  service_unavailable: "The computer cannot do this now. Try again later.",
};

/**
 * Every error a phone is told: the code, and the message and data only of the link's own
 * refusals. A handler's message and data may name a folder, a machine, the instances here or a
 * backup, so a phone gets fixed words for its code instead.
 */
export function phoneError(error: unknown): ErrorBody {
  if (!(error instanceof AppError)) {
    return { code: "internal", message: "The computer failed to do this." };
  }
  const body = error.toBody();
  if (OWN.has(error)) {
    const data = body.data ?? {};
    return {
      code: body.code,
      message: body.message,
      data: Object.fromEntries(
        ["rule", "field", "retryable"].flatMap((k) =>
          data[k] === undefined ? [] : [[k, data[k]]],
        ),
      ),
    };
  }
  const retryable = body.data?.["retryable"];
  return {
    code: body.code,
    message: WORDS[body.code] ?? "The computer could not do this.",
    ...(typeof retryable === "boolean" ? { data: { retryable } } : {}),
  };
}
