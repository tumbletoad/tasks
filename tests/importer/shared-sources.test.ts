// M7.03's Verify line, its writer half (A7 3.14): two legacy tasks with one source key become two
// tasks linked to one source row, and the fixture task with the same key is untouched. The plan of
// the synthetic prototype goes into the Mira sample space through the space's writer, which runs
// A1 3.6's source upsert and `dedupe: "none"` as the apply does.
//
// The importer never imports storage, and testkit and the importer import nothing from each other
// (A7 3.2, 3.15.8), so this test lives outside both packages. It sends the operations as a plain
// request of the user: `writerToday` leaves out the parts only an import's own request carries
// (the alias, `created_at`, `ext`, the dates of log entries and completions), which the whole
// apply puts in ([A7.3.15.importer.apply]). Fixture data only, in a temporary folder removed by
// its full name.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  bindOperations,
  mapPrototype,
  parsePrototype,
  readInput,
  type BoundOp,
  type ImportPlan,
} from "../../packages/importer-planning/src/index.ts";
import {
  newId,
  openSpace,
  SpaceWriter,
  type Connection,
  type Credential,
  type Id,
  type Operation,
  type WriteResult,
} from "../../packages/storage/src/index.ts";
import { checkedDriver, MIRA, seedMira } from "../../packages/testkit/src/index.ts";

const REPO = join(import.meta.dirname, "..", "..");

interface Index {
  me: string;
  spaceTask: { seed: string; tasks: number; ref: string; title: string; key: string };
  cases: Record<string, { where: { task?: string }[] }>;
}

type Row = Record<string, unknown>;

let work = "";
let index: Index;
let plan: ImportPlan;
let writer: SpaceWriter | undefined;
let conn: Connection;
let result: WriteResult;
/** The legacy IDs of the cases, and the `t_` IDs their tasks got. */
let legacy: string[];
let space: string[];
let ids: Map<string, Id<"t">>;
let before: { tasks: Row[]; links: Row[]; sources: Row[] };

/** The parts of a bound operation a plain request takes; an import's request carries the rest. */
function writerToday(op: BoundOp): Operation | undefined {
  // The alias (planning, <legacy id>): an import's own operation.
  if (op.kind === "alias.add") return undefined;
  // The creation instant from `(added …)`, `ext.planning`, and the dates of an evidence entry and
  // of a completion: an import's own fields. Without them the writer stamps the commit's instant.
  const later = new Set(["created_at", "ext", "at"]);
  const rest = Object.fromEntries(Object.entries(op).filter(([field]) => !later.has(field)));
  return rest as unknown as Operation;
}

const rows = (sql: string, params: Record<string, string | number> = {}): Row[] =>
  conn.prepare(sql).all(params);

beforeAll(async () => {
  index = JSON.parse(
    readFileSync(join(REPO, "fixtures", "planning-prototype.index.json"), "utf8"),
  ) as Index;
  const { input } = await readInput(join(REPO, "fixtures", "planning-prototype"));
  plan = mapPrototype(parsePrototype(input), {
    me: index.me,
    timeZone: "Europe/Amsterdam",
  });

  work = mkdtempSync(join(tmpdir(), "tasks-m7-03-shared-"));
  const seeded = await seedMira(work, {
    seed: index.spaceTask.seed,
    tasks: index.spaceTask.tasks,
  });
  const opened = openSpace(await checkedDriver(), seeded.folder, { role: "writer" });
  conn = opened.conn;
  writer = SpaceWriter.open(opened, {
    machine: { id: seeded.machine, name: MIRA.machine.name, os: MIRA.machine.os },
  });

  const caseTasks = (name: string): string[] =>
    (index.cases[name]?.where ?? []).map((w) => w.task ?? "");
  legacy = caseTasks("shared-source-legacy");
  space = caseTasks("shared-source-space");
  before = {
    tasks: rows("SELECT * FROM tasks ORDER BY id"),
    links: rows("SELECT * FROM task_sources ORDER BY task_id, source_id"),
    sources: rows("SELECT * FROM sources ORDER BY id"),
  };

  // Their tasks' operations from the plan, bound to fresh IDs as the apply binds them.
  const chosen = new Set([...legacy, ...space]);
  ids = new Map([...chosen].map((id) => [id, newId("t")]));
  const ops = bindOperations(
    { tasks: plan.tasks.filter((t) => chosen.has(t.legacyId)) },
    (id) => ids.get(id) ?? "",
  )
    .map(writerToday)
    .filter((op): op is Operation => op !== undefined);
  const human = rows("SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at, id")[0];
  const actor: Credential = {
    scope_id: "cli:import-fixture",
    principal_id: human?.["id"] as Id<"ac">,
    actor_kind: "human",
    machine_id: seeded.machine,
    origin: "cli",
  };
  result = writer.submit({
    space_id: opened.space.spaceId,
    request_id: newId("op").slice(3),
    actor,
    ops,
  });
});

afterAll(() => {
  writer?.close();
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

const sourceByKey = (key: string): Row[] =>
  rows("SELECT * FROM sources WHERE source_key = $key", { key });
const liveLinks = (source: string): Row[] =>
  rows(
    "SELECT * FROM task_sources WHERE source_id = $source AND removed_at IS NULL ORDER BY task_id",
    {
      source,
    },
  );

describe("[A7.3.15.importer.shared-sources] shared source keys through the writer", () => {
  test("the plan's operations apply, and every legacy task is created, never matched", () => {
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("applied");
    const creates = result.results.filter((r) => [...ids.values()].includes(r.id as Id<"t">));
    expect(creates.map((r) => r.status)).toEqual([...ids.keys()].map(() => "created"));
    expect(result.results.some((r) => r.status === "existing")).toBe(false);
  });

  test("two legacy tasks with one key: two tasks linked to one source row", () => {
    const key = plan.sources.find((s) => s.tasks.length > 1)?.key ?? "";
    expect(plan.sources.find((s) => s.key === key)?.tasks).toEqual(legacy);
    const source = sourceByKey(key);
    expect(source).toHaveLength(1);
    const links = liveLinks(String(source[0]?.["id"]));
    expect(links.map((l) => l["task_id"]).sort()).toEqual(legacy.map((id) => ids.get(id)).sort());
    for (const link of links) expect(link["role"]).toBe("origin");
    const tasks = rows("SELECT id, title FROM tasks WHERE id IN ($a, $b)", {
      a: ids.get(legacy[0] ?? "") ?? "",
      b: ids.get(legacy[1] ?? "") ?? "",
    });
    expect(tasks).toHaveLength(2);
  });

  test("the fixture task with the same key is untouched, and so is every other task", () => {
    const sample = before.tasks.find((t) => t["ref"] === Number(index.spaceTask.ref.slice(2)));
    expect(sample?.["title"]).toBe(index.spaceTask.title);
    // Every task the space had is as it was: fields, versions, touched mark and history fields.
    expect(
      rows("SELECT * FROM tasks WHERE created_seq < $seq ORDER BY id", { seq: result.seq }),
    ).toEqual(before.tasks);
    // Its source row is the one row with the key, unchanged, and it keeps its link.
    const [source] = sourceByKey(index.spaceTask.key);
    expect(sourceByKey(index.spaceTask.key)).toHaveLength(1);
    expect(source).toEqual(before.sources.find((s) => s["id"] === source?.["id"]));
    const sampleLink = before.links.find(
      (l) => l["task_id"] === sample?.["id"] && l["source_id"] === source?.["id"],
    );
    expect(sampleLink).toBeDefined();
    // The legacy task with that key is a task of its own, linked to the same row.
    const links = liveLinks(String(source?.["id"]));
    expect(links.map((l) => l["task_id"]).sort()).toEqual(
      [sample?.["id"], ...space.map((id) => ids.get(id))].sort(),
    );
    expect(links.find((l) => l["task_id"] === sample?.["id"])).toEqual(sampleLink);
    // Every link and source row the space had is unchanged.
    for (const link of before.links) {
      expect(
        rows("SELECT * FROM task_sources WHERE task_id = $t AND source_id = $s", {
          t: String(link["task_id"]),
          s: String(link["source_id"]),
        }),
      ).toEqual([link]);
    }
    for (const s of before.sources) {
      expect(rows("SELECT * FROM sources WHERE id = $id", { id: String(s["id"]) })).toEqual([s]);
    }
  });
});
