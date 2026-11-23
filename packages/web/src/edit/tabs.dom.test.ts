// @vitest-environment happy-dom
//
// Try again in one tab while another tab of the space keeps a newer value of the same field
// (keep.ts on the browser's real storage): the retry never writes over that value, nor takes it
// away once it is decided.
import { PRODUCT_ID } from "@ttasks/brand";
import { beforeEach, describe, expect, test } from "vitest";
import { FakeFrames } from "../../test/fake-frames.ts";
import { LiveStore } from "../store/store.ts";
import type { SnapshotMessage, TaskRow } from "../store/rows.ts";
import { priorityChange } from "./change.ts";
import { Edits, type Unsaved } from "./edits.ts";
import { unsavedKeeper } from "./keep.ts";

const SPACE = { id: "sp_0123456789abcdefghjkmnpqrs", name: "Mira", ref_prefix: "M" };
const TASK: TaskRow = {
  id: "t_00001",
  ref: "M-1",
  title: "Oil the gate",
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: "p1",
  created_at: Date.UTC(2026, 10, 1),
  version: 1,
};
const NAME = `${PRODUCT_ID}.unsaved.${SPACE.id}.${TASK.id}.priority`;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** The priority the browser keeps for the task, as a control made it. */
const storedLevel = (): unknown => {
  const value = localStorage.getItem(NAME);
  if (value === null) return undefined;
  return (JSON.parse(value) as { source: { level: number } }).source.level;
};

const kept = (level: number): Unsaved => ({
  task: TASK.id,
  ref: TASK.ref,
  field: "priority",
  change: priorityChange(level),
  reason: "failed",
  base: "1.10.01234567",
});

beforeEach(() => {
  localStorage.clear();
});

describe("[A5.3.11.web.kept-edits] Try again never writes over or takes away another tab's newer value", () => {
  test("tab A retries P1 while tab B kept P3 for the field: P3 stays in the browser, during and after", async () => {
    unsavedKeeper(SPACE.id).save(new Map([[`${TASK.id}\u0000priority`, kept(1)]]));
    const store = new LiveStore({
      space: SPACE.id,
      frames: new FakeFrames(),
      onResnapshot: () => undefined,
    });
    const snapshot: SnapshotMessage = {
      type: "snapshot",
      space: SPACE,
      cursor: { epoch: 1, incarnation: "ai_0123456789abcdefghjkmnpq", seq: 10 },
      tasks: [TASK],
      areas: [],
      projects: [],
      instances: [],
    };
    store.push(snapshot);
    store.flush();
    let answer: (value: unknown) => void = () => undefined;
    const edits = new Edits({
      client: {
        task: { update: () => new Promise((resolve) => (answer = resolve)) },
      } as unknown as ConstructorParameters<typeof Edits>[0]["client"],
      write: (send, overlay) => store.write(send, overlay),
      asOf: () => store.asOf,
      failed: () => false,
      onChanges: (listener) => store.onChanges(listener),
      rowOf: () => TASK,
      newRequest: () => "rq-1",
      keeper: unsavedKeeper(SPACE.id),
    });
    expect(edits.unsaved(TASK.id, "priority")).toMatchObject({ change: { set: { priority: 1 } } });
    // Tab B keeps a newer value for the same field, then closes.
    unsavedKeeper(SPACE.id).save(new Map([[`${TASK.id}\u0000priority`, kept(3)]]));
    expect(storedLevel()).toBe(3);

    edits.apply(TASK.id, "priority");
    await flush();
    expect(storedLevel()).toBe(3);
    answer({ result: "updated", task: "M-1", fields: ["priority"], as_of: "1.11.01234567" });
    await flush();
    expect(storedLevel()).toBe(3);
  });
});
