// A task's pages follow page.read's rule wherever they are listed: while the task is in the Trash,
// task.get names none of them, as page.read opens none of them. Fixture data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { phoneWorld } from "./phone-link.ts";

let w: Awaited<ReturnType<typeof phoneWorld>>;

beforeAll(async () => {
  w = await phoneWorld("trash-pages");
}, 300_000);

afterAll(async () => {
  await w.end();
});

describe("[A5.library.trash-listed] a task in the Trash lists none of its pages, as none of them is read", () => {
  test("task.get names a task's page until the task goes to the Trash; page.read opens it until then", async () => {
    const task = await w.added("Task with a page for the Trash");
    const made = await w.op("page.write", {
      action: "create",
      on: task.ref,
      title: "Page of a task for the Trash",
      brief: "Fixture",
      body: "Fixture body.",
      why: "fixture",
      request_id: randomUUID(),
    });
    const page = String(made.result?.["target"]);

    const sections = { task: task.ref, sections: ["notes"] };
    const before = await w.op("task.get", sections);
    expect(before.result?.["pages"]).toEqual([expect.objectContaining({ ref: page })]);
    expect((await w.op("page.read", { target: page })).status).toBe(200);

    const got = await w.op("task.get", { task: task.ref });
    const trashed = await w.op("task.delete", {
      tasks: [task.ref],
      base: got.result?.["as_of"],
      request_id: randomUUID(),
    });
    expect(trashed.status).toBe(200);

    const after = await w.op("task.get", sections);
    expect(after.status).toBe(200);
    expect(after.result?.["pages"] ?? []).toEqual([]);
    expect(after.result?.["pages_more"] ?? 0).toBe(0);
    const digest = await w.op("task.get", { task: task.ref });
    const shown = digest.result?.["task"] as { pages?: unknown[]; more?: { pages?: number } };
    expect(shown.pages ?? []).toEqual([]);
    expect(shown.more?.pages ?? 0).toBe(0);
    expect((await w.op("page.read", { target: page })).status).toBe(404);
  });
});
