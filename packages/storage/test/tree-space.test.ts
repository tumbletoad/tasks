// A tree space in a folder, opened as every space is: made with its manifest and the tree's step,
// recognised on open, its writer in the storage worker taking the tree's named commands, and its
// reader reading what they wrote. What only today's writer does is refused on it. Fixture text
// only.
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
  test("a tree space opens as a space: its writer takes named commands, its reader reads them", async () => {
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
      command: "tasks.add",
      input: { tasks: [{ title: "Fix the export" }] },
    };
    const result = await writer.submitTree(request);
    expect(result.status).toBe("applied");
    // A resend is answered from the receipt, and the receipt keeps that answer.
    expect(await writer.submitTree(request)).toEqual({ ...result, replayed: true });
    expect(
      await writer.treeReceipt({ scope_id: "cli:fixture", request_id: request.request_id }),
    ).toEqual(result);
    const { conn } = await worker.openSpaceReader(created.folder);
    expect(await conn.get("SELECT title FROM nodes WHERE kind = 'task'")).toEqual({
      title: "Fix the export",
    });
    expect((await rejection(writer.openLaunches(TEST_MACHINE))).code).toBe("STORAGE_UNSUPPORTED");
    await conn.close();
    await writer.close();
  });
});
