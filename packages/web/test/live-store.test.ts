// The live store's core on the real service's feed (A7 3.12 M5.02; A5 3.15): the messages
// are the ones packages/service/src/http/feed.ts reads from a real space, sent through JSON as the
// socket sends them. After real operations (adds, edits, a log entry, completion and reopening),
// read in batches of one to three commits, the core holds exactly the service's own snapshot.
// A batch capped before the head withholds rows; the core then takes a fresh snapshot.
import { afterEach, describe, expect, test } from "vitest";
import { readBatch, readSnapshot } from "@tasks/service/http";
import { httpWorld, type HttpWorld } from "@tasks/service/test/http-world";
import { TASK_FIELDS } from "@tasks/storage";
import { LiveCore, type Outcome } from "../src/store/core.ts";
import { parseMessage, TASK_FIELD_COLUMNS, withTaskRow } from "../src/store/rows.ts";

const SLOW = { timeout: 180_000 };
const worlds: HttpWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

type Reader = Parameters<typeof readSnapshot>[0];
type RpcSession = Awaited<ReturnType<HttpWorld["user"]>>;

/** A message as the page receives it: through JSON, checked by its shape. */
function wire(message: unknown) {
  const parsed = parseMessage(JSON.stringify(message));
  if (
    parsed === undefined ||
    parsed.type === "hello" ||
    parsed.type === "installed" ||
    parsed.type === "error" ||
    parsed.type === "machine"
  ) {
    throw new Error("not a feed message");
  }
  return parsed;
}

/** The core's rows, and the service's snapshot as the core holds it, for comparison. */
async function compare(core: LiveCore, reader: Reader) {
  const fresh = new LiveCore();
  fresh.receive(wire(await readSnapshot(reader)));
  const want = fresh.publish();
  const got = core.publish();
  expect(core.cursor).toEqual(want?.cursor);
  expect(got?.tasks).toEqual(want?.tasks);
  expect(got?.areas).toEqual(want?.areas);
  expect(got?.projects).toEqual(want?.projects);
}

/** Reads batches of `limit` commits until the core is at the head; a resnapshot reads a snapshot. */
async function catchUp(
  core: LiveCore,
  reader: Reader,
  limit: number,
  heard: (outcome: Outcome) => void = () => undefined,
): Promise<Outcome["kind"][]> {
  const seen: Outcome["kind"][] = [];
  for (let round = 0; round < 100; round += 1) {
    const cursor = core.resumeFrom;
    if (cursor === undefined) {
      const outcome = core.receive(wire(await readSnapshot(reader)));
      seen.push(outcome.kind);
      continue;
    }
    const { batch } = await readBatch(reader, cursor.seq, { limit });
    // Nothing newer: the service sends no batch (its pump stops at the head).
    if (batch.through === cursor.seq) return seen;
    const outcome = core.receive(wire(batch));
    heard(outcome);
    seen.push(outcome.kind);
  }
  throw new Error("the core did not reach the head");
}

let requests = 0;
const id = () => `store-request-${String((requests += 1)).padStart(4, "0")}`;

/** Real operations of the person, through the service's request path. */
function operations(user: RpcSession) {
  const call = (op: string, input: Record<string, unknown>) =>
    user.call("op/call", { op, input: { ...input, request_id: id() } });
  const base = async (task: string) =>
    ((await user.call("op/call", { op: "task.get", input: { task } })) as { as_of: string }).as_of;
  return [
    () =>
      call("task.add", { tasks: [{ title: "Water the plants" }, { title: "Call the plumber" }] }),
    () => call("task.add", { tasks: [{ title: "Book the clinic visit", inbox: true }] }),
    async () =>
      call("task.update", {
        task: "M-1",
        set: { title: "Water the ferns", summary: "Twice a week" },
        base: await base("M-1"),
      }),
    () => call("entry.add", { task: "M-2", kind: "progress", text: "Left a message." }),
    async () => call("task.finish", { task: "M-3", base: await base("M-3") }),
    async () =>
      call("task.update", {
        task: "M-2",
        set: { priority: 2 },
        clear: ["summary"],
        base: await base("M-2"),
      }),
    async () =>
      call("task.reopen", { task: "M-3", reason: "Moved to Friday.", base: await base("M-3") }),
    () => call("entry.add", { task: "M-3", kind: "progress", text: "Rebooked." }),
    async () => call("task.finish", { task: "M-1", base: await base("M-1") }),
    async () =>
      call("task.update", {
        task: "M-2",
        set: { due: "2026-12-01" },
        base: await base("M-2"),
      }),
    async () => call("task.update", { task: "M-2", clear: ["due"], base: await base("M-2") }),
  ];
}

async function served(label: string): Promise<{ user: RpcSession; reader: Reader }> {
  const w = await httpWorld(label);
  worlds.push(w);
  const user = await w.user();
  const reader = w.service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
  if (reader === undefined) throw new Error("no space is served");
  return { user, reader };
}

describe("[A5.3.15.web.store.service] the live store on the service's own feed", () => {
  test("batch by batch after every operation, it holds the service's snapshot", SLOW, async () => {
    const { user, reader } = await served("ls1");
    const core = new LiveCore();
    core.receive(wire(await readSnapshot(reader)));
    for (const [i, op] of operations(user).entries()) {
      await op();
      // The service pumps after every write: each batch reaches the head, nothing is withheld.
      const seen = await catchUp(core, reader, 1 + (i % 3));
      expect(seen.every((kind) => kind === "applied")).toBe(true);
      await compare(core, reader);
    }
  });

  test(
    "the feed names logical fields the page knows, and a row a view shows follows it exactly",
    SLOW,
    async () => {
      // The page's map of logical fields is storage's.
      expect(TASK_FIELD_COLUMNS).toEqual(TASK_FIELDS);
      const { user, reader } = await served("ls3");
      const core = new LiveCore();
      core.receive(wire(await readSnapshot(reader)));
      // Rows as a paged view shows them, taken from the snapshot and then only from the feed.
      const shown = new Map<string, Readonly<Record<string, unknown>>>();
      for (const [id, row] of core.publish()?.tasks ?? []) shown.set(id, row as never);
      const follow = (outcome: Outcome) => {
        if (outcome.kind !== "applied") return;
        for (const change of outcome.changes) {
          if (change.type !== "task") continue;
          for (const field of change.changed) expect(Object.keys(TASK_FIELDS)).toContain(field);
          const after = change.after as Readonly<Record<string, unknown>> | undefined;
          if (after === undefined) continue;
          const before = shown.get(change.id);
          shown.set(change.id, before === undefined ? after : withTaskRow(before, after));
        }
      };
      for (const op of operations(user)) {
        await op();
        const seen = await catchUp(core, reader, 100, follow);
        expect(seen.every((kind) => kind === "applied")).toBe(true);
      }
      // Each open task as shown equals the service's row (but for `touched`, which a child's change
      // moves without the task's row), the due date set and cleared included.
      const held = core.publish()?.tasks ?? new Map<string, never>();
      expect(held.size).toBeGreaterThan(0);
      const plain = (row: unknown) =>
        Object.fromEntries(
          Object.entries(row as Record<string, unknown>).filter(([field]) => field !== "touched"),
        );
      for (const [id, row] of held) expect(plain(shown.get(id))).toEqual(plain(row));
    },
  );

  test(
    "behind by several commits and read in small batches, it takes a fresh snapshot for a withheld row",
    SLOW,
    async () => {
      const { user, reader } = await served("ls2");
      const core = new LiveCore();
      core.receive(wire(await readSnapshot(reader)));
      for (const op of operations(user)) await op();
      const seen = await catchUp(core, reader, 1);
      expect(seen).toContain("resnapshot");
      await compare(core, reader);
    },
  );
});
