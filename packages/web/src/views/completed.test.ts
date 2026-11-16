// Completed's page source and groups (A5 3.5) against a fake `task.finished` that answers as the
// service does: finished tasks newest first by finish time, then by ID, from a key.
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import { completedGroups, completedSource, type FinishedRead } from "./completed.ts";

const CLOCK = { today: "2026-11-12", timeZone: "UTC", locale: "en" } as const;

let ids = 0;

/** A finished task's row: completed (wrapped, unless pending) or dropped, at a day and hour. */
function done(
  ref: string,
  day: string,
  how: "wrapped" | "pending" | "dropped" = "wrapped",
  extra: Partial<TaskRow> = {},
): TaskRow {
  const at = Date.parse(`${day}T09:00:00Z`);
  ids += 1;
  return {
    id: `t_${String(ids).padStart(26, "0")}`,
    ref,
    title: `Task ${ref}`,
    status: "open",
    inbox: false,
    lifecycle: how === "dropped" ? "archived" : "completed",
    position: "a0",
    created_at: at - 86_400_000,
    version: ids,
    finished_at: at,
    ...(how === "dropped" ? {} : { completed_at: at, wrap_state: how }),
    ...extra,
  };
}

/** The feed's row of the task once it is reopened: active, nothing of its finish. */
function reopened(row: TaskRow | undefined): TaskRow {
  if (row === undefined) throw new Error("no row");
  const finish = new Set(["finished_at", "completed_at", "wrap_state"]);
  const kept = Object.entries(row).filter(([column]) => !finish.has(column));
  return { ...(Object.fromEntries(kept) as unknown as TaskRow), lifecycle: "active" };
}

const newestFirst = (a: TaskRow, b: TaskRow): number =>
  (b.finished_at ?? 0) - (a.finished_at ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The service's read over `rows`, and the reads it answered. */
function fakeRead(rows: readonly TaskRow[]): {
  read: FinishedRead;
  reads: { checked_off: boolean | undefined; limit: number; cursor?: string }[];
} {
  const reads: { checked_off: boolean | undefined; limit: number; cursor?: string }[] = [];
  const read: FinishedRead = (input) => {
    const limit = input.limit ?? 50;
    reads.push({
      checked_off: input.checked_off,
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const pending = (r: TaskRow) => r.lifecycle === "completed" && r.wrap_state === "pending";
    const [at, id] = (input.cursor ?? "").split(".");
    const list = rows
      .filter((r) => input.checked_off === undefined || pending(r) === input.checked_off)
      .sort(newestFirst)
      .filter(
        (r) =>
          input.cursor === undefined ||
          (r.finished_at ?? 0) < Number(at) ||
          ((r.finished_at ?? 0) === Number(at) && r.id < (id ?? "")),
      );
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    return Promise.resolve({
      rows: page as Awaited<ReturnType<FinishedRead>>["rows"],
      ...(list.length > limit && last !== undefined
        ? { cursor: `${String(last.finished_at)}.${last.id}` }
        : {}),
    });
  };
  return { read, reads };
}

async function readAll(read: FinishedRead, limit: number): Promise<string[]> {
  const source = completedSource(read);
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const page = await source({ after, limit });
    seen.push(...page.rows.map((r) => r.ref));
    after = page.next;
  } while (after !== undefined);
  return seen;
}

const shown = (groups: ReturnType<typeof completedGroups>) =>
  groups.map((g) => [g.label ?? g.title, g.sections[0]?.tasks.map((t) => t.ref)]);

describe("[A5.3.5.web.completed] Completed: the source over the read of finished tasks, and the groups", () => {
  test("the checked-off part whole first, then the rest, a page crossing from one to the other", async () => {
    const rows = [
      done("C-1", "2026-11-11", "pending"),
      done("C-2", "2026-10-02", "pending"),
      ...Array.from({ length: 60 }, (_, i) =>
        done(`D-${String(i)}`, `2026-11-${String((i % 11) + 1).padStart(2, "0")}`),
      ),
    ];
    const { read, reads } = fakeRead(rows);
    const source = completedSource(read);
    const first = await source({ after: undefined, limit: 50 });
    expect(first.rows.slice(0, 2).map((r) => r.ref)).toEqual(["C-1", "C-2"]);
    expect(first.rows).toHaveLength(50);
    expect(reads.map((r) => [r.checked_off, r.limit])).toEqual([
      [true, 50],
      [false, 48],
    ]);
    const second = await source({ after: first.next, limit: 50 });
    expect(second.rows).toHaveLength(12);
    expect(second.next).toBeUndefined();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(62);
    // A refresh of many rows reads in pieces the service takes.
    reads.length = 0;
    expect((await source({ after: undefined, limit: 500 })).rows).toHaveLength(62);
    expect(reads.every((r) => r.limit <= 200)).toBe(true);
    // A cursor the source did not give reads nothing.
    expect((await source({ after: "nonsense", limit: 3 })).rows).toEqual([]);
  });

  test("every finished task stays reachable: thousands in one month, the checked off ones first", async () => {
    const rows: TaskRow[] = [];
    for (let i = 0; i < 1_200; i += 1) {
      rows.push(done(`C-${String(i)}`, `2026-11-0${String((i % 9) + 1)}`, "pending"));
    }
    for (let i = 0; i < 3_000; i += 1) {
      rows.push(done(`D-${String(i)}`, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`));
    }
    rows.push(done("X-1", "2026-10-15", "dropped"));
    const seen = await readAll(fakeRead(rows).read, 50);
    expect(seen).toHaveLength(4_201);
    expect(new Set(seen).size).toBe(4_201);
    expect(seen.slice(0, 1_200).every((ref) => ref.startsWith("C-"))).toBe(true);
    expect(seen).toContain("X-1");
  });

  test("Checked off first, then each month newest first; a dropped task in the month it was dropped", async () => {
    const rows = [
      done("M-3", "2026-11-12", "pending"),
      done("M-2", "2026-11-11"),
      done("M-1", "2026-11-10", "dropped"),
      done("M-4", "2026-09-03"),
      done("M-6", "2025-12-31", "dropped"),
    ];
    const page = await completedSource(fakeRead(rows).read)({ after: undefined, limit: 50 });
    expect(shown(completedGroups(page.rows, CLOCK))).toEqual([
      ["group.checkedOff", ["M-3"]],
      ["November", ["M-2", "M-1"]],
      ["September", ["M-4"]],
      ["December 2025", ["M-6"]],
    ]);
    // A row the feed reopened or deleted leaves at once; the next read agrees.
    const changed = rows.map((r) =>
      r.ref === "M-2" ? reopened(r) : r.ref === "M-4" ? { ...r, deleted_at: 1 } : r,
    );
    expect(shown(completedGroups(changed, CLOCK))).toEqual([
      ["group.checkedOff", ["M-3"]],
      ["November", ["M-1"]],
      ["December 2025", ["M-6"]],
    ]);
  });

  test("the expanded task stays where it was shown, or on top of its group when the rows do not hold it", () => {
    const rows = [done("M-1", "2026-11-10"), done("M-2", "2026-10-01"), done("M-5", "2026-10-03")];
    // A link named it: on top of its month.
    const linked = done("M-9", "2026-10-20");
    expect(shown(completedGroups(rows, CLOCK, { task: linked }))).toEqual([
      ["November", ["M-1"]],
      ["October", ["M-9", "M-2", "M-5"]],
    ]);
    // Reopened while expanded: it stays in its group, at its place, until it is collapsed.
    const open = reopened(rows[2]);
    expect(
      shown(
        completedGroups([rows[0], rows[1], open] as TaskRow[], CLOCK, {
          task: open,
          group: "c:2026-10",
          index: 1,
        }),
      ),
    ).toEqual([
      ["November", ["M-1"]],
      ["October", ["M-2", "M-5"]],
    ]);
    // Held and in the rows: once.
    expect(
      completedGroups(rows, CLOCK, { task: rows[0] as TaskRow }).flatMap(
        (g) => g.sections[0]?.tasks ?? [],
      ),
    ).toHaveLength(3);
    // The feed's row of a task completed again moves it to its new month.
    const again = { ...rows[1], finished_at: Date.UTC(2026, 10, 12, 9) } as TaskRow;
    expect(completedGroups([again], CLOCK).map((g) => g.title)).toEqual(["November"]);
  });
});
