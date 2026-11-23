// What the page relies on to put an archived area or project out of the way and bring it back:
// the snapshot and every batch carry a group's archived state, its active tasks stay in the open
// set, and the page's Unarchive, based on what it shows, applies and is one undo step. A real
// service in this process, a real ttasks-local/1 session and fixture text.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { WorkerConnection } from "@ttasks/storage";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readBatch, readHead, readSnapshot } from "../src/http/feed.ts";
import { classSession } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let cleanup: () => void;
let user: RpcSession;
let reader: WorkerConnection;

let n = 0;
const rid = () => `fixture-archived-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Record<string, unknown>) =>
  (await user.call("op/call", { op, input }, { timeoutMs: 30_000 })) as Record<string, unknown>;

beforeAll(async () => {
  const temp = tempRoot("archived-groups");
  cleanup = temp.cleanup;
  const home = join(temp.root, "h");
  service = await startService({
    env: serviceEnv(home),
    identity: () => ({ root: false, elevated: false, package: null }),
    maintenance: false,
    say: () => undefined,
  });
  user = await classSession(home, service.endpoint.path, "cli-interactive");
  await user.call(
    "space/create",
    { name: "Mira", path: join(temp.root, "spaces", "mira"), ref_prefix: "M" },
    { timeoutMs: 60_000 },
  );
  const served = service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
  if (served === undefined) throw new Error("no space is served");
  reader = served;
}, 120_000);

afterAll(async () => {
  user.close();
  await service.stop();
  removeRuntimeDir(service);
  cleanup();
});

type Rows = readonly Readonly<Record<string, unknown>>[];
const titled = (rows: Rows, title: string) => rows.find((r) => r["title"] === title);

/** The head as an `as_of`: what a page that shows every commit sends as its base. */
const asOfOf = async () => (await call("space.status", {}))["as_of"] as string;

describe("[A5.archived.service.feed] an archived group reaches the page, keeps its open tasks there, and comes back", () => {
  test("archive: the snapshot and the batch mark the area and the project archived and keep their open tasks; Unarchive from the page's base applies and undoes in one step", async () => {
    await call("group.manage", { action: "create", path: "Attic/Boxes", request_id: rid() });
    await call("group.manage", { action: "create", path: "Garage/Bikes", request_id: rid() });
    await call("task.add", {
      tasks: [
        { title: "Fixture sort the boxes", area: "Attic" },
        { title: "Fixture label the boxes", area: "Attic", project: "Boxes" },
        { title: "Fixture oil the chain", area: "Garage", project: "Bikes" },
      ],
      request_id: rid(),
    });
    const start = (await readHead(reader)).cursor.seq;
    await call("group.manage", {
      action: "archive",
      path: "Attic",
      base: await asOfOf(),
      request_id: rid(),
    });
    await call("group.manage", {
      action: "archive",
      path: "Garage/Bikes",
      base: await asOfOf(),
      request_id: rid(),
    });

    // A page open meanwhile learns it from the batch.
    const { batch } = await readBatch(reader, start);
    const rows = batch.events.flatMap((e) => e.entities.map((x) => x.row ?? {}));
    expect(titled(rows, "Attic")).toMatchObject({ lifecycle: "archived" });
    expect(titled(rows, "Bikes")).toMatchObject({ lifecycle: "archived" });

    // A page opened after learns it from the snapshot, with every task still open.
    const snapshot = await readSnapshot(reader);
    expect(titled(snapshot.areas, "Attic")).toMatchObject({ lifecycle: "archived" });
    expect(titled(snapshot.areas, "Garage")).toMatchObject({ lifecycle: "active" });
    expect(titled(snapshot.projects, "Bikes")).toMatchObject({ lifecycle: "archived" });
    expect(titled(snapshot.projects, "Boxes")).toMatchObject({ lifecycle: "active" });
    for (const title of [
      "Fixture sort the boxes",
      "Fixture label the boxes",
      "Fixture oil the chain",
    ]) {
      expect(titled(snapshot.tasks, title)).toMatchObject({ lifecycle: "active" });
    }

    // The page's Unarchive names the group by its ID, based on what it shows.
    const attic = String(titled(snapshot.areas, "Attic")?.["id"]);
    const back = await call("group.manage", {
      action: "unarchive",
      path: attic,
      base: await asOfOf(),
      mode: "apply",
      request_id: rid(),
    });
    expect(back).toMatchObject({ result: "unarchived", group: { kind: "area", id: attic } });
    expect(titled((await readSnapshot(reader)).areas, "Attic")).toMatchObject({
      lifecycle: "active",
    });
    await call("history.undo", { request_id: rid() });
    expect(titled((await readSnapshot(reader)).areas, "Attic")).toMatchObject({
      lifecycle: "archived",
    });
  });
});
