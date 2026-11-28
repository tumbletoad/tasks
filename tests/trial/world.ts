// One trial world: a temporary TTasks home with its own service, a seeded space of a few hundred
// tasks, and the trial's part of it, made through the operations as the person and one agent:
// project Trial in area Lumen with its tasks, pages on the space, the area and the project, a
// finished sibling whose log holds a decision no page has, two nodes without a brief (Trial and
// Lumen portal) and one with a poor one (Clinic sync). Every text is fixture text.
//
// The world writes only under its own folder. The agents' instances come from the trial; their
// app homes are never touched: the service looks for agent apps in an empty folder of the world.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcSession } from "../../packages/bridge/src/protocol/index.ts";
import { BIN } from "../../packages/cli/test/cli-harness.ts";
import { startService, type RunningService } from "../../packages/service/src/hub/index.ts";
import { registerSpaces, serviceEnv, stateOf } from "../../packages/service/test/harness.ts";
import { classSession } from "../../packages/service/test/ops-helpers.ts";
import type { Connection } from "../../packages/storage/src/driver.ts";
import { newId } from "../../packages/storage/src/ids.ts";
import { openSpaceConnection } from "../../packages/storage/src/open.ts";
import { PAGE_SHOWN } from "../../packages/storage/src/write/pages.ts";
import { checkedDriver } from "../../packages/storage/test/space-helpers.ts";
import { seedMira } from "../../packages/testkit/src/mira.ts";

export type Json = Record<string, unknown>;

export const AREA = "Lumen";
export const PROJECT = "Trial";

/** The pages the world starts with: the space's, the area's (its date rule) and the project's. */
export const PAGES = {
  writing: {
    on: "space",
    title: "Writing",
    brief: "How notes and pages are written in this space",
    body: "## Language\n\nWrite in English. Cite the task for every fact.\n\n## Length\n\nOne idea a paragraph.",
  },
  dates: {
    on: "area",
    title: "Dates and amounts",
    brief: "How dates and amounts are written in the clinic's work: read it before writing one",
    body:
      "## Dates\n\nWrite every date as day, short month and year: 3 Dec 2026. Never 12/03/2026, " +
      "never 2026-12-03.\n\n## Amounts\n\nAmounts in euros with two decimals: EUR 12.50.",
  },
  // The zone column is `zone_id`: task 2's request shows `tz` is wrong.
  export: {
    on: "project",
    title: "Export columns",
    brief: "The columns of the clinic's weekly export and what each holds",
    body:
      "## Columns\n\n- `visit_at`: the visit's time, in UTC.\n- `tz`: the clinic's time zone, an " +
      "IANA name.\n- `amount_eur`: the fee, in euros.\n- `clinic`: the clinic's code.",
  },
  checklist: {
    on: "project",
    title: "Release checklist",
    brief: "What to do before and after a release of the sync",
    body: "## Before\n\n- Run the export on the test clinics.\n\n## After\n\n- Check the first export of the day.",
  },
} as const;

export type PageName = keyof typeof PAGES;

export const SIBLING = {
  title: "Agree invoice rounding with the clinic",
  decision:
    "Decided with the clinic on 14 Nov 2026: invoice amounts are rounded to whole euros, half up, " +
    "on each line, never on the total.",
  outcome: "Agreed the rounding with the clinic.",
};

export interface World {
  readonly root: string;
  readonly home: string;
  readonly service: RunningService;
  /** The space's database, read only: the checks read what the agents left. */
  readonly db: Connection;
  readonly refPrefix: string;
  readonly pages: Readonly<Record<PageName, string>>;
  /** The trial's tasks by their number in the script, with the sibling as "sibling". */
  readonly tasks: ReadonlyMap<string, { readonly id: string; readonly ref: string }>;
  readonly projectId: string;
  /** The last change the setup made: what the agents did comes after it. */
  readonly setupSeq: number;
  /** The space's as_of now, the base a scripted finish gives. */
  asOf(): Promise<string>;
  /** The reference the space gives the next task or page it makes. */
  nextRef(): string;
  stop(): Promise<void>;
}

let n = 0;
/** A request ID of the trial's own, unique in this process. */
export const rid = (): string =>
  `trial-${process.pid.toString(36)}-${Date.now().toString(36)}-${String((n += 1)).padStart(4, "0")}`;

async function op(session: RpcSession, name: string, input: Json): Promise<Json> {
  return (await session.call("op/call", { op: name, input }, { timeoutMs: 60_000 })) as Json;
}

/**
 * Makes a world under `root`: seeds the space with `seedTasks` tasks, registers the agents'
 * `instances` (machine.toml `[[instance]]` tables), starts the service, and makes the trial's part
 * with one task per title in `titles`, keyed by its number.
 */
export async function makeWorld(
  root: string,
  options: {
    readonly seedTasks: number;
    readonly instances: string;
    readonly titles: ReadonlyMap<string, string>;
  },
): Promise<World> {
  const home = join(root, "h");
  const machine = newId("m");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateOf(home), "machine.json"),
    JSON.stringify({
      machine_id: machine,
      name: "trial-machine",
      created_at: "2026-11-17T08:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(root, "spaces"));
  mkdirSync(join(root, "agent-apps"));
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const seeded = await seedMira(join(root, "spaces"), {
    tasks: options.seedTasks,
    machineId: machine,
    os,
  });
  registerSpaces(home, [seeded.folder], options.instances);
  const service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
    launch: { shimCommand: [process.execPath, BIN], baseEnv: () => process.env },
    agentApps: { env: {}, home: join(root, "agent-apps") },
  });
  await service.spacesSettled;
  const db = openSpaceConnection(await checkedDriver(), join(seeded.folder, "space.db"), "reader");
  const person = await classSession(home, service.endpoint.path, "cli-interactive");
  const agent = await classSession(home, service.endpoint.path, "cli-script");
  try {
    const asOf = async () => String((await op(person, "space.status", {}))["as_of"]);
    const refPrefix = String(
      db.prepare("SELECT ref_prefix FROM space WHERE one = 1").get()?.["ref_prefix"],
    );
    const numbers = ["sibling", ...options.titles.keys()];
    const added = await op(person, "task.add", {
      tasks: [SIBLING.title, ...options.titles.values()].map((title) => ({
        title,
        area: AREA,
        project: PROJECT,
      })),
      request_id: rid(),
    });
    const tasks = new Map<string, { id: string; ref: string }>();
    (added["tasks"] as Json[]).forEach((task, i) => {
      tasks.set(numbers[i] ?? "", { id: String(task["id"]), ref: String(task["ref"]) });
    });
    const group = (table: "areas" | "projects", title: string): string =>
      String(
        db
          .prepare(`SELECT id FROM ${table} WHERE title = $title AND deleted_at IS NULL`)
          .get({ title })?.["id"],
      );
    const area = group("areas", AREA);
    const projectId = group("projects", PROJECT);
    // The briefs: the space's and the area's good, Clinic sync's poor, Trial's and Lumen portal's none.
    for (const [target, brief] of [
      ["space", "Work for the Lumen clinic group, and the house"],
      [area, "The clinic group's portal, its sync and the weekly export"],
      [group("projects", "Clinic sync"), "misc"],
    ] as const) {
      await op(person, "page.write", {
        action: "set",
        target,
        brief,
        base: await asOf(),
        why: "the trial's start",
        request_id: rid(),
      });
    }
    const holder = { space: "space", area, project: projectId } as const;
    const pages = {} as Record<PageName, string>;
    for (const [name, page] of Object.entries(PAGES) as [PageName, (typeof PAGES)[PageName]][]) {
      const made = await op(person, "page.write", {
        action: "create",
        on: holder[page.on],
        title: page.title,
        brief: page.brief,
        body: page.body,
        why: "the trial's start",
        request_id: rid(),
      });
      pages[name] = String(made["target"]);
    }
    const sibling = tasks.get("sibling")?.ref ?? "";
    await op(agent, "entry.add", {
      task: sibling,
      kind: "decision",
      text: SIBLING.decision,
      request_id: rid(),
    });
    await op(agent, "task.finish", {
      task: sibling,
      outcome: SIBLING.outcome,
      base: await asOf(),
      request_id: rid(),
    });
    const setupSeq = Number(db.prepare("SELECT max(seq) AS n FROM commits").get()?.["n"] ?? 0);
    return {
      root,
      home,
      service,
      db,
      refPrefix,
      pages,
      tasks,
      projectId,
      setupSeq,
      asOf: async () => {
        const s = await classSession(home, service.endpoint.path, "cli-interactive");
        try {
          return String((await op(s, "space.status", {}))["as_of"]);
        } finally {
          s.close();
        }
      },
      nextRef: () =>
        `${refPrefix}-${String(db.prepare("SELECT next_ref FROM space WHERE one = 1").get()?.["next_ref"])}`,
      stop: async () => {
        db.close();
        await service.stop();
      },
    };
  } finally {
    person.close();
    agent.close();
  }
}

// ---------------------------------------------------------------------------------------------
// What the checks read

export interface PageNow {
  readonly ref: string;
  readonly title: string;
  readonly brief: string;
  readonly body: string;
  readonly ownerKind: string;
  readonly createdSeq: number;
}

/** The pages the space shows now. */
export function livePages(world: World): PageNow[] {
  return world.db
    .prepare(
      `SELECT p.ref, p.title, p.brief, p.body, p.owner_kind, p.created_seq FROM pages p ` +
        `WHERE p.deleted_at IS NULL AND ${PAGE_SHOWN} ORDER BY p.ref`,
    )
    .all()
    .map((row) => ({
      ref: `${world.refPrefix}-${String(row["ref"])}`,
      title: String(row["title"]),
      brief: String(row["brief"]),
      body: String(row["body"]),
      ownerKind: String(row["owner_kind"]),
      createdSeq: Number(row["created_seq"]),
    }));
}

export const pageOf = (world: World, ref: string): PageNow | undefined =>
  livePages(world).find((p) => p.ref === ref);

/** A stored text, or "" for none. */
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** What a task says now: its outcome and its log, as one text. */
export function taskText(world: World, id: string): string {
  const task = world.db.prepare("SELECT outcome FROM tasks WHERE id = $id").get({ id });
  const log = world.db
    .prepare(
      "SELECT body FROM log_entries WHERE task_id = $id AND deleted_at IS NULL ORDER BY ordinal",
    )
    .all({ id })
    .map((row) => String(row["body"]));
  return [textOf(task?.["outcome"]), ...log].join("\n");
}

/** The edits of pages since the setup: changes to a page's body, title or brief, one per commit. */
export function pageEdits(world: World): number {
  const row = world.db
    .prepare(
      "SELECT count(DISTINCT seq || ':' || entity_id) AS n FROM changes WHERE entity = 'pages' " +
        "AND action <> 'create' AND seq > $seq",
    )
    .get({ seq: world.setupSeq });
  return Number(row?.["n"] ?? 0);
}

/**
 * The bytes of history the page edits since the setup left: their change rows, the words before
 * and after each changed field.
 */
export function historyBytes(world: World): number {
  const row = world.db
    .prepare(
      "SELECT sum(coalesce(length(CAST(before AS BLOB)), 0) + " +
        "coalesce(length(CAST(after AS BLOB)), 0)) AS n FROM changes " +
        "WHERE entity = 'pages' AND action <> 'create' AND seq > $seq",
    )
    .get({ seq: world.setupSeq });
  return Number(row?.["n"] ?? 0);
}

/** The brief a project has now. */
export const projectBrief = (world: World, id: string): string =>
  textOf(world.db.prepare("SELECT brief FROM projects WHERE id = $id").get({ id })?.["brief"]);

/** A run's token counts, as its agent reported them. */
export function usageOf(world: World, run: string): Json {
  const row = world.db.prepare("SELECT result FROM runs WHERE id = $id").get({ id: run });
  const result = JSON.parse(textOf(row?.["result"]) || "{}") as Json;
  return (result["usage"] as Json | null | undefined) ?? {};
}
