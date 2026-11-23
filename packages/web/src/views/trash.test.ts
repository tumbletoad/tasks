// The Trash's page source and groups (trash.ts) against a fake `task.trash`: one group per change,
// newest first, "Restore these" only for a change of several tasks, and the expanded task kept where
// it was shown, also once restored.
import { describe, expect, test } from "vitest";
import type { TaskRow } from "../store/rows.ts";
import {
  trashGroups,
  trashSource,
  type Removal,
  type TrashedRow,
  type TrashRead,
} from "./trash.ts";

const removal = (id: string, count: number): Removal => ({
  id,
  at: "2026-11-23T14:02:00.000Z",
  by: "user",
  count,
});

const row = (n: number, removed: Removal | undefined, deleted = true): TrashedRow => ({
  id: `t_${String(n).padStart(26, "0")}`,
  ref: `M-${String(n)}`,
  title: `Fixture task ${String(n)}`,
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: "a0",
  created_at: 1,
  version: n,
  ...(deleted ? { deleted_at: 2 } : {}),
  ...(removed === undefined ? {} : { removed }),
});

const face = {
  title: (r: Removal) => `${r.by} moved ${String(r.count)}`,
  restore: (r: Removal) => ({ label: `Restore ${r.id}`, run: () => undefined }),
};

const shape = (groups: ReturnType<typeof trashGroups>) =>
  groups.map((g) => [
    g.key,
    g.title ?? "",
    g.action?.label ?? null,
    g.sections.flatMap((s) => s.tasks.map((t: TaskRow) => t.ref)),
  ]);

describe("[A5.trash.web] the Trash's groups and pages", () => {
  test("one group per change in the order read, with Restore these only for several tasks", () => {
    const big = removal("op_big", 2);
    const one = removal("op_one", 1);
    const groups = trashGroups([row(3, big), row(4, big), row(9, one)], face);
    expect(shape(groups)).toEqual([
      ["x:op_big", "user moved 2", "Restore op_big", ["M-3", "M-4"]],
      ["x:op_one", "user moved 1", null, ["M-9"]],
    ]);
  });

  test("the expanded task stays where it was shown when it is restored, and one a link named heads the list", () => {
    const big = removal("op_big", 3);
    const rows = [row(3, big), row(4, big), row(5, big)];
    // M-4, expanded second in its group, is restored: the page's read leaves it out, the live row
    // has no tombstone; it stays second until collapsed.
    const restored = row(4, undefined, false);
    const held = { task: restored, group: "x:op_big", index: 1 };
    expect(shape(trashGroups([rows[0] as TrashedRow, rows[2] as TrashedRow], face, held))).toEqual([
      ["x:op_big", "user moved 3", "Restore op_big", ["M-3", "M-4", "M-5"]],
    ]);
    // A link's task the pages read so far do not hold: on top.
    const linked = row(40, undefined);
    expect(shape(trashGroups(rows, face, { task: linked }))[0]).toEqual(["x:", "", null, ["M-40"]]);
  });

  test("the source reads on from the last page's cursor with the search's words, until the limit", async () => {
    const asked: unknown[] = [];
    const pages = [
      { rows: [row(1, removal("op_a", 1))], cursor: "9.1" },
      { rows: [row(2, removal("op_b", 1))], cursor: "8.2" },
    ];
    const read = ((input: unknown) => {
      asked.push(input);
      return Promise.resolve(pages.shift() ?? { rows: [] });
    }) as unknown as TrashRead;
    const page = await trashSource(read, "passport")({ after: undefined, limit: 2 });
    expect(page.rows.map((r) => r.ref)).toEqual(["M-1", "M-2"]);
    expect(page.next).toBe("8.2");
    expect(asked).toEqual([
      { limit: 2, q: "passport" },
      { limit: 1, cursor: "9.1", q: "passport" },
    ]);
  });
});
