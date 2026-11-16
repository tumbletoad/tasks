// The quick capture's reading (parse.ts): each shortcut, the words that only look like one, a
// shortcut the person kept as text, and the view's own area.
import { describe, expect, test } from "vitest";
import { groupSuggestions, groupTyped, HERE_KEY, parseCapture, slugOf } from "./parse.ts";

/** Thursday 12 November 2026. */
const TODAY = "2026-11-12";
const AREAS = [
  { id: "a_work", title: "Client work" },
  { id: "a_home", title: "Home" },
  { id: "a_cafe", title: "Café" },
];
const PROJECTS = [
  { id: "p_lumen", title: "Lumen Health", area_id: "a_work" },
  { id: "p_garden", title: "Garden", area_id: "a_home" },
  { id: "p_repairs", title: "Repairs", area_id: "a_home" },
  { id: "p_repairs2", title: "Repairs", area_id: "a_cafe" },
];
const ctx = { today: TODAY, areas: AREAS, projects: PROJECTS };
const read = (text: string, more: Partial<Parameters<typeof parseCapture>[1]> = {}) =>
  parseCapture(text, { ...ctx, ...more });
const dueOf = (text: string) => read(text).draft?.due;

describe("[A5.3.13.web.capture] a quick capture reads its shortcuts and leaves the rest as the title", () => {
  test("dates: today, tomorrow, weekdays, next week, in N days, +3d, 20 nov and ISO", () => {
    expect(dueOf("Call the plumber today")).toBe(TODAY);
    expect(dueOf("Call the plumber tomorrow")).toBe("2026-11-13");
    // A weekday is the next one, today on that day.
    expect(dueOf("Water plants thu")).toBe(TODAY);
    expect(dueOf("Water plants fri")).toBe("2026-11-13");
    expect(dueOf("Water plants Monday")).toBe("2026-11-16");
    expect(dueOf("Water plants saturday")).toBe("2026-11-14");
    expect(dueOf("Plan the move next week")).toBe("2026-11-16");
    expect(dueOf("Renew the permit in 3 days")).toBe("2026-11-15");
    expect(dueOf("Renew the permit in 2 weeks")).toBe("2026-11-26");
    expect(dueOf("Renew the permit in 1 day")).toBe("2026-11-13");
    expect(dueOf("Renew the permit +3d")).toBe("2026-11-15");
    expect(dueOf("Renew the permit +2w")).toBe("2026-11-26");
    expect(dueOf("Send invoice 20 nov")).toBe("2026-11-20");
    expect(dueOf("Send invoice Nov 20")).toBe("2026-11-20");
    expect(dueOf("Send invoice 3rd december")).toBe("2026-12-03");
    // A day already past this year is next year's.
    expect(dueOf("Send invoice 2 jan")).toBe("2027-01-02");
    expect(dueOf("Send invoice 1 nov 2026")).toBe("2026-11-01");
    expect(dueOf("Send invoice 2026-12-24")).toBe("2026-12-24");
    expect(read("Send invoice 20 nov").title).toBe("Send invoice");
  });

  test("a lead word goes with its date, and only the first date applies", () => {
    const capture = read("Pay rent by fri and book the van 20 nov");
    expect(capture.draft?.due).toBe("2026-11-13");
    expect(capture.title).toBe("Pay rent and book the van 20 nov");
    expect(capture.chips[0]).toMatchObject({ kind: "due", text: "by fri" });
    expect(read("Due to the storm, check the roof").draft?.due).toBeUndefined();
  });

  test("words that only look like dates stay text", () => {
    for (const text of [
      "Clean the sun lounger",
      "Read the sat nav manual",
      "Ask tom about the roof",
      "Fix the wed page",
      "Review the may release",
      "Book 30 feb",
      "Meet at 11/12",
      "Order 20 novelties",
      "Plan in 3 weeksend",
      "Fix 2026-02-30 bug",
      "friday's notes",
    ]) {
      const capture = read(text);
      expect(capture.chips, text).toEqual([]);
      expect(capture.title, text).toBe(text);
    }
  });

  test("p1 to p3 set the priority, p4 none; other p words stay text", () => {
    expect(read("Fix the login p1").draft).toMatchObject({ title: "Fix the login", priority: 1 });
    expect(read("P2 Fix the login").draft?.priority).toBe(2);
    expect(read("Fix the login p3").draft?.priority).toBe(3);
    expect(read("Fix the login p4").draft?.priority).toBe(4);
    for (const text of ["Upgrade to p10", "Move mp3 files", "Tune p0 alerts", "p1x review"]) {
      expect(read(text).chips, text).toEqual([]);
    }
    // A second priority stays in the title.
    expect(read("p1 compare p2 plans").draft).toMatchObject({
      title: "compare p2 plans",
      priority: 1,
    });
  });

  test("#area and #area/project by name or slug, a project alone when it is the only one", () => {
    expect(read("Draft the brief #client-work").draft).toMatchObject({
      title: "Draft the brief",
      area: "Client work",
      inbox: false,
    });
    expect(read("Draft the brief #Client-Work/lumen-health").draft).toMatchObject({
      area: "Client work",
      project: "Lumen Health",
    });
    expect(read("Weed the beds #garden").draft).toMatchObject({ area: "Home", project: "Garden" });
    // An accent is matched without it.
    expect(read("Order beans #cafe").draft?.area).toBe("Café");
    // Two projects of that name: the text stays text.
    expect(read("Fix the tap #repairs").chips).toEqual([]);
    expect(read("Fix the tap #home/repairs").draft?.project).toBe("Repairs");
    for (const text of ["Close issue #3", "Fix #nowhere", "Ask #home/nowhere", "Tag #", "a#home"]) {
      const capture = read(text);
      expect(capture.chips, text).toEqual([]);
      expect(capture.title, text).toBe(text);
    }
  });

  test("@person waits on them; an address or a lone @ stays text", () => {
    expect(read("Contract signed @Ana").draft).toMatchObject({
      title: "Contract signed",
      status: "waiting",
      waiting_on: "Ana",
      inbox: false,
    });
    for (const text of ["Mail ana@example.com", "Meet @ noon", "Ping @, then"]) {
      expect(read(text).chips, text).toEqual([]);
    }
  });

  test("* alone stars the task; a star inside a word stays text", () => {
    expect(read("Book flights *").draft).toMatchObject({ title: "Book flights", focus: true });
    expect(read("Rate it 5* or more").chips).toEqual([]);
    expect(read("Fix the ** bold").chips).toEqual([]);
  });

  test("without an area or a person a capture goes to the Inbox; shortcuts alone give no task", () => {
    expect(read("Buy milk tomorrow p2").draft).toMatchObject({ inbox: true, due: "2026-11-13" });
    expect(read("Buy milk").draft).toEqual({ title: "Buy milk", inbox: true });
    expect(read("p1 tomorrow *").draft).toBeUndefined();
    expect(read("   ").draft).toBeUndefined();
  });

  test("a shortcut the person kept stays text, and only that one", () => {
    const first = read("Plan Monday standup p1");
    const due = first.chips.find((chip) => chip.kind === "due");
    expect(due?.key).toBe("due:monday");
    const kept = read("Plan Monday standup p1", { kept: new Set([due?.key ?? ""]) });
    expect(kept.title).toBe("Plan Monday standup");
    expect(kept.draft).toMatchObject({ priority: 1 });
    expect(kept.draft?.due).toBeUndefined();
    // A lead kept as text keeps its date with it.
    const by = read("Pay rent by fri", { kept: new Set(["due:by fri"]) });
    expect(by.title).toBe("Pay rent by fri");
    expect(by.chips).toEqual([]);
  });

  test("the view's area applies unless the text names another or the person turns it off", () => {
    const here = { area: "a_home", project: "p_garden" };
    expect(read("Weed the beds", { here }).draft).toMatchObject({
      area: "Home",
      project: "Garden",
      inbox: false,
    });
    expect(read("Weed the beds", { here }).chips[0]).toMatchObject({
      kind: "area",
      fromView: true,
    });
    expect(read("Draft the brief #client-work", { here }).draft).toMatchObject({
      area: "Client work",
    });
    expect(read("Draft the brief #client-work", { here }).draft?.project).toBeUndefined();
    expect(read("Weed the beds", { here, kept: new Set([HERE_KEY]) }).draft?.inbox).toBe(true);
  });

  test("chips keep the order of the text and say which words they took", () => {
    const capture = read("* Fix the sink tomorrow #home p2 @Jonas");
    expect(capture.chips.map((chip) => [chip.kind, chip.text])).toEqual([
      ["star", "*"],
      ["due", "tomorrow"],
      ["area", "#home"],
      ["priority", "p2"],
      ["waiting", "@Jonas"],
    ]);
    expect(capture.title).toBe("Fix the sink");
  });

  test("the area type-ahead finds what is typed at the caret", () => {
    expect(slugOf("Client work")).toBe("client-work");
    expect(groupTyped("Fix #ho", 7)).toEqual({ start: 4, typed: "#ho" });
    expect(groupTyped("Fix #ho now", 7)).toEqual({ start: 4, typed: "#ho" });
    expect(groupTyped("Fix #honow", 7)).toBeUndefined();
    expect(groupTyped("Fix it", 6)).toBeUndefined();
    expect(groupSuggestions("#ho", AREAS, PROJECTS).map((s) => s.insert)).toEqual(["#home"]);
    expect(groupSuggestions("#home/", AREAS, PROJECTS).map((s) => s.insert)).toEqual([
      "#home/garden",
      "#home/repairs",
    ]);
    expect(groupSuggestions("#ga", AREAS, PROJECTS).map((s) => s.insert)).toEqual(["#home/garden"]);
  });
});
