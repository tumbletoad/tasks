// The generated replay (piece iii): random ordinary sequences of the calls of the families on a
// tree space, sent to a new space of each backend and compared by the replay's strict helper
// (replay-helpers.ts), so the sequences are not the ones a person thought of. A write is sometimes
// sent twice under one request ID, its second answer held to the first, and sometimes from a stale
// base; every task an answer names is read after each step, and every node a read hands out.
//
// The vocabulary is the list of step makers below, one per call. Each family that moves to the tree
// adds its calls here. What the backends differ in by decision is left out of it, each with its
// reason: a project without an area (S2.replay.projects marks it, and S2.replay.folders holds the
// folder the tree refuses it), a node's history (marked in S2.replay.reviewed), and a task's
// history section (refused on a tree for now). What the sequences meet that differs by decision is
// left out of both sides (`known`, `marked`).
//
// CI runs a fixed list of seeds, 13 sequences each, about a minute (`SEEDS`). A failure prints its
// seed; FC_SEED runs one seed and FC_RUNS sets how many sequences it runs. The nightly deep job runs
// a new seed with 300.
// Fixture text only.
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, onTestFailed, test } from "vitest";
import { both, type Answer, type Sequence, type Side } from "../../storage/test/both-helpers.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";
import { backend, foldersUnder, newSpaces, type Session, type Step } from "./replay-helpers.ts";

/** The nightly deep job's 300 sequences take minutes. */
const LONG = process.env["TTASKS_DEEP"] === "1" ? 3_600_000 : 600_000;
let w: ContractWorld & { root: string };

beforeAll(async () => {
  w = await contractWorld("replay-prop");
  foldersUnder(join(w.root, "work", "replay"));
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
  // When a step is refused, only that it is refused is compared, with what a reader sees after
  // it: which refusal is named when several apply is each writer's own order, and the written
  // sequences hold the ones a person meets.
  if (answer.status === "error") return { status: "error" };
  const said = answer.said as { data?: { conflicts?: { field?: string }[] } } | undefined;
  const conflicts = said?.data?.conflicts;
  if (said?.data === undefined || conflicts === undefined) return answer;
  const kept = conflicts.filter((c) => c.field !== "owner");
  return { ...answer, said: { ...said, data: { ...said.data, conflicts: kept } } };
}

/**
 * Today's writer leaves a task's source link removed when the task comes back from the Trash by
 * Undo; the tree keeps it, and today's writer goes at the switch. So a task's sources are not
 * compared once a step of the sequence put it in the Trash; every other task's are.
 */
const trashed = new WeakMap<Session, Set<string>>();

function trashedOf(s: Session): Set<string> {
  let names = trashed.get(s);
  if (names === undefined) {
    names = new Set();
    trashed.set(s, names);
  }
  return names;
}

function withoutTrashedSources(s: Session, seen: unknown): unknown {
  const read = { ...(seen as Record<string, unknown>) };
  for (const name of trashedOf(s)) {
    const one = read[name] as { task?: Record<string, unknown> } | undefined;
    if (one?.task === undefined) continue;
    const task: Record<string, unknown> = { ...one.task };
    delete task["sources"];
    const more = task["more"] as Record<string, unknown> | undefined;
    read[name] = {
      ...one,
      task: { ...task, ...(more === undefined ? {} : { more: { ...more, sources: "<marked>" } }) },
    };
  }
  return read;
}

const marked = (side: Side<Step, Session>): Side<Step, Session> => ({
  ...side,
  step: async (s, step) => {
    const answer = known(await side.step(s, step));
    if (step.op === "task.delete" && step.input["restore"] !== true) {
      for (const key of (step.input["tasks"] as string[] | undefined) ?? []) {
        trashedOf(s).add(key.replace(/^\{(\w+)\}$/u, "$1"));
      }
    }
    return answer;
  },
  seen: async (s) => withoutTrashedSources(s, await side.seen(s)),
});

/**
 * The seeds CI runs, the same every run, so a pull request that changes nothing here never meets
 * a new sequence by chance: those run wide by hand, and one a run found. FC_SEED runs one seed of
 * its own; the nightly deep job (TTASKS_DEEP=1) runs a new seed with 300 sequences.
 */
const SEEDS = [271828, 99991, 424242, 1001, 55555, 1900855630];
const DEEP = process.env["TTASKS_DEEP"] === "1";

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
/** A size a task takes: levels a space has at first, and one only a changed list has. */
const size = fc.constantFrom("S", "M", "XL", "Huge");
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
    effort: fc.option(size, { nil: undefined }),
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
          ...(r.effort === undefined ? {} : { effort: r.effort }),
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
      size.map((effort) => ({ set: { effort } })),
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
      "is:overdue",
      "bank -photo",
      "Home passport",
      "gate Garden",
      "id:{t0}",
      "id:{t1}",
    )
    .chain((q) => who.map((by): Step => ({ op: "task.search", input: { q }, ...by }))),
  fc.constant<Step>({ op: "task.finished", input: {}, user: true }),
  fc.constant<Step>({ op: "space.status", input: {}, user: true }),
);

/** A folder of the space's own: a project's, a task's, and one inside another. */
const where = fc.constantFrom("{dir:a}", "{dir:a/inner}", "{dir:b}", "{dir:c}");
/** A project a folder call names: by its name, which two areas may both have, or by its path. */
const holder = fc.constantFrom("Holder", "Second", "Home/Holder", "Garden/Second", "Home/Papers");

/** A draft filed by its folder, or by the caller's working folder, sometimes sent twice. */
const filed = fc
  .record({ as: task, title, folder: where, cwd: fc.boolean(), who, retry: fc.boolean() })
  .map((r): Step => ({
    op: "task.add",
    input: {
      tasks: [{ title: r.title, folder: r.cwd ? "cwd" : r.folder }],
      ...(r.cwd ? { cwd: r.folder } : {}),
    },
    as: r.as,
    ...r.who,
    ...(r.retry ? { retry: true } : {}),
  }));

/**
 * Folders: a project made for a folder, always in an area as the page makes one; a project's or a
 * task's set and cleared, also after the person moved the folder on disk; a draft filed by its
 * folder; and the searches that read folders.
 */
const folders = fc.oneof(
  fc
    .record({
      project: fc.option(fc.constantFrom("Holder", "Second"), { nil: undefined }),
      area: fc.constantFrom("Home", "Garden"),
      folder: where,
      retry: fc.boolean(),
    })
    .map((r): Step => ({
      op: "folder.manage",
      input: {
        action: "add_project",
        ...(r.project === undefined ? {} : { project: r.project }),
        area: r.area,
        folder: r.folder,
      },
      user: true,
      ...(r.retry ? { retry: true } : {}),
    })),
  fc
    .record({
      owner: fc.oneof(
        holder.map((project) => ({ project })),
        task.map((t) => ({ task: `{${t}}` })),
      ),
      folder: fc.option(where, { nil: undefined }),
      moved: fc.option(fc.constantFrom(["a", "b"] as const, ["b", "c"] as const), {
        nil: undefined,
      }),
      sent,
    })
    .map((r): Step => ({
      op: "folder.manage",
      input:
        r.folder === undefined
          ? { action: "clear", ...r.owner }
          : { action: "set", ...r.owner, folder: r.folder },
      user: true,
      ...(r.folder !== undefined && r.moved !== undefined ? { moved: r.moved } : {}),
      ...r.sent,
    })),
  fc.record({ task, folder: fc.option(where, { nil: undefined }), who, sent }).map((r): Step => ({
    op: "task.update",
    input:
      r.folder === undefined
        ? { task: `{${r.task}}`, clear: ["folder"] }
        : { task: `{${r.task}}`, set: { folder: r.folder } },
    ...r.who,
    ...r.sent,
  })),
  filed,
  fc
    .record({
      q: fc.constantFrom("has:folder", "on:this-machine", "on:cwd", "folder:cwd", "folder:{dir:a}"),
      cwd: where,
      who,
    })
    .map((r): Step => ({ op: "task.search", input: { q: r.q, cwd: r.cwd }, ...r.who })),
);

/**
 * Preferences: the keys read, a number set and reset, and the effort levels changed, with or
 * without the moves of the tasks on a level the change drops, as a preview or for real.
 */
const preferences = fc.oneof(
  fc
    .record({ action: fc.constantFrom("get", "describe"), who })
    .map((r): Step => ({ op: "prefs.manage", input: { action: r.action }, ...r.who })),
  fc
    .record({
      change: fc.oneof(
        fc.constantFrom(7, 30, "21").map((value) => ({ value })),
        fc.constant({ reset: true }),
      ),
      who,
      sent,
    })
    .map((r): Step => ({
      op: "prefs.manage",
      input: { action: "set", set: [{ key: "tasks.dedupe_window_days", ...r.change }] },
      ...r.who,
      ...r.sent,
    })),
  fc
    .record({
      change: fc.oneof(
        fc
          .constantFrom("XS, S, M, L, XL, Huge", "S, M, L", "M, S, Huge", "XS, S, M, L, XL")
          .map((value) => ({ value })),
        fc.constant({ reset: true }),
      ),
      moves: fc.option(
        fc.subarray(
          [
            { from: "XS", to: "S" },
            { from: "XL", to: "Huge" },
            { from: "XL", to: null },
            { from: "Huge", to: "M" },
            { from: "L", to: "M" },
          ],
          { minLength: 1 },
        ),
        { nil: undefined },
      ),
      preview: fc.boolean(),
      sent,
    })
    .map((r): Step => ({
      op: "prefs.manage",
      input: {
        action: "set",
        set: [
          {
            key: "tasks.effort_scale",
            ...r.change,
            ...(r.moves === undefined ? {} : { moves: r.moves }),
          },
        ],
        ...(r.preview ? { dry_run: true } : {}),
      },
      user: true,
      ...r.sent,
    })),
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
  folders,
  preferences,
];

/** Steps that come together: a draft filed by its folder and sent twice, then Undo or Redo. */
const filedThenHistory: fc.Arbitrary<Step[]> = fc
  .tuple(filed, history)
  .map(([draft, after]) => [{ ...draft, retry: true }, after]);

/** A sequence starts by making something to act on. */
const sequence: fc.Arbitrary<Step[]> = fc
  .tuple(
    add,
    fc.array(fc.oneof(...VOCABULARY.map((one) => one.map((step) => [step])), filedThenHistory), {
      minLength: 3,
      maxLength: 16,
    }),
  )
  .map(([first, rest]) => [first, ...rest.flat()]);

describe("[S2.replay.generated] random ordinary sequences of the tree's families through both backends", () => {
  test(
    "each sequence answers and reads the same on both, by the strict comparison",
    async () => {
      const given = process.env["FC_SEED"];
      const seeds =
        given !== undefined
          ? [Number(given)]
          : DEEP
            ? [Math.floor(Math.random() * 2 ** 31)]
            : SEEDS;
      const runs = Number(process.env["FC_RUNS"] ?? (DEEP ? 300 : given !== undefined ? 80 : 13));
      let seed = 0;
      onTestFailed(() => {
        console.error(`Replay with FC_SEED=${String(seed)} FC_RUNS=${String(runs)}`);
      });
      let n = 0;
      for (seed of seeds) {
        await fc.assert(
          fc.asyncProperty(sequence, async (steps) => {
            n += 1;
            const spaces = await newSpaces(w, `gen-${String(n)}`);
            try {
              await both(
                {
                  today: marked(backend(w.service.ops, () => spaces.today)),
                  tree: marked(backend(w.service.ops, () => spaces.tree)),
                },
                steps as Sequence<Step>,
              );
            } finally {
              await spaces.close();
            }
          }),
          { seed, numRuns: runs, endOnFailure: true },
        );
      }
    },
    LONG,
  );
});
