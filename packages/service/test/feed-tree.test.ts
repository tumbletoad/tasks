// The feed sends the space as a tree: the space, each area as a top-level project and each project
// under its area or the space, with the IDs they have, and a `parent` on every task row. A real service in this process, a real ttasks-local/1 session and
// fixture text.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CompactNode } from "@ttasks/contracts";
import type { RpcSession } from "@ttasks/bridge/protocol";
import type { WorkerConnection } from "@ttasks/storage";
import { startService, type RunningService } from "../src/hub/service.ts";
import { readBatch, readHead, readSnapshot } from "../src/http/feed.ts";
import { phoneBatch, phoneSnapshot } from "../src/link/rows.ts";
import { classSession } from "./ops-helpers.ts";
import { removeRuntimeDir, serviceEnv, tempRoot } from "./harness.ts";

let service: RunningService;
let cleanup: () => void;
let user: RpcSession;
let reader: WorkerConnection;
let work: string;

let n = 0;
const rid = () => `fixture-feed-tree-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Record<string, unknown>) =>
  (await user.call("op/call", { op, input }, { timeoutMs: 30_000 })) as Record<string, unknown>;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

beforeAll(async () => {
  const temp = tempRoot("feed-tree");
  cleanup = temp.cleanup;
  const home = join(temp.root, "h");
  work = join(temp.root, "workroottree");
  mkdirSync(join(work, "garden"), { recursive: true });
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
const titled = <R extends Readonly<Record<string, unknown>>>(rows: readonly R[], title: string) =>
  rows.find((r) => r["title"] === title);
const idOf = (rows: Rows, title: string) => String(titled(rows, title)?.["id"]);

describe("[A5.tree.http.feed] the feed sends the space as a tree: areas as top-level projects, their projects as children", () => {
  test("the snapshot: the space, an area and its project as a two-level tree with their own IDs, a project without an area after every area, and each task's parent", async () => {
    await call("group.manage", { action: "create", path: "Client work/Portal", request_id: rid() });
    await call("folder.manage", {
      action: "add_project",
      project: "Garden",
      folder: join(work, "garden"),
      request_id: rid(),
    });
    const added = (await call("task.add", {
      tasks: [
        { title: "Fixture fix the login", area: "Client work", project: "Portal" },
        { title: "Fixture send the invoice", area: "Client work" },
        { title: "Fixture water the beans", project: "Garden" },
        { title: "Fixture a loose thought", inbox: true },
      ],
      request_id: rid(),
    })) as { tasks: { ref: string }[] };
    const page = (on: string, title: string) =>
      call("page.write", {
        action: "create",
        on,
        title,
        brief: "Fixture brief",
        body: "Fixture body.",
        why: "fixture",
        request_id: rid(),
      });
    await page(added.tasks[0]?.ref ?? "", "Fixture login notes");
    await page("Client work", "Fixture client rules");
    await page("space", "Fixture glossary");

    const snapshot = await readSnapshot(reader);
    const space = snapshot.space.id;
    const area = idOf(snapshot.nodes, "Client work");
    const portal = idOf(snapshot.nodes, "Portal");
    const garden = idOf(snapshot.nodes, "Garden");
    for (const node of snapshot.nodes) expect(CompactNode.parse(node)).toEqual(node);
    expect(snapshot.nodes[0]).toEqual({ id: space, kind: "space", title: "Mira", state: "active" });
    expect(titled(snapshot.nodes, "Client work")).toMatchObject({
      id: area,
      kind: "project",
      parent: space,
      state: "active",
    });
    expect(titled(snapshot.nodes, "Portal")).toMatchObject({
      id: portal,
      kind: "project",
      parent: area,
    });
    expect(titled(snapshot.nodes, "Garden")).toMatchObject({ id: garden, parent: space });
    const position = (title: string) => String(titled(snapshot.nodes, title)?.["position"]);
    expect(position("Garden") > position("Client work")).toBe(true);

    expect(titled(snapshot.tasks, "Fixture fix the login")).toMatchObject({ parent: portal });
    expect(titled(snapshot.tasks, "Fixture send the invoice")).toMatchObject({ parent: area });
    expect(titled(snapshot.tasks, "Fixture water the beans")).toMatchObject({ parent: garden });
    expect(titled(snapshot.tasks, "Fixture a loose thought")).toMatchObject({ parent: space });

    // A page lies under the node that holds it, or its task's.
    const pages = snapshot.pages ?? [];
    expect(titled(pages, "Fixture login notes")).toMatchObject({ under: portal });
    expect(titled(pages, "Fixture client rules")).toMatchObject({ owner_id: area, under: area });
    expect(titled(pages, "Fixture glossary")).toMatchObject({ owner_id: space, under: space });

    // The same IDs in the next snapshot: a node is the area or project it was made from.
    expect((await readSnapshot(reader)).nodes).toEqual(snapshot.nodes);

    // A phone gets the same tree and parents.
    const phone = phoneSnapshot(snapshot, {}, (label) => label);
    expect(phone["nodes"]).toEqual(snapshot.nodes);
    expect(titled(phone["tasks"] as Rows, "Fixture fix the login")).toMatchObject({
      parent: portal,
    });
  });

  test("a batch: a new area, a project moved to it and an archived area each carry their node row, naming the node's fields", async () => {
    const start = (await readHead(reader)).cursor.seq;
    await call("group.manage", { action: "create", path: "Internal", request_id: rid() });
    await call("group.manage", {
      action: "move",
      path: "Client work/Portal",
      to: "Internal",
      base: await asOf(),
      request_id: rid(),
    });
    await call("group.manage", {
      action: "archive",
      path: "Client work",
      base: await asOf(),
      request_id: rid(),
    });

    const { batch } = await readBatch(reader, start);
    const snapshot = await readSnapshot(reader);
    const internal = idOf(snapshot.nodes, "Internal");
    const nodes = batch.events.map((e) => e.entities.filter((x) => x.type === "node"));
    expect(nodes.map((list) => list.length)).toEqual([1, 1, 1]);
    const [created, moved, archived] = nodes.map((list) => list[0]);
    expect(created).toMatchObject({
      id: internal,
      created: true,
      row: { kind: "project", parent: snapshot.space.id, title: "Internal" },
    });
    expect(moved).toMatchObject({
      id: idOf(snapshot.nodes, "Portal"),
      changed: ["place"],
      row: { parent: internal },
    });
    expect(archived).toMatchObject({
      id: idOf(snapshot.nodes, "Client work"),
      changed: ["state"],
      row: { state: "archived" },
    });
    // Each batch row is the snapshot's row of the same node.
    expect(moved?.row).toEqual(titled(snapshot.nodes, "Portal"));
    expect(titled(snapshot.tasks, "Fixture fix the login")).toMatchObject({
      parent: idOf(snapshot.nodes, "Portal"),
    });

    const phone = phoneBatch(batch, (label) => label) as {
      events: { entities: { type: string; row: unknown }[] }[];
    };
    const phoneNodes = phone.events.flatMap((e) => e.entities.filter((x) => x.type === "node"));
    expect(phoneNodes.map((x) => x.row)).toEqual([created?.row, moved?.row, archived?.row]);
  });

  test("a batch: a task filed into another project carries its page's row, under the new project", async () => {
    const start = (await readHead(reader)).cursor.seq;
    const before = await readSnapshot(reader);
    const ref = titled(before.tasks, "Fixture fix the login")?.["ref"] as string;
    await call("task.update", {
      task: ref,
      set: { project: "Garden" },
      base: await asOf(),
      request_id: rid(),
    });

    const { batch } = await readBatch(reader, start);
    const snapshot = await readSnapshot(reader);
    const garden = idOf(snapshot.nodes, "Garden");
    const page = batch.events
      .flatMap((e) => e.entities)
      .find((x) => x.type === "page" && x.id === idOf(snapshot.pages ?? [], "Fixture login notes"));
    expect(page?.row).toMatchObject({ under: garden });
    expect(page?.row).toEqual(titled(snapshot.pages ?? [], "Fixture login notes"));
  });
});
