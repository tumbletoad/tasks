// A space that holds tasks of the earlier prototype import keeps working without the importer. The
// fixture (fixtures/space-with-import) was made by the last build that had the importer: the
// synthetic prototype imported (48 tasks, with aliases, areas, projects, sources, completions and
// extra fields), a summary the person changed on M-1, and a second import applied and undone. Its
// machine is the fixture's own, so this service opens the space as its writer.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { exportBundle, provenBackup } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { opCall, type Caller } from "../src/ops/index.ts";
import { startService, type RunningService } from "../src/hub/service.ts";
import {
  registerSpaces,
  removeRuntimeDir,
  serviceEnv,
  stateOf,
  tempRoot,
  waitFor,
} from "./harness.ts";
import { backupsBeside } from "../../storage/test/backup-helpers.ts";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/space-with-import", import.meta.url));
const USER: Caller = { class: "cli-interactive", env: {} };
const LONG = 120_000;

type Json = Record<string, unknown>;

let temp: ReturnType<typeof tempRoot>;
let service: RunningService;
let folder = "";

beforeAll(async () => {
  temp = tempRoot("imported");
  const home = join(temp.root, "h");
  mkdirSync(stateOf(home), { recursive: true, mode: 0o700 });
  copyFileSync(join(FIXTURE, "machine.json"), join(stateOf(home), "machine.json"));
  folder = join(temp.root, "s", "mira");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "space.db"), gunzipSync(readFileSync(join(FIXTURE, "space.db.gz"))), {
    mode: 0o600,
  });
  copyFileSync(join(FIXTURE, "space.json"), join(folder, "space.json"));
  registerSpaces(home, [folder]);
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    say: () => undefined,
  });
  await service.spacesSettled;
}, LONG);

afterAll(async () => {
  await service.stop();
  removeRuntimeDir(service);
  temp.cleanup();
}, LONG);

const call = async (op: string, input: Json): Promise<Json> =>
  (await opCall(service.ops, USER, { op, input })) as Json;
let n = 0;
const rid = () => `fixture-imported-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;
const show = async (task: string): Promise<Json> =>
  (await call("task.get", { task }))["task"] as Json;
const refs = (rows: unknown): string[] => (rows as Json[]).map((r) => String(r["ref"]));

describe("[A1.compat.imported-space] a space with prototype imports in its history opens, lists, searches, shows, undoes, backs up and restores", () => {
  test(
    "the imported tasks read as before, their history names the import, and later changes undo",
    async () => {
      const status = await call("space.status", {});
      expect(status["counts"]).toMatchObject({
        statuses: expect.arrayContaining([
          { status: "open", count: 28 },
          { status: "waiting", count: 4 },
        ]) as unknown,
      });

      // Lists: every active task, and the finished ones the import completed.
      const active = await call("task.search", { scope: "active", limit: 50 });
      expect((active["rows"] as unknown[]).length).toBe(34);
      const finished = await call("task.search", { scope: "finished", limit: 50 });
      expect((finished["rows"] as unknown[]).length).toBe(14);

      // Searches by words, and the tasks of the import that was undone stay gone.
      const toner = await call("task.search", { q: '"printer toner"' });
      expect((toner["rows"] as Json[]).map((r) => r["title"])).toEqual([
        "Order printer toner",
        "Order printer toner",
      ]);
      const undone = await call("task.search", { q: '"second undone task"', scope: "all" });
      expect(refs(undone["rows"])).toEqual([]);

      // The person's change on M-1 after the import, and the import itself, in its history.
      const m1 = await call("task.get", { task: "M-1", sections: ["history"] });
      const history = (m1["sections"] as { history: { actor: string; what: string }[] }).history;
      expect(history.map((h) => h.actor)).toEqual(["user", "import"]);
      expect((await show("M-1"))["summary"]).toBe("Changed by the person after the import");

      // A change now on another imported task undoes, and then the old build's change does too.
      const other = refs(active["rows"]).find((ref) => ref !== "M-1") ?? "";
      const before = await show(other);
      await call("task.update", {
        task: other,
        set: { summary: "Changed after the importer left" },
        base: await asOf(),
        request_id: rid(),
      });
      expect(await call("history.undo", { request_id: rid() })).toMatchObject({
        result: "undone",
        tasks: [other],
      });
      expect((await show(other))["summary"]).toBe(before["summary"]);
      expect(await call("history.undo", { request_id: rid() })).toMatchObject({
        result: "undone",
        tasks: ["M-1"],
      });
      expect((await show("M-1"))["summary"]).not.toBe("Changed by the person after the import");
      expect(await call("history.redo", { request_id: rid() })).toMatchObject({
        result: "redone",
        tasks: ["M-1"],
      });
      expect((await show("M-1"))["summary"]).toBe("Changed by the person after the import");
      // The import commits were never on the person's undo stack, so undo stops after their own.
      await call("history.undo", { request_id: rid() });
      await expect(call("history.undo", { request_id: rid() })).rejects.toMatchObject({
        code: "not_found",
      });
      await call("history.redo", { request_id: rid() });

      // A task still answers to its ID in the earlier tool.
      expect((await show("t-eb2a8db7"))["title"]).toBe(
        "Follow up on the time zone fix for the clinic",
      );

      // The space's view renders every imported task that was not undone.
      const view = join(folder, "view");
      await waitFor(
        () => (existsSync(join(view, ".projection.json")) ? true : undefined),
        30_000,
        "the first render",
      );
      const catalog = readFileSync(join(view, "catalog.jsonl"), "utf8").trim().split("\n");
      expect(catalog.slice(1)).toHaveLength(48);
      expect(catalog.join("\n")).toContain("Order printer toner");
    },
    LONG,
  );

  test(
    "it backs up, exports and restores",
    async () => {
      const checked = await checkedDriver();
      const backup = await provenBackup(checked, folder, {
        backupDir: backupsBeside(folder),
        kind: "manual",
      });
      const bundle = await exportBundle(checked, folder, { mode: "backup", withJsonl: true });
      expect(bundle.manifest.seq).toBe(backup.sidecar.seq);

      await call("task.update", {
        task: "M-1",
        set: { summary: "Changed after the backup" },
        base: await asOf(),
        request_id: rid(),
      });
      await service.spaceManager.restoreInPlace(0, backup.file);
      expect((await show("M-1"))["summary"]).toBe("Changed by the person after the import");
      const active = await call("task.search", { scope: "active", limit: 50 });
      expect((active["rows"] as unknown[]).length).toBe(34);
    },
    LONG,
  );
});
