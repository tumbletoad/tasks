// @vitest-environment happy-dom
//
// The edit queue and the page's own leaving (edits.ts `pageGone`): the window's `pagehide` ends a
// wait behind another edit as not saved, a switch of tabs does not, and a `pageshow` from the
// back-forward cache lets the next wait run in turn again.
import { afterEach, describe, expect, test } from "vitest";
import { LiveStore } from "../store/store.ts";
import type { SnapshotMessage, TaskRow } from "../store/rows.ts";
import { FakeFrames } from "../../test/fake-frames.ts";
import { effortChange, priorityChange, statusChange, titleChange } from "./change.ts";
import { Edits } from "./edits.ts";

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

const leave = () => window.dispatchEvent(new Event("pagehide"));
const back = (persisted: boolean) =>
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

// Every test leaves the page shown: the leaving signal is the module's, shared by the file.
afterEach(() => {
  back(true);
});

describe("[A5.3.11.web.edit-queue] the page's own leaving ends a wait behind another edit, and only that", () => {
  test("a tab switch leaves the wait running; pagehide keeps the waiting edit as not saved; a page back from the cache waits in turn again", async () => {
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
    const sent: unknown[] = [];
    let answer: (value: unknown) => void = () => undefined;
    const update = (input: { set?: unknown }) => {
      sent.push(input.set);
      return new Promise((resolve) => (answer = resolve));
    };
    let requests = 0;
    const edits = new Edits({
      client: { task: { update } } as unknown as ConstructorParameters<typeof Edits>[0]["client"],
      write: (send, overlay) => store.write(send, overlay),
      asOf: () => store.asOf,
      failed: () => false,
      onChanges: (listener) => store.onChanges(listener),
      rowOf: () => TASK,
      newRequest: () => `rq-${String((requests += 1))}`,
    });
    const answered = (seq: number) => ({
      result: "updated",
      task: "M-1",
      fields: [],
      as_of: `1.${String(seq)}.01234567`,
      warnings: [],
    });

    edits.edit(TASK, titleChange("Oil the gate twice"));
    edits.edit(TASK, priorityChange(1));
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(sent).toHaveLength(1);
    expect(edits.unsaved("t_00001", "priority")).toBeUndefined();

    leave();
    await flush();
    expect(sent).toHaveLength(1);
    expect(edits.unsaved("t_00001", "priority")).toMatchObject({ reason: "failed" });

    // Back from the back-forward cache: the rename answers, and a new wait runs in its turn.
    back(true);
    answer(answered(11));
    await flush();
    edits.edit(TASK, effortChange("S"));
    edits.edit(TASK, statusChange("waiting"));
    await flush();
    expect(sent).toHaveLength(2);
    expect(edits.unsaved("t_00001", "status")).toBeUndefined();
    answer(answered(12));
    await flush();
    expect(sent.at(-1)).toEqual({ status: "waiting" });
    expect(edits.unsaved("t_00001", "status")).toBeUndefined();
  });
});
