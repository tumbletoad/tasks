// The Mira sample space: fixture text only, for the invented Mira Okafor and her
// space "Mira" with reference prefix M. Deterministic from a seed: the same seed and size give
// the same rows, IDs and instants on every machine.
//
// The space comes from storage's createSpace, and its writer registers the machine on the first
// open (machine.register). Tasks, their notes, log entries and sources, the place and, from schema
// 0.2 on, a wrap-up with learnings are written through the write path as requests to the space's
// writer, each with its receipt. The
// record kinds whose operations arrive in later steps still go in through StandIn below, which
// writes the commits, change rows, outbox rows and receipts those operations will write: areas and
// projects (area.*, project.*). Each step that adds one of those operations moves its rows to the
// writer. Preferences stay here although `pref.set` exists: the frozen 0.1 sample
// (FIXED_SAMPLE_0_1) pins these rows and the IDs drawn after them, and its rows are what the
// writer would write.
import { join } from "node:path";
import { EFFORT_LEVELS } from "@ttasks/contracts/preferences";
import {
  CheckedDriver,
  createSpace,
  DEFAULT_DRIVER,
  formatAsOf,
  intentFingerprint,
  isSearchObject,
  loadDriver,
  newId,
  openSpace,
  positionBetween,
  SpaceWriter,
  type Connection,
  type Credential,
  type Id,
  type IdPrefix,
  type LaunchState,
  type Operation,
  type RunResultRow,
  type RunState,
  type SchemaStep,
  type SqlValue,
  type WriteResult,
} from "@ttasks/storage";
import { createSpaceAt, openSpaceAt } from "@ttasks/storage/revisions";
import { Rng } from "./rng.ts";

export const MIRA = {
  name: "Mira",
  slug: "mira",
  owner: "Mira Okafor",
  refPrefix: "M",
  machine: { name: "mira-desktop", os: "linux" },
} as const;

/** The default seed and size of `pnpm seed`. */
export const DEFAULT_SEED = "mira";
export const DEFAULT_TASKS = 24;
export const MAX_TASKS = 2000;

export interface MiraOptions {
  seed?: string;
  /** Tasks to generate, 1 to 2,000. */
  tasks?: number;
  /** The app version written into space.json. */
  appVersion?: string;
  /**
   * The chain of schema steps to build with: this build's by default. A released revision's chain
   * (@ttasks/storage/revisions: STEPS_0_1) builds the space as that release built it, through the
   * same write path, so the sample is the fixture of that revision for the migration tests.
   */
  steps?: readonly SchemaStep[];
  /** The space's authority machine. Default: one drawn from the seed. */
  machineId?: Id<"m">;
  /**
   * The authority machine's OS, which its folders take the form of. A service that runs as that
   * machine on another OS cannot give anything a folder. Default: Linux.
   */
  os?: "linux" | "macos" | "windows";
}

export interface SeededSpace {
  folder: string;
  /** The space's authority machine, which registered itself on the first open. */
  machine: Id<"m">;
  /** Rows per table. */
  counts: Record<string, number>;
}

let checked: Promise<CheckedDriver> | undefined;

/** The default driver, through the start-up check, once per process. */
export const checkedDriver = (): Promise<CheckedDriver> =>
  (checked ??= loadDriver(DEFAULT_DRIVER).then((driver) => CheckedDriver.check(driver)));

// ---------------------------------------------------------------------------------------------
// Fixture text. Invented: no real people, employers or customers.

const TITLES = [
  "Fix appointment time zones",
  "Review the invoice export",
  "Draft the Q1 portal roadmap",
  "Answer the clinic about sync delays",
  "Update the onboarding checklist",
  "Prepare the sprint demo",
  "Write the release notes for 2.3",
  "Check the backup restore drill",
  "Clean up the old feature flags",
  "Migrate the reports to the new API",
  "Read the accessibility audit",
  "Plan the team offsite",
  "Book the dentist",
  "Renew the passport",
  "Plant the spring bulbs",
  "Repair the garden fence",
  "Reply to the accountant",
  "Order printer toner",
  "Call the plumber about the leak",
  "Sort the photo archive",
];

const SUMMARIES = [
  "",
  "",
  "Next: compare the two exports",
  "Waiting for the clinic's answer",
  "Draft is half done",
  "Needs a decision on scope",
  "Blocked on access to staging",
];

const CONTEXTS = [
  "",
  "## Context\n\nThe clinic stores local times without a zone.\n",
  "Steps:\n\n1. Export last month.\n2. Compare totals.\n",
  "See the portal ticket for the full thread.\n",
];

const NOTES = [
  "Ask Tomas whether the old export can be retired.",
  "Remember the spare key is with the neighbours.",
  "Prefer UTC plus the clinic's zone ID, never local times.",
];

const LOGS = [
  "Reproduced the issue with the fixture data.",
  "Compared both exports: totals match.",
  "Decided to keep the old endpoint until March.",
  "Asked the clinic for a sample file.",
];

const OUTCOMES = [
  "Shipped in 2.3.",
  "Done, nothing left to follow up.",
  "Dropped: no longer needed.",
];

const STATUSES = ["open", "open", "waiting", "review", "backlog"];
// S, M and L: three of the levels a space starts with.
const EFFORTS = [null, ...EFFORT_LEVELS.slice(1, 4).map((level) => level.key)];
const LOG_KINDS = ["progress", "evidence", "decision", "question"] as const;

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------

/** Columns a create change leaves out of its row: each follows from the change's seq. */
const DERIVED = new Set(["created_seq", "version", "touched", "fv", "fp"]);

/**
 * The `changes.entity_id` of a row: its ID, `task_id|source_id` for a link row, and the
 * key for a preference, which has no ID.
 */
function entityId(table: string, row: Record<string, SqlValue>): string {
  const value =
    table === "task_sources"
      ? `${String(row["task_id"])}|${String(row["source_id"])}`
      : table === "preferences"
        ? row["key"]
        : row["id"];
  if (typeof value !== "string" || value === "" || value.includes("undefined")) {
    throw new Error(`no entity ID for a ${table} row`);
  }
  return value;
}

/**
 * Writes the rows of record kinds that have no operation yet, as their operations will: one commit
 * row per call in the writer's `commits.ops` format, a `create` change per new row with its columns
 * as the after-value, outbox rows, and the request's receipt with an applied result. A change
 * records the index of the commit's operation that targets its row. It shares the writer's
 * connection and clock, and runs only between the writer's requests.
 */
class StandIn {
  readonly #conn: Connection;
  readonly #clock: () => number;
  readonly #space: {
    spaceId: Id<"sp">;
    epoch: number;
    incarnation: Id<"ai">;
    machine: Id<"m">;
  };
  readonly #id: <P extends IdPrefix>(prefix: P) => Id<P>;
  #seq = 0;
  #n = 0;
  #at = 0;
  #ops: readonly { op: string; target: string }[] = [];

  constructor(
    conn: Connection,
    clock: () => number,
    space: { spaceId: Id<"sp">; epoch: number; incarnation: Id<"ai">; machine: Id<"m"> },
    id: <P extends IdPrefix>(prefix: P) => Id<P>,
  ) {
    this.#conn = conn;
    this.#clock = clock;
    this.#space = space;
    this.#id = id;
  }

  get at(): number {
    return this.#at;
  }

  #run(sql: string, params: Record<string, SqlValue>): void {
    this.#conn.prepare(sql).run(params);
  }

  /** One commit by `actor`, in one transaction. `ops` are the operations the rows stand for. */
  commit(
    actor: Credential,
    ops: { op: string; target: string; input: Record<string, unknown> }[],
    body: () => void,
  ): void {
    this.#conn.transaction("immediate", () => {
      const last = this.#conn.prepare("SELECT last_seq FROM space WHERE one = 1").get();
      this.#seq = Number(last?.["last_seq"]) + 1;
      this.#n = 0;
      this.#ops = ops;
      this.#at = this.#clock();
      const commit = this.#id("op");
      const request = this.#id("op").slice(3);
      const entries = ops.map((o) => ({ v: 1, ...o }));
      this.#run(
        `INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id, author_id,
           scope_id, machine_id, origin, request_id, kind, ops)
         VALUES ($seq, $id, $epoch, $incarnation, $at, $actor_kind, $actor, $actor,
           $scope, $machine, $origin, $request, 'ops', $ops)`,
        {
          seq: this.#seq,
          id: commit,
          epoch: this.#space.epoch,
          incarnation: this.#space.incarnation,
          at: this.#at,
          actor_kind: actor.actor_kind,
          actor: actor.principal_id,
          scope: actor.scope_id,
          machine: this.#space.machine,
          origin: actor.origin,
          request,
          ops: JSON.stringify(entries),
        },
      );
      body();
      this.#run("UPDATE space SET last_seq = $seq WHERE one = 1", { seq: this.#seq });
      // The receipt the writer writes for an applied request.
      const asOf = {
        epoch: this.#space.epoch,
        incarnation: this.#space.incarnation,
        seq: this.#seq,
      };
      const result: WriteResult = {
        status: "applied",
        as_of: formatAsOf(asOf),
        ...asOf,
        commit,
        results: ops.map((o, i) => ({ i, status: "created", id: o.target, version: this.#seq })),
        conflicts: [],
        warnings: [],
      };
      this.#run(
        `INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch, incarnation,
           result, at)
         VALUES ($scope, $request, $fingerprint, 'applied', $seq, $epoch, $incarnation, $result, $at)`,
        {
          scope: actor.scope_id,
          request,
          fingerprint: intentFingerprint({
            space_id: this.#space.spaceId,
            entry: null,
            input: { ops: entries },
            reason: null,
          }),
          seq: this.#seq,
          epoch: this.#space.epoch,
          incarnation: this.#space.incarnation,
          result: JSON.stringify(result),
          at: this.#at,
        },
      );
    });
  }

  #outbox(key: string): void {
    this.#run(
      `INSERT INTO outbox (topic, key, first_seq, seq) VALUES ('projection', $key, $seq, $seq)
       ON CONFLICT (topic, key) DO UPDATE SET seq = excluded.seq`,
      { key, seq: this.#seq },
    );
  }

  /** The row as stored, with its defaults: a create change holds every column. */
  #readBack(table: string, row: Record<string, SqlValue>): Record<string, unknown> {
    const where =
      table === "task_sources"
        ? {
            sql: "task_id = $a AND source_id = $b",
            params: { a: row["task_id"] ?? null, b: row["source_id"] ?? null },
          }
        : table === "preferences"
          ? { sql: "key = $a", params: { a: row["key"] ?? null } }
          : { sql: "id = $a", params: { a: row["id"] ?? null } };
    const stored = this.#conn
      .prepare(`SELECT * FROM ${table} WHERE ${where.sql}`)
      .get(where.params);
    if (stored === undefined) throw new Error(`the ${table} row was not written`);
    return stored;
  }

  /**
   * Inserts a new row with its create change. A task's child row marks the task touched. The
   * change belongs to the operation that targets `target`: the row itself by default, the source
   * for a source link.
   */
  create(
    table: string,
    row: Record<string, SqlValue>,
    taskId: string | null,
    target = entityId(table, row),
  ): void {
    const full: Record<string, SqlValue> = { ...row, created_seq: this.#seq, version: this.#seq };
    const columns = Object.keys(full);
    this.#run(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
      full,
    );
    const id = entityId(table, row);
    const after = Object.fromEntries(
      Object.entries(this.#readBack(table, row)).filter(([column]) => !DERIVED.has(column)),
    );
    this.#n += 1;
    const op = this.#ops.findIndex((o) => o.target === target);
    if (op < 0) throw new Error("a change that no operation of its commit targets");
    this.#run(
      `INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field, before, after,
         before_ver, before_prov, after_prov)
       VALUES ($seq, $n, $op, $entity, $entity_id, $task_id, 'create', NULL, NULL, $after,
         NULL, NULL, $seq)`,
      {
        seq: this.#seq,
        n: this.#n,
        op,
        entity: table,
        entity_id: id,
        task_id: taskId,
        after: JSON.stringify(after),
      },
    );
    if (taskId !== null) {
      this.#run("UPDATE tasks SET touched = $seq WHERE id = $id", { seq: this.#seq, id: taskId });
      this.#outbox(taskId);
      this.#outbox("*");
    }
  }
}

/** The first number in a generated source key: `jira:LUM-1000` for the first task. */
const SOURCE_NUMBER_BASE = 1000;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The first `n` positions of a group. */
function positions(n: number): string[] {
  const list: string[] = [];
  for (let i = 0; i < n; i += 1) list.push(positionBetween(list.at(-1), undefined));
  return list;
}

/** A commit an earlier build put on the person's undo stack, as every request of theirs was. */
const RELEASED_STEP = "UPDATE commits SET undo_status = 'done' WHERE seq = $seq";

/**
 * Builds the Mira sample space at `<spacesRoot>/mira`. The folder must not exist yet. Returns the
 * folder and the rows per table.
 */
export async function seedMira(
  spacesRoot: string,
  options: MiraOptions = {},
): Promise<SeededSpace> {
  const seed = options.seed ?? DEFAULT_SEED;
  const taskCount = options.tasks ?? DEFAULT_TASKS;
  if (!Number.isSafeInteger(taskCount) || taskCount < 1 || taskCount > MAX_TASKS) {
    throw new RangeError(`tasks is an integer from 1 to ${String(MAX_TASKS)}`);
  }
  // Fixed text, not the product's identifier: the samples earlier builds made pin its digests.
  const rng = new Rng(`tasks-mira:${seed}`);
  const random = (bytes: Uint8Array): void => {
    rng.fill(bytes);
  };
  const start = Date.UTC(2026, 10, 2, 8, 0, 0);
  const driver = await checkedDriver();
  // Drawn either way, so a given machine changes nothing else the seed draws.
  const drawn = newId("m", random);
  const machineId = options.machineId ?? drawn;
  const os = options.os ?? MIRA.machine.os;
  const createOptions = {
    name: MIRA.name,
    ownerLabel: MIRA.owner,
    refPrefix: MIRA.refPrefix,
    machineId,
    now: () => start,
    random,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
  };
  const folder = join(spacesRoot, MIRA.slug);
  const created =
    options.steps === undefined
      ? createSpace(driver, folder, createOptions)
      : createSpaceAt(driver, folder, createOptions, options.steps);
  const openOptions = {
    role: "writer" as const,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
  };
  const opened =
    options.steps === undefined
      ? openSpace(driver, created.folder, openOptions)
      : openSpaceAt(driver, created.folder, openOptions, options.steps);
  const { conn } = opened;
  // Every commit is some minutes after the one before.
  let now = start;
  const clock = (): number => (now += rng.range(1, 90) * 60_000);
  // No flush per commit while the sample is built: nobody uses the new folder before this returns,
  // and a sample that a crash cut short is thrown away. The largest sample is about 3,600 commits,
  // and a flush can cost milliseconds (4 ms on GitHub's Windows runner, many more while other
  // tests flush beside it), which made building it take minutes. FULL comes back before the close,
  // whose checkpoint then flushes the finished sample once.
  conn.pragma("synchronous", "OFF");
  let writer: SpaceWriter | undefined;
  try {
    writer = SpaceWriter.open(opened, {
      machine: { id: machineId, name: MIRA.machine.name, os },
      now: clock,
      random,
    });
    // An older chain's sample is the one its builds made, and they put every request of the
    // person's on the undo stack: this build puts only the steps Undo is for there.
    const released = (result: WriteResult): void => {
      if (opened.revision.major > 0 || opened.revision.minor >= 5) return;
      if (result.status !== "applied") return;
      conn.prepare(RELEASED_STEP).run({ seq: result.seq });
    };
    generate(conn, writer, rng, clock, created.space, created.actors, start, taskCount, released);
    // Schema 0.2's learnings: a 0.1 build had no wrap-up operation, so the sample at
    // that revision has none, and every row before them is the one the 0.1 builds made.
    if (opened.revision.major > 0 || opened.revision.minor >= 2) {
      released(wrapUp(conn, writer, rng, created.space, created.actors.human));
    }
    // Schema 0.5's folders: an older chain's sample has none, and every row before them is the one
    // that chain made.
    if (opened.revision.major > 0 || opened.revision.minor >= 5) {
      bindFolders(conn, writer, rng, created.space, created.actors.human, os === "windows");
    }
    conn.pragma("synchronous", "FULL");
    const counts: Record<string, number> = {};
    for (const { name } of conn
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>()) {
      // The search index is derived: its rows are not the sample's.
      if (isSearchObject(name, name)) continue;
      counts[name] = Number(conn.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.["n"]);
    }
    return { folder: created.folder, machine: machineId, counts };
  } finally {
    if (writer === undefined) conn.close();
    else writer.close();
  }
}

const LEARNINGS = [
  "Store UTC plus the clinic's zone ID, and convert once.",
  "Ask the clinic for a sample file before changing an export.",
];

/**
 * Mira wraps up her first task, which the sample always checks off, with what she learned: an
 * outcome when it has none yet, and two learnings, through the writer.
 */
function wrapUp(
  conn: Connection,
  writer: SpaceWriter,
  rng: Rng,
  space: { spaceId: Id<"sp">; authority: { machineId: Id<"m"> } },
  human: Id<"ac">,
): WriteResult {
  const first = conn.prepare("SELECT id, wrap_state FROM tasks ORDER BY ref LIMIT 1").get();
  const task = first?.["id"];
  if (typeof task !== "string") throw new Error("no task");
  const result = writer.submit({
    space_id: space.spaceId,
    request_id: newId("op", (bytes) => {
      rng.fill(bytes);
    }).slice(3),
    actor: {
      scope_id: "cli:mira",
      principal_id: human,
      actor_kind: "human",
      machine_id: space.authority.machineId,
      origin: "cli",
    },
    base: formatAsOf(writer.asOf()),
    ops: [
      {
        kind: "task.wrap_up",
        task,
        ...(first?.["wrap_state"] === "pending" ? { outcome: OUTCOMES[0] } : {}),
        learnings: { add: LEARNINGS },
      },
    ],
  });
  if (result.status !== "applied") {
    throw new Error(`the sample's wrap-up was ${result.status}: ${result.error?.code ?? ""}`);
  }
  return result;
}

/**
 * Mira gives her portal project its folder on her machine, and her first task a folder of its own
 * inside it, in one request through the writer.
 */
function bindFolders(
  conn: Connection,
  writer: SpaceWriter,
  rng: Rng,
  space: { spaceId: Id<"sp">; authority: { machineId: Id<"m"> } },
  human: Id<"ac">,
  windows: boolean,
): void {
  const sep = windows ? "\\" : "/";
  const portal = conn.prepare("SELECT id FROM projects WHERE slug = 'lumen-portal'").get()?.["id"];
  const first = conn.prepare("SELECT id FROM tasks ORDER BY ref LIMIT 1").get()?.["id"];
  if (typeof portal !== "string" || typeof first !== "string") throw new Error("no portal");
  const result = writer.submit({
    space_id: space.spaceId,
    request_id: newId("op", (bytes) => {
      rng.fill(bytes);
    }).slice(3),
    actor: {
      scope_id: "cli:mira",
      principal_id: human,
      actor_kind: "human",
      machine_id: space.authority.machineId,
      origin: "cli",
    },
    base: formatAsOf(writer.asOf()),
    ops: [
      {
        kind: "project.folder_set",
        project: portal,
        path: ["~", "work", "lumen", "portal"].join(sep),
      },
      {
        kind: "task.folder_set",
        task: first,
        path: ["~", "work", "lumen", "portal", "appointments"].join(sep),
      },
    ],
  });
  if (result.status !== "applied") {
    throw new Error(`the sample's folders were ${result.status}: ${result.error?.code ?? ""}`);
  }
}

function generate(
  conn: Connection,
  writer: SpaceWriter,
  rng: Rng,
  clock: () => number,
  space: {
    spaceId: Id<"sp">;
    authority: { epoch: number; incarnation: Id<"ai">; machineId: Id<"m"> };
  },
  actors: { human: Id<"ac">; system: Id<"ac"> },
  start: number,
  taskCount: number,
  released: (result: WriteResult) => void,
): void {
  const id = <P extends IdPrefix>(prefix: P): Id<P> =>
    newId(prefix, (bytes) => {
      rng.fill(bytes);
    });
  const machine = space.authority.machineId;
  const h = new StandIn(
    conn,
    clock,
    {
      spaceId: space.spaceId,
      epoch: space.authority.epoch,
      incarnation: space.authority.incarnation,
      machine,
    },
    id,
  );
  const credential = (principal: Id<"ac">, kind: "human" | "agent", scope: string): Credential => ({
    scope_id: scope,
    principal_id: principal,
    actor_kind: kind,
    machine_id: machine,
    origin: kind === "human" ? "cli" : "mcp",
  });
  const human = credential(actors.human, "human", "cli:mira");
  // Actors are bookkeeping rows without history, added as agents connect.
  const agents = [
    { label: "Codex · work", instance: "codex-work" },
    { label: "Claude Code · work", instance: "claude-work" },
  ].map(({ label, instance }) => {
    const agent = id("ac");
    conn
      .prepare(
        "INSERT INTO actors (id, kind, label, instance_id, routine_id, created_at) " +
          "VALUES ($id, 'agent', $label, $instance, NULL, $at)",
      )
      .run({ id: agent, label, instance, at: start });
    return credential(agent, "agent", `grant:${instance}`);
  });
  const submit = (actor: Credential, ops: Operation[], base?: boolean): WriteResult => {
    const result = writer.submit({
      space_id: space.spaceId,
      request_id: id("op").slice(3),
      actor,
      ops,
      ...(base === true ? { base: formatAsOf(writer.asOf()) } : {}),
    });
    if (actor.actor_kind === "human") released(result);
    // A random patch can set the values a task already has: then nothing changes.
    if (result.status !== "applied" && result.status !== "unchanged") {
      throw new Error(`a sample request was ${result.status}: ${result.error?.code ?? ""}`);
    }
    return result;
  };

  const areas = [
    { id: id("a"), slug: "lumen", title: "Lumen" },
    { id: id("a"), slug: "home", title: "Home" },
  ];
  const projects = [
    { id: id("p"), area: 0, slug: "lumen-portal", title: "Lumen portal" },
    { id: id("p"), area: 0, slug: "clinic-sync", title: "Clinic sync" },
    { id: id("p"), area: 1, slug: "garden", title: "Garden" },
  ];
  const areaPositions = positions(areas.length);
  const projectPositions = positions(projects.length);
  h.commit(
    human,
    [
      ...areas.map((a) => ({
        op: "area.create",
        target: a.id,
        input: { slug: a.slug, title: a.title },
      })),
      ...projects.map((p) => ({
        op: "project.create",
        target: p.id,
        input: { slug: p.slug, title: p.title, area: areas[p.area]?.id ?? null },
      })),
    ],
    () => {
      areas.forEach((a, i) => {
        h.create(
          "areas",
          {
            id: a.id,
            slug: a.slug,
            title: a.title,
            position: areaPositions[i] ?? "a0",
            created_at: h.at,
            created_by: human.principal_id,
          },
          null,
        );
      });
      projects.forEach((p, i) => {
        h.create(
          "projects",
          {
            id: p.id,
            area_id: areas[p.area]?.id ?? null,
            slug: p.slug,
            title: p.title,
            position: projectPositions[i] ?? "a0",
            created_at: h.at,
            created_by: human.principal_id,
          },
          null,
        );
      });
    },
  );

  h.commit(
    human,
    [
      { op: "pref.set", target: "ui.theme", input: { key: "ui.theme", value: "sumi" } },
      {
        op: "pref.set",
        target: "autonomy.level",
        input: { key: "autonomy.level", value: "review" },
      },
    ],
    () => {
      h.create("preferences", { key: "ui.theme", value: '"sumi"', schema_ver: 1, policy: 0 }, null);
      h.create(
        "preferences",
        { key: "autonomy.level", value: '"review"', schema_ver: 1, policy: 1 },
        null,
      );
    },
  );

  const portal = projects[0];
  if (portal === undefined) throw new Error("no project");
  const portalPlace = submit(human, [
    {
      kind: "place.set",
      project: portal.id,
      root: "work",
      path: "lumen/portal",
      git_remote: "https://git.lumen.example/lumen/portal.git",
    },
  ]).results[0]?.id;

  // Tasks, each created by one request through the writer with its first source and note.
  const tasks: Id<"t">[] = [];
  const completed = new Set<Id<"t">>();
  for (let i = 0; i < taskCount; i += 1) {
    const creator = rng.chance(0.6) ? human : rng.pick(agents);
    const project = rng.chance(0.8) ? rng.pick(projects) : undefined;
    const taskId = id("t");
    const base = TITLES[i % TITLES.length] ?? "Task";
    const title =
      i < TITLES.length ? base : `${base} (${String(Math.floor(i / TITLES.length) + 1)})`;
    const effort = rng.pick(EFFORTS);
    const due = rng.chance(0.3) ? day(start + rng.range(0, 40) * 86_400_000) : null;
    const withSource = i === 0 || rng.chance(0.4);
    const withNote = i === 0 || rng.chance(0.3);
    // A task has at most one source, so a number from the task's index makes every source key
    // unique by construction (sources_key is unique among live sources).
    const n = SOURCE_NUMBER_BASE + i;
    const kind = rng.pick(["email", "ticket", "pr"] as const);
    const source = {
      email: { key: `email:<${String(n)}.fixture@mail.lumen.example>`, who: "Tomas" },
      ticket: { key: `jira:LUM-${String(n)}`, who: "Aiko" },
      pr: { key: `github:lumen/portal#${String(n)}`, who: "Aiko" },
    }[kind];
    const sent = start - rng.range(1, 48) * 3_600_000;
    const addressee = rng.pick(["self", "agents"] as const);
    const body = rng.pick(NOTES);
    submit(creator, [
      {
        kind: "task.create",
        id: taskId,
        title,
        summary: rng.pick(SUMMARIES),
        context: rng.pick(CONTEXTS),
        status: rng.pick(STATUSES),
        inbox: project === undefined,
        priority: rng.range(1, 4),
        ...(effort === null ? {} : { effort }),
        ...(due === null ? {} : { due: { date: due } }),
        ...(project === undefined ? {} : { project: project.id }),
      },
      ...(withSource
        ? [
            {
              kind: "source.add" as const,
              task: taskId,
              source: {
                kind,
                title: `Re: ${title}`,
                key: source.key,
                who: source.who,
                url: `https://lumen.example/${kind}/${String(n)}`,
                at: sent,
              },
            },
          ]
        : []),
      ...(withNote ? [{ kind: "note.add" as const, task: taskId, body, addressee }] : []),
    ]);
    tasks.push(taskId);
  }

  // Follow-ups: agents log progress, Mira edits and checks tasks off through the writer.
  tasks.forEach((taskId, i) => {
    if (i === 0 || rng.chance(0.35)) {
      const agent = rng.pick(agents);
      const kind = rng.pick(LOG_KINDS);
      submit(agent, [{ kind: "log.add", task: taskId, body: rng.pick(LOGS), log_kind: kind }]);
    }
    if (i === 0 || rng.chance(0.25)) {
      submit(
        human,
        [
          { kind: "task.patch", task: taskId, set: { summary: rng.pick(SUMMARIES.slice(2)) } },
          { kind: "task.patch", task: taskId, set: { priority: rng.range(1, 3) } },
        ],
        true,
      );
    }
    if (i === 0 || rng.chance(0.2)) {
      const wrapped = rng.chance(0.5);
      submit(
        human,
        [
          {
            kind: "task.complete",
            task: taskId,
            ...(wrapped ? { outcome: rng.pick(OUTCOMES) } : {}),
          },
        ],
        true,
      );
      completed.add(taskId);
    }
  });

  // Launches, as the execution store writes them: one request per click and per
  // transition, from the page, never undoable. Mira opens an open task in Codex · work's terminal,
  // whose shim claims and settles, and the same task through Claude Code's link, which the service
  // loses track of in a restart.
  const ui: Credential = { ...human, scope_id: "ui:mira", origin: "ui" };
  const launch = (op: Operation): Id<"la"> => {
    const result = writer.submit({
      space_id: space.spaceId,
      request_id: id("op").slice(3),
      actor: ui,
      ops: [op],
    });
    if (result.status !== "applied") {
      throw new Error(`a sample launch was ${result.status}: ${result.error?.code ?? ""}`);
    }
    return result.results[0]?.id as Id<"la">;
  };
  const opened = tasks.find((t) => !completed.has(t)) ?? tasks[0];
  if (opened === undefined) throw new Error("no task");
  const taskVersion = Number(
    conn.prepare("SELECT version FROM tasks WHERE id = $id").get({ id: opened })?.["version"],
  );
  const click = (instance: string, route: string, place: string | null): Id<"la"> =>
    launch({
      kind: "launch.create",
      task: opened,
      instance,
      route,
      place: place as Id<"pl"> | null,
      task_version: taskVersion,
      // SHA-256 of the brief, which is never stored.
      brief_hash: "5f1d0c3a".repeat(8),
    });
  const terminal = click("codex-work", "terminal", portalPlace ?? null);
  const step = (
    which: Id<"la">,
    expect: LaunchState,
    next: LaunchState,
    more: { reason?: string; evidence?: Record<string, string | number | boolean> } = {},
  ): void => {
    launch({ kind: "launch.transition", launch: which, expect, next, ...more });
  };
  step(terminal, "prepared", "dispatching");
  step(terminal, "dispatching", "dispatched", {
    evidence: { claim: "claim-fixture-1", claimed_at: start + 3_600_000 },
  });
  step(terminal, "dispatched", "confirmed", {
    evidence: { pid: 48213, pid_started_at: start + 3_600_400 },
  });
  const link = click("claude-work", "link", null);
  step(link, "prepared", "dispatching");
  step(link, "dispatching", "unknown", { reason: "lost" });

  // Aliases are bookkeeping rows: imported legacy IDs and an old project slug.
  const at = h.at;
  const alias = conn.prepare(
    "INSERT INTO aliases (namespace, alias, entity_kind, entity_id, created_at) " +
      "VALUES ($namespace, $alias, $kind, $id, $at)",
  );
  conn.transaction("immediate", () => {
    alias.run({ namespace: "slug", alias: "portal", kind: "project", id: portal.id, at });
    tasks.slice(0, 2).forEach((taskId) => {
      const legacy = `t-${rng.u32().toString(16).padStart(8, "0")}`;
      alias.run({ namespace: "planning", alias: legacy, kind: "task", id: taskId, at });
    });
  });

  // Runs, as the execution store writes them, only once the schema has their table
  // (0.3), so a sample built by an older chain draws exactly what it drew before. Mira runs the
  // opened task in Codex · work in its place, which succeeds, and queues a Refresh that she
  // removes from the queue.
  const hasRuns =
    conn
      .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'runs'")
      .get() !== undefined;
  if (!hasRuns) return;
  // Every transition names the version it was decided on, as the execution store's do.
  const runVersion = (run: string): number =>
    Number(conn.prepare("SELECT version FROM runs WHERE id = $id").get({ id: run })?.["version"]);
  const limits = { max_turns: 50, wall_ms: 1_800_000, idle_ms: 600_000 };
  const queued = launch({
    kind: "run.create",
    task: opened,
    instance: "codex-work",
    adapter: "codex",
    place: (portalPlace ?? null) as Id<"pl"> | null,
    request: "Check the appointment export and fix the time zone.",
    brief_hash: "7c2e9a41".repeat(8),
    permission: "full-access",
    limits,
  });
  const runStep = (
    expect: RunState,
    next: RunState,
    more: { reason?: string; evidence?: Record<string, string | number | boolean> } = {},
    result?: RunResultRow,
  ): void => {
    launch({
      kind: "run.transition",
      run: queued as unknown as Id<"ru">,
      expect,
      expect_version: runVersion(queued),
      next,
      ...more,
      ...(result === undefined ? {} : { result }),
    });
  };
  runStep("queued", "starting");
  runStep("starting", "running", { evidence: { pid: 51007, pid_started_at: start + 7_200_300 } });
  runStep("running", "running", {
    evidence: { native_id: "0199a3f2-7c41-7d20-9b6e-3f1c2a4b5d6e" },
  });
  runStep(
    "running",
    "succeeded",
    {},
    {
      ok: true,
      outcome: "success",
      exit_code: 0,
      signal: null,
      native_id: "0199a3f2-7c41-7d20-9b6e-3f1c2a4b5d6e",
      text: "The export now writes local times with their zone.",
      error: null,
      usage: { input_tokens: 18_400, cached_input_tokens: 12_000, output_tokens: 2_100 },
      app_tools: null,
      declined: 0,
      permission_denials: 0,
      duration_ms: 412_000,
    },
  );
  const refresh = launch({
    kind: "run.create",
    routine: id("ro"),
    instance: "codex-work",
    adapter: "codex",
    place: null,
    brief_hash: "3b8d0f62".repeat(8),
    permission: "read-only",
    limits: { ...limits, max_turns: 150, wall_ms: 3_600_000 },
  });
  launch({
    kind: "run.transition",
    run: refresh as unknown as Id<"ru">,
    expect: "queued",
    expect_version: runVersion(refresh),
    next: "cancelled",
  });
}
