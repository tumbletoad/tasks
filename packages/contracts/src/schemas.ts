// Shared field schemas for the entries (A3 3.4.1, A1 3.3, 3.5 and 3.7).
//
// Inputs carry the limits and SafeText, and leave the formats of references, `base`, paths and
// source keys to the handler, which resolves them anyway and answers `invalid_input` or
// `not_found` with a hint. Every pattern costs definition tokens in every tool that uses the field
// (A3 3.2.5). Descriptions are short for the same reason. Outputs keep their patterns.
//
// Every pattern carries the `u` flag, so Zod reads it by code point, as Ajv and JSON Schema do.
import { z } from "zod";
import { under, type Pairs } from "./define.ts";
import { EFFORT_KEY_MAX } from "./preferences.ts";
import { ROW_RUN_STATES } from "./runs.ts";
import { safeLine, safeText } from "./safe-text.ts";

/**
 * A1 3.7's limits: what the user may send through the UI, the CLI and the RPC methods. Schemas
 * count characters (code points). Where A1 gives a size in KiB, the schema allows that many
 * characters (64 KiB is 65,536), and the writer checks A1's size of the stored text (A1 3.7).
 * Fields A1 does not limit take A3 3.4's limit for both audiences.
 */
export const USER_LIMITS = {
  title: 300,
  summary: 400,
  context: 65_536,
  note: 65_536,
  log: 16_384,
  outcome: 4_096,
  learning: 1_024,
  learnings: 20,
  sourceTitle: 300,
  url: 2_048,
} as const;

/**
 * A3 3.4's agent limits, tighter than A1's on purpose to keep results inside the token budgets
 * (A3 3.1). Entries list them in `agent.max`, so `mcp-tools.json` carries them.
 */
export const AGENT_LIMITS = {
  title: 200,
  summary: 240,
  context: 8_000,
  /** A log entry or note through `add_entry`, and a draft's log entry (A3 3.4.5, 3.4.7). */
  entry: 2_000,
  outcome: 600,
  learning: 300,
  learnings: 8,
  sourceTitle: 200,
} as const;

/** Crockford base32 in lower case, the alphabet of every ID (A1 3.3). */
const B32 = "[0-9a-hjkmnp-tv-z]";

export const patterns = {
  taskRef: /^[A-Z]{1,6}-[1-9][0-9]{0,9}$/u,
  /** `<epoch>.<seq>.<tag>`, such as `1.1046.5n0w8k3q` (A1 3.5). */
  asOf: /^[0-9]{1,10}\.[0-9]{1,15}\.[0-9a-hjkmnp-tv-z]{8}$/u,
  /** 16 to 64 characters from `[A-Za-z0-9_-]` (A3 3.4.1). */
  requestId: /^[A-Za-z0-9_-]{16,64}$/u,
  isoDate: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u,
  /** An instant in UTC, as `Date.toISOString()` writes it, with or without milliseconds. */
  instant: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u,
  /** A note or log entry ordinal within its task: `n2`, `l3` (A1 3.3). */
  entryRef: /^[nl][1-9][0-9]{0,5}$/u,
} as const;

export const idPattern = (prefix: string) => new RegExp(`^${prefix}_${B32}{26}$`, "u");

// ---------------------------------------------------------------------------------------------
// Inputs

/** A task reference (`M-14`) or ID (`t_...`), resolved as A1 3.3 defines. */
export const TaskRefInput = z.string().max(40);

/**
 * The task of a call that defaults to the session's. A connection that is no session and names
 * none is refused `unbound`, so the registry check makes every entry that takes it list that.
 */
export const SessionTask = TaskRefInput.describe(
  "Task ref (M-14) or ID; default: this session's task",
).optional();

/**
 * The one `request_id` schema. Every write entry uses this object, and the registry check
 * refuses any other (A3 3.4.1). Every input string states a maximum, even where its pattern
 * bounds it.
 */
export const RequestId = z
  .string()
  .max(64)
  .regex(patterns.requestId)
  .describe("New per intended change; reuse it only to retry that call");

/**
 * The `base` schemas, which the registry check requires on writes that change fields: a task's,
 * and a group's, whose base comes from another answer.
 */
export const Base = z
  .string()
  .max(40)
  .describe("as_of: the get_task that showed the field, the add that made it, your set of it");
export const GroupBase = z
  .string()
  .max(40)
  .describe("as_of of the organize list that showed the group, or of your write of it");

/** Each entry that takes it gives it the default `"apply"` in its `defaults`. */
export const Mode = z
  .enum(["apply", "propose"])
  .describe("propose: ask the user to decide")
  .optional();

export const Cwd = z.string().max(4096).describe("Your working folder, as an absolute path");

export const Priority = z.int().min(1).max(4);

/** A one-line title: A1's 300 characters for the user. Entries give agents A3's 200. */
export const TitleInput = safeLine(USER_LIMITS.title);

/** A one-line summary: A1's 400 characters for the user. Entries give agents A3's 240. */
export const SummaryInput = safeLine(USER_LIMITS.summary);

/** Markdown context: A1's 64 KiB for the user. Entries give agents A3's 8,000 characters. */
export const ContextInput = safeText(USER_LIMITS.context);

/** A log entry: A1's 16 KiB for the user. Entries give agents A3's 2,000 characters. */
export const LogInput = safeText(USER_LIMITS.log);

/**
 * The source kinds a caller may write (A3 3.4.5). Outputs take every kind A1 stores
 * (`SOURCE_KINDS`).
 */
export const SOURCE_KINDS_IN = [
  "email",
  "chat",
  "ticket",
  "pr",
  "issue",
  "doc",
  "calendar",
  "session",
  "web",
] as const;

/** A link to where a task came from (A3 3.4.5). Stored lean: no message bodies (A3 3.10). */
export const SourceInput = z.strictObject({
  key: z.string().max(512).describe("<namespace>:<id>, such as jira:LUM-212").optional(),
  kind: z.enum(SOURCE_KINDS_IN).describe("Source kind"),
  title: safeLine(USER_LIMITS.sourceTitle).describe("Subject, chat or ticket title"),
  who: safeLine(120).describe("Sender or counterpart").optional(),
  url: z.string().max(USER_LIMITS.url).describe("Link").optional(),
  at: z
    .string()
    .max(40)
    .describe("When it was sent: ISO date, or instant with its offset")
    .optional(),
});

/**
 * A folder on this machine: `"cwd"`, the caller's working folder from its `cwd` field, an absolute
 * path, or one under `~`. The service checks it and stores it with the home written as `~`.
 */
export const FolderInput = z.string().min(1).max(4096);

/**
 * When something happened, for work that existed before it was added here: an ISO date or an
 * instant with its offset, never in the future. The service reads it (ops/dates.ts).
 */
export const PastInput = z.string().max(40);

/** One task to create (A3 3.4.5). */
export const TaskDraft = z.strictObject({
  title: TitleInput.describe("Title"),
  summary: SummaryInput.describe("One line: the next step").optional(),
  area: safeLine(120).describe("Area name or slug").optional(),
  project: safeLine(120).describe("Project name or slug").optional(),
  status: safeLine(40).describe("A status of the space; default open").optional(),
  inbox: z.boolean().describe("Put it in the Inbox for the user").optional(),
  priority: Priority.describe("1 highest, 4 none: read skill setting-priority first").optional(),
  effort: safeLine(EFFORT_KEY_MAX)
    .describe("A size of the space: read skill sizing-effort first")
    .optional(),
  due: safeLine(40).describe("ISO date or phrase: fri, +3d").optional(),
  waiting_on: safeLine(80).describe("Who or what it waits on").optional(),
  focus: z
    .boolean()
    .describe("Star it: on Today until cleared. Only when the user asks")
    .optional(),
  created: PastInput.describe(
    "When it was created, only for work that existed before: ISO date or instant",
  ).optional(),
  folder: FolderInput.describe('Its folder: "cwd", an absolute folder or one under ~').optional(),
  sources: z.array(SourceInput).max(10).describe("Where it came from").optional(),
  context: ContextInput.describe("Markdown context").optional(),
  log: LogInput.describe("Log entry; also added to a matched task that lacks it").optional(),
  on_existing: z
    .enum(["return", "add_sources", "create_new"])
    .describe("When a source key matches; default return")
    .optional(),
});

/** The agent limits of a source's fields, for an entry's `agent.max` through `under()`. */
export const SOURCE_AGENT_MAX: Pairs<number> = [["title", AGENT_LIMITS.sourceTitle]];

/** The agent limits of a task draft's fields, for an entry's `agent.max` through `under()`. */
export const DRAFT_AGENT_MAX: Pairs<number> = [
  ["title", AGENT_LIMITS.title],
  ["summary", AGENT_LIMITS.summary],
  ["context", AGENT_LIMITS.context],
  ["log", AGENT_LIMITS.entry],
  ...under("sources[]", SOURCE_AGENT_MAX),
];

/**
 * What `entry.add` writes (A3 3.4.7): A1's log kinds except `handoff`, which A3 does not offer,
 * and `note`. Outputs take every log kind A1 stores (`LOG_KINDS`).
 */
export const ENTRY_KINDS_IN = [
  "progress",
  "evidence",
  "decision",
  "blocker",
  "question",
  "note",
] as const;

// ---------------------------------------------------------------------------------------------
// Outputs. Results are plain values: no transforms and no defaults. A field that carries a stored value
// accepts every value A1 can store, not only what a caller may write.

/** The log kinds A1 stores (A1 3.4, `log_entries.kind`). */
export const LOG_KINDS = [
  "progress",
  "evidence",
  "blocker",
  "decision",
  "question",
  "handoff",
] as const;

/**
 * The source kinds A1 stores (A1 3.4, `sources.kind`). A1 lists them without a CHECK
 * constraint, so the writer refuses any other kind (A3 3.2.1).
 */
export const SOURCE_KINDS = [
  "email",
  "chat",
  "ticket",
  "pr",
  "issue",
  "doc",
  "calendar",
  "crash",
  "session",
  "book",
  "web",
  "other",
] as const;

export const AsOf = z
  .string()
  .regex(patterns.asOf)
  .describe("The space's position when this answer was made");

/**
 * A write's `as_of`: the position of its own commit, or of the space it was judged on when it
 * changed nothing, in its first answer and in every retry. A caller passes it as the base of its
 * next write, which is then refused when something it has not seen changed since. The names and
 * lists in the answer are read when it is made, and may be newer.
 */
export const WriteAsOf = AsOf.describe(
  "This write's position: your next base. Names and lists here may be newer",
);

export const TaskId = z.string().regex(idPattern("t")).describe("Task ID");
export const TaskRef = z.string().regex(patterns.taskRef).describe("Task reference");
export const SourceId = z.string().regex(idPattern("s")).describe("Source ID");
export const ProposalId = z.string().regex(idPattern("pr")).describe("Proposal ID");
export const Lifecycle = z.enum(["active", "completed", "archived"]).describe("Lifecycle");
export const WrapState = z.enum(["pending", "wrapped"]).describe("Wrap-up state");
/**
 * A retry's mark. A retry repeats what the write did, from what it stored; the names and lists in
 * its answer are read as of now, and its `as_of` dates them.
 */
export const Replayed = z
  .boolean()
  .describe("True on a retry: what the write did, with names and lists as of now");
/** A project's area now: a project in an archived area is out of sight with it. */
export const ProjectArea = z
  .strictObject({
    id: z.string().regex(idPattern("a")).describe("Area ID"),
    name: z.string().describe("Its name"),
    archived: z.literal(true).describe("Archived, and the project with it").optional(),
  })
  .describe("A project's area; absent: it has none");
export const Warnings = z.array(z.string()).describe("Warnings, one sentence each");

/** A folder inside one whose change a write made: one that moved along with it, or stayed. */
export const InsideFolder = z.strictObject({
  kind: z.enum(["project", "task"]).describe("Whose folder it is"),
  name: z.string().describe("A project's name, when it could be read").optional(),
  ref: TaskRef.optional(),
  folder: z.string().max(4096).describe("Where it is now, the home as ~"),
});

/**
 * What a folder change did to the folders inside the old one: an old folder that is gone and found
 * at the new place was moved, and each folder inside it that is there in the new one moved along;
 * the others stayed, for one reason.
 */
export const InsideFolders = {
  moved: z
    .int()
    .min(0)
    .max(1_000_000)
    .describe("Folders inside the old one that moved along: it was moved, and they are in it")
    .optional(),
  followed: z.array(InsideFolder).max(20).describe("The first of them").optional(),
  stayed: z
    .int()
    .min(0)
    .max(1_000_000)
    .describe("Folders inside the old one that stayed")
    .optional(),
  stayed_because: z
    .enum(["old_folder_there", "old_folder_unseen", "unchecked", "not_in_new_folder"])
    .describe("Why they stayed: old folder there or unseen, unchecked, or not in the new one")
    .optional(),
  kept: z.array(InsideFolder).max(20).describe("The first of them").optional(),
};

/** The other projects that have a project's folder here too: any number of projects may share one. */
export const AlsoProjects = z
  .array(
    z.strictObject({
      id: z.string().regex(idPattern("p")).describe("Its ID"),
      name: z.string().describe("Its name now"),
    }),
  )
  .max(1000)
  .describe("Other projects with this folder here");

/** A draft that matched several active tasks by its source keys: none was picked. */
export const SeveralMatch = z.array(TaskRef).describe("Several active matches: pick one");
export const LogAdded = z.boolean().describe("The draft's log entry was added");
/**
 * A draft's log entry that this request added to no task: several match, or the match is finished.
 * A task may hold it from an earlier call all the same.
 */
export const LogLeftOut = z
  .literal(true)
  .describe("This request added its log to no task: check the matched task before filing it");

/** A new task's sources whose key another active task holds: each is linked without its key. */
export const HeldSources = z
  .array(
    z.strictObject({
      source: z.int().min(0).max(9).describe("Index in the draft's sources"),
      held_by: TaskRef.describe("The task that holds its key"),
    }),
  )
  .describe("Sources linked without their key, which another task holds");

/**
 * A task's due commitment as A1 3.4 stores it: a date-only `due_date`, never shifted to UTC, or a
 * timed `due_at` with its IANA zone `due_tz`. A task without one leaves the field out.
 */
export const DueOutput = z.union([
  z.string().regex(patterns.isoDate),
  z.strictObject({
    at: z.string().regex(patterns.instant).describe("Due time, in UTC"),
    tz: z.string().describe("IANA time zone of the commitment"),
  }),
]);

/** One task in a list (A3 3.4.2). */
export const TaskRow = z.strictObject({
  id: TaskId,
  ref: TaskRef,
  title: z.string().describe("Title"),
  lifecycle: Lifecycle,
  status: z.string().describe("Status key"),
  inbox: z.boolean().describe("In the Inbox"),
  priority: z.int().min(1).max(4).describe("1 highest, 4 none"),
  effort: z.string().describe("Effort").optional(),
  due: DueOutput.describe("Due date, or a due time with its zone").optional(),
  area: z.string().describe("Area name").optional(),
  project: z.string().describe("Project name").optional(),
  deleted: z
    .strictObject({
      at: z.string().regex(patterns.instant).describe("When"),
      by: z.string().describe("Who: user, import or the actor's label"),
      change: z.string().regex(idPattern("op")).describe("The change that moved it").optional(),
    })
    .describe("In the Trash: who moved it there. Tell the user; never add it again")
    .optional(),
});

/** A skill's name, as its folder spells it: the Agent Skills format's alphabet, 64 at most. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_NAME_CHARS = 64;

/**
 * One of the user's skills: TTasks' defaults, edited or not, and the user's own. Its text is the
 * user's instruction to their agents, as a note for agents is, and is never framed as data.
 */
export const SkillRow = z.strictObject({
  name: z.string().describe("Skill name"),
  when: z.string().describe("When to read it").optional(),
  problem: z.string().describe("Why the user's file for it is not used").optional(),
  text: z.string().describe("The skill: the user's instructions, when asked for").optional(),
});

/** The user's skill folders a list does not read, past its cap. */
export const SkillsUnread = z
  .int()
  .min(1)
  .max(1_000_000)
  .describe("Skill folders not read, past the cap: one is read only by its name")
  .optional();

/** An instant in milliseconds since the epoch. */
const Millis = z.int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
/** A commit's sequence number, or a count. */
const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A task's compact row: the change feed's form, which the page's lists draw. A column that is null
 * in the space is left out. It carries no long text (context, outcome, notes), only what a row
 * shows of its children: its first three sources, how many more, where it opens here, its
 * newest background run while it works or needs the person, and the questions that wait.
 */
export const CompactTaskRow = z.strictObject({
  id: TaskId,
  ref: TaskRef,
  title: z.string().describe("Title"),
  summary: z.string().describe("One line: the next step").optional(),
  lifecycle: Lifecycle,
  status: z.string().describe("Status key"),
  inbox: z.boolean().describe("In the Inbox"),
  priority: z.int().min(1).max(4).describe("1 highest, 4 none").optional(),
  effort: z.string().describe("Effort").optional(),
  due_date: z.string().describe("Due date, YYYY-MM-DD").optional(),
  due_at: Millis.describe("Due time").optional(),
  due_tz: z.string().describe("The due time's IANA zone").optional(),
  planned_for: z.string().describe("Day planned for").optional(),
  focus_on: z.string().describe("Day starred for").optional(),
  owner: z.string().describe("Owner").optional(),
  waiting_on: z.string().describe("Who or what it waits on").optional(),
  area_id: z.string().describe("Area ID").optional(),
  project_id: z.string().describe("Project ID").optional(),
  parent_id: z.string().describe("Parent task ID").optional(),
  position: z.string().describe("Order key within its group"),
  wrap_state: WrapState.optional(),
  completed_at: Millis.describe("When it was completed").optional(),
  finished_at: Millis.describe("When it was completed or dropped").optional(),
  deleted_at: Millis.describe("When it was deleted").optional(),
  created_at: Millis.describe("When it was created"),
  version: Count.describe("The seq of its last change"),
  touched: Count.describe("The seq of its or a child's last change").optional(),
  waiting_since: Millis.describe("When its current wait began").optional(),
  sources: z
    .array(
      z.strictObject({
        id: SourceId,
        kind: z.string().describe("Source kind"),
        title: z.string().describe("Title"),
        who: z.string().describe("Sender or counterpart").optional(),
        ref: z.string().describe("Its key in its own system").optional(),
        url: z.string().describe("Link").optional(),
      }),
    )
    .describe("Its first three sources")
    .optional(),
  sources_more: Count.describe("How many more sources it has").optional(),
  place: z
    .union([
      z.strictObject({
        state: z.enum(["here", "missing"]).describe("Its or its project's folder here, or missing"),
      }),
      z.strictObject({
        state: z.literal("elsewhere").describe("Only on another machine"),
        machine: z.string().describe("That machine's name"),
      }),
    ])
    .describe("Where it opens on this machine: its folder there, or another machine")
    .optional(),
  run: z
    .strictObject({
      id: z.string().describe("The run's ID"),
      state: z
        .enum(ROW_RUN_STATES)
        .describe(
          "It works, ended asking the person, or was open when this copy's backup was made",
        ),
      instance: z.string().describe("The run's agent instance"),
    })
    .describe("Its newest background run, while it works, needs the person, or is recorded")
    .optional(),
  last: z
    .strictObject({
      open: z.string().describe("The instance of its newest Open that was not refused").optional(),
      open_route: z
        .string()
        .describe("How that Open opened: t3-mcp names T3 Code also when its instance is gone")
        .optional(),
      run: z.string().describe("The instance of its newest run").optional(),
    })
    .describe("The agent instances it was last opened in and last ran with")
    .optional(),
  questions: z
    .array(
      z.strictObject({
        ref: z.string().describe("The log entry, such as l3, or the run that ended with it"),
        by: z.string().describe("The agent that asked"),
        instance: z.string().describe("The instance of the run that asked").optional(),
        text: z.string().max(300).describe("Its first 300 characters"),
        at: Millis.describe("When it was asked"),
      }),
    )
    .max(10)
    .describe("Questions agents asked that wait for the person, newest first")
    .optional(),
  questions_more: Count.describe("How many more questions wait").optional(),
});

/** The most tasks a read names as holding a source's key. */
export const CAPTURES_TO_MAX = 5;

export const SourceOutput = z.strictObject({
  id: SourceId.describe("Source ID: detach or put back by it"),
  key: z.string().describe("Source key").optional(),
  kind: z.enum(SOURCE_KINDS).describe("Source kind"),
  title: z.string().describe("Title"),
  who: z.string().describe("Sender or counterpart").optional(),
  url: z.string().describe("Link").optional(),
  at: z.string().describe("When it was sent").optional(),
  ref: z.string().describe("Its key, held by another task").optional(),
  captures_to: z
    .array(TaskRef)
    .max(CAPTURES_TO_MAX)
    .describe("Active tasks with its key: captures go there")
    .optional(),
  captures_more: Count.describe("How many more tasks have its key").optional(),
  removed: z
    .strictObject({
      at: z.string().describe("When, ISO date and time"),
      by: z.string().describe("Actor that detached it"),
    })
    .describe("Detached from the task; put_back_sources brings it back")
    .optional(),
});
