// The Trash's page source and groups (trash.ts) against a fake `task.trash`: one group per change,
// newest first, "Restore these" only for a change of several tasks, and the expanded task kept where
// it was shown, also once restored; the count of what agents moved there that the Trash has not shown.
import { describe, expect, test } from "vitest";
import { pageKept } from "../kept.ts";
import type { TaskRow } from "@ttasks/client/store";
import {
  keepTrashSeen,
  movedByOthers,
  trashGroups,
  trashSeen,
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

  const at = (iso: string, by: string, count: number): Removal => ({
    id: `op_${iso}`,
    at: `2026-11-24T${iso}:00.000Z`,
    by,
    count,
  });
  const fake = (pages: { rows: TrashedRow[]; cursor?: string }[]): TrashRead =>
    (() => Promise.resolve(pages.shift() ?? { rows: [] })) as unknown as TrashRead;

  test("the count is what others moved to the Trash after the newest removal it showed, read newest first; with none shown, all of it", async () => {
    const pages = () => [
      {
        rows: [
          row(1, at("14:00", "agent:claude-code:se_fixture", 2)),
          row(2, at("14:00", "agent:claude-code:se_fixture", 2)),
          row(3, at("13:00", "user", 1)),
        ],
        cursor: "7.3",
      },
      { rows: [row(4, at("12:00", "agent:unknown", 1)), row(5, at("10:00", "agent:x", 1))] },
    ];
    const read = pages();
    expect(await movedByOthers(fake(read), Date.parse("2026-11-24T11:00:00.000Z"))).toBe(3);
    expect(read).toEqual([]);
    expect(await movedByOthers(fake(pages()), undefined)).toBe(4);
  });

  test("what the Trash shows is seen: the newest removal's time, which never goes back when a newer one is restored", () => {
    const kept = pageKept();
    expect(trashSeen("sp_fixture", kept)).toBeUndefined();
    keepTrashSeen("sp_fixture", [], kept);
    expect(trashSeen("sp_fixture", kept)).toBeUndefined();
    keepTrashSeen(
      "sp_fixture",
      [row(1, at("14:00", "agent:x", 1)), row(2, at("13:00", "user", 1))],
      kept,
    );
    expect(trashSeen("sp_fixture", kept)).toBe(Date.parse("2026-11-24T14:00:00.000Z"));
    keepTrashSeen("sp_fixture", [row(2, at("13:00", "user", 1))], kept);
    expect(trashSeen("sp_fixture", kept)).toBe(Date.parse("2026-11-24T14:00:00.000Z"));
  });
});
