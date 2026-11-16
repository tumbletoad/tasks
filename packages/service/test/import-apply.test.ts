// M7.05 (A7 3.15.5, 3.15.6): the apply of a dry run, its guards, re-imports over a space the
// person changed, and the undo, through the service's own dry run, apply and undo on the Mira
// sample space, in one thread (import-harness.ts). The committed synthetic prototype is the input,
// copied into a folder of the test's own where a test edits it. Fixture data only; every folder is
// made in beforeAll and removed by its full name in afterAll.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AppError,
  ImportPlanningApplyResult,
  ImportPlanningUndoResult,
  ReceiptGetResult,
  receiptResult,
} from "@tasks/contracts";
import { applyRequestId } from "../src/ops/import-planning.ts";
import {
  hashInputs,
  judgedNames,
  mapPrototype,
  parsePrototype,
  previewPinned,
  readInput,
  type ImportPlan,
  type MappingOptions,
} from "@tasks/importer-planning";
import {
  formatAsOf,
  recomputeToken,
  StorageError,
  type Id,
  type PreviewGuard,
} from "@tasks/storage";
import {
  openWorld,
  writePrototype,
  ZONE,
  type ImportWorld,
  type ProtoTask,
  type WorldOptions,
} from "./import-harness.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const FIXTURE = join(REPO, "fixtures", "planning-prototype");

interface Index {
  me: string;
  roots: Record<string, string>;
}
const index = JSON.parse(
  readFileSync(join(REPO, "fixtures", "planning-prototype.index.json"), "utf8"),
) as Index;
const ROOTS = Object.entries(index.roots).map(([id, path]) => ({ id, path }));
const OPTIONS: MappingOptions = {
  me: index.me,
  roots: Object.fromEntries(ROOTS.map((r) => [r.id, r.path])),
  timeZone: ZONE,
};

let scratch = "";
let n = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-05-apply-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A world of its own and a copy of the fixture prototype the test may edit. */
async function fresh(options: WorldOptions = {}) {
  n += 1;
  const root = join(scratch, `w${String(n)}`);
  const prototype = join(root, "prototype");
  cpSync(FIXTURE, prototype, { recursive: true });
  const world = await openWorld(root, { roots: ROOTS, ...options });
  return { world, prototype, root };
}

const dryRun = (world: ImportWorld, prototype: string) =>
  world.preview({ folder: prototype, me: index.me });

/** A dry run and its apply. */
async function imported(world: ImportWorld, prototype: string) {
  const preview = await dryRun(world, prototype);
  expect(preview.blocked).toBe(false);
  const result = await world.apply(preview.run, preview.token ?? "");
  expect(ImportPlanningApplyResult.safeParse(result).success).toBe(true);
  return { preview, result };
}

/** The error an apply or an undo was refused with. */
async function refusal(work: Promise<unknown>): Promise<{ code: string; cause?: unknown }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, cause: error.data["cause"] };
    if (error instanceof StorageError) return { code: error.code };
    throw error;
  }
  throw new Error("It was not refused");
}

/** The task a legacy ID names now. */
const taskOf = (world: ImportWorld, legacy: string): Id<"t"> =>
  String(
    world.rows("SELECT entity_id FROM aliases WHERE namespace = 'planning' AND alias = $a", {
      a: legacy,
    })[0]?.["entity_id"],
  ) as Id<"t">;

const task = (world: ImportWorld, id: string) =>
  world.rows("SELECT * FROM tasks WHERE id = $id", { id })[0] ?? {};

/** The fixture's metadata: an object keyed by legacy ID. */
function metadata(prototype: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(prototype, "data", "metadata.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
}

function setMeta(prototype: string, legacy: string, fields: Record<string, unknown>): void {
  const meta = metadata(prototype);
  meta[legacy] = { ...(meta[legacy] ?? {}), ...fields };
  writeFileSync(join(prototype, "data", "metadata.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Active, marked tasks of the dry run with metadata, by legacy ID: the tests edit these. */
function picks(prototype: string, preview: { tasks: { legacy_id: string; lifecycle: string }[] }) {
  const meta = metadata(prototype);
  return preview.tasks
    .filter((t) => t.lifecycle === "active" && !t.legacy_id.startsWith("t-"))
    .map((t) => t.legacy_id)
    .filter((id) => meta[id] !== undefined);
}

/** The plan of a run as the apply makes it again, and the guard the service sends the writer. */
async function guardOf(world: ImportWorld, folder: string, run: string, token: string) {
  const { input } = await readInput(join(folder, "input"));
  const plan: ImportPlan = mapPrototype(parsePrototype(input), OPTIONS);
  const { files } = await hashInputs(join(folder, "input"));
  const projects = world
    .rows(
      "SELECT p.slug, p.id, p.version, a.slug AS area, p.title FROM projects p LEFT JOIN areas a " +
        "ON a.id = p.area_id AND a.deleted_at IS NULL WHERE p.deleted_at IS NULL",
    )
    .map((r) => ({
      slug: String(r["slug"]),
      id: String(r["id"]),
      version: Number(r["version"]),
      area: (r["area"] as string | null) ?? null,
      title: String(r["title"]),
    }));
  const areas = world
    .rows("SELECT slug, id, version, title FROM areas WHERE deleted_at IS NULL")
    .map((r) => ({
      slug: String(r["slug"]),
      id: String(r["id"]),
      version: Number(r["version"]),
      title: String(r["title"]),
    }));
  const guard: PreviewGuard = {
    token,
    pinned: previewPinned(plan, { run, inputs: files, options: OPTIONS }) as PreviewGuard["pinned"],
    ...judgedNames(plan, { areas, projects }),
  };
  return { plan, guard };
}

describe("[A7.3.15.importer.apply] the apply of a dry run", () => {
  test("the fixture applies as one commit: tasks, aliases, groups, the exchange and its items", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await dryRun(world, prototype);
      expect(preview.blocked).toBe(false);
      const before = world.seq();
      const tasksBefore = Number(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"]);
      const result = await world.apply(preview.run, preview.token ?? "");
      expect(ImportPlanningApplyResult.safeParse(result).success).toBe(true);
      expect(result.status).toBe("applied");
      expect(result.counts.created).toBe(preview.counts.tasks);
      // One commit, of the user with the import actor as author and origin import. The import
      // actor joins the space on its first act, a system commit of its own (A1 3.6).
      const since = world.rows("SELECT * FROM commits WHERE seq > $seq ORDER BY seq", {
        seq: before,
      });
      expect(since.map((c) => [c["origin"], c["kind"]])).toEqual([
        ["system", "ops"],
        ["import", "ops"],
      ]);
      const commit = since[1];
      expect(commit?.["id"]).toBe(result.commit);
      const applied = Number(commit?.["seq"]);
      expect(commit).toMatchObject({ actor_kind: "human", principal_id: world.user });
      const author = world.rows("SELECT kind FROM actors WHERE id = $id", {
        id: String(commit?.["author_id"]),
      });
      expect(author[0]?.["kind"]).toBe("import");
      // Never on the undo stack: an import is undone with its own undo.
      expect(commit?.["undo_status"]).toBeNull();
      expect(Number(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"])).toBe(
        tasksBefore + preview.counts.tasks,
      );
      // Every legacy ID is an alias of its own task, created by the user.
      const aliases = world.rows(
        "SELECT a.alias, t.created_by, t.ext FROM aliases a JOIN tasks t ON t.id = a.entity_id " +
          "WHERE a.namespace = 'planning' AND t.created_seq = $seq",
        { seq: applied },
      );
      expect(aliases).toHaveLength(preview.counts.aliases);
      for (const a of aliases) {
        expect(a["created_by"]).toBe(world.user);
        const ext = JSON.parse(String(a["ext"])) as { planning: Record<string, unknown> };
        expect(ext.planning["legacy_id"]).toBe(a["alias"]);
        expect(typeof ext.planning["imported_at"]).toBe("number");
      }
      // The exchange is applied in that commit, with one item per task, its folder the input copy.
      expect(
        world.rows("SELECT * FROM exchanges WHERE id = $id", { id: preview.run })[0],
      ).toMatchObject({
        state: "applied",
        applied_seq: applied,
        dir: `exchange/planning/${preview.run}/input`,
      });
      expect(
        world.rows("SELECT count(*) AS n FROM exchange_items WHERE exchange_id = $id", {
          id: preview.run,
        })[0]?.["n"],
      ).toBe(preview.counts.tasks);
      // Areas the space holds by slug are reused; the others are new.
      expect(
        world.rows("SELECT count(*) AS n FROM areas WHERE created_seq = $seq", {
          seq: applied,
        })[0]?.["n"],
      ).toBe(preview.counts.areas - preview.counts.areas_existing);
      // The prototype's own instants: a check-off's time, an evidence entry's day.
      const done = world.rows(
        "SELECT completed_at, created_at FROM tasks WHERE created_seq = $seq AND completed_at IS NOT NULL",
        { seq: applied },
      );
      expect(done.length).toBe(preview.counts.completed);
      expect(done.some((t) => t["completed_at"] !== commit?.["at"])).toBe(true);
      // A barrier backup was taken right before it.
      expect(result.backup).toMatch(/^pre-import-/);
      expect(
        readdirSync(join(world.folder, "backups")).filter((f) => f.startsWith("pre-import-")),
      ).toHaveLength(2);
      // The run's folder holds the answer.
      expect(JSON.parse(readFileSync(join(preview.folder, "apply.json"), "utf8"))).toMatchObject({
        status: "applied",
        commit: result.commit,
      });
    } finally {
      world.close();
    }
  }, 120_000);

  test("applying twice applies once, and the same input again applies nothing", async () => {
    const { world, prototype } = await fresh();
    try {
      const { preview, result } = await imported(world, prototype);
      const seq = world.seq();
      const backups = readdirSync(join(world.folder, "backups")).length;
      const again = await world.apply(preview.run, preview.token ?? "");
      expect(again).toMatchObject({ status: "applied", commit: result.commit, replayed: true });
      expect(world.seq()).toBe(seq);
      // Its receipt reads back through receipt.get as any write's does.
      const receipt = world.writer.receipt({
        scope_id: "cli:import-test",
        request_id: applyRequestId(preview.run, preview.token ?? ""),
      });
      expect(receipt?.result.results.length).toBeGreaterThan(50);
      expect(ReceiptGetResult.safeParse(receiptResult(receipt)).success).toBe(true);
      // A new dry run of the same prototype: zero operations, no commit, no backup.
      const second = await imported(world, prototype);
      expect(second.result.status).toBe("unchanged");
      expect(second.result.counts).toMatchObject({ created: 0, updated: 0, conflicts: 0 });
      expect(world.seq()).toBe(seq);
      expect(readdirSync(join(world.folder, "backups")).length).toBe(backups);
    } finally {
      world.close();
    }
  }, 120_000);

  test("the token the writer recomputes in its transaction is the dry run's; another is refused", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await dryRun(world, prototype);
      const token = preview.token ?? "";
      const { guard } = await guardOf(world, preview.folder, preview.run, token);
      expect(recomputeToken(world.conn, guard)).toBe(token);
      // An import request whose preview no longer holds: refused in the transaction, decided.
      const importer = world.writer.actor("import", "import");
      const request = (preview: PreviewGuard) => ({
        space_id: world.writer.spaceId,
        request_id: `guard-${preview.token.slice(4, 24)}`,
        actor: {
          scope_id: "cli:import-test",
          principal_id: world.user,
          actor_kind: "human" as const,
          author_id: importer,
          machine_id: world.machine,
          origin: "import" as const,
        },
        base: formatAsOf(world.writer.asOf()),
        preview,
        ops: [{ kind: "area.upsert" as const, slug: "guarded", title: "Guarded" }],
      });
      const seq = world.seq();
      const stale = world.writer.submit(request({ ...guard, token: `pv1_${"A".repeat(43)}` }));
      expect(stale).toMatchObject({ status: "rejected", error: { code: "PREVIEW_STALE" } });
      expect(world.seq()).toBe(seq);
      // Only the import actor writes an import: the user as its author is refused, undecided.
      const human = request(guard);
      const byUser = world.writer.submit({
        ...human,
        request_id: `${human.request_id}-u`,
        actor: { ...human.actor, author_id: world.user },
      });
      expect(byUser).toMatchObject({
        status: "rejected",
        error: { code: "VALIDATION_FAILED", field: "actor.author_id" },
      });
      expect(world.seq()).toBe(seq);
      // A request of origin import with no import's powers is a plain one, held to a plain one's
      // size: over 512 KiB it is refused, whoever its author is.
      const mira = String(world.rows("SELECT id FROM tasks ORDER BY ref LIMIT 1")[0]?.["id"]);
      const large = world.writer.submit({
        space_id: human.space_id,
        request_id: `${human.request_id}-large`,
        actor: { ...human.actor, author_id: world.user },
        base: human.base,
        // 40 entries of 16,000 characters: each within its limit, 640,000 bytes together.
        ops: Array.from({ length: 40 }, () => ({
          kind: "log.add" as const,
          task: mira,
          body: "x".repeat(16_000),
        })),
      });
      expect(large).toMatchObject({ status: "rejected", error: { code: "TOO_LARGE" } });
      expect(world.seq()).toBe(seq);
      expect(world.writer.submit(request(guard)).status).toBe("applied");
    } finally {
      world.close();
    }
  }, 120_000);

  test("a space that changed between the dry run and the apply: nothing is written", async () => {
    const { world, prototype } = await fresh();
    try {
      // A first import: a source key of the plan that the space takes meanwhile.
      const preview = await dryRun(world, prototype);
      const { plan } = await guardOf(world, preview.folder, preview.run, preview.token ?? "");
      const keyed = plan.sources.find((s) => s.key !== undefined);
      const mira = String(world.rows("SELECT id FROM tasks ORDER BY ref LIMIT 1")[0]?.["id"]);
      const edit = world.edit([
        {
          kind: "source.add",
          task: mira,
          source: {
            kind: "web",
            title: "Taken meanwhile",
            key: keyed?.key ?? "",
            url: keyed?.url ?? "",
          },
        },
      ]);
      expect(edit.status).toBe("applied");
      const seq = world.seq();
      expect(await refusal(world.apply(preview.run, preview.token ?? ""))).toMatchObject({
        code: "conflict",
        cause: "PREVIEW_STALE",
      });
      expect(world.seq()).toBe(seq);
      expect(world.rows("SELECT * FROM exchanges")).toHaveLength(0);

      // A re-import: an imported task the person edits after the dry run.
      const first = await imported(world, prototype);
      expect(first.result.status).toBe("applied");
      const again = await dryRun(world, prototype);
      const legacy = picks(prototype, again)[0] ?? "";
      expect(
        world.edit([{ kind: "task.patch", task: taskOf(world, legacy), set: { title: "Mine" } }])
          .status,
      ).toBe("applied");
      const after = world.seq();
      expect(await refusal(world.apply(again.run, again.token ?? ""))).toMatchObject({
        code: "conflict",
        cause: "PREVIEW_STALE",
      });
      expect(world.seq()).toBe(after);
    } finally {
      world.close();
    }
  }, 120_000);

  test("apply.json holds every task, the answer the first 2,000 with conflicts first, and a replay without it says so", async () => {
    const { world, prototype } = await synthetic();
    try {
      const tasks = (edit: (i: number) => Partial<ProtoTask>) =>
        Array.from({ length: 2_001 }, (_, i) => ({
          id: `p-${String(i)}`,
          title: `Task ${String(i)}`,
          ...edit(i),
        }));
      writePrototype(prototype, { tasks: tasks(() => ({})) });
      const first = await importedSynthetic(world, prototype);
      expect(first.result).toMatchObject({ counts: { created: 2_001 }, tasks_more: 1 });
      expect(first.result.tasks).toHaveLength(2_000);
      const stored = (run: string) =>
        JSON.parse(
          readFileSync(join(world.folder, "exchange", "planning", run, "apply.json"), "utf8"),
        ) as ImportPlanningApplyResult;
      expect(stored(first.preview.run).tasks).toHaveLength(2_001);

      // The last task conflicts, every other one changes: the conflict leads the answer.
      const last = taskOf(world, "p-2000");
      world.edit([{ kind: "task.patch", task: last, set: { title: "Mine" } }]);
      writePrototype(prototype, {
        tasks: tasks((i) =>
          i === 2_000 ? { title: "In the prototype" } : { meta: { next: "Changed" } },
        ),
      });
      const second = await importedSynthetic(world, prototype);
      expect(second.result.counts).toMatchObject({ updated: 2_000, conflicts: 1 });
      expect(second.result.tasks[0]).toMatchObject({ legacy_id: "p-2000", conflicts: ["title"] });
      expect(stored(second.preview.run).tasks).toHaveLength(2_001);

      // A replay whose apply.json is gone counts from the commit and says what it cannot know.
      rmSync(join(world.folder, "exchange", "planning", second.preview.run, "apply.json"));
      const replay = await world.apply(second.preview.run, second.preview.token ?? "");
      expect(ImportPlanningApplyResult.safeParse(replay).success).toBe(true);
      expect(replay).toMatchObject({
        replayed: true,
        incomplete: true,
        counts: { created: 0, updated: 2_000, unchanged: 1 },
        tasks_more: 0,
      });
    } finally {
      world.close();
    }
  }, 300_000);

  test("a write between the apply's read and its barrier makes it decide again, on what the person did", async () => {
    n += 1;
    const root = join(scratch, `w${String(n)}`);
    const places = join(root, "places");
    mkdirSync(join(places, "old"), { recursive: true });
    mkdirSync(join(places, "new"), { recursive: true });
    const options: WorldOptions = { roots: [{ id: "work", path: places }] };
    const world = await openWorld(root, options);
    const prototype = join(root, "prototype");
    try {
      writePrototype(prototype, {
        tasks: [{ id: "pa", title: "Task", meta: { paths: [join(places, "old")] } }],
      });
      await importedSynthetic(world, prototype);
      const ta = taskOf(world, "pa");
      writePrototype(prototype, {
        tasks: [{ id: "pa", title: "Task", meta: { paths: [join(places, "new")] } }],
      });
      const preview = await world.preview({ folder: prototype });
      // The person clears the task's folder in another window just after the apply read the space.
      // A place is a row of its own: the token's task versions do not see it.
      let handed = 0;
      options.beforeBarrier = () => {
        handed += 1;
        if (handed === 1) {
          expect(world.edit([{ kind: "place.clear", task: ta }]).status).toBe("applied");
        }
      };
      const result = await world.apply(preview.run, preview.token ?? "");
      const live = world.rows(
        "SELECT root_id, rel_path FROM places WHERE owner_id = $t AND deleted_at IS NULL",
        { t: ta },
      );
      expect(live).toEqual([]);
      // Decided again on the cleared place: both sides changed it, a conflict, nothing written.
      expect(result.status).toBe("unchanged");
      expect(result.tasks.find((t) => t.legacy_id === "pa")?.conflicts).toEqual(["place"]);

      // A space that keeps changing at that moment: refused, nothing of the import written.
      writePrototype(prototype, {
        tasks: [{ id: "pa", title: "Task renamed", meta: { paths: [join(places, "new")] } }],
      });
      const busy = await world.preview({ folder: prototype });
      const mira = String(world.rows("SELECT id FROM tasks ORDER BY ref LIMIT 1")[0]?.["id"]);
      options.beforeBarrier = () => {
        world.edit([{ kind: "note.add", task: mira, body: `Meanwhile ${String(world.seq())}` }]);
      };
      expect(await refusal(world.apply(busy.run, busy.token ?? ""))).toMatchObject({
        code: "conflict",
        cause: "SPACE_CHANGED",
      });
      expect(task(world, ta)["title"]).toBe("Task");
      options.beforeBarrier = undefined;
      expect((await world.apply(busy.run, busy.token ?? "")).status).toBe("applied");
      expect(task(world, ta)["title"]).toBe("Task renamed");
    } finally {
      world.close();
    }
  }, 120_000);

  test("a prototype that changed between the dry run and the apply: nothing is written", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await dryRun(world, prototype);
      writeFileSync(
        join(prototype, "TODO.md"),
        `${readFileSync(join(prototype, "TODO.md"), "utf8")}- [ ] **Added after the dry run**\n`,
      );
      const seq = world.seq();
      expect(await refusal(world.apply(preview.run, preview.token ?? ""))).toMatchObject({
        code: "conflict",
        cause: "PREVIEW_STALE",
      });
      expect(world.seq()).toBe(seq);
      // And a token that is not the run's.
      expect(await refusal(world.apply(preview.run, `pv1_${"B".repeat(43)}`))).toMatchObject({
        code: "invalid_input",
      });
    } finally {
      world.close();
    }
  }, 120_000);

  test("a failed pre-import backup aborts the apply before its transaction starts", async () => {
    let fail: "write" | "disk" | undefined = "write";
    const { world, prototype } = await fresh({
      barrier: {
        at: (point) => {
          if (fail === "write" && point === "checked") throw new Error("the backup fails here");
        },
        // A disk with room, or a full one: the backup checks the room before it writes.
        freeBytes: () => (fail === "disk" ? 0 : Number.MAX_SAFE_INTEGER),
      },
    });
    try {
      const preview = await dryRun(world, prototype);
      const before = world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"];
      const nothing = () => {
        expect(world.rows("SELECT * FROM exchanges")).toHaveLength(0);
        expect(world.rows("SELECT * FROM commits WHERE origin = 'import'")).toHaveLength(0);
        expect(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"]).toBe(before);
      };
      expect(await refusal(world.apply(preview.run, preview.token ?? ""))).toMatchObject({
        code: "space_unavailable",
        cause: "BACKUP_FAILED",
      });
      nothing();
      // A full disk: the backup refuses before it writes anything.
      fail = "disk";
      expect(await refusal(world.apply(preview.run, preview.token ?? ""))).toMatchObject({
        code: "too_large",
        cause: "BUNDLE_LIMIT_EXCEEDED",
      });
      nothing();
      expect(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"]).toBe(before);
      // With room again, the same command applies.
      fail = undefined;
      expect((await world.apply(preview.run, preview.token ?? "")).status).toBe("applied");
    } finally {
      world.close();
    }
  }, 120_000);

  test("two imports at once: one applies, the other is refused, and no task is made twice", async () => {
    const { world, prototype, root } = await fresh();
    try {
      const other = join(root, "prototype-2");
      cpSync(prototype, other, { recursive: true });
      const [a, b] = await Promise.all([dryRun(world, prototype), dryRun(world, other)]);
      const before = Number(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"]);
      const outcomes = await Promise.allSettled([
        world.apply(a.run, a.token ?? ""),
        world.apply(b.run, b.token ?? ""),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((o) => o.status === "rejected");
      expect(["conflict", "space_unavailable"]).toContain(
        refused?.status === "rejected" ? (refused.reason as AppError).code : "",
      );
      expect(Number(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"])).toBe(
        before + a.counts.tasks,
      );
      const counts = world.rows(
        "SELECT alias, count(*) AS n FROM aliases WHERE namespace = 'planning' GROUP BY alias HAVING n > 1",
      );
      expect(counts).toEqual([]);
    } finally {
      world.close();
    }
  }, 120_000);
});

describe("[A7.3.15.importer.reimport] a re-import over a space the person changed", () => {
  test("a changed prototype field applies exactly that field; one the space changed is kept and shown", async () => {
    const { world, prototype } = await fresh();
    try {
      const { preview } = await imported(world, prototype);
      const [a = "", b = ""] = picks(prototype, preview);
      const ta = taskOf(world, a);
      const tb = taskOf(world, b);
      // The person renames a; the prototype renames a too, raises its priority and rewrites b's next.
      expect(world.edit([{ kind: "task.patch", task: ta, set: { title: "Mine" } }]).status).toBe(
        "applied",
      );
      const priority = Number(task(world, ta)["priority"]) === 1 ? "P2" : "P1";
      setMeta(prototype, a, { priority });
      setMeta(prototype, b, { next: "Call the clinic about the export" });
      const todo = readFileSync(join(prototype, "TODO.md"), "utf8");
      const line = todo.split("\n").find((l) => l.includes(`<!-- task:${a} -->`)) ?? "";
      writeFileSync(
        join(prototype, "TODO.md"),
        todo.replace(line, line.replace(/\*\*(.+?)\*\*/, "**Renamed in the prototype**")),
      );
      const before = { a: task(world, ta), b: task(world, tb) };
      const { result } = await imported(world, prototype);
      expect(result.status).toBe("applied");
      const row = (id: string) => result.tasks.find((t) => t.legacy_id === id);
      expect(row(a)).toMatchObject({
        outcome: "updated",
        changed: ["priority"],
        conflicts: ["title"],
      });
      expect(row(b)).toMatchObject({ outcome: "updated", changed: ["summary"] });
      expect(result.counts).toMatchObject({ created: 0, conflicts: 1 });
      const after = { a: task(world, ta), b: task(world, tb) };
      expect(after.a["title"]).toBe("Mine");
      expect(after.a["priority"]).toBe(Number(priority.slice(1)));
      expect(after.b["summary"]).toBe("Call the clinic about the export");
      // Every other field of both is as it was.
      for (const [id, field] of [
        ["a", "context"],
        ["a", "status"],
        ["a", "due_date"],
        ["b", "title"],
        ["b", "priority"],
        ["b", "context"],
      ] as const) {
        expect(after[id][field], `${id}.${field}`).toEqual(before[id][field]);
      }
      // The conflict stays shown, and nothing is written for it.
      const seq = world.seq();
      const third = await imported(world, prototype);
      expect(third.result).toMatchObject({ status: "unchanged", counts: { conflicts: 1 } });
      expect(world.seq()).toBe(seq);
      // When the person takes the prototype's title, the two agree: no conflict from then on.
      world.edit([{ kind: "task.patch", task: ta, set: { title: "Renamed in the prototype" } }]);
      expect((await imported(world, prototype)).result.counts.conflicts).toBe(0);
    } finally {
      world.close();
    }
  }, 120_000);

  test("after the person completed, deleted and moved imported tasks, nothing of theirs is undone", async () => {
    const { world, prototype } = await fresh();
    try {
      const { preview } = await imported(world, prototype);
      const [c = "", d = "", e = ""] = picks(prototype, preview);
      const [tc, td, te] = [taskOf(world, c), taskOf(world, d), taskOf(world, e)];
      const areaOf = (id: string) => String(task(world, id)["area_id"]);
      const elsewhere = String(
        world.rows("SELECT slug FROM areas WHERE deleted_at IS NULL AND id <> $a ORDER BY slug", {
          a: areaOf(te),
        })[0]?.["slug"],
      );
      for (const op of [
        { kind: "task.complete" as const, task: tc },
        { kind: "task.delete" as const, task: td },
        { kind: "task.move" as const, task: te, area: elsewhere },
      ]) {
        expect(world.edit([op]).status).toBe("applied");
      }
      const moved = areaOf(te);
      // The same prototype: nothing to write; the deleted task is named, not brought back.
      const seq = world.seq();
      const same = await imported(world, prototype);
      expect(same.result.status).toBe("unchanged");
      expect(same.result.tasks.find((t) => t.legacy_id === d)).toMatchObject({
        outcome: "deleted",
      });
      expect(world.seq()).toBe(seq);
      // The prototype changes them too: a completed task takes a field the person did not touch,
      // the deleted one stays deleted, and the moved one keeps its new area, as a conflict.
      setMeta(prototype, c, { next: "Changed in the prototype" });
      setMeta(prototype, d, { next: "Changed in the prototype" });
      setMeta(prototype, e, { category: "Somewhere new" });
      const { result } = await imported(world, prototype);
      expect(result.tasks.find((t) => t.legacy_id === c)).toMatchObject({
        outcome: "updated",
        changed: ["summary"],
      });
      expect(task(world, tc)).toMatchObject({
        lifecycle: "completed",
        summary: "Changed in the prototype",
      });
      expect(task(world, td)["deleted_at"]).not.toBeNull();
      expect(task(world, td)["summary"]).not.toBe("Changed in the prototype");
      expect(result.tasks.find((t) => t.legacy_id === e)?.conflicts).toEqual(["grouping"]);
      expect(areaOf(te)).toBe(moved);
    } finally {
      world.close();
    }
  }, 120_000);

  test("a reordered prototype keeps every task in its area and project, however their slugs number", async () => {
    const { world, prototype } = await synthetic();
    try {
      // Two areas whose slugs meet (`area`, `area-2`), each with a project "Admin" (`admin`,
      // `admin-2`): which gets the number follows from the order of first appearance.
      const work = { id: "pa", title: "Work task", meta: { category: "Работа", project: "Admin" } };
      const home = { id: "pb", title: "Home task", meta: { category: "Дом", project: "Admin" } };
      const homeToo = { id: "pc", title: "Home too", meta: { category: "Дом", project: "Admin" } };
      writePrototype(prototype, { tasks: [work, home] });
      await importedSynthetic(world, prototype);
      const groups = () => ({
        areas: world.rows("SELECT id FROM areas WHERE deleted_at IS NULL").length,
        projects: world.rows("SELECT id FROM projects WHERE deleted_at IS NULL").length,
      });
      const before = groups();
      const where = (legacy: string) => {
        const t = task(world, taskOf(world, legacy));
        return { area: t["area_id"], project: t["project_id"] };
      };
      const [wa, hb] = [where("pa"), where("pb")];
      expect(wa.area).not.toBe(hb.area);
      // Home first now, with a new task: nothing moves, nothing is made twice, and the new task
      // joins Home's area and project.
      writePrototype(prototype, { tasks: [homeToo, home, work] });
      const second = await importedSynthetic(world, prototype);
      expect(second.result.counts).toMatchObject({ created: 1, updated: 0, conflicts: 0 });
      expect([where("pa"), where("pb"), where("pc")]).toEqual([wa, hb, hb]);
      expect(groups()).toEqual(before);
      // The first of the two gone from the prototype: the other keeps its area and project.
      writePrototype(prototype, { tasks: [home, homeToo] });
      const third = await importedSynthetic(world, prototype);
      expect(third.result.status).toBe("unchanged");
      expect(third.result.gone).toContain("pa");
      expect([where("pa"), where("pb"), where("pc")]).toEqual([wa, hb, hb]);
      expect(groups()).toEqual(before);
    } finally {
      world.close();
    }
  }, 120_000);

  test("a folder cleared and restored with an undo is a change: the prototype's new folder conflicts", async () => {
    n += 1;
    const root = join(scratch, `w${String(n)}`);
    const places = join(root, "places");
    for (const folder of ["a", "b"]) mkdirSync(join(places, folder), { recursive: true });
    const world = await openWorld(root, { roots: [{ id: "work", path: places }] });
    const prototype = join(root, "prototype");
    try {
      const at = (folder: string) => ({
        tasks: [{ id: "pa", title: "Task", meta: { paths: [join(places, folder)] } }],
      });
      writePrototype(prototype, at("a"));
      await importedSynthetic(world, prototype);
      const ta = taskOf(world, "pa");
      // The person clears the folder by mistake and takes it back with Ctrl+Z.
      expect(world.edit([{ kind: "place.clear", task: ta }]).status).toBe("applied");
      const undo = world.writer.submit({
        space_id: world.writer.spaceId,
        request_id: `undo-clear-${String(world.seq()).padStart(8, "0")}`,
        actor: {
          scope_id: "cli:import-test",
          principal_id: world.user,
          actor_kind: "human",
          machine_id: world.machine,
          origin: "cli",
        },
        ops: [{ kind: "undo" }],
      });
      expect(undo.status).toBe("applied");
      const folder = () =>
        world.rows("SELECT rel_path FROM places WHERE owner_id = $t AND deleted_at IS NULL", {
          t: ta,
        });
      expect(folder()).toEqual([{ rel_path: "a" }]);
      writePrototype(prototype, at("b"));
      const { result } = await importedSynthetic(world, prototype);
      expect(result.tasks.find((t) => t.legacy_id === "pa")?.conflicts).toEqual(["place"]);
      expect(folder()).toEqual([{ rel_path: "a" }]);
    } finally {
      world.close();
    }
  }, 120_000);

  test("an outcome the person wrote stays through the prototype's uncheck and check again", async () => {
    const { world, prototype } = await synthetic();
    try {
      const done = { id: "pa", title: "Ship", done: { date: "2026-11-02", evidence: "Shipped" } };
      writePrototype(prototype, { tasks: [done] });
      await importedSynthetic(world, prototype);
      const ta = taskOf(world, "pa");
      expect(task(world, ta)).toMatchObject({ lifecycle: "completed", outcome: "Shipped" });
      expect(
        world.edit([{ kind: "task.wrap_up", task: ta, outcome: "Shipped, with my notes" }]).status,
      ).toBe("applied");
      const mine = {
        lifecycle: "completed",
        wrap_state: "wrapped",
        outcome: "Shipped, with my notes",
      };
      // Unchecked in the prototype: a change of the lifecycle that would take the person's
      // outcome with it, so both are a conflict and the task stays as the person left it.
      writePrototype(prototype, { tasks: [{ id: "pa", title: "Ship" }] });
      const unchecked = await importedSynthetic(world, prototype);
      expect(unchecked.result.tasks.find((t) => t.legacy_id === "pa")?.conflicts).toEqual([
        "lifecycle",
        "wrap",
      ]);
      expect(task(world, ta)).toMatchObject(mine);
      // Checked again with its old outcome: the person's stays.
      writePrototype(prototype, { tasks: [done] });
      await importedSynthetic(world, prototype);
      expect(task(world, ta)).toMatchObject(mine);
    } finally {
      world.close();
    }
  }, 120_000);

  test("a source the person took off stays off, also after an import whose prototype left it out", async () => {
    const { world, prototype } = await synthetic();
    try {
      const url = "https://example.com/notes/plan";
      const at = (title: string, linked: boolean) => ({
        tasks: [
          {
            id: "pa",
            title,
            meta: linked ? { sources: [{ label: "Plan notes", url }] } : {},
          },
        ],
      });
      writePrototype(prototype, at("First", false));
      await importedSynthetic(world, prototype);
      const ta = taskOf(world, "pa");
      const links = () =>
        world.rows(
          "SELECT s.url FROM task_sources ts JOIN sources s ON s.id = ts.source_id " +
            "WHERE ts.task_id = $t AND ts.removed_at IS NULL",
          { t: ta },
        ).length;
      // The person links the source by hand; the prototype names it too, in an import that writes.
      expect(
        world.edit([
          {
            kind: "source.add",
            task: ta,
            source: { kind: "web", title: "Plan", url, key: `url:${url}` },
          },
        ]).status,
      ).toBe("applied");
      writePrototype(prototype, at("Second", true));
      expect((await importedSynthetic(world, prototype)).result.status).toBe("applied");
      // The person takes the link off again with Ctrl+Z.
      const undo = world.writer.submit({
        space_id: world.writer.spaceId,
        request_id: `undo-link-${String(world.seq()).padStart(8, "0")}`,
        actor: {
          scope_id: "cli:import-test",
          principal_id: world.user,
          actor_kind: "human",
          machine_id: world.machine,
          origin: "cli",
        },
        ops: [{ kind: "undo" }],
      });
      expect(undo.status).toBe("applied");
      expect(links()).toBe(0);
      // An import whose prototype leaves the source out, then one that names it again.
      writePrototype(prototype, at("Third", false));
      expect((await importedSynthetic(world, prototype)).result.status).toBe("applied");
      writePrototype(prototype, at("Third", true));
      await importedSynthetic(world, prototype);
      expect(links()).toBe(0);
    } finally {
      world.close();
    }
  }, 120_000);

  test("groups whose long titles cut to the same text keep their tasks when the prototype is reordered", async () => {
    const { world, prototype } = await synthetic();
    try {
      // Past the title's 300 characters only the last word differs: one title, two groups, and
      // their slugs number by the order of first appearance.
      const long = `Long ${"name ".repeat(70)}`;
      const a = { id: "pa", title: "A", meta: { category: `${long}alpha` } };
      const b = { id: "pb", title: "B", meta: { category: `${long}beta` } };
      const c = { id: "pc", title: "C", meta: { category: "Work", project: `${long}one` } };
      const d = { id: "pd", title: "D", meta: { category: "Work", project: `${long}two` } };
      const a2 = { id: "pe", title: "A too", meta: a.meta };
      const c2 = { id: "pf", title: "C too", meta: c.meta };
      writePrototype(prototype, { tasks: [a, b, c, d] });
      await importedSynthetic(world, prototype);
      const where = (legacy: string) => {
        const t = task(world, taskOf(world, legacy));
        return { area: t["area_id"], project: t["project_id"] };
      };
      const [wa, wb, wc, wd] = [where("pa"), where("pb"), where("pc"), where("pd")];
      expect(wa.area).not.toBe(wb.area);
      expect(wc.project).not.toBe(wd.project);
      // Reordered, with a new task in the first group of each kind: the dry run finds every
      // group, the apply moves nothing, and the new tasks join their own groups.
      writePrototype(prototype, { tasks: [b, d, a2, c2, a, c] });
      const second = await importedSynthetic(world, prototype);
      expect(second.preview.counts).toMatchObject({ areas_existing: 3, projects_existing: 2 });
      expect(second.result.counts).toMatchObject({ created: 2, updated: 0, conflicts: 0 });
      expect([where("pa"), where("pb"), where("pc"), where("pd")]).toEqual([wa, wb, wc, wd]);
      expect([where("pe"), where("pf")]).toEqual([wa, wc]);
    } finally {
      world.close();
    }
  }, 120_000);

  test("a group the import made and its undo removed is made again, never another group of the same shown title", async () => {
    const { world, prototype } = await synthetic();
    try {
      const long = `Long ${"name ".repeat(70)}`;
      const a = { id: "pa", title: "A", meta: { category: `${long}alpha` } };
      const b = { id: "pb", title: "B", meta: { category: `${long}beta` } };
      writePrototype(prototype, { tasks: [a, b] });
      const first = await importedSynthetic(world, prototype);
      const areaOf = (legacy: string) => String(task(world, taskOf(world, legacy))["area_id"]);
      const [alpha, beta] = [areaOf("pa"), areaOf("pb")];
      expect(alpha).not.toBe(beta);
      // The person works on A, then undoes the import: A and its area stay, B and its area go.
      expect(
        world.edit([{ kind: "task.patch", task: taskOf(world, "pa"), set: { title: "Mine" } }])
          .status,
      ).toBe("applied");
      await world.undo(first.preview.run);
      const liveArea = (id: string) =>
        world.rows("SELECT deleted_at FROM areas WHERE id = $id", { id })[0]?.["deleted_at"] ===
        null;
      expect([liveArea(alpha), liveArea(beta)]).toEqual([true, false]);

      // The prototype now holds B alone: the dry run and the apply both make its area anew.
      writePrototype(prototype, { tasks: [b] });
      const again = await importedSynthetic(world, prototype);
      expect(again.preview.counts).toMatchObject({ areas: 1, areas_existing: 0 });
      const made = areaOf("pb");
      expect(made).not.toBe(alpha);
      expect(liveArea(made)).toBe(true);
      expect(
        world.rows("SELECT count(*) AS n FROM tasks WHERE area_id = $a AND deleted_at IS NULL", {
          a: alpha,
        })[0]?.["n"],
      ).toBe(1);
    } finally {
      world.close();
    }
  }, 120_000);
});

describe("[A7.3.15.importer.undo] the undo of an import", () => {
  test("what the import made goes; a task changed since stays whole and is listed", async () => {
    const { world, prototype } = await fresh();
    try {
      const { preview, result } = await imported(world, prototype);
      const applied = Number(
        world.rows("SELECT seq FROM commits WHERE id = $id", { id: result.commit ?? "" })[0]?.[
          "seq"
        ],
      );
      const [a = "", b = ""] = picks(prototype, preview);
      const [ta, tb] = [taskOf(world, a), taskOf(world, b)];
      world.edit([{ kind: "task.patch", task: ta, set: { title: "Mine" } }]);
      world.edit([{ kind: "task.delete", task: tb }]);
      // The person moves a task of their own into an area the import made, away from a and b.
      const keepers = new Set([task(world, ta)["area_id"], task(world, tb)["area_id"]]);
      const madeArea = world
        .rows("SELECT id, slug FROM areas WHERE created_seq = $seq ORDER BY slug", { seq: applied })
        .find((r) => !keepers.has(r["id"]));
      const mine = String(
        world.rows("SELECT id FROM tasks WHERE created_seq < $seq ORDER BY ref LIMIT 1", {
          seq: applied,
        })[0]?.["id"],
      );
      expect(
        world.edit([{ kind: "task.move", task: mine, area: String(madeArea?.["slug"]) }]).status,
      ).toBe("applied");
      const created = world.rows("SELECT id FROM tasks WHERE created_seq = $seq", { seq: applied });
      const undone = await world.undo(preview.run);
      expect(ImportPlanningUndoResult.safeParse(undone).success).toBe(true);
      expect(undone.undone).toBe(result.commit);
      const refOf = (id: string) => `M-${String(task(world, id)["ref"])}`;
      // Only the import's own tasks are listed; the person's task keeps its area without a mention.
      expect(undone.kept.map((k) => k.task).sort()).toEqual([refOf(ta), refOf(tb)].sort());
      // The run's undo.json holds every kept task, as the answer does up to its 2,000.
      const saved = ImportPlanningUndoResult.parse(
        JSON.parse(
          readFileSync(
            join(world.folder, "exchange", "planning", preview.run, "undo.json"),
            "utf8",
          ),
        ),
      );
      expect(saved.kept).toEqual(undone.kept);
      expect(undone.removed).toBe(created.length - 2);
      expect(
        world.rows("SELECT deleted_at FROM areas WHERE id = $id", {
          id: String(madeArea?.["id"]),
        })[0],
      ).toEqual({ deleted_at: null });
      expect(task(world, mine)).toMatchObject({ deleted_at: null, area_id: madeArea?.["id"] });
      // a stays as the person left it, with every entry and link the import gave it.
      expect(task(world, ta)).toMatchObject({ title: "Mine", deleted_at: null });
      expect(
        world.rows(
          "SELECT count(*) AS n FROM log_entries WHERE task_id = $t AND deleted_at IS NOT NULL",
          { t: ta },
        )[0]?.["n"],
      ).toBe(0);
      expect(task(world, ta)["area_id"]).not.toBeNull();
      const area = world.rows("SELECT deleted_at FROM areas WHERE id = $id", {
        id: String(task(world, ta)["area_id"]),
      })[0];
      expect(area?.["deleted_at"]).toBeNull();
      // b stays deleted; every other task the import made is gone, its aliases and exchange stay.
      expect(task(world, tb)["deleted_at"]).not.toBeNull();
      const live = world.rows(
        "SELECT id FROM tasks WHERE created_seq = $seq AND deleted_at IS NULL",
        { seq: applied },
      );
      expect(live.map((r) => r["id"])).toEqual([ta]);
      expect(
        world.rows("SELECT * FROM exchanges WHERE id = $id", { id: preview.run }),
      ).toHaveLength(1);
      // Not on the undo stack, and a second undo of the run answers as the first.
      expect(
        world.rows("SELECT undo_status FROM commits WHERE id = $id", { id: undone.commit })[0],
      ).toEqual({
        undo_status: null,
      });
      expect(await world.undo(preview.run)).toMatchObject({
        commit: undone.commit,
        replayed: true,
      });
      // The undone run's apply again is no import: a new dry run imports anew.
      expect(await refusal(world.apply(preview.run, preview.token ?? ""))).toMatchObject({
        code: "conflict",
        cause: "INVALID_TRANSITION",
      });

      // A re-import after the undo makes the undone tasks again and leaves the two as they are.
      const again = await imported(world, prototype);
      expect(again.result.counts).toMatchObject({
        created: created.length - 2,
        deleted: 1,
      });
      expect(task(world, ta)["title"]).toBe("Mine");
      expect(taskOf(world, a)).toBe(ta);
      expect(
        world.rows(
          "SELECT alias, count(*) AS n FROM aliases WHERE namespace = 'planning' GROUP BY alias HAVING n > 1",
        ),
      ).toEqual([]);
    } finally {
      world.close();
    }
  }, 120_000);

  test("the undo of a re-import keeps whole a task the person worked on since, in any field or note", async () => {
    const { world, prototype } = await synthetic();
    try {
      const version = (title: string, evidence: string): void => {
        writePrototype(prototype, {
          tasks: ["pa", "pb", "pc"].map((id) => ({
            id,
            title: `${title} ${id}`,
            meta: { evidence: `${evidence} ${id}` },
          })),
        });
      };
      version("First", "Seen");
      await importedSynthetic(world, prototype);
      version("Second", "Updated");
      const second = await importedSynthetic(world, prototype);
      expect(second.result.counts.updated).toBe(3);
      const [ta, tb, tc] = [taskOf(world, "pa"), taskOf(world, "pb"), taskOf(world, "pc")];
      // The person changes a field the re-import did not write on pa, and adds a note to pb.
      expect(world.edit([{ kind: "task.patch", task: ta, set: { priority: 1 } }]).status).toBe(
        "applied",
      );
      expect(world.edit([{ kind: "note.add", task: tb, body: "Follow the update" }]).status).toBe(
        "applied",
      );
      const undone = await world.undo(second.preview.run);
      const evidence = (id: string) =>
        world
          .rows(
            "SELECT body FROM log_entries WHERE task_id = $t AND kind = 'evidence' AND deleted_at IS NULL ORDER BY body",
            { t: id },
          )
          .map((r) => r["body"]);
      // pa and pb stay as the re-import and the person left them, and are listed.
      expect(task(world, ta)).toMatchObject({ title: "Second pa", priority: 1 });
      expect(evidence(ta)).toEqual(["Seen pa", "Updated pa"]);
      expect(task(world, tb)).toMatchObject({ title: "Second pb" });
      expect(evidence(tb)).toEqual(["Seen pb", "Updated pb"]);
      const refOf = (id: string) => `M-${String(task(world, id)["ref"])}`;
      expect(Object.fromEntries(undone.kept.map((k) => [k.task, k.fields]))).toEqual({
        [refOf(ta)]: ["priority"],
        [refOf(tb)]: ["notes"],
      });
      // pc, which no one touched since, is set back whole.
      expect(task(world, tc)).toMatchObject({ title: "First pc" });
      expect(evidence(tc)).toEqual(["Seen pc"]);
    } finally {
      world.close();
    }
  }, 120_000);

  test("undoing a re-import and then the first import takes both back", async () => {
    const { world, prototype } = await synthetic();
    try {
      writePrototype(prototype, {
        tasks: [
          { id: "pa", title: "First pa" },
          { id: "pb", title: "First pb" },
        ],
      });
      const first = await importedSynthetic(world, prototype);
      writePrototype(prototype, {
        tasks: [
          { id: "pa", title: "Second pa" },
          { id: "pb", title: "First pb", meta: { evidence: "New for pb" } },
          { id: "pc", title: "First pc" },
        ],
      });
      const second = await importedSynthetic(world, prototype);
      expect(second.result.counts).toMatchObject({ created: 1, updated: 2 });
      const [ta, tb, tc] = [taskOf(world, "pa"), taskOf(world, "pb"), taskOf(world, "pc")];
      // pa's title and pb's new evidence entry are set back, pc is removed.
      expect(await world.undo(second.preview.run)).toMatchObject({
        kept: [],
        removed: 1,
        restored: 2,
      });
      expect(task(world, ta)["title"]).toBe("First pa");
      expect(task(world, tc)["deleted_at"]).not.toBeNull();
      const undone = await world.undo(first.preview.run);
      expect(undone.kept).toEqual([]);
      for (const id of [ta, tb]) expect(task(world, id)["deleted_at"]).not.toBeNull();
    } finally {
      world.close();
    }
  }, 120_000);
});

/** A world and an empty prototype folder of the test's own, for writePrototype. */
async function synthetic(options: WorldOptions = {}) {
  n += 1;
  const root = join(scratch, `w${String(n)}`);
  const world = await openWorld(root, options);
  return { world, prototype: join(root, "prototype"), root };
}

/** A dry run of a synthetic prototype and its apply. */
async function importedSynthetic(world: ImportWorld, prototype: string) {
  const preview = await world.preview({ folder: prototype });
  expect(preview.blocked).toBe(false);
  const result = await world.apply(preview.run, preview.token ?? "");
  return { preview, result };
}
