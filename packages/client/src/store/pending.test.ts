import { describe, expect, test } from "vitest";
import { Pending } from "./pending.ts";
import type { TaskRow } from "./rows.ts";

const starred: TaskRow = {
  id: "t_1",
  ref: "M-1",
  title: "Fix appointment time zones",
  status: "open",
  inbox: false,
  lifecycle: "active",
  position: "a0",
  created_at: 1,
  version: 3,
  focus_on: "2026-11-10",
};

describe("[A5.3.15.web.overlay-clear] an overlay that clears fields", () => {
  test("unstarring clears focus_on at once, and the confirmed row returns when the write settles", () => {
    const pending = new Pending();
    const confirmed = new Map([[starred.id, starred]]);
    pending.add("r1", { tasks: [{ id: starred.id, set: {}, clear: ["focus_on"] }] });
    const shown = pending.view(confirmed).get(starred.id);
    expect(shown).toBeDefined();
    expect(shown && "focus_on" in shown).toBe(false);
    expect(shown?.title).toBe(starred.title);
    // The confirmed rows are never changed by an overlay.
    expect(confirmed.get(starred.id)).toBe(starred);
    expect(pending.refused("r1")).toBe(true);
    expect(pending.view(confirmed).get(starred.id)).toBe(starred);
  });

  test("a set and a clear in one overlay both apply", () => {
    const pending = new Pending();
    pending.add("r2", {
      tasks: [{ id: starred.id, set: { priority: 1 }, clear: ["focus_on"] }],
    });
    const shown = pending.view(new Map([[starred.id, starred]])).get(starred.id);
    expect(shown?.priority).toBe(1);
    expect(shown?.focus_on).toBeUndefined();
  });
});
