// `renderRow` as data (A5 3.6, A7 3.12 M5.03 Verify: "renderRow cases per view"): one case per view
// with the context A5 3.5 gives it, then each column's rules. The model holds message IDs; the
// tests format them with the page's own catalogue, so they read the words a person sees.
import { createIntl } from "react-intl";
import { describe, expect, test } from "vitest";
import { APP_NAME, CLI_NAME } from "@tasks/brand";
import type { Instance, Receipt } from "../api.ts";
import en from "../i18n/en.json" with { type: "json" };
import type { MessageId, Values } from "../i18n/intl.tsx";
import { sayMsg } from "./say.ts";
import type { TaskRow } from "../store/rows.ts";
import type { Clock } from "./dates.ts";
import { tileClick } from "./launch.ts";
import {
  contextFor,
  renderRow,
  type Msg,
  type RowInput,
  type RowModel,
  type RowView,
  type Grouping,
} from "./model.ts";

const intl = createIntl({
  locale: "en",
  messages: en,
  onError: (e) => {
    throw e;
  },
});
const t = (id: MessageId, values?: Values) =>
  intl.formatMessage({ id }, { product: APP_NAME, cli: CLI_NAME, ...values });
const say = (m: Msg | undefined): string | undefined =>
  m === undefined ? undefined : sayMsg(t, m);

// Thursday 12 November 2026, 09:00 in Amsterdam: a fixed day for the tests.
const CLOCK: Clock = {
  today: "2026-11-12",
  now: Date.UTC(2026, 10, 12, 8, 0),
  timeZone: "Europe/Amsterdam",
  locale: "en",
};
const DAY = 86_400_000;
const daysAgo = (n: number) => CLOCK.now - n * DAY;

const CX: Instance = { key: "cx", label: "Codex · work", glyph: "Cx", ring: 6, route: "terminal" };
const CC: Instance = {
  key: "cc",
  label: "Claude Code · work",
  glyph: "Cc",
  ring: 2,
  route: "terminal",
};

let next = 0;
function task(fields: Partial<TaskRow> & { title: string }): TaskRow {
  next += 1;
  return {
    id: `t_${String(next)}`,
    ref: `M-${String(next)}`,
    status: "open",
    inbox: false,
    lifecycle: "active",
    position: "a0",
    created_at: daysAgo(1),
    version: 1,
    ...fields,
  };
}

const BRIGHTSIDE = { area: { title: "Brightside Bikes", slot: 2 } };
const LUMEN = { area: { title: "Lumen", slot: 1 }, project: { title: "Lumen Health" } };

function row(t: TaskRow, extra: Partial<RowInput> = {}): RowInput {
  return { task: t, instances: [CX, CC], receipts: [], ...extra };
}

const ctx = (view: RowView, grouping: Grouping) => contextFor(view, grouping, CLOCK);

/** What a person reads off a row: its words, column by column. */
function read(model: RowModel) {
  return {
    title: model.title,
    chip: say(model.chip?.text),
    prefix: model.prefix?.text,
    dot: model.prefix?.slot,
    summary: model.summary,
    due: say(model.due?.text),
    tone: model.due?.tone,
    age: say(model.age?.text),
    priority: say(model.priority?.text),
    starred: model.starred,
    tile: model.launch.state,
    glyph: model.launch.instance?.glyph,
    description: model.description.map(say),
  };
}

describe("[A5.3.6.web.render-row] renderRow, one case per view", () => {
  test("Today mixes areas: the summary line starts with the area dot and the project", () => {
    const release = task({
      title: "Release 2.4 to the app stores",
      summary: "Build, upload and fill in the release notes",
      priority: 1,
      due_date: "2026-11-17",
      created_at: daysAgo(6),
    });
    expect(read(renderRow(row(release, BRIGHTSIDE), ctx("today", "flat")))).toEqual({
      title: "Release 2.4 to the app stores",
      chip: undefined,
      prefix: "Brightside Bikes",
      dot: 2,
      summary: "Build, upload and fill in the release notes",
      due: "Tue 17",
      tone: "soon",
      age: "6d",
      priority: "P1",
      starred: false,
      tile: "ready",
      glyph: "Cx",
      description: [
        "Brightside Bikes",
        "due Tuesday 17 November",
        "priority 1",
        "created Friday 6 November",
      ],
    });
    // A project's name stands for its area on the summary line.
    const sync = renderRow(
      row(task({ title: "Check the CSV columns" }), LUMEN),
      ctx("today", "flat"),
    );
    expect(sync.prefix).toEqual({ slot: 1, text: "Lumen Health" });
  });

  test("Today: a waiting task carries its person's chip and its follow-up day in indigo", () => {
    const photos = task({
      title: "New product photos",
      status: "waiting",
      waiting_on: "Tom Haas",
      planned_for: "2026-11-16",
      priority: 4,
    });
    const r = read(renderRow(row(photos, BRIGHTSIDE), ctx("today", "flat")));
    expect(r.chip).toBe("Tom Haas");
    expect(r.due).toBe("Mon 16");
    expect(r.tone).toBe("follow_up");
    expect(r.priority).toBeUndefined();
    expect(r.description).toEqual([
      "Brightside Bikes",
      "waiting on Tom Haas",
      "planned for Monday 16 November",
      "created Wednesday 11 November",
    ]);
  });

  test("Inbox: a capture without an area has no prefix, its age reads today", () => {
    const capture = task({
      title: "Call the plumber",
      inbox: true,
      created_at: CLOCK.now - 3_600_000,
    });
    const r = read(renderRow(row(capture), ctx("inbox", "flat")));
    expect(r).toMatchObject({ prefix: undefined, chip: undefined, due: undefined, age: "today" });
    expect(r.description).toEqual(["created Thursday 12 November"]);
  });

  test("Open, under area headings: no prefix and no chip; a star from an earlier day still shows", () => {
    const fix = task({ title: "Fix appointment time zones", focus_on: "2026-11-10", priority: 2 });
    const r = read(renderRow(row(fix, LUMEN), ctx("open", "area")));
    expect(r).toMatchObject({ prefix: undefined, chip: undefined, starred: true, priority: "P2" });
    expect(r.description).toEqual(["priority 2", "created Wednesday 11 November", "starred"]);
    // A star for a later day is not on yet (A5 3.4: the star shows from its day).
    const later = renderRow(
      row(task({ title: "Later", focus_on: "2026-11-13" })),
      ctx("open", "area"),
    );
    expect(later.starred).toBe(false);
  });

  test("Waiting, under person labels: no chip, the due column shows the follow-up day", () => {
    const photos = task({
      title: "New product photos",
      status: "waiting",
      waiting_on: "Tom Haas",
      planned_for: "2026-11-16",
      due_date: "2026-11-20",
    });
    const r = read(renderRow(row(photos, BRIGHTSIDE), ctx("waiting", "person")));
    expect(r).toMatchObject({
      chip: undefined,
      due: "Mon 16",
      tone: "follow_up",
      prefix: "Brightside Bikes",
    });
  });

  test("Waiting: the age is the time spent waiting, from when the wait began", () => {
    const photos = task({
      title: "New product photos",
      status: "waiting",
      waiting_on: "Tom Haas",
      created_at: daysAgo(100),
    });
    const model = renderRow(
      row(photos, { ...BRIGHTSIDE, waitingSince: daysAgo(3) }),
      ctx("waiting", "person"),
    );
    expect(say(model.age?.text)).toBe("3d");
    expect(say(model.age?.tip)).toBe("Waiting since Monday 9 November");
    expect(model.description.map(say)).toContain("waiting since Monday 9 November");
    // Other views keep the task's own age.
    const open = renderRow(
      row(photos, { ...BRIGHTSIDE, waitingSince: daysAgo(3) }),
      ctx("today", "flat"),
    );
    expect(say(open.age?.text)).toBe("3mo");
    // Until the page gets the wait's start, the Waiting row says plainly that it shows the creation.
    const unknown = renderRow(row(photos, BRIGHTSIDE), ctx("waiting", "person"));
    expect(say(unknown.age?.tip)).toBe("Created Tuesday 4 August");
  });

  test("Waiting without person labels: the person's chip stays", () => {
    const photos = task({ title: "New product photos", status: "waiting", waiting_on: "Tom Haas" });
    const model = renderRow(row(photos, BRIGHTSIDE), ctx("waiting", "area"));
    expect(say(model.chip?.text)).toBe("Tom Haas");
    expect(model.chip?.person).toBe(true);
    // A waiting task with nobody named: the status view already says waiting.
    const nobody = renderRow(row(task({ title: "X", status: "waiting" })), ctx("waiting", "area"));
    expect(nobody.chip).toBeUndefined();
  });

  test("Review: flat, mixed areas, no Review chip", () => {
    const docs = task({ title: "Agent finished the docs migration, check it", status: "review" });
    const r = read(renderRow(row(docs, LUMEN), ctx("review", "flat")));
    expect(r).toMatchObject({ chip: undefined, prefix: "Lumen Health", dot: 1 });
  });

  test("Backlog, under area headings: nothing the headings say", () => {
    const later = task({ title: "Release 1.9 with structured fields", status: "backlog" });
    const r = read(renderRow(row(later, LUMEN), ctx("backlog", "area")));
    expect(r).toMatchObject({ chip: undefined, prefix: undefined });
  });

  test("An area view, under project labels: status chips on rows that are not open", () => {
    const area = ctx("area", "project");
    const chips = ["open", "waiting", "review", "backlog", "someday"].map((status) =>
      say(renderRow(row(task({ title: status, status }), LUMEN), area).chip?.text),
    );
    expect(chips).toEqual([undefined, "Waiting", "Review", "Backlog", "someday"]);
    const r = renderRow(row(task({ title: "x", status: "review" }), LUMEN), area);
    expect(r.prefix).toBeUndefined();
    expect(r.chip?.kind).toBe("review");
  });

  test("an area view without project labels names the project on the summary line, without a dot", () => {
    const r = renderRow(row(task({ title: "x" }), LUMEN), ctx("area", "flat"));
    expect(r.prefix).toEqual({ text: "Lumen Health" });
  });

  test("Inbox and Review: the view's move out of it is a visible button on the row", () => {
    const capture = task({ title: "Call the plumber", inbox: true });
    expect(renderRow(row(capture), ctx("inbox", "flat")).move).toEqual({
      kind: "triage",
      text: { id: "fact.moveToOpen" },
    });
    const docs = task({ title: "Check the docs", status: "review" });
    const back = renderRow(row(docs, LUMEN), ctx("review", "flat")).move;
    expect([back?.kind, say(back?.text)]).toEqual(["reopen", "Back to open"]);
    // Elsewhere, and on a finished task, no such button.
    expect(renderRow(row(docs, LUMEN), ctx("area", "project")).move).toBeUndefined();
    expect(renderRow(row(capture), ctx("today", "flat")).move).toBeUndefined();
    const done = task({ title: "Done", inbox: true, lifecycle: "completed" });
    expect(renderRow(row(done), ctx("inbox", "flat")).move).toBeUndefined();
  });

  test("Completed: the completion date in the due column, no age and no priority", () => {
    const lease = task({
      title: "Sign the lease",
      lifecycle: "completed",
      status: "review",
      priority: 1,
      due_date: "2026-11-01",
      created_at: daysAgo(40),
      completed_at: Date.UTC(2026, 10, 10, 9),
    });
    const r = read(renderRow(row(lease, LUMEN), ctx("completed", "flat")));
    expect(r).toMatchObject({
      due: "10 Nov",
      tone: "done",
      chip: undefined,
      age: undefined,
      priority: undefined,
      prefix: "Lumen Health",
    });
    expect(r.description).toEqual(["Lumen Health", "completed Tuesday 10 November"]);
    // A dropped task keeps no completion time: the day it was dropped, and its box says so.
    const dropped = renderRow(
      row(task({ title: "x", lifecycle: "archived", finished_at: Date.UTC(2026, 10, 12, 9) })),
      ctx("completed", "flat"),
    );
    expect([say(dropped.due?.text), say(dropped.due?.tip), say(dropped.done)]).toEqual([
      "Today",
      "Dropped Thursday 12 November",
      "Dropped: x",
    ]);
    expect(dropped.description.map(say)).toEqual(["dropped Thursday 12 November"]);
    // A row found by a search carries the day only.
    const found = renderRow(
      row(task({ title: "x", lifecycle: "completed", completed_on: "2026-11-12" })),
      ctx("completed", "flat"),
    );
    expect([say(found.due?.text), say(found.due?.tip)]).toEqual([
      "Today",
      "Completed Thursday 12 November",
    ]);
  });

  test("Completed says how a task ended where the summary goes; other views keep the summary", () => {
    const shipped = task({
      title: "Fix the report",
      summary: "Check the March totals",
      lifecycle: "completed",
      ending: "Shipped the fix.",
    });
    expect(renderRow(row(shipped), ctx("completed", "flat"))).toMatchObject({
      ending: "Shipped the fix.",
      summary: "Check the March totals",
    });
    expect(renderRow(row(shipped), ctx("today", "flat")).ending).toBeUndefined();
    const plain = task({ title: "x", summary: "Next step", lifecycle: "completed" });
    expect(renderRow(row(plain), ctx("completed", "flat")).ending).toBeUndefined();
  });

  test("Agents: mixed areas and statuses, so the prefix and the chips show", () => {
    const docs = task({ title: "Check the docs", status: "review" });
    const r = read(renderRow(row(docs, LUMEN), ctx("agents", "flat")));
    expect(r).toMatchObject({ chip: "Review", prefix: "Lumen Health", dot: 1 });
  });
});

describe("[A5.3.6.web.row-columns] renderRow's columns", () => {
  const due = (fields: Partial<TaskRow>, view: RowView = "open") => {
    const model = renderRow(row(task({ title: "t", ...fields })), ctx(view, "area"));
    return { text: say(model.due?.text), tone: model.due?.tone, tip: say(model.due?.tip) };
  };

  test("due: late, today, tomorrow, within six days, later, another year; never colour alone", () => {
    expect(due({ due_date: "2026-11-10" })).toEqual({
      text: "2d late",
      tone: "late",
      tip: "Due Tuesday 10 November",
    });
    expect(due({ due_date: "2026-11-12" }).text).toBe("Today");
    expect(due({ due_date: "2026-11-13" }).text).toBe("Tomorrow");
    expect(due({ due_date: "2026-11-14" })).toMatchObject({ text: "Sat 14", tone: "soon" });
    expect(due({ due_date: "2026-11-18" })).toMatchObject({ text: "Wed 18", tone: "soon" });
    expect(due({ due_date: "2026-11-19" })).toMatchObject({ text: "19 Nov", tone: "later" });
    expect(due({ due_date: "2027-01-12" })).toEqual({
      text: "12 Jan 2027",
      tone: "later",
      tip: "Due Tuesday 12 January 2027",
    });
  });

  test("a timed due shows its time today and its day otherwise, in the viewer's zone", () => {
    // 10:30 in Amsterdam is 09:30 UTC.
    const at = Date.UTC(2026, 10, 12, 9, 30);
    expect(due({ due_at: at, due_tz: "Europe/Amsterdam" })).toEqual({
      text: "10:30",
      tone: "soon",
      tip: "Due Thursday 12 November, 10:30",
    });
    expect(due({ due_at: at - 3 * 3_600_000 }).tone).toBe("late");
    expect(due({ due_at: at + 2 * DAY }).text).toBe("Sat 14");
    // 23:30 UTC on the 12th is already the 13th in Amsterdam.
    expect(due({ due_at: Date.UTC(2026, 10, 12, 23, 30) }).text).toBe("Tomorrow");
  });

  test("without a due date a planned day shows muted, or indigo on a waiting row", () => {
    expect(due({ planned_for: "2026-11-16" })).toMatchObject({ text: "Mon 16", tone: "planned" });
    expect(due({ planned_for: "2026-11-16", status: "waiting" }).tone).toBe("follow_up");
    expect(due({ planned_for: "2026-11-16", due_date: "2026-11-13" }).text).toBe("Tomorrow");
    expect(due({}).text).toBeUndefined();
  });

  test("a day filter that implies the due date leaves the column empty", () => {
    const dayFilter = contextFor("today", "flat", CLOCK, ["due"]);
    const model = renderRow(row(task({ title: "t", due_date: "2026-11-14" })), dayFilter);
    expect(model.due).toBeUndefined();
    expect(model.description.map(say).join(" ")).not.toContain("due");
  });

  test("age: today, days, weeks up to eight, months, years", () => {
    const age = (days: number) =>
      say(
        renderRow(row(task({ title: "t", created_at: daysAgo(days) })), ctx("open", "area")).age
          ?.text,
      );
    expect([0, 1, 6, 7, 13, 62, 63, 95, 364, 365, 800].map(age)).toEqual([
      "today",
      "1d",
      "6d",
      "1w",
      "1w",
      "8w",
      "2mo",
      "3mo",
      "11mo",
      "1y",
      "2y",
    ]);
  });

  test("priority: P1 outlined, P2 and P3 muted, nothing for P4 or none", () => {
    const level = (priority?: number) =>
      renderRow(
        row(task({ title: "t", ...(priority === undefined ? {} : { priority }) })),
        ctx("open", "area"),
      ).priority?.level;
    expect([1, 2, 3, 4, undefined].map(level)).toEqual([1, 2, 3, undefined, undefined]);
  });

  test("the launch tile: the first pinned instance, its receipts, Copy only and the blocks", () => {
    const t = task({ title: "t" });
    const receipt = (state: Receipt["state"], instance = "cx"): Receipt => ({
      id: `ln_${state}`,
      reference: t.ref,
      instance,
      route: "terminal",
      state,
      reason: null,
      at: { prepared: 1 },
    });
    const tile = (extra: Partial<RowInput>) => renderRow(row(t, extra), ctx("open", "area")).launch;
    expect(tile({}).state).toBe("ready");
    expect(say(tile({}).tip)).toBe("Open in Codex · work");
    expect(tile({ receipts: [receipt("confirmed")] }).state).toBe("connected");
    // Another instance's receipt says nothing about the effective instance's tile.
    expect(tile({ receipts: [receipt("confirmed", "cc")] }).state).toBe("ready");
    expect(tile({ instances: [] }).state).toBe("copy_only");
    expect(tile({ launchBlock: { kind: "none" } }).state).toBe("none");
    expect(
      say(tile({ launchBlock: { kind: "unavailable", reason: "Not set up on this machine" } }).tip),
    ).toBe("Codex · work · Not set up on this machine");
    expect(say(tile({ launchBlock: { kind: "elsewhere", machine: "mira-desktop" } }).tip)).toBe(
      "Opens on mira-desktop",
    );
    expect(tileClick(tile({ instances: [] }).state)).toBe("copy");
    // A launch state that is not Ready is the last part of the description.
    const connected = renderRow(row(t, { receipts: [receipt("confirmed")] }), ctx("open", "area"));
    expect(say(connected.description.at(-1))).toBe("Connected · Codex · work");
  });

  test("sources: up to three with their own text and domain, then +N; only safe schemes link", () => {
    const sources = [
      {
        kind: "mail",
        text: "Wrong appointment times since Sunday · Ana Reyes",
        url: "mailto:ana@clinic.example",
      },
      {
        kind: "pr",
        text: "#388 Billing export v2",
        url: "https://git.example/lumen/portal/pull/388",
      },
      { kind: "chat", text: "#lumen-dev · Jonas Berg", url: "javascript:alert(1)" },
      { kind: "ticket", text: "LUM-14" },
      { kind: "link", text: "Spec" },
    ];
    const model = renderRow(row(task({ title: "t" }), { sources }), ctx("open", "area"));
    expect(model.sources.shown.map((s) => [s.kind, s.href, say(s.tip)])).toEqual([
      ["mail", "mailto:ana@clinic.example", "Wrong appointment times since Sunday · Ana Reyes"],
      ["pr", "https://git.example/lumen/portal/pull/388", "#388 Billing export v2 · git.example"],
      ["chat", undefined, "#lumen-dev · Jonas Berg"],
    ]);
    expect(say(model.sources.more)).toBe("+2");
  });

  test("the folder slot follows the place; empty without one", () => {
    const folder = (place?: RowInput["place"]) => {
      const f = renderRow(
        row(task({ title: "t" }), place === undefined ? {} : { place }),
        ctx("open", "area"),
      ).folder;
      return [f.state, say(f.tip)];
    };
    expect(folder()).toEqual(["empty", undefined]);
    expect(folder({ kind: "here" })).toEqual(["here", "Open folder"]);
    expect(folder({ kind: "missing" })).toEqual(["missing", "Folder not found on this machine"]);
    expect(folder({ kind: "elsewhere", machine: "mira-desktop" })).toEqual([
      "elsewhere",
      "On mira-desktop",
    ]);
    expect(folder({ kind: "work_folder" })).toEqual(["work_folder", `${APP_NAME} work folder`]);
  });

  test("the marker: the needs-input ring wins over the changed dot", () => {
    const t = task({ title: "t" });
    const changed = renderRow(
      row(t, {
        marker: {
          kind: "changed",
          by: "Codex",
          what: "Codex prepared the changelog",
          at: Date.UTC(2026, 10, 12, 7, 15),
        },
      }),
      ctx("open", "area"),
    );
    expect(changed.marker?.kind).toBe("changed");
    expect(say(changed.marker?.tip)).toBe("Codex prepared the changelog · 08:15");
    expect(say(changed.description.at(-1))).toBe("changed by Codex");
    const input = renderRow(
      row(t, { marker: { kind: "needs_input", by: "Codex" } }),
      ctx("open", "area"),
    );
    expect(input.marker?.kind).toBe("needs_input");
    expect(say(input.description.at(-1))).toBe("needs your input");
  });

  test("the row is a pure function of its own task and the view", () => {
    const t = task({ title: "Pure", due_date: "2026-11-14", priority: 2, summary: "Next" });
    const a = renderRow(row(t, LUMEN), ctx("today", "flat"));
    const b = renderRow(row({ ...t }, LUMEN), ctx("today", "flat"));
    expect(b).toEqual(a);
    expect(say(a.done)).toBe("Done: Pure");
  });
});
