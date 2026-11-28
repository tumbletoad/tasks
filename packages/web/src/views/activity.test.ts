// The Activity screen's words and its log of lines (activity.ts), against a fake `activity.list`:
// one line's acts in words, a kind of change the table does not know as "changed", and the log
// reading the newest lines, then older ones before the last and newer ones after the first.
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import type { Clock } from "../row/dates.ts";
import { ActivityLog, wordsOf, type ActivityLine, type ActivityRead } from "./activity.ts";

const intl = createIntl({
  locale: "en",
  messages: en,
  onError: (e) => {
    throw e;
  },
});
const t = (id: MessageId, values?: Values) =>
  intl.formatMessage({ id }, { product: PRODUCT_NAME, cli: CLI_NAME, ...values });
const clock: Clock = {
  today: "2026-11-28",
  now: Date.UTC(2026, 10, 28, 10, 0),
  timeZone: "Europe/Amsterdam",
  locale: "en-GB",
};
const say = { t, clock };

const line = (
  seq: number,
  acts: ActivityLine["acts"] = [{ op: "task.complete" }],
): ActivityLine => ({
  seq,
  at: clock.now,
  actor: "agent",
  by: "agent:codex",
  tasks: [{ id: "t_000000000000000000000000aa", ref: "M-1", title: "Fixture task" }],
  count: 1,
  acts,
});

describe("[A5.activity.web] the Activity screen's words and lines", () => {
  test("several fields set by one change are one line of words, each with its value", () => {
    expect(
      wordsOf(
        line(1, [
          { op: "task.patch", field: "priority", from: 2, to: 1 },
          { op: "task.patch", field: "due", from: null, to: "2026-12-03" },
        ]),
        say,
      ),
    ).toBe("priority P2 to P1, due 3 Dec");
    expect(
      wordsOf(line(2, [{ op: "task.move", field: "grouping", from: "Home", to: "Portal" }]), say),
    ).toBe("moved to Portal");
    expect(wordsOf(line(3, [{ op: "task.patch", field: "summary" }]), say)).toBe("summary changed");
  });

  test("an operation says what it did once, whatever fields it set; a create leaves out what came with it", () => {
    expect(
      wordsOf(
        line(1, [
          { op: "task.complete", field: "lifecycle" },
          { op: "task.complete", field: "wrap" },
        ]),
        say,
      ),
    ).toBe("completed");
    expect(wordsOf(line(2, [{ op: "task.create", to: "Portal" }, { op: "note.add" }]), say)).toBe(
      "added to Portal",
    );
    expect(wordsOf(line(3, [{ op: "task.delete", field: "deleted" }]), say)).toBe(
      "moved to the Trash",
    );
  });

  test("a kind of change the table does not know reads changed, and never fails", () => {
    expect(wordsOf(line(1, [{ op: "page.publish" }]), say)).toBe("changed");
    expect(wordsOf(line(2, [{ op: "task.patch", field: "ext.color", to: "red" }]), say)).toBe(
      "changed",
    );
    expect(wordsOf(line(3, []), say)).toBe("changed");
  });

  test("the log reads the newest lines, older ones before its last, newer ones after its first", async () => {
    // A space of 120 lines; the fake reads them as the service does, newest first.
    let all = Array.from({ length: 120 }, (_, i) => line(120 - i));
    const asked: Parameters<ActivityRead>[0][] = [];
    const read: ActivityRead = (input) => {
      asked.push(input);
      const limit = input.limit ?? 50;
      if (input.after !== undefined) {
        const after = input.after;
        const newer = all.filter((l) => l.seq > after).reverse();
        return Promise.resolve({
          lines: newer.slice(0, limit).reverse(),
          more: newer.length > limit,
        });
      }
      const before = input.before ?? Infinity;
      const older = all.filter((l) => l.seq < before);
      return Promise.resolve({ lines: older.slice(0, limit), more: older.length > limit });
    };
    const log = new ActivityLog(read);
    await log.start();
    expect(log.getState()).toMatchObject({ phase: "ready", more: true });
    expect(log.getState().lines.map((l) => l.seq)).toEqual(all.slice(0, 50).map((l) => l.seq));

    await log.older();
    await log.older();
    expect(log.getState().more).toBe(false);
    expect(log.getState().lines.map((l) => l.seq)).toEqual(all.map((l) => l.seq));

    // 60 lines come while the screen is open: all of them go on top, in order, none twice.
    all = [...Array.from({ length: 60 }, (_, i) => line(180 - i)), ...all];
    await Promise.all([log.newer(), log.newer()]);
    expect(log.getState().lines.map((l) => l.seq)).toEqual(all.map((l) => l.seq));
    expect(asked.filter((input) => input.after !== undefined)).toEqual([
      { after: 120, limit: 50 },
      { after: 170, limit: 50 },
    ]);
  });

  test("a failed first read says so and reads again; a failed read of newer lines keeps what is shown", async () => {
    let fail = true;
    const read: ActivityRead = () =>
      fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ lines: [line(1)], more: false });
    const log = new ActivityLog(read);
    await log.start();
    expect(log.getState().phase).toBe("failed");
    fail = false;
    await log.start();
    expect(log.getState()).toMatchObject({ phase: "ready", lines: [{ seq: 1 }] });
    fail = true;
    await log.newer();
    expect(log.getState()).toMatchObject({ phase: "ready", lines: [{ seq: 1 }] });
  });
});
