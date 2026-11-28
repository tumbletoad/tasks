// The generated replay (piece iii): random ordinary sequences of the calls of the families on a
// tree space, sent to a new space of each backend and compared by the replay's strict helper
// (replay-helpers.ts), so the sequences are not the ones a person thought of. A write is sometimes
// sent twice under one request ID, its second answer held to the first, and sometimes from a stale
// base; every task an answer names is read after each step, and every node a read hands out.
//
// The vocabulary is the list of step makers below, one per call. Each family that moves to the tree
// adds its calls here. What the backends differ in by decision is left out of it, each with its
// reason: a project without an area (S2.replay.projects marks it), a node's history (marked in
// S2.replay.reviewed), and a task's history section (refused on a tree for now). One difference
// the sequences meet is left out of both answers (`KNOWN`).
//
// A failure prints its seed; FC_SEED replays it, and FC_RUNS sets how many sequences run.
// Fixture text only.
import fc from "fast-check";
import { afterAll, beforeAll, describe, onTestFailed, test } from "vitest";
import { both, type Answer, type Sequence, type Side } from "../../storage/test/both-helpers.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { backend, newSpaces, type Session, type Step } from "./replay-helpers.ts";

const LONG = 600_000;
let w: ContractWorld & { root: string };

beforeAll(async () => {
  w = await contractWorld("replay-prop");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/**
 * The marks of the generated replay: what the backends answer differently by decision, taken out
 * of both answers. Today's task row has an `owner`, which nothing in the product writes and the
 * tree does not keep, so a conflict on every field of a task names it only today.
 */
function known(answer: Answer): Answer {
  const said = answer.said as { data?: { conflicts?: { field?: string }[] } } | undefined;
  const conflicts = said?.data?.conflicts;
  if (said?.data === undefined || conflicts === undefined) return answer;
  const kept = conflicts.filter((c) => c.field !== "owner");
  return { ...answer, said: { ...said, data: { ...said.data, conflicts: kept } } };
}

const marked = (side: Side<Step, Session>): Side<Step, Session> => ({
  ...side,
  step: async (s, step) => known(await side.step(s, step)),
});

/** The names steps give what they make, and refer to: a name nothing made yet is not found. */
const TASKS = ["t0", "t1", "t2", "t3"] as const;
const ENTRIES = ["e0", "e1", "e2"] as const;
const PAGES = ["g0", "g1"] as const;

const task = fc.constantFrom(...TASKS);
const entry = fc.constantFrom(...ENTRIES);
const page = fc.constantFrom(...PAGES);
const title = fc.constantFrom(
  "Renew the passport",
  "Fix the gate",
  "Pay the invoice",
  "Call the bank",
);
const words = fc.constantFrom(
  "Bring a photo",
  "Ask the office",
  "Paint it green",
  "Done by Friday",
);
/** A group by today's names: a project always in an area. */
const group = fc.constantFrom(
  {},
  { area: "Home" },
  { area: "Garden" },
  { area: "Home", project: "Papers" },
  { area: "Garden", project: "Fence" },
);
const who = fc.record({ user: fc.boolean() }).map((r) => (r.user ? { user: true as const } : {}));
/** How a write is sent: from the latest read or a stale one, once or twice. */
const sent = fc.record({ stale: fc.boolean(), retry: fc.boolean() }).map((r) => ({
  base: true as const,
  ...(r.stale ? { stale: true as const } : {}),
  ...(r.retry ? { retry: true as const } : {}),
}));

const add = fc
  .record({
    as: task,
    title,
    group,
    due: fc.option(fc.constantFrom("2026-12-01", "tomorrow"), { nil: undefined }),
    focus: fc.boolean(),
    waiting: fc.option(fc.constantFrom("The bank", "A reply"), { nil: undefined }),
    key: fc.option(fc.constantFrom("fixture:gen-1", "fixture:gen-2"), { nil: undefined }),
    log: fc.option(words, { nil: undefined }),
    who,
    retry: fc.boolean(),
  })
  .map((r): Step => ({
    op: "task.add",
    input: {
      tasks: [
        {
          title: r.title,
          ...r.group,
          ...(r.due === undefined ? {} : { due: r.due }),
          ...(r.focus ? { focus: true } : {}),
          ...(r.waiting === undefined ? {} : { waiting_on: r.waiting }),
          ...(r.key === undefined
            ? {}
            : { sources: [{ key: r.key, kind: "ticket", title: "Fixture ticket" }] }),
          ...(r.log === undefined ? {} : { log: r.log }),
        },
      ],
    },
    as: r.as,
    ...r.who,
    ...(r.retry ? { retry: true } : {}),
  }));

const update = fc
  .record({
    task,
    change: fc.oneof(
      title.map((t) => ({ set: { title: t } })),
      words.map((t) => ({ set: { summary: t } })),
      fc.integer({ min: 1, max: 4 }).map((p) => ({ set: { priority: p } })),
      fc.constantFrom("open", "waiting").map((st) => ({ set: { status: st } })),
      group.map((g) => ({ set: g })),
      fc.constantFrom("2026-12-05", "+3d").map((d) => ({ set: { due: d } })),
      fc.boolean().map((f) => ({ set: { focus: f } })),
      fc.constant({ clear: ["due", "waiting_on"] }),
    ),
    who,
    sent,
  })
  .map((r): Step => ({
    op: "task.update",
    input: { task: `{${r.task}}`, ...r.change },
    ...r.who,
    ...r.sent,
  }));

const finish = fc
  .record({ task, dropped: fc.boolean(), outcome: fc.option(words, { nil: undefined }), who, sent })
  .map((r): Step => ({
    op: "task.finish",
    input: {
      task: `{${r.task}}`,
      ...(r.dropped ? { status: "dropped" } : {}),
      ...(r.outcome === undefined ? {} : { outcome: r.outcome }),
    },
    ...r.who,
    ...r.sent,
  }));

const reopen = fc
  .record({ task, sent })
  .map((r): Step => ({ op: "task.reopen", input: { task: `{${r.task}}` }, user: true, ...r.sent }));

/** Tasks to the Trash, or back, in the order a person selects them. */
const trash = fc
  .record({
    tasks: fc.shuffledSubarray([...TASKS], { minLength: 1, maxLength: 3 }),
    restore: fc.boolean(),
    sent,
  })
  .map((r): Step => ({
    op: "task.delete",
    input: { tasks: r.tasks.map((t) => `{${t}}`), ...(r.restore ? { restore: true } : {}) },
    user: true,
    ...r.sent,
  }));

const entryAdd = fc
  .record({
    task,
    as: entry,
    kind: fc.constantFrom("note", "progress", "question"),
    text: words,
    agents: fc.boolean(),
    who,
  })
  .map((r): Step => ({
    op: "entry.add",
    input: {
      task: `{${r.task}}`,
      kind: r.kind,
      text: r.text,
      ...(r.agents && r.kind === "note" ? { for_agents: true } : {}),
    },
    entry: r.as,
    ...r.who,
  }));

/** A person's edit of an entry, live or removed, and its removal and putting back. */
const entryChange = fc
  .record({ task, entry, action: fc.constantFrom("edit", "remove", "put_back"), text: words, sent })
  .map((r): Step =>
    r.action === "edit"
      ? {
          op: "entry.edit",
          input: { task: `{${r.task}}`, entry: `{${r.entry}}`, text: r.text },
          user: true,
          ...r.sent,
        }
      : {
          op: "note.remove",
          input: { task: `{${r.task}}`, [r.action]: `{${r.entry}}` },
          user: true,
          ...r.sent,
        },
  );

const history = fc.record({ redo: fc.boolean(), check: fc.boolean() }).map((r): Step => ({
  op: r.redo ? "history.redo" : "history.undo",
  input: r.check && !r.redo ? { check_script: true } : {},
  user: true,
}));

const pageCreate = fc.record({ task, as: page, title, body: words }).map((r): Step => ({
  op: "page.write",
  input: {
    action: "create",
    task: `{${r.task}}`,
    title: r.title,
    brief: "What it holds",
    body: `## Notes\n\n${r.body}.`,
    why: "kept for later",
  },
  page: r.as,
}));

const pageChange = fc
  .record({
    page,
    change: fc.oneof(
      words.map((t) => ({ action: "edit", old: "Bring a photo.", new: `${t}.` })),
      words.map((t) => ({ action: "append", text: `${t}.` })),
      fc.constantFrom("space", "Home", "Home/Papers").map((to) => ({ action: "move", to })),
      fc.constant({ action: "trash" }),
      fc.constant({ action: "restore" }),
    ),
  })
  .map((r): Step => ({
    op: "page.write",
    input: { target: `{${r.page}}`, ...r.change, why: "a change" },
  }));

const pageSet = fc.record({ page, title, sent }).map((r): Step => ({
  op: "page.write",
  input: { action: "set", target: `{${r.page}}`, title: r.title },
  user: true,
  ...r.sent,
}));

const pageRead = fc.record({ page, history: fc.boolean() }).map((r): Step => ({
  op: r.history ? "page.history" : "page.read",
  input: { target: `{${r.page}}` },
  user: true,
}));

const instruct = fc
  .record({ target: fc.constantFrom("space", "Home"), text: words, sent })
  .map((r): Step => ({
    op: "node.instruct",
    input: { target: r.target, text: r.text },
    user: true,
    ...r.sent,
  }));

const sections = task.map((t): Step => ({
  op: "task.get",
  input: { task: `{${t}}`, sections: ["context", "notes", "log", "sources", "outcome"] },
}));

/** The reads: a search by words and the filters a tree answers, the finished list, the status. */
const reads = fc.oneof(
  fc
    .constantFrom(
      "photo",
      "passport OR invoice",
      "status:waiting",
      "due<2026-12-05",
      "area:Home",
      "project:Papers",
      "is:inbox",
      "is:focus",
      "is:completed",
      "bank -photo",
    )
    .map((q): Step => ({ op: "task.search", input: { q }, user: true })),
  fc.constant<Step>({ op: "task.finished", input: {}, user: true }),
  fc.constant<Step>({ op: "space.status", input: {}, user: true }),
);

/** The vocabulary: one maker per call of the families on a tree space. */
const VOCABULARY: fc.Arbitrary<Step>[] = [
  add,
  update,
  finish,
  reopen,
  trash,
  entryAdd,
  entryChange,
  history,
  pageCreate,
  pageChange,
  pageSet,
  pageRead,
  instruct,
  sections,
  reads,
];

/** A sequence starts by making something to act on. */
const sequence: fc.Arbitrary<Step[]> = fc
  .tuple(add, fc.array(fc.oneof(...VOCABULARY), { minLength: 3, maxLength: 16 }))
  .map(([first, rest]) => [first, ...rest]);

describe("[S2.replay.generated] random ordinary sequences of the tree's families through both backends", () => {
  test(
    "each sequence answers and reads the same on both, by the strict comparison",
    async () => {
      const seed = Number(process.env["FC_SEED"] ?? Math.floor(Math.random() * 2 ** 31));
      onTestFailed(() => {
        console.error(`Replay with FC_SEED=${String(seed)}`);
      });
      let n = 0;
      await fc.assert(
        fc.asyncProperty(sequence, async (steps) => {
          n += 1;
          const spaces = await newSpaces(w, `gen-${String(n)}`);
          await both(
            {
              today: marked(backend(w.service.ops, () => spaces.today)),
              tree: marked(backend(w.service.ops, () => spaces.tree)),
            },
            steps as Sequence<Step>,
          );
        }),
        { seed, numRuns: Number(process.env["FC_RUNS"] ?? 6), endOnFailure: true },
      );
    },
    LONG,
  );
});
