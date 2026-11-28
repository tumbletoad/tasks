// The replay (piece iii): today's service requests sent through both backends, one service serving
// a space on today's writer and a tree space, and compared step by step by the strict helper
// (replay-helpers.ts): the whole answer each call got and what a reader then sees of every task any
// answer named, and of every node a read hands out. The calls are those `answers.test.ts` and its
// kin send, one family at a time: the readable cases beside the generated replay
// (replay.prop.test.ts). A step where the backends may differ names those fields and says why.
// Fixture text only.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CheckedDriver,
  createSpace,
  loadDriver,
  DEFAULT_DRIVER,
  NO_TOP_FOLDER,
} from "@ttasks/storage";
import { both, type Sequence } from "../../storage/test/both-helpers.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { classSession } from "./ops-helpers.ts";
import { readBatch, readSnapshot } from "../src/http/feed.ts";
import {
  backend,
  foldersUnder,
  newSpaces,
  normal,
  type Session,
  type Side,
  type Step,
} from "./replay-helpers.ts";

const LONG = 180_000;
let w: ContractWorld & { root: string };
let tree: string;

beforeAll(async () => {
  w = await contractWorld("replay");
  foldersUnder(join(w.root, "work", "replay"));
  const checked = await CheckedDriver.check(await loadDriver(DEFAULT_DRIVER));
  const folder = join(w.root, "s", "tree");
  createSpace(checked, folder, {
    name: "Mira",
    // The prefix of the contract world's space: a status shows it.
    refPrefix: "M",
    machineId: w.service.ops.machine.id as `m_${string}`,
    ownerLabel: "user",
    tree: true,
  });
  const person = await classSession(w.home, w.path, "cli-interactive");
  try {
    const opened = (await person.call("space/open", { path: folder })) as { space: { id: string } };
    tree = opened.space.id;
  } finally {
    person.close();
  }
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const replay = (steps: Sequence<Step>) =>
  both(
    { today: backend(w.service.ops, () => w.space), tree: backend(w.service.ops, () => tree) },
    steps,
  );

/** The tasks family, as `answers.test.ts` sends it. */
const TASKS: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Renew the passport" }] }, as: "passport" },
  { op: "task.add", input: { tasks: [{ title: "Renew the passport" }] }, again: 1 },
  {
    op: "task.update",
    input: { task: "{passport}", set: { title: "Renew both passports", priority: 2 } },
    base: true,
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "Book the van", summary: "Before the move" }] },
    as: "van",
  },
  { op: "task.finish", input: { task: "{van}", outcome: "Booked for Monday" }, base: true },
  { op: "task.reopen", input: { task: "{van}" }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{passport}"] }, base: true, user: true },
];

const ticket = (key: string) => ({ key, kind: "ticket", title: "Fixture ticket" });

/** Captures, a lost reply after a rename, a request ID reused, a stale base and repeats. */
const AGAIN: Sequence<Step> = [
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed before", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
    as: "keyed",
  },
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
  },
  {
    op: "task.update",
    input: { task: "{keyed}", set: { title: "Keyed and renamed" } },
    base: true,
  },
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Keyed again", sources: [ticket("fixture:meanwhile-1")], log: "Asked" }],
    },
    again: 2,
  },
  { op: "task.add", input: { tasks: [{ title: "Second under its ID" }] }, again: 1 },
  {
    op: "task.update",
    input: { task: "{keyed}", set: { title: "From a stale read" } },
    baseFrom: 1,
  },
  { op: "task.update", input: { task: "{keyed}", set: { priority: 1 } }, base: true },
  { op: "task.update", input: { task: "{keyed}", set: { priority: 1 } }, base: true },
  { op: "task.finish", input: { task: "{keyed}", outcome: "Answered" }, base: true, user: true },
  { op: "task.finish", input: { task: "{keyed}", outcome: "Answered" }, base: true, user: true },
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "Keyed later", sources: [ticket("fixture:meanwhile-1")], log: "Asked again" },
      ],
    },
  },
  { op: "task.delete", input: { tasks: ["{keyed}"] }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{keyed}"] }, base: true, user: true },
  { op: "task.get", input: { task: "X-999" } },
];

/** What review found the tree answered otherwise, and what `answers.test.ts` holds a write to. */
const HELD: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Plan the trip" }] }, as: "trip" },
  // A finish as dropped archives the task; its request ID reused as done is another request.
  { op: "task.finish", input: { task: "{trip}", status: "dropped" }, base: true, user: true },
  {
    op: "task.finish",
    input: { task: "{trip}", status: "done" },
    base: true,
    user: true,
    again: 2,
  },
  // A finished task is not edited by an update.
  { op: "task.update", input: { task: "{trip}", set: { title: "Edited after" } }, base: true },
  { op: "task.add", input: { tasks: [{ title: "Pay the fee" }] }, as: "fee" },
  {
    op: "task.finish",
    input: { task: "{fee}", finished: "2999-01-01T00:00:00Z" },
    base: true,
    user: true,
  },
  {
    op: "task.finish",
    input: { task: "{fee}", finished: "2020-01-01T00:00:00Z", outcome: "Paid" },
    base: true,
    user: true,
  },
  // The Trash with arguments that do not go together.
  {
    op: "task.delete",
    input: { tasks: ["{fee}"], change: "op_0000000000000000000000000a" },
    base: true,
    user: true,
  },
  // A refused batch writes nothing, and the same ID then carries the corrected batch.
  {
    op: "task.add",
    input: { tasks: [{ title: "First of two" }, { title: "Second", status: "x" }] },
  },
  { op: "task.add", input: { tasks: [{ title: "First of two" }, { title: "Second" }] }, again: 9 },
  { op: "task.add", input: { tasks: [{ title: "Same title" }, { title: "Same title" }] } },
  {
    op: "task.add",
    input: {
      tasks: [
        {
          title: "Dated",
          sources: [{ kind: "email", title: "Fixture mail", at: "2026-01-02T03:04:05Z" }],
        },
      ],
    },
    as: "dated",
  },
  // An update without its base, and an accepted ID reused on other tools, well-formed or not.
  { op: "task.update", input: { task: "{dated}", set: { title: "No base" } } },
  { op: "task.update", input: { task: "{dated}", set: { priority: 9 } }, again: 1 },
  { op: "task.reopen", input: { task: "{trip}" }, base: true, again: 1 },
  // A person's edit between a write and its retry: the retry is answered as the write was decided.
  {
    op: "task.add",
    input: { tasks: [{ title: "Call the bank", summary: "About the card" }] },
    as: "bank",
  },
  {
    op: "task.update",
    input: { task: "{bank}", set: { summary: "About the new card" } },
    base: true,
    user: true,
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "Call the bank", summary: "About the card" }] },
    again: 16,
  },
];

describe("[S2.replay.tasks] today's service requests through both backends: the tasks family", () => {
  test(
    "add, a lost reply sent again, update, finish, reopen and the Trash, with what a reader then sees",
    async () => {
      await replay(TASKS);
    },
    LONG,
  );

  test(
    "captures by source with their log, a lost reply after a rename, a request ID reused, a stale base and repeats",
    async () => {
      await replay(AGAIN);
    },
    LONG,
  );

  test(
    "a finish dropped and done, a finished task's edit, a future finish, the Trash's arguments, a refused batch, a reused ID, an edit before a retry",
    async () => {
      await replay(HELD);
    },
    LONG,
  );
});

/** Notes, log entries and the person's texts, as the entry tests send them. */
const NOTES: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Renew the passport" }] }, as: "t" },
  {
    op: "entry.add",
    input: { task: "{t}", kind: "note", text: "Bring the old one", for_agents: true },
    entry: "note",
    user: true,
  },
  {
    op: "entry.add",
    input: { task: "{t}", kind: "progress", text: "Called the office" },
    entry: "log",
  },
  {
    op: "entry.add",
    input: {
      task: "{t}",
      kind: "decision",
      text: "Go in person",
      links: [{ title: "Opening hours", url: "https://example.org/hours" }],
    },
  },
  {
    op: "entry.add",
    input: { task: "{t}", kind: "note", text: "Dated", at: "2026-11-01" },
    user: true,
  },
  {
    op: "entry.add",
    input: { task: "{t}", kind: "progress", text: "For agents", for_agents: true },
  },
  {
    op: "entry.edit",
    input: { task: "{t}", entry: "{note}", text: "Bring the old one and a photo" },
    base: true,
    user: true,
  },
  {
    op: "entry.edit",
    input: { task: "{t}", entry: "{note}", text: "Bring the old one and a photo" },
    base: true,
    user: true,
  },
  { op: "note.remove", input: { task: "{t}", remove: "{note}" }, base: true, user: true },
  { op: "note.remove", input: { task: "{t}", remove: "{note}" }, base: true, user: true },
  { op: "note.remove", input: { task: "{t}", put_back: "{note}" }, base: true, user: true },
  { op: "note.remove", input: { task: "{t}" }, base: true, user: true },
  {
    op: "node.instruct",
    input: { target: "space", text: "Ask before you book anything" },
    base: true,
    user: true,
  },
  {
    op: "node.instruct",
    input: { target: "space", text: "Ask before you book anything" },
    base: true,
    user: true,
  },
];

/** A task read by its sections, a page at a time. */
const SECTIONS: Sequence<Step> = [
  {
    op: "task.add",
    input: { tasks: [{ title: "Read in sections", context: "Why it matters" }] },
    as: "s",
  },
  { op: "entry.add", input: { task: "{s}", kind: "note", text: "First note" }, user: true },
  { op: "entry.add", input: { task: "{s}", kind: "progress", text: "First step" } },
  {
    op: "task.get",
    input: {
      task: "{s}",
      sections: ["instructions", "context", "notes", "log", "sources", "outcome"],
    },
  },
  { op: "task.get", input: { task: "{s}", sections: ["log"], log_limit: 1 } },
];

/** Undo and Redo of the person's steps, and a step kept by an agent's work since. */
const HISTORY: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Fixture task the person changes" }] }, as: "mine" },
  {
    op: "task.update",
    input: { task: "{mine}", set: { summary: "Fixture summary to undo" } },
    base: true,
    user: true,
  },
  { op: "history.undo", input: {}, user: true },
  { op: "history.undo", input: {}, again: 3, user: true },
  { op: "history.redo", input: {}, user: true },
  {
    op: "task.update",
    input: { task: "{mine}", set: { summary: "An agent's change since" } },
    base: true,
  },
  { op: "history.undo", input: {}, user: true },
  { op: "task.finish", input: { task: "{mine}", outcome: "Done" }, base: true, user: true },
  { op: "history.undo", input: {}, user: true },
  { op: "history.redo", input: {}, user: true },
  { op: "history.redo", input: {}, user: true },
];

/** Several tasks to the Trash in one call, as a person selects rows, and its Undo. */
const TRASH: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "Old invoice" }] }, as: "a" },
  { op: "task.add", input: { tasks: [{ title: "Old receipt" }] }, as: "b" },
  { op: "task.delete", input: { tasks: ["{a}", "{b}"] }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{a}", "{b}"] }, base: true, user: true },
  { op: "history.undo", input: {}, user: true },
  { op: "task.delete", input: { tasks: ["{a}", "X-999"] }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{b}"] }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{a}", "{b}"] }, base: true, user: true },
];

describe("[S2.replay.notes] today's service requests through both backends: notes, texts, Undo", () => {
  test(
    "a note for agents, log entries with links, the refused forms, an edit, a removal and its put back, the space's text",
    async () => {
      await replay(NOTES);
    },
    LONG,
  );

  test(
    "several tasks to the Trash in one call, again, its Undo, one the space lacks, and one already there",
    async () => {
      await replay(TRASH);
    },
    LONG,
  );

  test(
    "a task read by its sections",
    async () => {
      await replay(SECTIONS);
    },
    LONG,
  );

  test(
    "Undo, a lost reply to it, Redo, and a step kept by an agent's work since",
    async () => {
      await replay(HISTORY);
    },
    LONG,
  );
});

/** Areas and projects named in drafts, as `answers.test.ts` and the group rules send them. */
const GROUPS: Sequence<Step> = [
  {
    op: "task.add",
    input: { tasks: [{ title: "Keyed work", sources: [ticket("fixture:groups-1")] }] },
  },
  {
    op: "task.add",
    input: {
      tasks: [
        {
          title: "Keyed work again",
          area: "Unused area",
          project: "Unused project",
          sources: [ticket("fixture:groups-1")],
        },
      ],
    },
  },
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "New in the shared project", area: "Shared area", project: "Shared project" },
      ],
    },
    as: "shared",
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "Another in the area", area: "Shared area" }] },
    as: "inarea",
  },
  {
    op: "task.add",
    input: { tasks: [{ title: "By its slugs", area: "shared-area", project: "shared-project" }] },
    as: "byslug",
  },
  { op: "task.add", input: { tasks: [{ title: "A typo", area: "Shared aera" }] } },
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "First of two", area: "Farm", project: "Barn" },
        { title: "Second of two", area: "Farm", project: "Barn" },
      ],
    },
    as: "barn",
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "To be filed" }] }, as: "filed" },
  {
    op: "task.update",
    input: { task: "{filed}", set: { area: "Shared area", project: "Shared project" } },
    base: true,
    user: true,
  },
  {
    op: "task.update",
    input: { task: "{filed}", set: { area: "Shared area", project: "Shared project" } },
    base: true,
    user: true,
  },
  {
    op: "task.update",
    input: { task: "{filed}", set: { area: "Workshop", project: "Bench" } },
    base: true,
    user: true,
  },
  { op: "history.undo", input: {}, user: true },
  {
    step: {
      op: "task.add",
      input: { tasks: [{ title: "A project alone", project: "Lone" }] },
      as: "lone",
    },
    // The one task this step adds, as its answer and its read name it, and its project's read.
    field: [
      "answer.said.tasks.0.project",
      "seen.lone.task.area",
      "seen.lone.task.project",
      "seen.lone.trail.0.kind",
      "seen.read Lone.kind",
    ],
    differs:
      "a project without an area: today's is a project, the tree's a top-level project, read as an area",
  },
];

describe("[S2.replay.projects] today's service requests through both backends: areas and projects", () => {
  test(
    "names a found task's draft gives make nothing; new names make their groups once; slugs, a typo",
    async () => {
      await replay(GROUPS);
    },
    LONG,
  );
});

const BODY = "## Steps\n\nBring a photo.\n\n## Fees\n\nPay at the desk.";

/** Pages through the request path, as `library.test.ts` sends them. */
const PAGES: Sequence<Step> = [
  {
    op: "task.add",
    input: { tasks: [{ title: "Renew the passport", area: "Home", project: "Papers" }] },
    as: "t",
    user: true,
  },
  { op: "page.write", input: { action: "create", task: "{t}", title: "Passport", why: "x" } },
  {
    op: "page.write",
    input: {
      action: "create",
      task: "{t}",
      title: "Passport",
      brief: "What to bring",
      body: BODY,
      why: "what the renewal needs",
    },
    page: "page",
  },
  { op: "page.read", input: { target: "{page}", section: "Fees" } },
  { op: "page.read", input: { target: "Home/Papers" } },
  {
    op: "page.write",
    input: { action: "edit", target: "{page}", old: "Bring a pen.", new: "Bring two.", why: "fix" },
  },
  {
    op: "page.write",
    input: {
      action: "edit",
      target: "{page}",
      old: "Bring a photo.",
      new: "Bring two photos.",
      why: "the office asks for two",
    },
  },
  {
    op: "page.write",
    input: { action: "append", target: "{page}", text: "Take a pen.", why: "pen" },
  },
  {
    op: "page.write",
    input: { action: "set", target: "{page}", title: "Passport renewal" },
    base: true,
    user: true,
  },
  { op: "page.history", input: { target: "{page}" }, user: true },
  {
    op: "task.finish",
    input: { task: "{t}", outcome: "Renewed.", library: ["X-999"] },
    base: true,
  },
  {
    op: "task.finish",
    input: { task: "{t}", outcome: "Renewed.", library: ["{page}"] },
    base: true,
  },
  { op: "page.write", input: { action: "move", target: "{page}", to: "space", why: "for all" } },
  { op: "page.write", input: { action: "trash", target: "{page}", why: "the trip is off" } },
  { op: "page.read", input: { target: "{page}" } },
  { op: "page.trashed", input: {}, user: true },
  { op: "page.write", input: { action: "restore", target: "{page}", why: "back" } },
  {
    op: "page.write",
    input: { action: "set", target: "Home/Papers", description: "Papers to keep at home." },
    base: true,
    user: true,
  },
  { op: "page.history", input: { target: "Home/Papers" }, user: true },
  { op: "page.read", input: { target: "space" } },
  // A page grown past the library's budget, and back under it.
  ...[4_000, 4_000, 4_000, 4_000, 1_000].map((chars) => ({
    op: "page.write",
    input: { action: "append", target: "{page}", text: "word ".repeat(chars / 5), why: "grow" },
  })),
  {
    op: "page.write",
    input: { action: "set", target: "{page}", body: BODY, why: "split by subject" },
    base: true,
  },
];

describe("[S2.replay.pages] today's service requests through both backends: pages", () => {
  test(
    "a page made on its task's project, read by heading and by node, edited, appended, set, its history, a finish's library, moved, the Trash and back",
    async () => {
      await replay(PAGES);
    },
    LONG,
  );
});

/** Dates, a star and a wait in drafts and updates, and a finished status refused. */
const DATES: Sequence<Step> = [
  {
    op: "task.add",
    input: {
      tasks: [{ title: "Pay the invoice", due: "2026-12-01", focus: true, waiting_on: "The bank" }],
    },
    as: "pay",
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "Call the office", due: "tomorrow" }] }, as: "call" },
  { op: "task.add", input: { tasks: [{ title: "Undated", due: "someday soon" }] } },
  { op: "task.update", input: { task: "{pay}", set: { due: "+3d" } }, base: true, user: true },
  { op: "task.update", input: { task: "{pay}", set: { status: "done" } }, base: true, user: true },
  { op: "task.update", input: { task: "{pay}", set: { focus: false } }, base: true, user: true },
  {
    op: "task.update",
    input: { task: "{pay}", clear: ["due", "waiting_on"] },
    base: true,
    user: true,
  },
  {
    op: "task.update",
    input: { task: "{pay}", clear: ["due", "waiting_on"] },
    base: true,
    user: true,
  },
  { op: "task.update", input: { task: "{call}", set: { waiting_on: "A reply" } }, base: true },
];

describe("[S2.replay.dates] today's service requests through both backends: dates", () => {
  test(
    "a due date, a phrase and one refused; a star and a wait; a finished status refused; cleared twice",
    async () => {
      await replay(DATES);
    },
    LONG,
  );
});

/** What review found the tree answered otherwise in the four families. */
const REVIEWED: Sequence<Step> = [
  { op: "task.add", input: { tasks: [{ title: "File me" }] }, as: "f", user: true },
  // A person files a task into a new project, a script renames it, the person's guarded Undo.
  {
    op: "task.update",
    input: { task: "{f}", set: { area: "Shed", project: "Tools" } },
    base: true,
    user: true,
  },
  { op: "task.update", input: { task: "{f}", set: { title: "Renamed by a script" } }, base: true },
  { op: "history.undo", input: { check_script: true }, user: true },
  // A removed note is not edited: its words come back as they were when it is put back.
  {
    op: "entry.add",
    input: { task: "{f}", kind: "note", text: "Original words" },
    entry: "n",
    user: true,
  },
  { op: "note.remove", input: { task: "{f}", remove: "{n}" }, base: true, user: true },
  {
    op: "entry.edit",
    input: { task: "{f}", entry: "{n}", text: "Replaced" },
    base: true,
    user: true,
  },
  { op: "note.remove", input: { task: "{f}", put_back: "{n}" }, base: true, user: true },
  // A filing from a stale read.
  {
    op: "task.update",
    input: { task: "{f}", set: { area: "Shed", project: "Bench" } },
    baseFrom: 1,
  },
  // Several tasks to the Trash in the order a person selected them, and its Undo.
  { op: "task.add", input: { tasks: [{ title: "Selected second" }] }, as: "z", user: true },
  { op: "task.add", input: { tasks: [{ title: "Selected first" }] }, as: "y", user: true },
  { op: "task.delete", input: { tasks: ["{y}", "{z}"] }, base: true, user: true },
  { op: "history.undo", input: {}, user: true },
  // An area's text for agents, then its description, and the description's history.
  {
    op: "node.instruct",
    input: { target: "Shed", text: "Ask before you buy tools" },
    base: true,
    user: true,
  },
  {
    op: "page.write",
    input: { action: "set", target: "Shed", description: "Tools and seeds." },
    base: true,
    user: true,
  },
  {
    step: { op: "page.history", input: { target: "Shed" }, user: true },
    field: "answer.said.versions",
    differs:
      "today counts the texts' row its text for agents made as a first, empty version; the tree has the description's own",
  },
  // An open task reopened from a read before it was made: a conflict first, as today's.
  { op: "task.add", input: { tasks: [{ title: "Made after the read" }] }, as: "late", user: true },
  { op: "task.reopen", input: { task: "{late}" }, baseFrom: 16, user: true },
];

describe("[S2.replay.reviewed] what review found in the four families, through both backends", () => {
  test(
    "a guarded Undo after a script's change, a removed note's edit, an area's trail, a stale filing, a Trash's order",
    async () => {
      await replay(REVIEWED);
    },
    LONG,
  );
});

const search = (q: string, more: Record<string, unknown> = {}): Step => ({
  op: "task.search",
  input: { q, ...more },
  user: true,
});

/** Search by words and the filters a person and an agent use most, as the search tests send it. */
const SEARCH: Sequence<Step> = [
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "Renew the passport", summary: "Bring a photo", area: "Home", project: "Papers" },
      ],
    },
    as: "a",
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "Pay the invoice", due: "2026-12-01" }] }, as: "b" },
  {
    op: "task.add",
    input: { tasks: [{ title: "Call the bank", focus: true, area: "Home" }] },
    as: "c",
    user: true,
  },
  { op: "task.update", input: { task: "{b}", set: { status: "waiting" } }, base: true },
  {
    op: "entry.add",
    input: { task: "{a}", kind: "note", text: "Ask about the photo booth" },
    user: true,
  },
  search("photo"),
  search("passport OR invoice"),
  search("status:waiting"),
  search("due<2026-12-05"),
  search("area:Home"),
  search("project:Papers photo"),
  search("is:inbox"),
  search("is:focus"),
  search("id:{a}"),
  search("bank -photo"),
  { op: "task.finish", input: { task: "{a}", outcome: "Renewed" }, base: true, user: true },
  search("photo"),
  search("photo", { scope: "all" }),
  search("is:completed"),
  // A task's words hold its area's and its project's names, and two words find it together.
  search("Home"),
  search("Home passport"),
  search("is:overdue"),
  search("photo", { scope: "learnings" }),
  // An agent searches too.
  { op: "task.search", input: { q: "invoice" } },
  { op: "task.search", input: { q: "id:{b}" } },
  { op: "task.finished", input: {}, user: true },
  { op: "space.status", input: {}, user: true },
  { op: "space.status", input: {} },
];

describe("[S2.replay.search] today's service requests through both backends: search", () => {
  test(
    "words, OR and a negation, status, due, area and project, the Inbox, the star, id:, a finished task by scope",
    async () => {
      await replay(SEARCH);
    },
    LONG,
  );
});

/** A backend whose reader then sees the feed: the snapshot, and the batch since the last step. */
const feedBackend = (space: () => string): Side<Step, Session & { seq: number }> => {
  const inner = backend(w.service.ops, space);
  const reader = (s: Session) => {
    const found = w.service.ops.spaces().find((x) => x.id === s.space)?.reader;
    if (found === undefined) throw new Error("The space is not served");
    return found;
  };
  return {
    // From the space as it is when the sequence starts: the first batch is the first step's.
    open: async () => {
      const session = await inner.open();
      return { ...session, seq: (await readSnapshot(reader(session), undefined, 0)).cursor.seq };
    },
    step: (s, step) => inner.step(s, step),
    seen: async (s) => {
      const read = await readSnapshot(reader(s), undefined, 0);
      // Tasks at one position under different parents come in the order of their random IDs; a
      // page places each under its parent, so they are compared in the order they were made.
      const byRef = (row: { ref?: unknown }) => Number(String(row.ref).split("-")[1]);
      // Projects at one position in different areas, likewise, so nodes are compared by title.
      const snapshot = {
        ...read,
        tasks: [...read.tasks].sort((a, b) => byRef(a) - byRef(b)),
        nodes: [...read.nodes].sort((a, b) => a.title.localeCompare(b.title)),
      };
      const { batch } = await readBatch(reader(s), s.seq);
      s.seq = snapshot.cursor.seq;
      // The batch since the step before.
      return normal({ snapshot, batch }, s);
    },
    close: () => undefined,
  };
};

/** What the page's feed sends of a tree space: the tree from the tree, and each change. */
const FEED: Sequence<Step> = [
  {
    op: "task.add",
    input: { tasks: [{ title: "Fix the gate", area: "Garden", project: "Fence" }] },
    as: "gate",
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "Water the beds", area: "Garden" }] }, as: "beds" },
  {
    op: "task.update",
    input: { task: "{beds}", set: { title: "Water the raised beds", priority: 2 } },
    base: true,
    user: true,
  },
  { op: "entry.add", input: { task: "{gate}", kind: "question", text: "Which paint?" } },
  { op: "task.finish", input: { task: "{beds}", outcome: "Watered" }, base: true, user: true },
  { op: "task.delete", input: { tasks: ["{gate}"] }, base: true, user: true },
];

const manage = (input: Record<string, unknown>, more: Partial<Step> = {}): Step => ({
  op: "folder.manage",
  input,
  user: true,
  ...more,
});

/** The feed's rows of a task with a folder of its own and one in a project with a folder. */
const FEED_FOLDERS: Sequence<Step> = [
  manage({ action: "add_project", project: "Fence", area: "Garden", folder: "{dir:fence}" }),
  {
    op: "task.add",
    input: { tasks: [{ title: "Fix the gate", area: "Garden", project: "Fence" }] },
    as: "gate",
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "Order the paint" }] }, as: "paint", user: true },
  manage({ action: "set", task: "{paint}", folder: "{dir:paint}" }, { base: true }),
  manage({ action: "set", project: "Garden/Fence", folder: "{dir:fence-2}" }, { base: true }),
  manage({ action: "clear", task: "{paint}" }, { base: true }),
  manage({ action: "clear", project: "Garden/Fence" }, { base: true }),
];

describe("[S2.replay.feed] the feed of both backends: the snapshot and each batch", () => {
  test(
    "the tree of areas and projects, a task's row, a question waiting, a finish and the Trash",
    async () => {
      // A space of each backend of its own: the feed sends all of a space, and the order of what
      // other sequences left at one position or one instant is chance.
      const spaces = await newSpaces(w, "feed");
      try {
        await both(
          { today: feedBackend(() => spaces.today), tree: feedBackend(() => spaces.tree) },
          FEED,
        );
      } finally {
        await spaces.close();
      }
    },
    LONG,
  );

  test(
    "a task's row with its project's folder and with its own, as each is set, changed and cleared",
    async () => {
      const spaces = await newSpaces(w, "feed-folders");
      try {
        await both(
          { today: feedBackend(() => spaces.today), tree: feedBackend(() => spaces.tree) },
          FEED_FOLDERS,
        );
      } finally {
        await spaces.close();
      }
    },
    LONG,
  );
});

/** Folders on a project and a task, as the page and the folder tests send them. */
const FOLDERS: Sequence<Step> = [
  manage({ action: "add_project", project: "Holder", area: "Home", folder: "{dir:held}" }),
  // Another project for the same folder names the first, and its lost reply is answered again.
  manage({ action: "add_project", project: "Second", area: "Home", folder: "{dir:held}" }),
  manage(
    { action: "add_project", project: "Second", area: "Home", folder: "{dir:held}" },
    { again: 2 },
  ),
  // Asked again under a new ID: the project of that name in that area has the folder already.
  manage({ action: "add_project", project: "Second", area: "Home", folder: "{dir:held}" }),
  // A project named after its folder, in a new area.
  manage({ action: "add_project", area: "Garden", folder: "{dir:shed}" }),
  // A draft's folder files it: in the one project that has it, with a folder of its own when it
  // is inside the project's; in none when two projects share it.
  {
    op: "task.add",
    input: {
      tasks: [
        { title: "On the bench", folder: "{dir:shed/bench}" },
        { title: "In the shed", folder: "{dir:shed}" },
        { title: "Inside the held folder", folder: "{dir:held/inner}" },
      ],
    },
    user: true,
  },
  { op: "task.add", input: { tasks: [{ title: "Sorted later" }] }, as: "t" },
  manage({ action: "set", task: "{t}", folder: "{dir:held/own}" }, { base: true }),
  // An agent's draft in its working folder, and its search from there.
  {
    op: "task.add",
    input: { tasks: [{ title: "From the shed", folder: "cwd" }], cwd: "{dir:shed}" },
    as: "cwd",
  },
  { op: "task.search", input: { q: "on:cwd", cwd: "{dir:shed}" } },
  { op: "task.search", input: { q: "on:this-machine" }, user: true },
  { op: "task.search", input: { q: "folder:cwd", cwd: "{dir:held}" } },
  { op: "task.search", input: { q: "has:folder" }, user: true },
  // A project's folder set elsewhere: the folders inside the old one stay, and are named.
  manage({ action: "set", project: "Home/Holder", folder: "{dir:elsewhere}" }, { base: true }),
  // The person moved a folder on disk, then says where it is: the folders inside it move along.
  manage(
    { action: "set", project: "Garden/shed", folder: "{dir:barn}" },
    { base: true, moved: ["shed", "barn"] },
  ),
  {
    op: "task.update",
    input: { task: "{t}", set: { folder: "{dir:own}" } },
    base: true,
    user: true,
  },
  { op: "task.update", input: { task: "{t}", clear: ["folder"] }, base: true, user: true },
  { op: "task.update", input: { task: "{t}", clear: ["folder"] }, base: true, user: true },
  manage({ action: "clear", task: "{cwd}" }, { base: true }),
  manage({ action: "clear", project: "Holder" }, { base: true }),
  manage({ action: "clear", project: "Holder" }, { base: true }),
  // A project's folder set from a read before its last change is a conflict.
  manage({ action: "set", project: "Second", folder: "{dir:second}" }, { base: true }),
  manage({ action: "set", project: "Second", folder: "{dir:third}" }, { stale: true }),
  // A folder that is not there, and a project the space lacks.
  manage({ action: "set", project: "Second", folder: "{dir:held}/missing" }, { base: true }),
  manage({ action: "set", project: "Nowhere", folder: "{dir:held}" }, { base: true }),
  // A project made for a folder is one step: its Undo, and its Redo. Undone, the project is
  // archived and keeps its folder, which another project made for that folder then names.
  manage({ action: "add_project", project: "Tried", area: "Home", folder: "{dir:tried}" }),
  { op: "history.undo", input: {}, user: true },
  { op: "history.redo", input: {}, user: true },
  { op: "history.undo", input: {}, user: true },
  manage({ action: "add_project", project: "Again", area: "Home", folder: "{dir:tried}" }),
  { op: "task.add", input: { tasks: [{ title: "Tried here", folder: "{dir:tried}" }] } },
];

describe("[S2.replay.folders] today's service requests through both backends: folders", () => {
  test(
    "a project made for a folder, another for the same folder, drafts filed by their folders, an agent's working folder, a project's folder set elsewhere and moved on disk, a task's set and cleared, a stale set, Undo and Redo",
    async () => {
      await replay(FOLDERS);
    },
    LONG,
  );

  // Where the backends differ by decision: today's project without an area takes a folder. The
  // tree keeps such a project at the top, read as an area, which has no folder under today's names.
  test(
    "a project at the top of a tree space is refused a folder by name, and nothing is made",
    async () => {
      const side = backend(w.service.ops, () => tree);
      const session = await side.open();
      const alone = { action: "add_project", project: "Alone", folder: "{dir:alone}" };
      expect(await side.step(session, manage(alone))).toMatchObject({
        status: "error",
        code: "invalid_input",
        said: { data: { field: "project" } },
      });
      expect(
        await side.step(session, { op: "page.read", input: { target: "Alone" } }),
      ).toMatchObject({ status: "error", code: "not_found" });
      expect(await side.seen(session)).toEqual({ "marker alone": [] });
      // One it has already, made by a draft that names no area: the same sentence, and no folder.
      await side.step(session, {
        op: "task.add",
        input: { tasks: [{ title: "x", project: "Sole" }] },
      });
      for (const step of [
        manage(alone),
        manage({ action: "set", project: "Sole", folder: "{dir:alone}" }, { base: true }),
      ]) {
        const refused = await side.step(session, step);
        expect(refused).toMatchObject({ status: "error", code: "invalid_input" });
        expect((refused.said as { message: string }).message).toContain(NO_TOP_FOLDER);
      }
      expect(((await side.seen(session)) as Record<string, unknown>)["marker alone"]).toEqual([]);
    },
    LONG,
  );
});

/** A sequence in a new space of each backend: what it sets is the space's, for every later read. */
async function replayIn(name: string, steps: Sequence<Step>): Promise<void> {
  const spaces = await newSpaces(w, name);
  try {
    await both(
      {
        today: backend(w.service.ops, () => spaces.today),
        tree: backend(w.service.ops, () => spaces.tree),
      },
      steps,
    );
  } finally {
    await spaces.close();
  }
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * More folders inside a moved one than an answer names, made in another order than their paths,
 * and four tasks that share one folder: the answer names the first twenty by path, the tasks of
 * one folder by their references, and the same ones when the request is sent again.
 */
const MANY: Sequence<Step> = [
  manage({ action: "add_project", project: "Big", area: "Home", folder: "{dir:big}" }),
  {
    op: "task.add",
    input: {
      tasks: [
        ...Array.from({ length: 21 }, (_, k) => ({
          title: `Part ${two(21 - k)}`,
          folder: `{dir:big/sub${two(21 - k)}}`,
        })),
        ...Array.from({ length: 4 }, (_, k) => ({
          title: `Shared ${String(k + 1)}`,
          folder: "{dir:big/shared}",
        })),
      ],
    },
    user: true,
  },
  // Moved on disk: all of them move along. Then set elsewhere: all of them stay.
  manage(
    { action: "set", project: "Home/Big", folder: "{dir:bigger}" },
    { base: true, retry: true, moved: ["big", "bigger"] },
  ),
  manage(
    { action: "set", project: "Home/Big", folder: "{dir:big-elsewhere}" },
    { base: true, retry: true },
  ),
];

describe("[S2.replay.folders] today's service requests through both backends: many folders inside one", () => {
  test(
    "a move with more folders inside than an answer names, taken along and left: the same twenty by path when it is sent again, and the tasks of one folder by their references",
    async () => {
      await replayIn("many-folders", MANY);
    },
    LONG,
  );
});
