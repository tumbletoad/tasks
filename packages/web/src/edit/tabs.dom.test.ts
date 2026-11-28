// @vitest-environment happy-dom
//
// Try again in one tab while another tab of the space keeps a newer value of the same field
// (unsent.ts on the browser's real storage): the retry never writes over that value, nor takes it
// away, whatever its outcome.
import { beforeEach, describe, expect, test } from "vitest";
import { FakeFrames } from "../../test/fake-frames.ts";
import { LiveStore } from "../store/store.ts";
import type { SnapshotMessage, TaskRow } from "@ttasks/client/store";
import { priorityChange } from "./change.ts";
import { Edits, type Unsaved } from "./edits.ts";
import { unsavedKeeper } from "../unsent.ts";

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

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** The priorities the browser keeps for the task, of every tab, as a control made them. */
const storedLevels = (): number[] =>
  Object.keys(localStorage)
    .filter((name) => name.includes(`.${SPACE.id}.${TASK.id}.priority`))
    .map((name) => JSON.parse(localStorage.getItem(name) ?? "") as { source: { level: number } })
    .map((kept) => kept.source.level)
    .sort();

const kept = (level: number): Unsaved => ({
  id: crypto.randomUUID(),
  task: TASK.id,
  ref: TASK.ref,
  field: "priority",
  change: priorityChange(level),
  reason: "failed",
  base: "1.10.01234567",
});

/** An error as the generated client throws it: a code and its data. */
const refusal = (code: string, data: Record<string, unknown>) =>
  Object.assign(new Error("refused"), { code, data });

const conflictOn = (value: number) =>
  refusal("conflict", {
    cause: "VERSION_CONFLICT",
    conflicts: [
      {
        task: "M-1",
        field: "priority",
        value,
        version: 11,
        by: "Codex",
        at: "2026-11-12T09:40:00Z",
      },
    ],
  });

/** Each outcome, and the priorities the browser keeps after it: P1 again when it was refused. */
const OUTCOMES: readonly (readonly [string, () => Promise<unknown>, readonly number[]])[] = [
  [
    "saved",
    () => Promise.resolve({ result: "updated", task: "M-1", fields: [], as_of: "1.11.01234567" }),
    [3],
  ],
  ["already there", () => Promise.reject(conflictOn(1)), [3]],
  ["failed", () => Promise.reject(refusal("internal", {})), [1, 3]],
  ["a conflict with another value", () => Promise.reject(conflictOn(2)), [1, 3]],
];

beforeEach(() => {
  localStorage.clear();
});

/** A store with the task, and a tab's edits on it whose updates wait for `answer()`. */
function tab(outcome: () => Promise<unknown>) {
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
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const sent: Record<string, unknown>[] = [];
  const edits = new Edits({
    client: {
      task: {
        update: (input: Record<string, unknown>) => {
          sent.push(input);
          return answered.then(outcome);
        },
      },
    } as unknown as ConstructorParameters<typeof Edits>[0]["client"],
    write: (send, overlay) => store.write(send, overlay),
    asOf: () => store.asOf,
    failed: () => false,
    onChanges: (listener) => store.onChanges(listener),
    rowOf: () => TASK,
    newRequest: () => "rq-1",
    keeper: unsavedKeeper(SPACE.id),
  });
  return { edits, answer, sent };
}

/** The names the browser keeps the task's priorities under. */
const storedNames = (): string[] =>
  Object.keys(localStorage)
    .filter((name) => name.includes(`.${SPACE.id}.${TASK.id}.priority`))
    .sort();

describe("[A5.3.11.web.kept-edits] Try again never writes over or takes away another tab's value", () => {
  test.each(OUTCOMES)(
    "tab A retries P1 while tab B kept P3 for the field: P3 stays in the browser, during and after an answer that it was %s",
    async (_, outcome, after) => {
      unsavedKeeper(SPACE.id).save(new Map([[`${TASK.id}\u0000priority`, kept(1)]]));
      const { edits, answer, sent } = tab(outcome);
      expect(edits.unsaved(TASK.id, "priority")).toMatchObject({
        change: { set: { priority: 1 } },
      });
      // Tab B keeps a newer value for the same field, then closes.
      unsavedKeeper(SPACE.id).save(new Map([[`${TASK.id}\u0000priority`, kept(3)]]));
      expect(storedLevels()).toEqual([1, 3]);
      const names = storedNames();

      edits.apply(TASK.id, "priority");
      await flush();
      expect(storedNames()).toEqual(names);
      // The base the person made it at.
      expect(sent).toEqual([expect.objectContaining({ base: "1.10.01234567" })]);
      answer();
      await flush();
      expect(storedLevels()).toEqual(after);
      // Refused again, P1 is the same kept edit, with the base it was made at.
      if (after.length === 2) {
        expect(storedNames()).toEqual(names);
        expect(edits.unsaved(TASK.id, "priority")?.base).toBe("1.10.01234567");
      }
    },
  );

  test("two copies of a tab retry the same kept edit and both are refused: it is kept once", async () => {
    unsavedKeeper(SPACE.id).save(new Map([[`${TASK.id}\u0000priority`, kept(1)]]));
    const names = storedNames();
    const refused = () => Promise.reject(refusal("internal", {}));
    const first = tab(refused);
    const second = tab(refused);
    first.edits.apply(TASK.id, "priority");
    second.edits.apply(TASK.id, "priority");
    first.answer();
    second.answer();
    await flush();
    expect(storedLevels()).toEqual([1]);
    expect(storedNames()).toEqual(names);
  });
});
