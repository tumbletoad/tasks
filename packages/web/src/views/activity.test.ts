// The Activity screen's words, shapes and log of lines (activity.ts), against a fake
// `activity.list`: each thing a change touched in its own words, several things the same happened
// to as a count, a kind of change the table does not know as "changed" after its name, the log
// reading the newest lines, then older ones before the last and newer ones after the first, and
// once more when the feed is live again.
import { createIntl } from "react-intl";
import { describe, expect, test, vi } from "vitest";
import { PRODUCT_NAME, CLI_NAME } from "@ttasks/brand";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import type { Clock } from "../row/dates.ts";
import type { Changes } from "../store/store.ts";
import {
  ActivityLog,
  follow,
  shapeOf,
  wordsOf,
  type ActivityLine,
  type ActivityRead,
  type Target,
} from "./activity.ts";

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

let n = 0;
const task = (acts: Target["acts"], extra: Partial<Target> = {}): Target => {
  n += 1;
  return {
    kind: "task",
    id: `t_${String(n)}`,
    ref: `M-${String(n)}`,
    name: `Task ${String(n)}`,
    acts,
    ...extra,
  };
};

const line = (
  seq: number,
  targets: Target[] = [task([{ op: "task.complete" }])],
): ActivityLine => ({
  seq,
  at: clock.now,
  actor: "agent",
  by: "agent:codex",
  targets,
  count: targets.length,
  acts: [],
});

/** A line's shape with each target by its name. */
const read = (l: ActivityLine) => {
  const shape = shapeOf(l, say);
  switch (shape.kind) {
    case "none":
      return { none: shape.words };
    case "many":
      return {
        many: t("activity.many", { count: shape.count, of: shape.of }),
        words: shape.words,
        each: shape.each.map((s) => [s.target.name, s.words]),
      };
    case "one":
      return {
        one: [shape.main.target.name, shape.main.words],
        also: shape.also.map((s) => [s.words, s.target.name]),
      };
  }
};

describe("[A5.activity.web] the Activity screen's words and lines", () => {
  test("several fields set by one change are one line of words, each with its value", () => {
    const words = (acts: Target["acts"]) => wordsOf(task(acts), say);
    expect(
      words([
        { op: "task.patch", field: "priority", from: 2, to: 1 },
        { op: "task.patch", field: "due", from: null, to: "2026-12-03" },
      ]),
    ).toBe("priority P2 to P1, due 3 Dec");
    expect(words([{ op: "task.move", field: "grouping", from: "Home", to: "Portal" }])).toBe(
      "moved to Portal",
    );
    expect(words([{ op: "task.patch", field: "summary" }])).toBe("summary changed");
    expect(words([{ op: "task.patch", field: "waiting_on" }])).toBe("waiting details changed");
    expect(
      words([
        { op: "task.complete", field: "lifecycle" },
        { op: "task.complete", field: "wrap" },
      ]),
    ).toBe("completed");
  });

  test("the Inbox flag reads the right way, both ways", () => {
    const inbox = (to: boolean) =>
      wordsOf(task([{ op: "task.patch", field: "inbox", from: !to, to }]), say);
    expect(inbox(true)).toBe("back in the Inbox");
    expect(inbox(false)).toBe("out of the Inbox");
  });

  test("a finish that makes a follow-up: the task completed, and the follow-up named with it", () => {
    const done = task([{ op: "task.complete", field: "lifecycle" }], { name: "Renew the permit" });
    const next = task([{ op: "task.create" }, { op: "note.add" }], {
      name: "Book the appointment",
      created: true,
    });
    expect(read(line(1, [done, next]))).toEqual({
      one: ["Renew the permit", "completed"],
      also: [["follow-up added", "Book the appointment"]],
    });
  });

  test("tasks added by one change are a count, each with its own place", () => {
    const made = (name: string, to: string) =>
      task([{ op: "task.create", to }], { name, created: true });
    expect(read(line(1, [made("A", "Portal"), made("B", "Garden"), made("C", "Portal")]))).toEqual({
      many: "3 tasks",
      words: "added",
      each: [
        ["A", "added to Portal"],
        ["B", "added to Garden"],
        ["C", "added to Portal"],
      ],
    });
  });

  test("a change to a project names it; what the table does not know reads changed after its name", () => {
    const project = (acts: Target["acts"]): Target => ({
      kind: "project",
      id: "p_1",
      name: "Portal",
      acts,
    });
    expect(read(line(1, [project([{ op: "project.patch", field: "title" }])]))).toEqual({
      one: ["Portal", "renamed"],
      also: [],
    });
    expect(read(line(2, [project([{ op: "project.archive", field: "lifecycle" }])]))).toEqual({
      one: ["Portal", "archived"],
      also: [],
    });
    expect(read(line(3, [project([{ op: "project.paint" }])]))).toEqual({
      one: ["Portal", "changed"],
      also: [],
    });
    expect(
      read(line(4, [task([{ op: "task.patch", field: "ext.color", to: "red" }])])),
    ).toMatchObject({
      one: [expect.any(String), "changed"],
    });
    expect(read({ ...line(5, []), acts: [{ op: "pref.set" }] })).toEqual({
      none: "a setting changed",
    });
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

  test("a line missed while the connection was down comes when the feed is live again, with one read", async () => {
    let all = [line(1)];
    let fail = false;
    let reads = 0;
    const read: ActivityRead = (input) => {
      reads += 1;
      if (fail) return Promise.reject(new Error("offline"));
      const after = input.after ?? 0;
      return Promise.resolve({ lines: all.filter((l) => l.seq > after), more: false });
    };
    const changes = new Set<(c: Changes) => void>();
    const phases = new Set<() => void>();
    let phase = "live";
    const feed = {
      onChanges: (listener: (c: Changes) => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      subscribe: (listener: () => void) => {
        phases.add(listener);
        return () => phases.delete(listener);
      },
      getState: () => ({ phase }),
    };
    const setPhase = (to: string) => {
      phase = to;
      for (const listener of phases) listener();
    };
    const log = new ActivityLog(read);
    await log.start();
    const stop = follow(log, feed);

    // The feed brings an agent's change, and the read of its line fails.
    all = [line(2), ...all];
    fail = true;
    const agent = { actor: { kind: "agent", label: "agent:codex" } } as Changes["changes"][number];
    for (const listener of changes) listener({ changes: [agent], reset: false });
    await log.newer();
    expect(log.getState().lines.map((l) => l.seq)).toEqual([1]);

    // The connection drops and comes back with nothing new in the feed: the line comes.
    fail = false;
    setPhase("offline");
    const before = reads;
    const asked = vi.spyOn(log, "newer");
    setPhase("live");
    expect(asked).toHaveBeenCalledTimes(1);
    // Waits for that read: a read of newer lines asked while one waits is the same read.
    await log.newer();
    expect(log.getState().lines.map((l) => l.seq)).toEqual([2, 1]);
    expect(reads - before).toBe(1);
    // A notice that leaves the feed live asks nothing.
    setPhase("live");
    expect(asked).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("[A5.pages.web.activity] page lines in Activity", () => {
  const page = (acts: Target["acts"], extra: Partial<Target> = {}): Target => ({
    kind: "page",
    id: "pg_1b5f9k3p7t1x5c9h3m7r1w5a9e",
    ref: "M-180",
    name: "Time zone rules",
    acts,
    ...extra,
  });

  test("an agent's page edits read as what they did to the page, and pages made by one change are a count", () => {
    expect(wordsOf(page([{ op: "page.edit" }]), say)).toBe("text changed");
    expect(wordsOf(page([{ op: "page.append" }]), say)).toBe("text added");
    expect(wordsOf(page([{ op: "page.set", field: "title" }]), say)).toBe("renamed");
    expect(wordsOf(page([{ op: "page.set", field: "body" }]), say)).toBe("text changed");
    expect(wordsOf(page([{ op: "page.move", to: "Client work" }]), say)).toBe(
      "moved to Client work",
    );
    expect(wordsOf(page([{ op: "page.trash" }]), say)).toBe("moved to the Trash");
    const made = (name: string) =>
      page([{ op: "page.create", to: "Lumen Health" }], { name, created: true });
    expect(read(line(1, [made("A"), made("B")]))).toMatchObject({
      many: "2 pages",
      words: "added",
    });
  });
});
