// The live store holds a tree space's routines as the feed sends them: from the snapshot, moved on
// by each batch's routine row, gone once finished or in the Trash, and a task that became a routine
// leaves the tasks. Fixture data only.
import { describe, expect, test } from "vitest";
import { LiveCore } from "./core.ts";
import { messageOf, type BatchMessage, type RoutineRow, type SnapshotMessage } from "./rows.ts";

const SPACE = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const cursor = (seq: number) => ({ epoch: 1, incarnation: "ai_x", seq });

const routine = (patch: Partial<RoutineRow> = {}): RoutineRow => ({
  id: "t_routine00000000000000000000",
  ref: "M-7",
  kind: "routine",
  title: "Water the plants",
  parent: SPACE,
  position: "a",
  priority: 4,
  lifecycle: "active",
  rule: "FREQ=WEEKLY;BYDAY=SA",
  start: "2026-12-02",
  tz: "Europe/Amsterdam",
  due_date: "2026-12-05",
  paused: false,
  by: "you",
  entries: 0,
  version: 1,
  ...patch,
});

const snapshot = (routines: RoutineRow[], tasks: unknown[] = []): SnapshotMessage => {
  const read = messageOf({
    type: "snapshot",
    space: { id: SPACE, name: "Mira", ref_prefix: "M" },
    cursor: cursor(10),
    tasks,
    nodes: [{ id: SPACE, kind: "space", title: "Mira", state: "active" }],
    routines,
  });
  if (read?.type !== "snapshot") throw new Error("not a snapshot");
  return read;
};

const batch = (seq: number, row: RoutineRow): BatchMessage => ({
  type: "batch",
  space_id: SPACE,
  epoch: 1,
  incarnation: "ai_x",
  from: seq - 1,
  through: seq,
  events: [
    {
      seq,
      request_id: "r",
      actor: { kind: "human", label: "user" },
      kind: "ops",
      entities: [
        {
          type: "routine",
          id: row.id,
          task: row.id,
          row: { ...row },
          changed: ["open"],
          created: false,
        },
      ],
    },
  ],
});

describe("[A5.routines.store] the live store holds a tree space's routines", () => {
  test("from the snapshot, on by each batch, gone once finished or in the Trash", () => {
    const core = new LiveCore();
    core.receive(snapshot([routine()]));
    expect([...(core.publish()?.routines.values() ?? [])]).toEqual([routine()]);
    core.receive(batch(11, routine({ due_date: "2026-12-12", entries: 1, last_state: "done" })));
    expect(core.publish()?.routines.get(routine().id)).toMatchObject({
      due_date: "2026-12-12",
      entries: 1,
    });
    core.receive(batch(12, routine({ lifecycle: "completed" })));
    expect(core.publish()?.routines.size).toBe(0);
    core.receive(batch(13, routine()));
    core.receive(batch(14, routine({ deleted_at: 1, paused: true })));
    expect(core.publish()?.routines.size).toBe(0);
  });

  test("a task that became a routine leaves the tasks", () => {
    const core = new LiveCore();
    const task = {
      id: routine().id,
      ref: "M-7",
      title: "Water the plants",
      lifecycle: "active",
      status: "open",
      inbox: false,
      position: "a",
      created_at: 0,
      version: 1,
      parent: SPACE,
    };
    core.receive(snapshot([], [task]));
    expect(core.publish()?.tasks.has(task.id)).toBe(true);
    core.receive(batch(11, routine()));
    const held = core.publish();
    expect(held?.tasks.has(task.id)).toBe(false);
    expect(held?.routines.has(task.id)).toBe(true);
  });
});
