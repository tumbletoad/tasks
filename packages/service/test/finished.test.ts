// The page's read of finished tasks (`task.finished`): every completed or dropped task, newest first
// by the time it was finished, a page at a time from a key, with the feed's compact rows. Against a
// real space in this thread, through the request path with a reader shaped like the service's.
// Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, FinishedRow, TaskFinishedResult } from "@tasks/contracts";
import {
  newId,
  type Connection,
  type Id,
  type Operation,
  type Row,
  type WorkerConnection,
  type WriteResult,
} from "@tasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@tasks/storage/write-helpers";
import { readBatch } from "../src/http/feed.ts";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import type { SearchReader } from "../src/search/search.ts";
import { tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
/** The writer's clock: each test moves it on, so commits land at the times it names. */
let clock = Date.UTC(2026, 10, 20, 9, 0, 0);

beforeAll(async () => {
  temp = tempRoot("finished");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

/** The service's reader, in this thread: each call is one deferred read transaction. */
function readerOf(conn: Connection): WorkerConnection {
  const reader: SearchReader = {
    transaction: (mode, queries) =>
      Promise.resolve(
        conn.transaction(mode, () =>
          queries.map((q) => {
            const statement = conn.prepare(q.sql);
            if (q.mode === "get") return statement.get(q.params) ?? null;
            if (q.mode === "all") {
              const rows: Row[] = statement.all(q.params);
              return rows;
            }
            return statement.run(q.params);
          }),
        ),
      ),
  };
  return reader as unknown as WorkerConnection;
}

const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    { id: fx.spaceId, name: "Mira", state: "open", writer: undefined, reader: readerOf(fx.reader) },
  ],
  now: () => clock,
  timeZone: () => "Europe/Lisbon",
});
const user: Caller = { class: "cli-interactive", env: {} };

type Result = ReturnType<typeof TaskFinishedResult.parse>;

const finished = async (input: Record<string, unknown>): Promise<Result> =>
  TaskFinishedResult.parse(await opCall(host(), user, { op: "task.finished", input }));

/** Every page of a read, in order. */
async function all(input: Record<string, unknown>): Promise<Result["rows"]> {
  const rows: Result["rows"][number][] = [];
  let cursor: string | undefined;
  do {
    const page = await finished({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return rows;
}

function submit(ops: Operation[], at: number): WriteResult {
  clock = at;
  const result = fx.writer.submit(fx.request(fx.human, ops, { base: fx.base() }));
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
  return result;
}

/** Tasks made and finished in one request at `at`: their IDs. */
function finish(
  count: number,
  at: number,
  how: "wrapped" | "pending" | "dropped",
  title = "Fixture finished",
): Id<"t">[] {
  const ids = Array.from({ length: count }, () => newId("t"));
  submit(
    [
      ...ids.map((id, i): Operation => ({
        kind: "task.create",
        id,
        title: `${title} ${String(i)}`,
        area: fx.areas.home,
      })),
      ...ids.map((task): Operation =>
        how === "dropped"
          ? { kind: "task.archive", task }
          : how === "pending"
            ? { kind: "task.complete", task }
            : { kind: "task.complete", task, outcome: "Done as planned." },
      ),
    ],
    at,
  );
  return ids;
}

/** Newest first by finish time, then by ID. */
const ordered = (rows: readonly { finished_at: number; id: string }[]): boolean =>
  rows.every((row, i) => {
    const prev = rows[i - 1];
    return (
      prev === undefined ||
      prev.finished_at > row.finished_at ||
      (prev.finished_at === row.finished_at && prev.id > row.id)
    );
  });

const HOUR = 3_600_000;

describe("[A5.3.5.service.finished] the read of finished tasks behind Completed", () => {
  const wrapped: string[] = [];
  const pending: string[] = [];
  const dropped: string[] = [];

  beforeAll(() => {
    // 2,500 completed and wrapped up in one month, 25 at a time (a request holds 50 operations), so
    // 25 share each instant.
    for (let i = 0; i < 100; i += 1) {
      wrapped.push(...finish(25, Date.UTC(2026, 10, 20, 10) + i * HOUR, "wrapped"));
    }
    pending.push(...finish(25, Date.UTC(2026, 10, 25, 12), "pending"));
    dropped.push(...finish(5, Date.UTC(2026, 10, 25, 13), "dropped"));
  }, 120_000);

  test("several thousand in one month: every one reachable once, newest first, past any cap", async () => {
    const rest = await all({ checked_off: false, limit: 200 });
    expect(rest).toHaveLength(2_505);
    expect(new Set(rest.map((r) => r.id)).size).toBe(2_505);
    expect(ordered(rest)).toBe(true);
    expect(
      rest
        .slice(0, 5)
        .map((r) => r.id)
        .sort(),
    ).toEqual([...dropped].sort());
    expect(new Set(rest.slice(5).map((r) => r.id))).toEqual(new Set(wrapped));
    for (const row of rest) expect(FinishedRow.safeParse(row).success).toBe(true);

    // The checked-off list: completed, its wrap-up waiting. All of it is the two parts together.
    const checked = await all({ checked_off: true });
    expect(checked.map((r) => r.id).sort()).toEqual([...pending].sort());
    expect(checked.every((r) => r.lifecycle === "completed" && r.wrap_state === "pending")).toBe(
      true,
    );
    const every = await all({ limit: 200 });
    expect(every).toHaveLength(2_530);
    expect(ordered(every)).toBe(true);
  }, 120_000);

  test("the feed's compact row: the area's ID, the version, the creation time, no lookup by name", async () => {
    const [row] = (await finished({ checked_off: true, limit: 1 })).rows;
    expect(row).toMatchObject({
      lifecycle: "completed",
      wrap_state: "pending",
      area_id: fx.areas.home,
      completed_at: Date.UTC(2026, 10, 25, 12),
      finished_at: Date.UTC(2026, 10, 25, 12),
    });
    expect(row?.version).toBeGreaterThan(0);
    expect(row?.created_at).toBe(Date.UTC(2026, 10, 25, 12));
    expect(row?.ref).toMatch(/^M-\d+$/);
  });

  test("a dropped task has its place: the time it was dropped, and no completion", async () => {
    const [kept] = finish(1, Date.UTC(2026, 10, 26, 9), "wrapped", "Fixture dropped later");
    if (kept === undefined) throw new Error("no task");
    // Reopened, then dropped: it is finished when it was dropped, not when it was made or done.
    submit([{ kind: "task.reopen", task: kept }], Date.UTC(2026, 10, 26, 10));
    submit(
      [{ kind: "task.archive", task: kept, reason: "Not needed." }],
      Date.UTC(2026, 10, 26, 11),
    );
    const [top] = (await finished({ checked_off: false, limit: 1 })).rows;
    expect(top).toMatchObject({
      id: kept,
      lifecycle: "archived",
      finished_at: Date.UTC(2026, 10, 26, 11),
    });
    expect(top).not.toHaveProperty("completed_at");
    // A finished task in the Trash is not in the list.
    submit([{ kind: "task.delete", task: kept }], Date.UTC(2026, 10, 26, 12));
    expect((await finished({ checked_off: false, limit: 1 })).rows[0]?.id).not.toBe(kept);
  });

  test("a task finished or reopened while the list is open neither repeats nor skips a row", async () => {
    const first = await finished({ checked_off: false, limit: 100 });
    const before = await all({ checked_off: false, limit: 200 });
    // Between the pages: a task finished now, and one further down reopened.
    const [late] = finish(1, Date.UTC(2026, 10, 27, 9), "wrapped", "Fixture finished late");
    const gone = before[700]?.id;
    if (gone === undefined || late === undefined) throw new Error("no task");
    submit([{ kind: "task.reopen", task: gone }], Date.UTC(2026, 10, 27, 10));
    const seen = [...first.rows];
    let cursor = first.cursor;
    while (cursor !== undefined) {
      const page = await finished({ checked_off: false, limit: 100, cursor });
      seen.push(...page.rows);
      cursor = page.cursor;
    }
    const ids = seen.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every task of the first read, but the one reopened after the first page passed it.
    expect(ids).toEqual(before.map((r) => r.id).filter((id) => id !== gone));
    expect(ids).not.toContain(late);
    // The list read again from the top has the new one first.
    expect((await finished({ checked_off: false, limit: 1 })).rows[0]?.id).toBe(late);
  });

  test("a cursor this read did not give is invalid input", async () => {
    for (const cursor of ["c_7m2k9q4w1z8r3c6d", "12.ts_x", "1.t_00000000000000000000000000"]) {
      const error = await opCall(host(), user, {
        op: "task.finished",
        input: { cursor },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (cursor.startsWith("1.t_")) expect(error).toBeUndefined();
      else expect(error instanceof AppError && error.code).toBe("invalid_input");
    }
  });

  test("the feed's row of a finished task carries when it was finished", async () => {
    const after = Number(
      (fx.reader.prepare("SELECT max(seq) AS seq FROM commits").get() as Row | undefined)?.["seq"],
    );
    const [task] = finish(1, Date.UTC(2026, 10, 28, 9), "dropped", "Fixture dropped in the feed");
    const { batch } = await readBatch(readerOf(fx.reader), after);
    const rows = batch.events.flatMap((e) => e.entities).filter((e) => e.id === task);
    expect(rows.at(-1)?.row).toMatchObject({
      lifecycle: "archived",
      finished_at: Date.UTC(2026, 10, 28, 9),
    });
  });
});
