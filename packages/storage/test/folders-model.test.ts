// A property test over random sequences of folder and group operations on two machines, a Linux
// and a Windows one: a person sets and clears projects' and tasks' folders, moves tasks between
// projects and next to each other, moves projects between areas, deletes and restores tasks and
// projects, files a new area, project and task together, sends several of these in one request,
// undoes and redoes; an agent does most of these too, and adds notes, in between, on no undo stack.
// Paths come from small sets per machine, so two projects often reach for one folder, by the same
// spelling or, on Windows, another case, and one project's folder is often inside another's. After
// every step, the rules every write keeps (space-rules.ts: checkSpace), one live folder per owner
// and machine among them, and:
// - a folder change that names the owners whose folders moved with it (`carry`) moved each of
//   their folders on that machine that is the old one or inside it, projects' and tasks' alike, to
//   the same place inside the new one, unless the new folder is around or inside the old one, and
//   changed no other folder; one that names none changed the owner's folder alone (worked out here
//   apart from the writer's code);
// - a task moved next to another stands right there in its list;
// - an undo that applied whole, of a commit nobody else's change followed, gives back the space as
//   it was before that commit, and its redo the space as that commit left it.
// Each run ends with A1's history invariants (write-helpers.ts: checkHistory). Fixture paths only:
// nothing here looks at a folder.
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { newId, type Id } from "../src/ids.ts";
import { openSpace } from "../src/space.ts";
import { type FolderOs } from "../src/write/folders.ts";
import type { Credential, Operation, WriteResult } from "../src/write/request.ts";
import { checkedDriver, tempFolders } from "./space-helpers.ts";
import { checkSpace, expectBeside, listOf, listsOf } from "./space-rules.ts";
import { checkHistory, fixtureCopies, type Fixture } from "./write-helpers.ts";

const temp = tempFolders("folders-model");
// Each run gets its own copy of one fixture space, made once.
const fixture = fixtureCopies(temp.make, { flush: false });
afterAll(temp.cleanup);

const PATHS: Readonly<Record<FolderOs, readonly string[]>> = {
  linux: ["~/work/a", "~/work/a/x", "~/work/a/x/y", "~/work/b", "~/work/A", "/srv/c"],
  windows: ["~\\Dev\\a", "~\\dev\\A", "~\\Dev\\a\\x", "D:\\w", "D:\\w\\z", "D:\\W\\z"],
  macos: [],
};

const PROJECTS = 4;
/** Tasks start in the first two projects; the last two start empty, so they can be deleted. */
const TASKS = 4;
/** Areas a project moves between at the start. */
const AREAS = 2;
/** How many times a run files a new area, project and task together, at most. */
const FILED = 2;

type Who = "human" | "agent";
/** The owners a folder change carries, by index: the first projects, then the first tasks. */
type Carry = readonly number[];

/**
 * A row by index among those there are, modulo their number. A project or an area of a move or a
 * regroup past the last one is none.
 */
type Forward =
  | { kind: "project_set"; who: Who; m: number; p: number; path: number; carry: Carry }
  | { kind: "project_clear"; m: number; p: number }
  | { kind: "task_set"; m: number; t: number; path: number; carry: Carry }
  | { kind: "task_clear"; m: number; t: number }
  | { kind: "move"; who: Who; t: number; p: number }
  /** A move right before or after another task, into that task's list. */
  | { kind: "beside"; who: Who; t: number; s: number; side: "before" | "after" }
  | { kind: "task_delete"; who: Who; t: number; restore: boolean }
  | { kind: "regroup"; who: Who; p: number; a: number }
  | { kind: "delete"; who: Who; p: number }
  | { kind: "restore"; who: Who; p: number }
  | { kind: "note"; who: Who; t: number }
  /** A new area, a project in it and a task in that, in one request. */
  | { kind: "file"; who: Who };

type Step =
  | Forward
  /** An agent sets a project's folder to one a project had and lost: a delete's, a clear's. */
  | { kind: "steal"; m: number; p: number; pick: number }
  /** Several forward steps in one request, of one actor on one machine. */
  | { kind: "batch"; who: Who; m: number; steps: readonly Forward[] }
  | { kind: "undo"; partial: boolean }
  | { kind: "redo" };

const m = fc.nat({ max: 1 });
const p = fc.nat({ max: PROJECTS - 1 + FILED });
const t = fc.nat({ max: TASKS - 1 + FILED });
const path = fc.nat({ max: 5 });
/** A project for a task to move into, or past the last one none. */
const into = fc.nat({ max: PROJECTS + FILED });
/** An area for a project to move into, or past the last one none. */
const area = fc.nat({ max: AREAS + FILED });
const side = fc.constantFrom("before" as const, "after" as const);
/** None, every first owner, or some. */
const carry: fc.Arbitrary<Carry> = fc.oneof(
  fc.constant([]),
  fc.constant([...Array(PROJECTS + TASKS).keys()]),
  fc.uniqueArray(fc.nat({ max: PROJECTS + TASKS - 1 })),
);
/** Mostly the person, whose changes are on the undo stack; sometimes an agent in between. */
const who = fc.constantFrom<Who>("human", "human", "agent");
const either = fc.constantFrom<Who>("human", "agent");

/** The forward steps, each with its weight, of an actor drawn from `by`. */
const forward = (by: fc.Arbitrary<Who>, weights: Partial<Record<Forward["kind"], number>>) =>
  fc.oneof(
    ...(
      [
        [
          "project_set",
          fc.record({ kind: fc.constant("project_set" as const), who: by, m, p, path, carry }),
        ],
        ["project_clear", fc.record({ kind: fc.constant("project_clear" as const), m, p })],
        ["task_set", fc.record({ kind: fc.constant("task_set" as const), m, t, path, carry })],
        ["task_clear", fc.record({ kind: fc.constant("task_clear" as const), m, t })],
        ["move", fc.record({ kind: fc.constant("move" as const), who: by, t, p: into })],
        ["beside", fc.record({ kind: fc.constant("beside" as const), who: by, t, s: t, side })],
        [
          "task_delete",
          fc.record({
            kind: fc.constant("task_delete" as const),
            who: by,
            t,
            restore: fc.boolean(),
          }),
        ],
        ["regroup", fc.record({ kind: fc.constant("regroup" as const), who: by, p, a: area })],
        ["delete", fc.record({ kind: fc.constant("delete" as const), who: by, p })],
        ["restore", fc.record({ kind: fc.constant("restore" as const), who: by, p })],
        [
          "note",
          fc.record({ kind: fc.constant("note" as const), who: fc.constant<Who>("agent"), t }),
        ],
        ["file", fc.record({ kind: fc.constant("file" as const), who: by })],
      ] as const
    )
      .filter(([kind]) => (weights[kind] ?? 0) > 0)
      .map(([kind, arbitrary]) => ({
        arbitrary: arbitrary as fc.Arbitrary<Forward>,
        weight: weights[kind] ?? 0,
      })),
  );

const history = (undo: number, redo: number) => [
  {
    arbitrary: fc.record({ kind: fc.constant("undo" as const), partial: fc.boolean() }),
    weight: undo,
  },
  { arbitrary: fc.record({ kind: fc.constant("redo" as const) }), weight: redo },
];

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: forward(who, {
      project_set: 6,
      project_clear: 1,
      task_set: 4,
      task_clear: 1,
      move: 2,
      beside: 1,
      task_delete: 1,
      regroup: 2,
      delete: 2,
      restore: 3,
      note: 1,
      file: 1,
    }),
    weight: 25,
  },
  {
    arbitrary: fc.record({ kind: fc.constant("steal" as const), m, p, pick: fc.nat() }),
    weight: 2,
  },
  ...history(5, 3),
);

/**
 * Fewer kinds, and an agent as often as the person: a project's moves, deletes and restores, tasks
 * moved next to each other and filed together, with an agent filing tasks, adding notes and setting
 * folders in between, several of them in one request now and then, and the person's undo and redo.
 */
const groupWeights = {
  regroup: 3,
  move: 3,
  beside: 2,
  task_delete: 2,
  delete: 2,
  restore: 2,
  project_set: 2,
  project_clear: 1,
  note: 2,
  file: 1,
} as const;
const groupStep: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: forward(either, groupWeights), weight: 20 },
  {
    arbitrary: fc.record({
      kind: fc.constant("batch" as const),
      who: either,
      m,
      steps: fc.array(forward(either, groupWeights), { minLength: 2, maxLength: 3 }),
    }),
    weight: 2,
  },
  ...history(4, 2),
);

/**
 * Counterexamples, run every time before the random cases: what the random runs found, and each
 * way an undo once left a space no ordinary write makes.
 */
const GROUP_CASES: readonly (readonly Step[])[] = [
  // An undo held back by an agent's change, a redo of it that wrote nothing again, and an undo
  // after that (seed 565489635, path "52:3:2:3:8:8:8:8:10:6:9:11:14:14:14:11:11:11:11:11:11:11:11:11:11:11:11:11").
  [
    { kind: "move", who: "human", t: 0, p: 1 },
    { kind: "regroup", who: "agent", p: 0, a: 1 },
    { kind: "undo", partial: true },
    { kind: "redo" },
    { kind: "undo", partial: false },
    { kind: "move", who: "human", t: 0, p: 0 },
    { kind: "regroup", who: "human", p: 0, a: 0 },
    { kind: "move", who: "human", t: 0, p: 0 },
    { kind: "undo", partial: false },
  ],
  // seed -1539344306, path "0:6:7:12:12:7:8:8:7:7"
  [
    { kind: "regroup", who: "human", p: 3, a: 0 },
    { kind: "move", who: "agent", t: 0, p: 3 },
    { kind: "undo", partial: false },
    { kind: "regroup", who: "human", p: 0, a: 0 },
    { kind: "undo", partial: true },
    { kind: "redo" },
    { kind: "undo", partial: false },
  ],
  // seed 2125393020, path "77:3:3:11:7:7:7:9:2:1:7:8:8:8"
  [
    { kind: "move", who: "human", t: 0, p: 1 },
    { kind: "regroup", who: "agent", p: 0, a: 1 },
    { kind: "undo", partial: true },
    { kind: "task_delete", who: "human", t: 0, restore: true },
    { kind: "redo" },
    { kind: "regroup", who: "human", p: 0, a: 1 },
    { kind: "undo", partial: false },
  ],
  // A partial undo of an area, a project and a task filed together, after an agent's note on the
  // task: the task and its project stay, and so does their area.
  [
    { kind: "file", who: "human" },
    { kind: "note", who: "agent", t: TASKS },
    { kind: "undo", partial: true },
  ],
  // An undo of a move out of a list that another filled meanwhile: the task comes back on a
  // position of its own, and one moved before the second then stands right there.
  [
    { kind: "move", who: "human", t: 0, p: 2 },
    { kind: "move", who: "human", t: 0, p: 3 },
    { kind: "move", who: "agent", t: 1, p: 2 },
    { kind: "undo", partial: false },
    { kind: "beside", who: "agent", t: 3, s: 1, side: "before" },
  ],
  // An undo of a project's restore that a task restored since keeps: the restore is named.
  [
    { kind: "move", who: "agent", t: 0, p: 2 },
    { kind: "task_delete", who: "human", t: 0, restore: false },
    { kind: "delete", who: "human", p: 2 },
    { kind: "restore", who: "human", p: 2 },
    { kind: "task_delete", who: "agent", t: 0, restore: true },
    { kind: "undo", partial: false },
  ],
  // A project restored after its area's creation was undone comes back without an area
  // (seed 163886335, path "23:3:3:6:6:6:2:2:2:2:2:2:2:2").
  [
    { kind: "file", who: "human" },
    { kind: "undo", partial: false },
    { kind: "restore", who: "human", p: 0 },
    { kind: "move", who: "human", t: 0, p: 0 },
  ],
  // A step that files a new area and moves a project into it is undone whole: the same undo moves
  // the project out (seed -377774187, path "1281:1:0:0:1:2:2:2:4:4:4:5:4:4:4:4:4:4").
  [
    {
      kind: "batch",
      who: "human",
      m: 0,
      steps: [
        { kind: "file", who: "human" },
        { kind: "move", who: "human", t: 0, p: 0 },
        { kind: "regroup", who: "human", p: 0, a: 2 },
      ],
    },
    { kind: "undo", partial: false },
    { kind: "redo" },
    { kind: "undo", partial: false },
  ],
  // A redo after a later step's create was undone gives back its own commit; the later rows stay
  // out of sight (seed -147665983, path "2153:2:0:1:3:3:3:5:7:10:11:10:10:10:10:10:10:10:10").
  [
    { kind: "project_set", who: "human", m: 0, p: 0, path: 0, carry: [] },
    { kind: "file", who: "human" },
    { kind: "undo", partial: false },
    { kind: "undo", partial: false },
    { kind: "redo" },
  ],
  // One request that restores the empty project P2 and files a new project titled P2: the new one
  // takes a slug of its own (seed 1123905362, paths "215:1:6:7:2:5:5:5:6:6:6:6:6:6:6:6:5:5:5:5:5:5"
  // and "1366:0:2:2:0:0:0:0:0:0:0:0:0:0:0:0").
  [
    { kind: "delete", who: "human", p: 2 },
    {
      kind: "batch",
      who: "human",
      m: 0,
      steps: [
        { kind: "restore", who: "human", p: 0 },
        { kind: "file", who: "human" },
      ],
    },
    { kind: "undo", partial: false },
    { kind: "redo" },
  ],
  // One request that deletes an empty project and sets its folder: refused, the project named.
  [
    { kind: "project_set", who: "human", m: 0, p: 2, path: 0, carry: [] },
    {
      kind: "batch",
      who: "human",
      m: 0,
      steps: [
        { kind: "delete", who: "human", p: 2 },
        { kind: "project_set", who: "human", m: 0, p: 2, path: 1, carry: [] },
      ],
    },
  ],
];

interface FolderState {
  id: string;
  kind: string;
  owner: string;
  machine: string;
  path: string;
  live: boolean;
}

/**
 * What an undo must give back: the live folders, the live projects with their areas, each
 * task's project, area and tombstone, and the order of every list (space-rules.ts: listsOf).
 */
interface Snapshot {
  folders: Record<string, string>;
  projects: string[];
  areas: Record<string, string | null>;
  tasks: Record<string, string | null>;
  taskAreas: Record<string, string | null>;
  deletedTasks: string[];
  lists: Record<string, string[]>;
}

interface World {
  fx: Fixture;
  machines: { id: Id<"m">; os: FolderOs; human: Credential; agent: Credential }[];
  areas: Id<"a">[];
  projects: Id<"p">[];
  tasks: Id<"t">[];
}

async function world(): Promise<World> {
  const fx = await fixture();
  const second = newId("m");
  fx.writer.close();
  const conn = openSpace(await checkedDriver(), fx.folder, { role: "writer" }).conn;
  try {
    conn.pragma("synchronous", "OFF");
    conn.transaction("immediate", () => {
      const seq = Number(conn.prepare("SELECT last_seq AS seq FROM space").get()?.["seq"]);
      conn
        .prepare(
          "INSERT INTO machines (id, name, os, first_seen, retired_at, created_seq, version, " +
            "fv, fp) VALUES ($id, 'mira-laptop', 'windows', 0, NULL, $seq, $seq, '{}', '{}')",
        )
        .run({ id: second, seq });
    });
  } finally {
    conn.close();
  }
  fx.reopen();
  const machines = [
    { id: fx.human.machine_id, os: "linux" as const },
    { id: second, os: "windows" as const },
  ].map((machine) => ({
    ...machine,
    human: { ...fx.human, machine_id: machine.id },
    agent: { ...fx.codex, machine_id: machine.id },
  }));
  const areas = Array.from({ length: AREAS }, () => newId("a"));
  const projects = Array.from({ length: PROJECTS }, () => newId("p"));
  const tasks = Array.from({ length: TASKS }, () => newId("t"));
  const ops: Operation[] = [
    ...areas.map((id, k): Operation => ({ kind: "area.create", id, title: `A${String(k)}` })),
    ...projects.map((id, k): Operation => ({
      kind: "project.create",
      id,
      title: `P${String(k)}`,
      area: areas[k % AREAS] ?? null,
    })),
    ...tasks.map((id, k): Operation => ({
      kind: "task.create",
      id,
      title: `T${String(k)}`,
      project: projects[k % 2] ?? "",
    })),
  ];
  const created = fx.writer.submit(fx.request(fx.codex, ops));
  if (created.status !== "applied") throw new Error("the world was not created");
  return { fx, machines, areas, projects, tasks };
}

function folders(w: World): FolderState[] {
  return w.fx.reader
    .prepare("SELECT * FROM folders ORDER BY id")
    .all()
    .map((r) => ({
      id: String(r["id"]),
      kind: String(r["owner_kind"]),
      owner: String(r["owner_id"]),
      machine: String(r["machine_id"]),
      path: String(r["path"]),
      live: r["deleted_at"] === null,
    }));
}

function snapshot(w: World): Snapshot {
  const projects = w.fx.reader
    .prepare("SELECT id, area_id, deleted_at FROM projects ORDER BY id")
    .all();
  const tasks = w.fx.reader
    .prepare("SELECT id, project_id, area_id, deleted_at FROM tasks ORDER BY id")
    .all();
  const nullable = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    folders: Object.fromEntries(
      folders(w)
        .filter((f) => f.live)
        .map((f) => [f.id, f.path]),
    ),
    projects: projects.filter((r) => r["deleted_at"] === null).map((r) => String(r["id"])),
    areas: Object.fromEntries(projects.map((r) => [String(r["id"]), nullable(r["area_id"])])),
    tasks: Object.fromEntries(tasks.map((r) => [String(r["id"]), nullable(r["project_id"])])),
    taskAreas: Object.fromEntries(tasks.map((r) => [String(r["id"]), nullable(r["area_id"])])),
    deletedTasks: tasks.filter((r) => r["deleted_at"] !== null).map((r) => String(r["id"])),
    lists: listsOf(w.fx.reader),
  };
}

/**
 * Where a folder lands when the folder `from` was moved to `to`, worked out here apart from the
 * writer's code: inside the old folder it moves, unless one of the two folders is the other or
 * inside it, when nothing moves.
 */
function expectedMove(path: string, from: string, to: string, os: FolderOs): string {
  const sep = os === "windows" ? "\\" : "/";
  const fold = (s: string): string => (os === "linux" ? s : s.toLowerCase());
  const within = (a: string, b: string): boolean =>
    fold(a) === fold(b) || fold(a).startsWith(fold(b) + sep);
  if (within(to, from) || within(from, to) || !within(path, from)) return path;
  return to + path.slice(from.length);
}

/**
 * The space as an undo or a redo gives `was` back: rows created since are out of sight (an undone
 * create keeps its row), and the others are as they were.
 */
function backTo(now: Snapshot, was: Snapshot): Snapshot {
  const old = (id: string): boolean => Object.hasOwn(was.tasks, id);
  const made = Object.keys(now.tasks).filter((id) => !old(id));
  expect(
    made.filter((id) => !now.deletedTasks.includes(id)),
    "an undone create is gone",
  ).toEqual([]);
  const kept = <T>(map: Record<string, T>, rows: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(map).filter(([id]) => Object.hasOwn(rows, id)));
  return {
    folders: now.folders,
    projects: now.projects,
    areas: kept(now.areas, was.areas),
    tasks: kept(now.tasks, was.tasks),
    taskAreas: kept(now.taskAreas, was.tasks),
    deletedTasks: now.deletedTasks.filter(old),
    lists: Object.fromEntries(
      Object.entries(now.lists)
        .map(([list, ids]): [string, string[]] => [
          list,
          ids.filter((id) => old(id) || Object.hasOwn(was.areas, id)),
        ])
        .filter(([, ids]) => ids.length > 0),
    ),
  };
}

/**
 * What a refused or partial undo names is someone's change after the step it undoes: who moved,
 * filed, restored or deleted something since, never what was there before the step.
 */
function expectNewer(w: World, result: WriteResult): void {
  const step = result.status === "conflict" ? result.target : result.results[0]?.id;
  if (step === undefined || result.conflicts.length === 0) return;
  const seq = Number(
    w.fx.reader.prepare("SELECT seq FROM commits WHERE id = $id").get({ id: step })?.["seq"],
  );
  for (const c of result.conflicts) {
    expect(c.version, `${c.entity} ${c.field} is named by a change after the step`).toBeGreaterThan(
      seq,
    );
  }
}

/** A commit on the person's stack, with the space before and after it. */
interface Entry {
  before: Snapshot;
  after: Snapshot;
  /** Nobody else's change came after it, so its undo must give back `before` exactly. */
  clean: boolean;
}

/** Which row an index names: modulo the rows there are. */
const nth = <T>(rows: readonly T[], k: number): T => {
  const row = rows[k % rows.length];
  if (row === undefined) throw new Error("no rows");
  return row;
};

/**
 * The operations of a forward step on `machine`, as the space stands (`before`), or undefined
 * when the step has nothing to do here.
 */
function opsOf(
  w: World,
  s: Forward,
  machine: World["machines"][number],
  before: Snapshot,
): Operation[] | undefined {
  const carried = (owners: Carry): string[] =>
    owners.map((k) => (k < PROJECTS ? w.projects[k] : w.tasks[k - PROJECTS]) ?? "");
  switch (s.kind) {
    case "project_set":
      return [
        {
          kind: "project.folder_set",
          project: nth(w.projects, s.p),
          path: PATHS[machine.os][s.path] ?? "",
          ...(s.carry.length === 0 ? {} : { carry: carried(s.carry) }),
        },
      ];
    case "project_clear":
      return [{ kind: "project.folder_clear", project: nth(w.projects, s.p) }];
    case "task_set":
      return [
        {
          kind: "task.folder_set",
          task: nth(w.tasks, s.t),
          path: PATHS[machine.os][s.path] ?? "",
          ...(s.carry.length === 0 ? {} : { carry: carried(s.carry) }),
        },
      ];
    case "task_clear":
      return [{ kind: "task.folder_clear", task: nth(w.tasks, s.t) }];
    case "move":
      return [
        {
          kind: "task.move",
          task: nth(w.tasks, s.t),
          project: s.p < w.projects.length ? nth(w.projects, s.p) : null,
        },
      ];
    case "beside": {
      const task = nth(w.tasks, s.t);
      const sibling = nth(w.tasks, s.s);
      if (task === sibling) return undefined;
      return [
        s.side === "before"
          ? { kind: "task.move", task, before: sibling }
          : { kind: "task.move", task, after: sibling },
      ];
    }
    case "task_delete":
      return [{ kind: s.restore ? "task.restore" : "task.delete", task: nth(w.tasks, s.t) }];
    case "regroup":
      return [
        {
          kind: "project.move",
          project: nth(w.projects, s.p),
          area: s.a < w.areas.length ? nth(w.areas, s.a) : null,
        },
      ];
    case "delete":
      return [{ kind: "project.delete", project: nth(w.projects, s.p) }];
    case "restore": {
      // A deleted project when there is one: restoring a live one only tests the refusal.
      const deleted = w.projects.filter((id) => !before.projects.includes(id));
      return [
        {
          kind: "project.restore",
          project: deleted.length > 0 ? nth(deleted, s.p) : nth(w.projects, s.p),
        },
      ];
    }
    case "note":
      return [{ kind: "note.add", task: nth(w.tasks, s.t), body: "Fixture note." }];
    case "file": {
      if (w.areas.length >= AREAS + FILED) return undefined;
      const a = newId("a");
      const p = newId("p");
      const t = newId("t");
      const k = String(w.areas.length);
      w.areas.push(a);
      w.projects.push(p);
      w.tasks.push(t);
      return [
        { kind: "area.create", id: a, title: `A${k}` },
        { kind: "project.create", id: p, title: `P${k}`, area: a },
        { kind: "task.create", id: t, title: `T${k}`, project: p },
      ];
    }
  }
}

async function run(steps: readonly Step[]): Promise<void> {
  const w = await world();
  const carried = (owners: Carry): string[] =>
    owners.map((k) => (k < PROJECTS ? w.projects[k] : w.tasks[k - PROJECTS]) ?? "");
  const done: Entry[] = [];
  const undone: Entry[] = [];
  const dirty = (): void => {
    for (const e of [...done, ...undone]) e.clean = false;
  };
  try {
    let space = checkSpace(w.fx.reader);
    for (const s of steps) {
      const before = snapshot(w);
      const beforeFolders = folders(w);
      const machine = nth(w.machines, "m" in s ? s.m : 0);
      let ops: Operation[] | undefined;
      let actor = "who" in s && s.who === "agent" ? machine.agent : machine.human;
      let sibling: { list: string[] } | undefined;
      // A request that files new rows and is refused leaves none of them.
      const counts = [w.areas.length, w.projects.length, w.tasks.length] as const;
      if (s.kind === "steal") {
        const lost = beforeFolders.filter(
          (f) => !f.live && f.kind === "project" && f.machine === machine.id,
        );
        const taken = lost[s.pick % Math.max(lost.length, 1)];
        if (taken === undefined) continue;
        actor = machine.agent;
        ops = [{ kind: "project.folder_set", project: nth(w.projects, s.p), path: taken.path }];
      } else if (s.kind === "batch") {
        ops = s.steps.flatMap((f) => opsOf(w, f, machine, before) ?? []);
        if (ops.length === 0) continue;
      } else if (s.kind !== "undo" && s.kind !== "redo") {
        ops = opsOf(w, s, machine, before);
        if (ops === undefined) continue;
        if (s.kind === "beside") sibling = { list: listOf(w.fx.reader, nth(w.tasks, s.s)) };
      }
      let result: WriteResult;
      if (ops !== undefined) {
        const person = actor.actor_kind === "human";
        result = w.fx.writer.submit(
          w.fx.request(actor, ops, {
            base: w.fx.base(),
            ...(person ? { undoable: true } : {}),
          }),
        );
        if (result.status === "applied") {
          if (person) {
            done.push({ before, after: snapshot(w), clean: true });
            undone.length = 0;
          } else dirty();
        } else {
          w.areas.length = counts[0];
          w.projects.length = counts[1];
          w.tasks.length = counts[2];
        }
      } else {
        result = w.fx.writer.submit(
          w.fx.request(w.fx.human, [
            s.kind === "undo"
              ? { kind: "undo", ...(s.partial ? { partial: true } : {}) }
              : { kind: "redo" },
          ]),
        );
        if (s.kind === "undo") expectNewer(w, result);
        if (result.status === "applied") {
          const whole = result.conflicts.length === 0;
          if (s.kind === "undo") {
            const entry = done.pop();
            if (entry !== undefined) {
              if (whole && entry.clean) {
                expect(backTo(snapshot(w), entry.before), "an undo gives back the space").toEqual(
                  entry.before,
                );
              }
              if (!whole) entry.clean = false;
              undone.unshift(entry);
            }
          } else {
            const entry = undone.shift();
            if (entry !== undefined) {
              if (entry.clean)
                expect(backTo(snapshot(w), entry.after), "a redo gives back the commit").toEqual(
                  entry.after,
                );
              done.push(entry);
            }
          }
          if (!whole) dirty();
        }
      }
      expect(["applied", "unchanged", "conflict", "rejected"]).toContain(result.status);
      space = checkSpace(w.fx.reader, space);
      if (s.kind === "beside" && result.status === "applied" && sibling !== undefined) {
        expectBeside(w.fx.reader, nth(w.tasks, s.t), nth(w.tasks, s.s), s.side, sibling.list);
      }
      // A folder change on a machine moved exactly the folders inside the old one, when it said so.
      if ((s.kind === "project_set" || s.kind === "task_set") && result.status === "applied") {
        const kind = s.kind === "project_set" ? "project" : "task";
        const owner = s.kind === "project_set" ? nth(w.projects, s.p) : nth(w.tasks, s.t);
        const mine = (f: FolderState) =>
          f.kind === kind && f.owner === owner && f.machine === machine.id;
        const old = beforeFolders.find((f) => f.live && mine(f));
        const to = PATHS[machine.os][s.path] ?? "";
        const after = new Map(folders(w).map((f) => [f.id, f]));
        for (const f of beforeFolders) {
          if (!f.live) continue;
          let expected = f.path;
          if (mine(f)) expected = to;
          else if (
            carried(s.carry).includes(f.owner) &&
            old !== undefined &&
            f.machine === machine.id
          ) {
            expected = expectedMove(f.path, old.path, to, machine.os);
          }
          expect(after.get(f.id)?.path, "a folder change moves exactly the folders inside").toBe(
            expected,
          );
        }
      }
    }
    checkHistory(w.fx.reader);
  } finally {
    w.fx.close();
  }
}

describe("[A1.5.write.folders-model] random folder operations, deletes, restores, undos and redos on two machines", () => {
  test("one folder per owner and machine, never two live projects on one folder, a moved folder carries exactly every folder inside it, and undo gives back what was", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 40 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 100 },
    );
  }, 300_000);

  test("after every write, undo and redo, also of several writes in one request: a deleted project or area holds nothing live, a task stays in its project's area, and no two rows of a list share a position", async () => {
    const failures: string[] = [];
    for (const [k, steps] of GROUP_CASES.entries()) {
      try {
        await run(steps);
      } catch (error) {
        const [first = ""] = String(error).split("\n");
        failures.push(`${String(k)}: ${first}`);
      }
    }
    expect(failures).toEqual([]);
    await fc.assert(
      fc.asyncProperty(fc.array(groupStep, { minLength: 5, maxLength: 30 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: 100 },
    );
  }, 300_000);
});
