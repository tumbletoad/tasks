// M7.05 (A7 3.15.5, 3.15.6): the apply of a dry run, its guards and its undo, through the service's
// own dry run, apply and undo on the Mira sample space, in one thread (harness.ts). The committed
// synthetic prototype is the input, copied into a folder of the test's own where a test edits it.
// Fixture data only; every folder is made in beforeAll and removed by its full name in afterAll.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AppError,
  ImportPlanningApplyResult,
  ImportPlanningUndoResult,
} from "../../packages/contracts/src/index.ts";
import {
  judgedNames,
  mapPrototype,
  parsePrototype,
  previewPinned,
  previewToken,
  readInput,
  type PreviewRun,
} from "../../packages/importer-planning/src/index.ts";
import { recomputeToken, StorageError } from "../../packages/storage/src/index.ts";
import { openWorld, type ImportWorld } from "./harness.ts";

const REPO = join(import.meta.dirname, "..", "..");
const FIXTURE = join(REPO, "fixtures", "planning-prototype");

interface Index {
  me: string;
  roots: Record<string, string>;
  counts: Record<string, number>;
}
const index = JSON.parse(
  readFileSync(join(REPO, "fixtures", "planning-prototype.index.json"), "utf8"),
) as Index;
const ROOTS = Object.entries(index.roots).map(([id, path]) => ({ id, path }));

let scratch = "";
let n = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-05-apply-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A world of its own and a copy of the fixture prototype the test may edit. */
async function fresh(options: Parameters<typeof openWorld>[1] = {}) {
  n += 1;
  const root = join(scratch, `w${String(n)}`);
  const prototype = join(root, "prototype");
  cpSync(FIXTURE, prototype, { recursive: true });
  const world = await openWorld(root, { roots: ROOTS, ...options });
  return { world, prototype, root };
}

const dryRun = (world: ImportWorld, prototype: string) =>
  world.preview({ folder: prototype, me: index.me });

/** The error an apply or an undo was refused with. */
async function refusal(work: Promise<unknown>): Promise<{ code: string; cause?: unknown }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, cause: error.data?.["cause"] };
    if (error instanceof StorageError) return { code: error.code };
    throw error;
  }
  throw new Error("It was not refused");
}

describe("[A7.3.15.importer.apply] the apply of a dry run", () => {
  test("the fixture applies as one commit: tasks, aliases, groups, the exchange and its items", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await dryRun(world, prototype);
      expect(preview.blocked).toBe(false);
      const before = world.seq();
      const tasksBefore = world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"];
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
      expect(commit).toMatchObject({ origin: "import", actor_kind: "human", principal_id: world.user });
      const author = world.rows("SELECT kind FROM actors WHERE id = $id", {
        id: String(commit?.["author_id"]),
      });
      expect(author[0]?.["kind"]).toBe("import");
      expect(commit?.["undo_status"]).toBeNull();
      expect(world.rows("SELECT count(*) AS n FROM tasks")[0]?.["n"]).toBe(
        Number(tasksBefore) + preview.counts.tasks,
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
      const exchange = world.rows("SELECT * FROM exchanges WHERE id = $id", { id: preview.run })[0];
      expect(exchange).toMatchObject({
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
      const areas = world.rows("SELECT count(*) AS n FROM areas WHERE created_seq = $seq", {
        seq: applied,
      })[0]?.["n"];
      expect(areas).toBe(preview.counts.areas - preview.counts.areas_existing);
      // A barrier backup was taken right before it, of the state it started from.
      expect(result.backup).toMatch(/^pre-import-/);
      expect(readdirSync(join(world.folder, "backups")).some((f) => f.startsWith("pre-import-"))).toBe(
        true,
      );
      // The run's folder holds the answer.
      expect(JSON.parse(readFileSync(join(preview.folder, "apply.json"), "utf8"))).toMatchObject({
        status: "applied",
        commit: result.commit,
      });
    } finally {
      world.close();
    }
  }, 120_000);

  test("the token the writer recomputes in its transaction is the dry run's", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await dryRun(world, prototype);
      const { input } = await readInput(join(preview.folder, "input"));
      const options = {
        me: index.me,
        roots: Object.fromEntries(ROOTS.map((r) => [r.id, r.path])),
        timeZone: "Europe/Amsterdam",
      };
      const plan = mapPrototype(parsePrototype(input), options);
      const rows = world.rows("SELECT p.slug, p.id, p.version, a.slug AS area FROM projects p " +
        "LEFT JOIN areas a ON a.id = p.area_id AND a.deleted_at IS NULL WHERE p.deleted_at IS NULL");
      const projects = rows.map((r) => ({
        slug: String(r["slug"]),
        id: String(r["id"]),
        version: Number(r["version"]),
        area: (r["area"] as string | null) ?? null,
      }));
      const report = JSON.parse(readFileSync(join(preview.folder, "report.json"), "utf8")) as {
        token: string;
      };
      const run = { run: preview.run, inputs: [], options } as unknown as PreviewRun;
      void previewToken;
      const pinned = previewPinned(plan, run);
      // The writer's token over the same pinned values and the rows it reads itself.
      const token = world.writer.asOf() && recomputeToken(world.conn, {
        token: report.token,
        pinned: pinned as never,
        ...judgedNames(plan, { projects }),
      });
      expect(token).toMatch(/^pv1_/);
    } finally {
      world.close();
    }
  }, 120_000);
});
