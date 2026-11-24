// A person working alone can always undo everything they did, one step at a time, and redo it
// (A1 3.10.1). One person creates tasks, files them into areas and projects, moves and reorders
// them, checks them off, reopens and archives them, moves them to the Trash and back, adds notes,
// folders and tickets, makes areas and projects and moves and removes them, often several of these
// in one request. In between, and between their undos and redos, they queue runs and open
// sessions, which are no steps on their stack. No one else writes. Then they undo until nothing is
// left and redo until nothing is left: every Undo and Redo applies whole, the space after the last
// Undo is the space before the first step, and after the last Redo the space after the last step,
// the order of every list included. The rules every write keeps (space-rules.ts) are checked after
// every write. A run keeps its task's create (undo-runs.test.ts), so runs go on the tasks that
// were there before the first step. Each ticket goes to one task: while two tasks hold one key,
// an Undo or Redo never brings a link of it back, also when the person linked both, a limit for
// now. Fixture text and paths only.
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { tempFolders } from "./space-helpers.ts";
import { checkSpace, listsOf, type SpaceState } from "./space-rules.ts";
import { checkHistory, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("undo-alone");
// Each run gets its own copy of one fixture space, made once.
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

/** Tasks in the Inbox and in the fixture's project before the first step. */
const INBOX = 4;
const IN_PROJECT = 2;
const PATHS = ["~/work/a", "~/work/a/x", "~/work/b"] as const;

/** A row by index among those there are, modulo their number. */
type Forward =
  /** A new task in the Inbox, in a project, or right before or after another task. */
  | { kind: "create"; where: "inbox" | "project" | "before" | "after"; at: number }
  | { kind: "move"; t: number; to: number }
  | { kind: "beside"; t: number; s: number; side: "before" | "after" }
  | { kind: "complete" | "reopen" | "archive" | "delete" | "restore" | "note"; t: number }
  | { kind: "folder"; owner: "task" | "project"; at: number; path: number; clear: boolean }
  /** The task's own ticket, linked once more or for the first time. */
  | { kind: "ticket"; t: number }
  /** A new area, a project in it and a task in that. */
  | { kind: "file" }
  | { kind: "regroup"; p: number; a: number }
  | { kind: "project_delete" | "project_restore"; p: number };

/** What the person does that is on no stack. */
type Aside = { kind: "run" | "session"; t: number };

type Step = Forward | { kind: "batch"; steps: readonly Forward[] } | Aside;

const isAside = (s: Step): s is Aside => s.kind === "run" || s.kind === "session";

const n = fc.nat({ max: 40 });
const forward: fc.Arbitrary<Forward> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      where: fc.constantFrom(
        "inbox" as const,
        "project" as const,
        "before" as const,
        "after" as const,
      ),
      at: n,
    }),
    weight: 4,
  },
  { arbitrary: fc.record({ kind: fc.constant("move" as const), t: n, to: n }), weight: 4 },
  {
    arbitrary: fc.record({
      kind: fc.constant("beside" as const),
      t: n,
      s: n,
      side: fc.constantFrom("before" as const, "after" as const),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "complete" as const,
        "reopen" as const,
        "archive" as const,
        "delete" as const,
        "restore" as const,
        "note" as const,
      ),
      t: n,
    }),
    weight: 6,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("folder" as const),
      owner: fc.constantFrom("task" as const, "project" as const),
      at: n,
      path: fc.nat({ max: PATHS.length - 1 }),
      clear: fc.boolean(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("ticket" as const), t: n }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant("file" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("regroup" as const), p: n, a: n }), weight: 2 },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom("project_delete" as const, "project_restore" as const),
      p: n,
    }),
    weight: 2,
  },
);
const aside: fc.Arbitrary<Aside> = fc.record({
  kind: fc.constantFrom("run" as const, "session" as const),
  t: n,
});
const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: forward, weight: 12 },
  {
    arbitrary: fc.record({
      kind: fc.constant("batch" as const),
      steps: fc.array(forward, { minLength: 2, maxLength: 4 }),
    }),
    weight: 3,
  },
  { arbitrary: aside, weight: 1 },
);

/** A run: the person's steps, then what they do on no stack between their undos and redos. */
interface Plan {
  readonly steps: readonly Step[];
  /** After the k-th undo or redo of the whole run (undos counted first), these. */
  readonly between: readonly { readonly at: number; readonly aside: Aside }[];
}

const plan: fc.Arbitrary<Plan> = fc.record({
  steps: fc.array(step, { minLength: 3, maxLength: 25 }),
  between: fc.array(fc.record({ at: fc.nat({ max: 60 }), aside }), { maxLength: 4 }),
});

/** Every way a person working alone once could not undo or redo their own work. */
const CASES: readonly Plan[] = [
  // A task made, moved to a project, and another made where it stood.
  {
    steps: [
      { kind: "create", where: "inbox", at: 0 },
      { kind: "move", t: INBOX + IN_PROJECT, to: 0 },
      { kind: "create", where: "inbox", at: 0 },
    ],
    between: [],
  },
  // Checked off, reopened, a run queued on it: the reopen's undo.
  {
    steps: [
      { kind: "complete", t: 0 },
      { kind: "reopen", t: 0 },
      { kind: "run", t: 0 },
    ],
    between: [],
  },
  // Archived, the archive undone, a run queued, the archive redone.
  { steps: [{ kind: "archive", t: 1 }], between: [{ at: 1, aside: { kind: "run", t: 1 } }] },
  // Moved to the Trash, the move undone, a session opened, the move redone.
  { steps: [{ kind: "delete", t: 2 }], between: [{ at: 1, aside: { kind: "session", t: 2 } }] },
  // A step that moves several tasks while one takes another's old place: Undo and Redo give
  // the order back. A, B, C are the first three of the Inbox.
  {
    steps: [
      { kind: "create", where: "before", at: 1 },
      { kind: "create", where: "before", at: INBOX + IN_PROJECT },
      { kind: "move", t: INBOX + IN_PROJECT, to: 0 },
      {
        kind: "batch",
        steps: [
          { kind: "move", t: 0, to: 0 },
          { kind: "move", t: INBOX + IN_PROJECT + 1, to: 0 },
          { kind: "beside", t: 2, s: 1, side: "before" },
        ],
      },
    ],
    between: [],
  },
  // A project moved, then a task made in it: the move's undo takes the uncreated task along
  // (seed 1186922805, path "3:3:3:4:4:5:4:4:4:4:6:6:5:5:5:5:5:5:5:5:5:5").
  {
    steps: [
      { kind: "regroup", p: 0, a: 1 },
      { kind: "create", where: "project", at: 0 },
    ],
    between: [],
  },
  // The same in one request (seed -690496115, path "16:3:3:3:3:3:3:3:6:3:3:4:4:4:4:4:4:4:4:4:4").
  {
    steps: [
      {
        kind: "batch",
        steps: [
          { kind: "create", where: "project", at: 0 },
          { kind: "regroup", p: 0, a: 1 },
        ],
      },
    ],
    between: [],
  },
  // A task in the Trash that its project's move took along, redone after a Redo put it back there
  // (seed 974871056, path "17:1:0:1:1:1:6:9:9:6:6:6:6:6:6:6:6").
  {
    steps: [
      { kind: "delete", t: INBOX },
      { kind: "regroup", p: 0, a: 1 },
    ],
    between: [],
  },
  // A note and the move to the Trash in one request (seed 842406740, path
  // "20:2:1:3:5:17:17:14:14:14:14:14:14:14").
  {
    steps: [
      {
        kind: "batch",
        steps: [
          { kind: "note", t: INBOX },
          { kind: "delete", t: INBOX },
        ],
      },
    ],
    between: [],
  },
];

interface World {
  fx: Fixture;
  ui: Credential;
  tasks: Id<"t">[];
  /** The tasks there before the first step: the ones runs and sessions go on. */
  first: number;
  areas: Id<"a">[];
  projects: Id<"p">[];
}

async function world(): Promise<World> {
  const fx = await fixture();
  const spare = newId("p");
  const tasks = Array.from({ length: INBOX + IN_PROJECT }, () => newId("t"));
  const ops: Operation[] = [
    { kind: "project.create", id: spare, title: "Spare", area: fx.areas.home },
    ...tasks.map((id, k): Operation => ({
      kind: "task.create",
      id,
      title: `Fixture task ${String(k + 1)}`,
      ...(k < INBOX ? {} : { project: fx.project }),
    })),
  ];
  const made = fx.writer.submit(fx.request(fx.codex, ops));
  if (made.status !== "applied") throw new Error("the world was not made");
  return {
    fx,
    // The service writes runs and sessions with the person's page credential (R7).
    ui: { ...fx.human, scope_id: "ui:fixture", origin: "ui" },
    tasks,
    first: tasks.length,
    areas: [fx.areas.lumen, fx.areas.home],
    projects: [fx.project, spare],
  };
}

const nth = <T>(rows: readonly T[], k: number): T => {
  const row = rows[k % rows.length];
  if (row === undefined) throw new Error("no rows");
  return row;
};

/** The operations of a forward step; new rows join the world's lists as they are named. */
function opsOf(w: World, s: Forward): Operation[] {
  const task = (k: number): Id<"t"> => nth(w.tasks, k);
  switch (s.kind) {
    case "create": {
      const id = newId("t");
      const title = `Fixture task ${String(w.tasks.length + 1)}`;
      const sibling = task(s.at);
      w.tasks.push(id);
      return [
        {
          kind: "task.create",
          id,
          title,
          ...(s.where === "project"
            ? { project: nth(w.projects, s.at) }
            : s.where === "before"
              ? { before: sibling }
              : s.where === "after"
                ? { after: sibling }
                : {}),
        },
      ];
    }
    case "move": {
      // Into a project, an area outside a project, or the Inbox.
      const to = s.to % (w.projects.length + w.areas.length + 1);
      const target =
        to < w.projects.length
          ? { project: nth(w.projects, to) }
          : to < w.projects.length + w.areas.length
            ? { project: null, area: nth(w.areas, to - w.projects.length) }
            : { project: null, area: null };
      return [{ kind: "task.move", task: task(s.t), ...target }];
    }
    case "beside": {
      const [t, sibling] = [task(s.t), task(s.s)];
      if (t === sibling) return [];
      return [
        s.side === "before"
          ? { kind: "task.move", task: t, before: sibling }
          : { kind: "task.move", task: t, after: sibling },
      ];
    }
    case "complete":
      return [{ kind: "task.complete", task: task(s.t) }];
    case "reopen":
      return [{ kind: "task.reopen", task: task(s.t) }];
    case "archive":
      return [{ kind: "task.archive", task: task(s.t) }];
    case "delete":
      return [{ kind: "task.delete", task: task(s.t) }];
    case "restore":
      return [{ kind: "task.restore", task: task(s.t) }];
    case "note":
      return [{ kind: "note.add", task: task(s.t), body: "Fixture note." }];
    case "folder": {
      if (s.owner === "task") {
        const t = task(s.at);
        return s.clear
          ? [{ kind: "task.folder_clear", task: t }]
          : [{ kind: "task.folder_set", task: t, path: nth(PATHS, s.path) }];
      }
      const p = nth(w.projects, s.at);
      return s.clear
        ? [{ kind: "project.folder_clear", project: p }]
        : [{ kind: "project.folder_set", project: p, path: nth(PATHS, s.path) }];
    }
    case "ticket": {
      const t = task(s.t);
      const key = `jira:LUM-${String(w.tasks.indexOf(t) + 1)}`;
      return [
        { kind: "source.add", task: t, source: { kind: "ticket", title: "Fixture ticket", key } },
      ];
    }
    case "file": {
      const [a, p, t] = [newId("a"), newId("p"), newId("t")];
      const k = String(w.areas.length);
      w.areas.push(a);
      w.projects.push(p);
      w.tasks.push(t);
      return [
        { kind: "area.create", id: a, title: `Fixture area ${k}` },
        { kind: "project.create", id: p, title: `Fixture project ${k}`, area: a },
        { kind: "task.create", id: t, title: `Fixture task ${String(w.tasks.length)}`, project: p },
      ];
    }
    case "regroup": {
      const a = s.a % (w.areas.length + 1);
      return [
        {
          kind: "project.move",
          project: nth(w.projects, s.p),
          area: a < w.areas.length ? nth(w.areas, a) : null,
        },
      ];
    }
    case "project_delete":
      return [{ kind: "project.delete", project: nth(w.projects, s.p) }];
    case "project_restore":
      return [{ kind: "project.restore", project: nth(w.projects, s.p) }];
  }
}

function asideOps(w: World, s: Aside): Operation[] {
  const task = nth(w.tasks.slice(0, w.first), s.t);
  return s.kind === "run"
    ? [
        {
          kind: "run.create",
          task,
          instance: "codex-work",
          adapter: "codex",
          place: null,
          request: "Fixture instruction.",
          brief_hash: "a1b2c3d4".repeat(8),
          permission: "full-access",
          limits: { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 },
        },
      ]
    : [
        {
          kind: "launch.create",
          task,
          instance: "codex-work",
          route: "terminal",
          place: null,
          task_version: 1,
          brief_hash: "a1b2c3d4".repeat(8),
        },
      ];
}

/** The columns a space keeps that are no part of what a person sees: versions and positions. */
const BOOKKEEPING = new Set(["version", "touched", "fv", "fp", "position"]);

const ROWS = {
  tasks: "SELECT id AS key, * FROM tasks",
  areas: "SELECT id AS key, * FROM areas",
  projects: "SELECT id AS key, * FROM projects",
  notes: "SELECT id AS key, * FROM notes",
  sources: "SELECT id AS key, * FROM sources",
  task_sources: "SELECT task_id || '|' || source_id AS key, * FROM task_sources",
  folders: "SELECT id AS key, * FROM folders",
} as const;

/** The column that puts each kind of row out of sight. */
const GONE: Readonly<Record<keyof typeof ROWS, string>> = {
  tasks: "deleted_at",
  areas: "deleted_at",
  projects: "deleted_at",
  notes: "deleted_at",
  sources: "deleted_at",
  task_sources: "removed_at",
  folders: "deleted_at",
};

/** What a person can see of a space: every row but its bookkeeping, and every list's order. */
interface Space {
  rows: Record<string, Record<string, Record<string, unknown>>>;
  lists: Record<string, string[]>;
}

function spaceOf(w: World): Space {
  const rows: Space["rows"] = {};
  for (const [table, sql] of Object.entries(ROWS)) {
    rows[table] = Object.fromEntries(
      w.fx.reader
        .prepare(sql)
        .all()
        .map((r) => [
          String(r["key"]),
          Object.fromEntries(Object.entries(r).filter(([c]) => c !== "key" && !BOOKKEEPING.has(c))),
        ]),
    );
  }
  return { rows, lists: listsOf(w.fx.reader) };
}

/**
 * The space after the last Undo, as the space before the first step: every row made since is out
 * of sight, and is left out with its place in its list.
 */
function without(now: Space, was: Space): Space {
  const old = new Set(Object.values(was.rows).flatMap((rows) => Object.keys(rows)));
  const rows: Space["rows"] = {};
  for (const [table, all] of Object.entries(now.rows)) {
    const gone = GONE[table as keyof typeof ROWS];
    const made = Object.entries(all).filter(([key]) => !old.has(key));
    expect(
      made.filter(([, row]) => row[gone] === null).map(([key]) => key),
      `the ${table} made since are out of sight`,
    ).toEqual([]);
    rows[table] = Object.fromEntries(Object.entries(all).filter(([key]) => old.has(key)));
  }
  const lists = Object.fromEntries(
    Object.entries(now.lists)
      .map(([list, ids]): [string, string[]] => [list, ids.filter((id) => old.has(id))])
      .filter(([, ids]) => ids.length > 0),
  );
  return { rows, lists };
}

async function run({ steps, between }: Plan): Promise<void> {
  const w = await world();
  const { fx } = w;
  let rules: SpaceState = checkSpace(fx.reader);
  /** Every write is checked against the rules on the space it leaves. */
  const submit = (actor: Credential, ops: Operation[], undoable: boolean): WriteResult => {
    const result = fx.writer.submit(
      fx.request(actor, ops, { base: fx.base(), ...(undoable ? { undoable: true } : {}) }),
    );
    expect(
      ["applied", "unchanged", "conflict", "rejected"],
      JSON.stringify(result.error),
    ).toContain(result.status);
    rules = checkSpace(fx.reader, rules);
    return result;
  };
  const asideOf = (s: Aside): void => {
    submit(w.ui, asideOps(w, s), false);
  };
  try {
    const first = spaceOf(w);
    let done = 0;
    for (const s of steps) {
      if (isAside(s)) {
        asideOf(s);
        continue;
      }
      const counts = [w.tasks.length, w.areas.length, w.projects.length] as const;
      const ops = s.kind === "batch" ? s.steps.flatMap((f) => opsOf(w, f)) : opsOf(w, s);
      if (ops.length === 0) continue;
      const result = submit(fx.human, ops, true);
      if (result.status === "applied") done += 1;
      else {
        // A request refused leaves none of the rows it named.
        w.tasks.length = counts[0];
        w.areas.length = counts[1];
        w.projects.length = counts[2];
      }
    }
    const last = spaceOf(w);
    let k = 0;
    const history = (kind: "undo" | "redo"): WriteResult => {
      const result = fx.writer.submit(fx.request(fx.human, [{ kind }]));
      rules = checkSpace(fx.reader, rules);
      k += 1;
      for (const b of between) if (b.at === k) asideOf(b.aside);
      return result;
    };
    for (let u = 0; u < done; u += 1) {
      const result = history("undo");
      expect(
        [result.status, result.conflicts, result.newer],
        `undo ${String(u + 1)} of ${String(done)}`,
      ).toEqual(["applied", [], undefined]);
    }
    expect(history("undo").error?.code, "nothing is left to undo").toBe("NOTHING_TO_UNDO");
    expect(without(spaceOf(w), first), "the space before the first step").toEqual(first);
    for (let r = 0; r < done; r += 1) {
      const result = history("redo");
      expect(
        [result.status, result.conflicts, result.passed],
        `redo ${String(r + 1)} of ${String(done)}`,
      ).toEqual(["applied", [], undefined]);
    }
    expect(history("redo").error?.code, "nothing is left to redo").toBe("NOTHING_TO_REDO");
    expect(spaceOf(w), "the space after the last step").toEqual(last);
    checkHistory(fx.reader);
  } finally {
    fx.close();
  }
}

describe("[A1.5.history.alone] a person working alone undoes everything they did and redoes it", () => {
  test("every Undo and Redo applies whole, and gives back the space before the first step and after the last, the order of every list included", async () => {
    const failures: string[] = [];
    for (const [k, c] of CASES.entries()) {
      try {
        await run(c);
      } catch (error) {
        const [line = ""] = String(error).split("\n");
        failures.push(`${String(k)}: ${line}`);
      }
    }
    expect(failures).toEqual([]);
    await fc.assert(
      fc.asyncProperty(plan, async (p) => {
        await run(p);
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
