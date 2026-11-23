// What the page relies on to put an archived area or project out of the way and bring it back:
// the snapshot and every batch carry a group's archived state, its active tasks stay in the open
// set, and the page's Unarchive, based on what it shows, applies and is one undo step. A real
// service in this process, a real ttasks-local/1 session and fixture text.
import { mkdirSync } from "node:fs";
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
let root: string;

let n = 0;
const rid = () => `fixture-archived-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Record<string, unknown>) =>
  (await user.call("op/call", { op, input }, { timeoutMs: 30_000 })) as Record<string, unknown>;

beforeAll(async () => {
  const temp = tempRoot("archived-groups");
  cleanup = temp.cleanup;
  root = temp.root;
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

describe("[A5.archived.service.where] a new project's answer says where it is: its area, and whether that area is archived", () => {
  test("a name that resolves to an archived area by slug, by an old slug and before another case of it: group.manage and folder.manage name the area and say it is archived; a live area is named without", async () => {
    const archive = async (path: string) =>
      call("group.manage", { action: "archive", path, base: await asOfOf(), request_id: rid() });
    await call("group.manage", { action: "create", path: "Amber Deck", request_id: rid() });
    await call("group.manage", { action: "create", path: "Old Shed", request_id: rid() });
    await call("group.manage", {
      action: "rename",
      path: "Old Shed",
      to: "Potting Shed",
      base: await asOfOf(),
      request_id: rid(),
    });
    await call("group.manage", { action: "create", path: "Loft", request_id: rid() });
    // A create of "LOFT" would name Loft: a rename gives the second case its own area.
    await call("group.manage", { action: "create", path: "Garret", request_id: rid() });
    await call("group.manage", {
      action: "rename",
      path: "Garret",
      to: "LOFT",
      base: await asOfOf(),
      request_id: rid(),
    });
    const listed = (await call("group.manage", { action: "list", archived: true })) as {
      areas: { id: string; name: string }[];
    };
    const idOf = (name: string) => listed.areas.find((a) => a.name === name)?.id ?? "";
    await archive(idOf("Amber Deck"));
    await archive(idOf("Potting Shed"));
    await archive(idOf("Loft"));

    for (const [given, area] of [
      ["amber-deck", "Amber Deck"],
      ["old-shed", "Potting Shed"],
      ["Loft", "Loft"],
    ] as const) {
      const made = await call("group.manage", {
        action: "create",
        path: `${given}/Fixture planks ${given}`,
        mode: "apply",
        request_id: rid(),
      });
      expect(made).toMatchObject({
        result: "created",
        group: { kind: "project", area: { id: idOf(area), name: area, archived: true } },
      });
    }
    const live = await call("group.manage", {
      action: "create",
      path: "LOFT/Fixture beams",
      mode: "apply",
      request_id: rid(),
    });
    expect(live).toMatchObject({ group: { area: { id: idOf("LOFT"), name: "LOFT" } } });
    expect((live["group"] as { area: Record<string, unknown> }).area).not.toHaveProperty(
      "archived",
    );

    const folder = join(root, "work", "rafters");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const added = await call("folder.manage", {
      action: "add_project",
      area: "amber-deck",
      folder,
      request_id: rid(),
    });
    expect(added).toMatchObject({
      result: "created",
      owner: {
        kind: "project",
        name: "rafters",
        area: { id: idOf("Amber Deck"), name: "Amber Deck", archived: true },
      },
    });
  });
});
