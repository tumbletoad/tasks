// A tree space in a folder, opened as every space is: made with its manifest and the tree's step,
// recognised on open, its writer in the storage worker taking today's requests and keeping today's
// receipts, and its reader reading what they wrote. What only today's writer does is refused on
// it. Fixture text only.
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { newId } from "../src/ids.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { createFixtureSpace, tempFolders, TEST_MACHINE } from "./space-helpers.ts";
import { rejection } from "./worker-helpers.ts";
import { MACHINE } from "./write-helpers.ts";

const temp = tempFolders("tree-space");
const workers: StorageWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});
afterAll(temp.cleanup);

describe("[S2.tree.space] a tree space in a folder, served by the storage worker", () => {
  test("a tree space opens as a space: its writer takes today's requests, its reader reads them", async () => {
    const created = await createFixtureSpace(temp.make(), "mira", { tree: true });
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    workers.push(worker);
    const writer = await worker.openSpaceWriter(created.folder, { machine: MACHINE });
    expect(writer.backend).toBe("tree");
    expect(writer.revision).toEqual({ major: 1, minor: 0 });
    const human = await writer.actor("human", "user");
    const request = {
      space_id: writer.spaceId,
      request_id: newId("op").slice(3),
      actor: {
        scope_id: "cli:fixture",
        principal_id: human,
        actor_kind: "human",
        machine_id: TEST_MACHINE,
        origin: "cli",
      },
      intent: { entry: "task.add", input: { tasks: [{ title: "Fix the export" }] } },
      ops: [{ kind: "task.create", title: "Fix the export" }],
    };
    const result = await writer.submit(request);
    expect(result.status).toBe("applied");
    expect(result.results.map((r) => [r.i, r.status, r.ref])).toEqual([[0, "created", "M-1"]]);
    // A resend is answered from the receipt, which keeps that answer under the intent's fingerprint.
    expect(await writer.submit(request)).toEqual({ ...result, replayed: true });
    const receipt = await writer.receipt({
      scope_id: "cli:fixture",
      request_id: request.request_id,
    });
    expect(receipt?.result).toEqual({ ...result, replayed: true });
    // Another intent under the same ID is refused, as today's writer refuses it.
    const other = { ...request, intent: { entry: "task.add", input: { tasks: [{ title: "x" }] } } };
    expect((await writer.submit(other)).error?.code).toBe("REQUEST_ID_REUSED");
    const { conn } = await worker.openSpaceReader(created.folder);
    // A reader alone says it reads a tree, so a space served read-only reads the tree's tables.
    expect(conn.backend).toBe("tree");
    expect(await conn.get("SELECT title FROM nodes WHERE kind = 'task'")).toEqual({
      title: "Fix the export",
    });
    expect((await rejection(writer.openLaunches(TEST_MACHINE))).code).toBe("STORAGE_UNSUPPORTED");
    await conn.close();
    await writer.close();
  });
});
