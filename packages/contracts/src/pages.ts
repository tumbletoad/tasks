// The shapes of knowledge pages and of the texts on the space, areas and projects that every task
// below them inherits (step 1). The entries that use them are in entries/page-*.ts and
// entries/node-instruct.ts; they join the registry in the pull request that brings their handler.
//
// A page is Markdown knowledge on the space, an area, a project or a task. Its reference comes from
// the space's one counter, so `M-180` is a task or a page, never both. Its brief may be empty when
// a person made it: an agent gives one on every page it makes. A node's texts are the space's
// brief, a description on the space, an area or a project, and the person's text for agents there:
// the one standing instruction for every task below it, which only a person writes.
import { z } from "zod";
import { idPattern, patterns, TaskRef } from "./schemas.ts";

/** Who may hold a page, and who holds the texts every task below inherits. */
export const PAGE_OWNER_KINDS = ["space", "area", "project", "task"] as const;
export const NODE_KINDS = ["space", "area", "project"] as const;

/** What a person may store, and what an agent may send in one call: the two audiences. */
export const PAGE_LIMITS = {
  user: { title: 300, brief: 400, body: 65_536, why: 1_000 },
  agent: { title: 200, brief: 160, body: 8_000, words: 4_000, why: 200 },
} as const;

/**
 * Where a library starts to cost its readers: a page a reader cannot take in at once, a node whose
 * list no longer shows what it holds. An agent's write that leaves either over is told so; nothing
 * is refused.
 */
export const LIBRARY_BUDGET = { pageBytes: 16_384, nodePages: 12 } as const;

/** The most rows of one list in one answer: a longer list pages with its cursor. */
export const PAGE_LIST = 25;
/** The characters of a page an unapplied edit shows: the rest is read with its cursor. */
export const EXCERPT_CHARS = 1_200;

export const PageId = z.string().regex(idPattern("pg")).describe("Page ID");
export const PageRef = z
  .string()
  .max(20)
  .regex(patterns.taskRef)
  .describe("Page reference, such as M-180");
const NodeId = z
  .string()
  .regex(/^(?:sp|a|p)_[0-9a-hjkmnp-tv-z]{26}$/u)
  .describe("The space's, an area's or a project's ID");
const Count = z.int().min(0).max(1_000_000);
const At = z.string().regex(patterns.instant).describe("When, ISO date and time");
const By = z.string().describe("Who: user, import or the agent's label");
const Seq = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A read's cursor: pass it back to `read` to read on. */
export const ReadCursor = z.string().max(80).describe("Pass it to read to read on");

/** The change that last touched a page or a text: the commit at the row's version. */
export const LastChange = z.strictObject({
  by: By,
  at: At,
  why: z.string().describe("Its one line of what changed and why").optional(),
});

/** One page in a list: never its body. */
export const PageRow = z.strictObject({
  ref: PageRef,
  title: z.string().describe("Title"),
  brief: z.string().describe("One line: what a reader finds in it; empty: none given"),
  by: By.describe("Who changed it last"),
  at: At.describe("When it was changed last"),
});

/** A page of a task, in its project's or area's list of its tasks' pages. */
export const TaskPageRow = PageRow.extend({
  task: TaskRef.describe("The task it is on"),
});

/** The person's standing instruction on a node: their own words and when they wrote them. */
export const ForAgents = z.strictObject({
  text: z.string().describe("The user's instruction for every task below"),
  at: At,
});

/**
 * One level above a task or a node: what it is, the person's text for agents there, and its
 * pages. `read` names it for `read`, whatever its title, and `count` says how many pages it holds
 * when `pages` shows fewer.
 */
export const TrailLevel = z.strictObject({
  kind: z.enum(NODE_KINDS).describe("What the level is"),
  id: NodeId,
  title: z.string().describe("Its name"),
  brief: z.string().describe("One line: what it is; empty: none given"),
  read: z.string().max(40).describe("Pass it to read for its description and all its pages"),
  has_description: z.boolean().describe("It has a description: read it"),
  for_agents: ForAgents.describe("The user's instruction for every task below it").optional(),
  pages: z.array(PageRow).max(PAGE_LIST).describe("Its pages, by title"),
  count: Count.describe("Its pages in all"),
});

/**
 * A page as the feed carries it, in the snapshot and in a batch's `page` entity: everything but
 * the body. `deleted_at` set means it is not shown: the page is in the Trash, or what holds it is
 * (a task in the Trash, a deleted project). Such a row leaves the live lists.
 */
export const CompactPage = z.strictObject({
  id: PageId,
  ref: PageRef,
  title: z.string().describe("Title"),
  brief: z.string().describe("One line: what a reader finds in it; empty: none given"),
  owner_id: z.string().max(40).describe("The space's, a project's or a task's ID"),
  task: z
    .strictObject({
      ref: TaskRef,
      title: z.string().describe("Its title"),
      lifecycle: z.string().describe("Its lifecycle"),
    })
    .describe("The task it is on, as it is now")
    .optional(),
  under: z.string().max(40).describe("The node it lies under, also through its task"),
  version: Seq.describe("Row version: the commit that changed it last"),
  by: By.describe("Who changed it last"),
  at: z.int().min(0).max(Number.MAX_SAFE_INTEGER).describe("When, in milliseconds since 1970"),
  why: z.string().describe("The last change's one line").optional(),
  deleted_at: z
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .describe("Not shown: it or what holds it is in the Trash")
    .optional(),
});

/** What `complete_task` takes in place of learnings: the pages updated, or that there were none. */
export const NOTHING_REUSABLE = "nothing reusable";
export const FinishLibrary = z
  .union([z.array(PageRef).min(1).max(10), z.literal(NOTHING_REUSABLE)])
  .describe(`The pages you updated, or "${NOTHING_REUSABLE}"`);

/** A page that matched a search in scope `library`. */
export const SearchPageRow = z.strictObject({
  kind: z.literal("page").describe("A page"),
  ref: PageRef,
  title: z.string().describe("Title"),
  brief: z.string().describe("One line: what a reader finds in it; empty: none given"),
  on: z.string().describe("What holds it, by name"),
  by: By.describe("Who changed it last"),
  at: At.describe("When it was changed last"),
  snippet: z.string().describe("Where it matched").optional(),
  changed: z.literal(true).describe("Changed since the search ran").optional(),
});

/** One earlier version of a page's body or a node's description: never its words in a list. */
export const PageVersion = z.strictObject({
  seq: Seq.describe("The change that made this version"),
  at: At,
  by: By,
  why: z.string().describe("Its one line").optional(),
  restored_from: Seq.describe("A Restore: the version it brought back").optional(),
  chars: Count.describe("Characters in this version"),
});
