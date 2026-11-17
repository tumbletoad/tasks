// The folders an import gives on the machine that applies it, through the service's own dry run,
// apply and undo on the Mira sample space (import-harness.ts): the committed synthetic prototype
// with its folders made under the world's own home, and small synthetic prototypes. Fixture data
// only; every folder is made in the test's own temporary folder and removed by its full name.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ImportPlanningApplyResult, ImportPlanningPreviewResult } from "@tasks/contracts";
import { newId } from "@tasks/storage";
import { copyFixture, openWorld, writePrototype, type ImportWorld } from "./import-harness.ts";

const ME = "Mira Okafor";
const SEP = process.platform === "win32" ? "\\" : "/";
/** A folder under the world's home as the space stores it. */
const home = (...names: string[]): string => ["~", ...names].join(SEP);

let scratch = "";
let n = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tasks-m7-11-folders-"));
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

/** A world of its own and a copy of the fixture prototype, its folders under the world's home. */
async function fresh() {
  n += 1;
  const root = join(scratch, `w${String(n)}`);
  const world = await openWorld(root);
  const prototype = join(root, "prototype");
  copyFixture(prototype, world.here.home);
  return { world, prototype, root };
}

async function imported(world: ImportWorld, prototype: string, me: string | null = ME) {
  const preview = await world.preview({ folder: prototype, ...(me === null ? {} : { me }) });
  expect(ImportPlanningPreviewResult.safeParse(preview).success).toBe(true);
  expect(preview.blocked).toBe(false);
  const result = await world.apply(preview.run, preview.token ?? "");
  expect(ImportPlanningApplyResult.safeParse(result).success).toBe(true);
  return { preview, result };
}

/** The live task a legacy ID names now. */
const taskOf = (world: ImportWorld, legacy: string): string =>
  idOf(
    world.rows(
      "SELECT t.id FROM aliases a JOIN tasks t ON t.id = a.entity_id " +
        "WHERE a.namespace = 'planning' AND a.alias = $a AND t.deleted_at IS NULL",
      { a: legacy },
    ),
  );

/** The ID of the first row, or "" when there is none. */
const idOf = (rows: readonly Record<string, unknown>[]): string => {
  const id = rows[0]?.["id"];
  return typeof id === "string" ? id : "";
};

/** The live project with this title. */
const projectOf = (world: ImportWorld, title: string): string =>
  idOf(world.rows("SELECT id FROM projects WHERE title = $t AND deleted_at IS NULL", { t: title }));

/** An owner's live folder on the world's machine, as stored, or null. */
const folderOf = (world: ImportWorld, owner: string): string | null => {
  const rows = world.rows(
    "SELECT path FROM folders WHERE owner_id = $o AND machine_id = $m AND deleted_at IS NULL",
    { o: owner, m: world.machine },
  );
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] === undefined ? null : String(rows[0]["path"]);
};

/** How many live folders the commit with this ID made. */
const liveIn = (world: ImportWorld, commit: string | undefined): number =>
  Number(
    world.rows(
      "SELECT count(*) AS n FROM folders f JOIN commits k ON k.seq = f.created_seq " +
        "WHERE k.id = $id AND f.deleted_at IS NULL",
      { id: commit ?? "" },
    )[0]?.["n"],
  );

/** The fixture's folders as the import gives them on this machine. */
function fixtureFolders(world: ImportWorld) {
  return {
    clinic: folderOf(world, projectOf(world, "Clinic sync")),
    tidy: folderOf(world, projectOf(world, "tidy-md (oss)")),
    garden: folderOf(world, projectOf(world, "Garden")),
    answer: folderOf(world, taskOf(world, "t-7e820ac6")),
    reports: folderOf(world, taskOf(world, "lum_report-api")),
    portalTask: folderOf(world, taskOf(world, "t-eb2a8db7")),
    roadmap: folderOf(world, taskOf(world, "t-8ae0f771")),
    health: folderOf(world, taskOf(world, "t-5216665d")),
    fence: folderOf(world, taskOf(world, "home-fence")),
  };
}

/** What the fixture import gives: the cases of its index. */
const FIXTURE_FOLDERS = {
  // One task's folder holds the other's: the project's, and that task has none of its own.
  clinic: home("work", "lumen", "clinic-sync"),
  answer: null,
  reports: home("work", "lumen", "clinic-sync", "reports-api"),
  // The project's only task folder.
  tidy: home("oss", "tidy-md"),
  // Its one task folder is not on this machine.
  garden: null,
  fence: null,
  // No folder holds the others: each task keeps its own.
  portalTask: home("work", "lumen", "portal"),
  roadmap: home("work", "lumen", "portal", "docs", "roadmap"),
  // No project: its own.
  health: home("Documents", "health"),
};

describe("[A7.3.15.importer.folders] the folders an import gives on this machine", () => {
  test("the dry run shows each project's folder or why none, and each task's; the apply gives them", async () => {
    const { world, prototype } = await fresh();
    try {
      const preview = await world.preview({ folder: prototype, me: ME });
      const projects = new Map(preview.project_folders.map((p) => [p.project, p]));
      expect(projects.get("Clinic sync")).toEqual({
        project: "Clinic sync",
        area: "Lumen",
        folder: home("work", "lumen", "clinic-sync"),
      });
      expect(projects.get("tidy-md (oss)")?.folder).toBe(home("oss", "tidy-md"));
      expect(projects.get("Garden")).toMatchObject({ none: "no_folders" });
      // The sample's own project, which the import goes to: no folder holds its tasks' folders,
      // and the folder it has keeps.
      expect(projects.get("Lumen portal")).toMatchObject({
        none: "no_common_folder",
        current: expect.any(String) as unknown,
      });
      const tasks = new Map(preview.tasks.map((t) => [t.legacy_id, t.folder]));
      expect(tasks.get("t-7e820ac6")).toEqual({
        path: home("work", "lumen", "clinic-sync"),
        state: "project",
      });
      expect(tasks.get("lum_report-api")).toEqual({
        path: home("work", "lumen", "clinic-sync", "reports-api"),
        state: "own",
      });
      // A Linux path that is not there here; on Windows a path of another kind of machine.
      expect(tasks.get("home-fence")).toEqual({
        path: "/mnt/shed/fence-plans",
        state: process.platform === "win32" ? "other_machine" : "missing",
      });
      expect(preview.problems.filter((p) => p.code.startsWith("folder-"))).toEqual([
        {
          code: "folder-missing",
          severity: "warning",
          file: "data/metadata.json",
          task: "home-fence",
          field: "paths",
          index: 0,
        },
      ]);
      expect(preview.counts).toMatchObject({ folders: 8, folders_missing: 1, project_folders: 2 });
      const md = readFileSync(join(preview.folder, "report.md"), "utf8");
      expect(md).toContain("## 3. Project folders");
      expect(md).toContain("none: no task's folder holds all the others");

      const portal = projectOf(world, "Lumen portal");
      const before = folderOf(world, portal);
      const result = await world.apply(preview.run, preview.token ?? "");
      expect(result.status).toBe("applied");
      expect(result.projects).toEqual([
        { project: "Clinic sync", outcome: "set" },
        { project: "tidy-md (oss)", outcome: "set" },
      ]);
      expect(fixtureFolders(world)).toEqual(FIXTURE_FOLDERS);
      expect(folderOf(world, portal)).toBe(before);
      // Two project folders and five tasks' own, all in the import's one commit.
      expect(liveIn(world, result.commit)).toBe(7);
    } finally {
      world.close();
    }
  }, 120_000);

  test("apply, undo, apply again: the folders come and go with the tasks; the same input again writes nothing", async () => {
    const { world, prototype } = await fresh();
    try {
      const first = await imported(world, prototype);
      expect(fixtureFolders(world)).toEqual(FIXTURE_FOLDERS);
      const seq = world.seq();
      const same = await imported(world, prototype);
      expect(same.result.status).toBe("unchanged");
      expect(world.seq()).toBe(seq);

      const clinic = projectOf(world, "Clinic sync");
      const reports = taskOf(world, "lum_report-api");
      await world.undo(first.preview.run);
      // The import's tasks are gone, and so are their folders. The sample's project it gave a
      // folder stays, without that folder.
      expect(projectOf(world, "Clinic sync")).toBe(clinic);
      expect(taskOf(world, "lum_report-api")).toBe("");
      expect(projectOf(world, "tidy-md (oss)")).toBe("");
      expect(folderOf(world, clinic)).toBeNull();
      expect(folderOf(world, reports)).toBeNull();
      expect(liveIn(world, first.result.commit)).toBe(0);

      const again = await imported(world, prototype);
      expect(again.result.counts.created).toBe(first.result.counts.created);
      expect(fixtureFolders(world)).toEqual(FIXTURE_FOLDERS);
      const after = world.seq();
      expect((await imported(world, prototype)).result.status).toBe("unchanged");
      expect(world.seq()).toBe(after);
    } finally {
      world.close();
    }
  }, 180_000);

  test("a folder the person changed stays theirs; one only the prototype changed follows it", async () => {
    const { world, prototype, root } = await fresh();
    try {
      await imported(world, prototype);
      const clinic = projectOf(world, "Clinic sync");
      const reports = taskOf(world, "lum_report-api");
      const tidy = projectOf(world, "tidy-md (oss)");
      // The person gives the clinic project and one of its tasks folders of their own.
      const mine = join(root, "mine");
      mkdirSync(join(mine, "api"), { recursive: true });
      expect(
        world.edit([{ kind: "project.folder_set", project: clinic, path: stored(mine) }]).status,
      ).toBe("applied");
      expect(
        world.edit([{ kind: "task.folder_set", task: reports, path: stored(join(mine, "api")) }])
          .status,
      ).toBe("applied");

      // The prototype moves the clinic's folders and tidy-md's.
      const meta = join(prototype, "data", "metadata.json");
      const v2 = join(world.here.home, "work", "lumen", "clinic-sync-v2");
      const tidy2 = join(world.here.home, "oss", "tidy-md-2");
      for (const folder of [join(v2, "reports-api"), tidy2]) mkdirSync(folder, { recursive: true });
      const text = readFileSync(meta, "utf8")
        .replaceAll(json(join(world.here.home, "work", "lumen", "clinic-sync")), json(v2))
        .replaceAll(
          json(join(world.here.home, "work", "lumen", "clinic-sync", "reports-api")),
          json(join(v2, "reports-api")),
        )
        .replaceAll(json(join(world.here.home, "oss", "tidy-md")), json(tidy2));
      writeFileSync(meta, text);

      const { preview, result } = await imported(world, prototype);
      expect(preview.project_folders.find((p) => p.project === "Clinic sync")).toEqual({
        project: "Clinic sync",
        area: "Lumen",
        folder: home("work", "lumen", "clinic-sync-v2"),
        current: stored(mine),
      });
      // Both changed it: the person's stays, and the answer says so.
      expect(result.projects).toEqual([
        { project: "Clinic sync", outcome: "conflict" },
        { project: "tidy-md (oss)", outcome: "set" },
      ]);
      expect(folderOf(world, clinic)).toBe(stored(mine));
      expect(result.tasks.find((t) => t.legacy_id === "lum_report-api")?.conflicts).toEqual([
        "folder",
      ]);
      expect(folderOf(world, reports)).toBe(stored(join(mine, "api")));
      // Only the prototype changed tidy-md's: it follows.
      expect(folderOf(world, tidy)).toBe(home("oss", "tidy-md-2"));

      // The same input again writes nothing, and the person's folders still stand.
      const seq = world.seq();
      expect((await imported(world, prototype)).result.status).toBe("unchanged");
      expect(world.seq()).toBe(seq);
      expect(folderOf(world, clinic)).toBe(stored(mine));
    } finally {
      world.close();
    }
  }, 180_000);

  test("a project folder another project has: none for the import's project, its tasks keep theirs", async () => {
    n += 1;
    const root = join(scratch, `w${String(n)}`);
    const world = await openWorld(root);
    const prototype = join(root, "prototype");
    try {
      const atlas = join(root, "atlas");
      mkdirSync(join(atlas, "docs"), { recursive: true });
      const holder = newId("p");
      expect(
        world.edit([
          { kind: "project.create", id: holder, title: "Holder" },
          { kind: "project.folder_set", project: holder, path: stored(atlas) },
        ]).status,
      ).toBe("applied");
      writePrototype(prototype, {
        tasks: [
          { id: "pa", title: "Map it", meta: { project: "Atlas", paths: [atlas] } },
          { id: "pb", title: "Write it", meta: { project: "Atlas", paths: [join(atlas, "docs")] } },
          // Inside the app's own data: never a folder.
          { id: "pc", title: "Look inside", meta: { paths: [world.folder] } },
        ],
      });
      const { preview, result } = await imported(world, prototype, null);
      expect(preview.project_folders).toEqual([
        { project: "Atlas", area: "Other", none: "taken", holder: "Holder" },
      ]);
      expect(preview.problems.filter((p) => p.code.startsWith("folder-"))).toEqual([
        {
          code: "folder-reserved",
          severity: "warning",
          file: "data/metadata.json",
          task: "pc",
          field: "paths",
          index: 0,
        },
        {
          code: "folder-taken",
          severity: "warning",
          file: "data/metadata.json",
          task: "pa",
          field: "paths",
          index: 0,
        },
      ]);
      expect(readFileSync(join(preview.folder, "report.md"), "utf8")).toContain(
        "none: Holder has that folder",
      );
      expect(result.status).toBe("applied");
      expect(result.projects).toBeUndefined();
      expect(folderOf(world, projectOf(world, "Atlas"))).toBeNull();
      expect(folderOf(world, holder)).toBe(stored(atlas));
      expect(folderOf(world, taskOf(world, "pa"))).toBe(stored(atlas));
      expect(folderOf(world, taskOf(world, "pb"))).toBe(stored(join(atlas, "docs")));
      expect(folderOf(world, taskOf(world, "pc"))).toBeNull();
    } finally {
      world.close();
    }
  }, 120_000);

  test("the undo keeps a project the person worked in with the folder the import gave it", async () => {
    n += 1;
    const root = join(scratch, `w${String(n)}`);
    const world = await openWorld(root);
    const prototype = join(root, "prototype");
    try {
      const atlas = join(root, "atlas");
      mkdirSync(join(atlas, "docs"), { recursive: true });
      writePrototype(prototype, {
        tasks: [
          { id: "pa", title: "Map it", meta: { project: "Atlas", paths: [atlas] } },
          { id: "pb", title: "Write it", meta: { project: "Atlas", paths: [join(atlas, "docs")] } },
        ],
      });
      const { preview } = await imported(world, prototype, null);
      const project = projectOf(world, "Atlas");
      const pb = taskOf(world, "pb");
      expect(folderOf(world, project)).toBe(stored(atlas));
      expect(
        world.edit([{ kind: "task.patch", task: pb, set: { title: "Write it all" } }]).status,
      ).toBe("applied");
      const undone = await world.undo(preview.run);
      expect(undone.kept.map((k) => k.fields)).toEqual([["title"]]);
      // The task the person changed stays, with its folder, in its project, with the project's.
      expect(taskOf(world, "pa")).toBe("");
      expect(taskOf(world, "pb")).toBe(pb);
      expect(projectOf(world, "Atlas")).toBe(project);
      expect(folderOf(world, project)).toBe(stored(atlas));
      expect(folderOf(world, pb)).toBe(stored(join(atlas, "docs")));
    } finally {
      world.close();
    }
  }, 120_000);

  test("a space imported before folders gets them on a re-import, once", async () => {
    const { world, prototype } = await fresh();
    try {
      const first = await imported(world, prototype);
      // As an import that set places, not folders, left it: no folder of its own, no record of one.
      const applied = Number(
        world.rows("SELECT seq FROM commits WHERE id = $id", {
          id: first.result.commit ?? "",
        })[0]?.["seq"],
      );
      world.sql(
        "UPDATE exchange_items SET base = json_remove(base, '$.fields.folder', '$.groups.project.folder')",
      );
      world.sql("DELETE FROM folders WHERE created_seq = $seq", { seq: applied });
      expect(fixtureFolders(world)).toEqual(
        Object.fromEntries(Object.keys(FIXTURE_FOLDERS).map((k) => [k, null])),
      );

      const again = await imported(world, prototype);
      expect(again.result.status).toBe("applied");
      expect(again.result.counts.conflicts).toBe(0);
      expect(fixtureFolders(world)).toEqual(FIXTURE_FOLDERS);
      const seq = world.seq();
      expect((await imported(world, prototype)).result.status).toBe("unchanged");
      expect(world.seq()).toBe(seq);
    } finally {
      world.close();
    }
  }, 180_000);
});

/** A folder outside the world's home as the space stores it on this machine. */
function stored(path: string): string {
  return process.platform === "win32" ? path.replace(/^[a-z]:/u, (d) => d.toUpperCase()) : path;
}

/** A path as metadata.json writes it. */
const json = (path: string): string => JSON.stringify(path);
