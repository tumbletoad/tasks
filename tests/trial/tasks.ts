// The trial's twenty tasks, run in this order in one world, so task 9 sees task 2's work. Each has
// the request the agent is given, the counts it feeds (README: a to f), a check a script can make
// of what the agent left in the space, and the calls the stand-in agent makes for it. Task 15 is two
// runs at once, editing different passages of one page. Fixture text only.
import type { ToolCall } from "../../packages/runs/test/codex-server.ts";
import { livePages, pageOf, projectBrief, rid, taskText, type World } from "./world.ts";

export type Count = "a" | "b" | "c" | "d" | "e" | "f";

/** One call an agent made in a run, as the trial's call log keeps it: names and references only. */
export interface CallLine {
  readonly at: number;
  readonly instance: string | null;
  readonly tool: string;
  readonly target?: string;
  readonly task?: string;
  readonly action?: string;
  readonly scope?: string;
}

export interface Facts {
  readonly world: World;
  readonly task: { readonly id: string; readonly ref: string };
  /** The calls made while the run ran. */
  readonly calls: readonly CallLine[];
}

export interface Script {
  readonly world: World;
  readonly task: { readonly id: string; readonly ref: string };
  /** The space's as_of before the run: a scripted finish's base. */
  readonly base: string;
  /** The reference the next page made gets. */
  readonly next: string;
}

export interface TrialTask {
  /** Its number in the script: "1" to "20", and "15a", "15b" for the two runs at once. */
  readonly n: string;
  readonly title: string;
  readonly request: string;
  readonly counts: readonly Count[];
  /** Checks of what the run left: each true when it holds. */
  check(facts: Facts): Record<string, boolean>;
  /** What the stand-in agent calls, in order. */
  standIn(script: Script): ToolCall[];
}

const finish = (s: Script, outcome: string, library: string[] | "nothing reusable"): ToolCall => ({
  name: "complete_task",
  arguments: { outcome, library, base: s.base, request_id: rid() },
});
const getTask: ToolCall = { name: "get_task", arguments: {} };
const read = (target: string): ToolCall => ({ name: "read", arguments: { target } });
const edit = (target: string, old: string, words: string, why: string): ToolCall => ({
  name: "write_page",
  arguments: { action: "edit", target, old, new: words, why, request_id: rid() },
});
const create = (title: string, brief: string, body: string, why: string): ToolCall => ({
  name: "write_page",
  arguments: { action: "create", title, brief, body, why, request_id: rid() },
});

/** A date written as the area's page wants it, and none in the forms it forbids. */
const DATE_FORBIDDEN =
  /\b20[0-9]{2}-[01][0-9]-[0-3][0-9]\b|\b[0-3]?[0-9]\/[01]?[0-9]\/20[0-9]{2}\b/u;
const datesApplied = (text: string, wanted: readonly string[]): boolean =>
  wanted.every((d) => text.includes(d)) && !DATE_FORBIDDEN.test(text);

const readThe = (facts: Facts, ref: string): boolean =>
  facts.calls.some((c) => c.tool === "read" && c.target === ref);

/** The live pages whose text holds `words`, any case. */
const pagesWith = (world: World, ...words: string[]): number =>
  livePages(world).filter((p) =>
    words.every((w) => `${p.title}\n${p.brief}\n${p.body}`.toLowerCase().includes(w.toLowerCase())),
  ).length;

/** A task of rule (a): a line with dates, written as the area's page says, without being told. */
function dateTask(
  n: string,
  title: string,
  request: string,
  wanted: readonly string[],
  outcome: string,
): TrialTask {
  return {
    n,
    title,
    request,
    counts: ["a", "d"],
    check: (facts) => ({
      applied: datesApplied(taskText(facts.world, facts.task.id), wanted),
      read_area_page: readThe(facts, facts.world.pages.dates),
    }),
    standIn: (s) => [getTask, read(s.world.pages.dates), finish(s, outcome, "nothing reusable")],
  };
}

const EXPORT_ROW = "- `tz`: the clinic's time zone, an IANA name.";

export const TASKS: readonly TrialTask[] = [
  dateTask(
    "1",
    "Tell the clinic when December's visits run",
    "Write the one line we send the clinic about December's visits: the first is on 2026-12-03 " +
      "and the last on 2026-12-17. Put the line in the task's outcome.",
    ["3 Dec 2026", "17 Dec 2026"],
    "December's visits run from 3 Dec 2026 to 17 Dec 2026.",
  ),
  {
    n: "2",
    title: "Check the export columns against the clinic's file",
    request:
      "The clinic's export of 1 Dec came with this header line: visit_at,zone_id,amount_eur,clinic. " +
      "Check what we know about the export against it, and correct what is wrong.",
    counts: ["b", "c", "d"],
    check: ({ world }) => {
      const page = pageOf(world, world.pages.export)?.body ?? "";
      return {
        corrected_in_place: page.includes("zone_id") && !/`tz`/u.test(page),
        one_page_on_the_export: pagesWith(world, "visit_at") === 1,
      };
    },
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      edit(
        s.world.pages.export,
        EXPORT_ROW,
        "- `zone_id`: the clinic's time zone, an IANA name (the header of 1 Dec).",
        "the export's header names zone_id, not tz",
      ),
      finish(s, "The zone column is zone_id; the export page says so now.", [s.world.pages.export]),
    ],
  },
  {
    n: "3",
    title: "Record the test clinics",
    request:
      "We try every change of the sync on three clinics first: North, Harbour and Hill, in that " +
      "order. Make sure whoever works on this project next knows.",
    counts: ["c", "d"],
    check: ({ world }) => ({ kept_on_a_page: pagesWith(world, "North", "Harbour", "Hill") >= 1 }),
    standIn: (s) => [
      getTask,
      create(
        "Test clinics",
        "Which clinics a change of the sync is tried on first, in order",
        "## Order\n\n1. North\n2. Harbour\n3. Hill",
        "the order the team tries changes in",
      ),
      finish(s, "The test clinics and their order are on a page.", [s.next]),
    ],
  },
  dateTask(
    "4",
    "Draft the patient reminder for the moved visit",
    "Draft the reminder text for patients whose visit moved from 2026-12-08 to 2026-12-10. Put it " +
      "in the task's outcome.",
    ["8 Dec 2026", "10 Dec 2026"],
    "Your visit of 8 Dec 2026 moved to 10 Dec 2026, at the same time.",
  ),
  {
    n: "5",
    title: "Keep the new export column",
    request:
      "From the next export on, the clinic adds a column room: the room's number, as text. Keep " +
      "what we know about the export current.",
    counts: ["c", "d"],
    check: ({ world }) => ({
      on_the_export_page: (pageOf(world, world.pages.export)?.body ?? "").includes("room"),
      one_page_on_the_export: pagesWith(world, "visit_at") === 1,
    }),
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      edit(
        s.world.pages.export,
        "- `clinic`: the clinic's code.",
        "- `clinic`: the clinic's code.\n- `room`: the room's number, as text.",
        "the clinic adds the room from the next export",
      ),
      finish(s, "The export page lists the room column.", [s.world.pages.export]),
    ],
  },
  dateTask(
    "6",
    "Write the export line for the weekly report",
    "Write the line for this week's report: the export was late on 2026-11-30 and arrived on " +
      "2026-12-01.",
    ["30 Nov 2026", "1 Dec 2026"],
    "The export was late on 30 Nov 2026 and arrived on 1 Dec 2026.",
  ),
  {
    n: "7",
    title: "Note who to ask about exports",
    request:
      "The clinic's contact for exports is the export desk, extension 214, mornings only. Make " +
      "sure the next person can find that.",
    counts: ["c", "d"],
    check: ({ world }) => ({ kept_on_a_page: pagesWith(world, "214") >= 1 }),
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      edit(
        s.world.pages.export,
        "- `clinic`: the clinic's code.",
        "- `clinic`: the clinic's code.\n\n## Contact\n\nThe export desk, extension 214, mornings only.",
        "who to ask about an export",
      ),
      finish(s, "The export page names the export desk.", [s.world.pages.export]),
    ],
  },
  {
    n: "8",
    title: "Change the test clinics",
    request: "We no longer try changes on Hill; Bay takes its place, after Harbour.",
    counts: ["c", "d"],
    check: ({ world }) => {
      const pages = livePages(world).filter((p) => p.body.includes("Harbour"));
      return {
        changed_in_place:
          pages.length === 1 &&
          pages.every((p) => p.body.includes("Bay") && !p.body.includes("Hill")),
      };
    },
    standIn: (s) => {
      const clinics = livePages(s.world).find((p) => p.body.includes("Harbour"))?.ref ?? "";
      return [
        getTask,
        read(clinics),
        edit(clinics, "3. Hill", "3. Bay", "Bay replaces Hill"),
        finish(s, "Bay replaces Hill on the test clinics page.", [clinics]),
      ];
    },
  },
  {
    n: "9",
    title: "Write the query for local visit times",
    request:
      "Write the SQL that lists each visit's local time from the export table visits, and put it " +
      "in the task's outcome.",
    counts: ["b", "d"],
    check: (facts) => {
      const text = taskText(facts.world, facts.task.id);
      return {
        uses_the_corrected_column: text.includes("zone_id") && !/\btz\b/u.test(text),
        read_the_export_page: readThe(facts, facts.world.pages.export),
        one_page_on_the_export: pagesWith(facts.world, "visit_at") === 1,
      };
    },
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      finish(
        s,
        "SELECT visit_at AT TIME ZONE zone_id AS local_time FROM visits;",
        "nothing reusable",
      ),
    ],
  },
  dateTask(
    "10",
    "Tell the clinic when the next export is due",
    "Write the one line telling the clinic the next export is due on 2026-12-15.",
    ["15 Dec 2026"],
    "The next export is due on 15 Dec 2026.",
  ),
  {
    n: "11",
    title: "Prepare December's invoice lines",
    request:
      "Prepare the invoice lines for the December visits. How do we round the amounts? Say the " +
      "rule in the outcome.",
    counts: ["f", "c", "d"],
    check: (facts) => ({
      found_the_rule: /whole euros?/iu.test(taskText(facts.world, facts.task.id)),
      searched: facts.calls.some((c) => c.tool === "search"),
      put_on_a_page: pagesWith(facts.world, "whole euro") >= 1,
    }),
    standIn: (s) => [
      getTask,
      { name: "search", arguments: { q: "invoice rounding", scope: "library" } },
      { name: "search", arguments: { q: "rounded whole euros" } },
      create(
        "Invoicing",
        "How invoice amounts are rounded, as agreed with the clinic",
        `## Rounding\n\nRound each line to whole euros, half up; never round the total. Agreed with the clinic on 14 Nov 2026 (${s.world.tasks.get("sibling")?.ref ?? ""}).`,
        "the rounding was only in a finished task's log",
      ),
      finish(s, "Each line is rounded to whole euros, half up, never the total.", [s.next]),
    ],
  },
  {
    n: "12",
    title: "Keep the rule for empty amounts",
    request:
      "An export row whose amount_eur is empty is dropped, never counted as 0. Make sure that is known.",
    counts: ["c", "d"],
    check: ({ world }) => ({
      kept_on_a_page: pagesWith(world, "amount_eur", "dropped") >= 1,
      one_page_on_the_export: pagesWith(world, "visit_at") === 1,
    }),
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      edit(
        s.world.pages.export,
        "- `amount_eur`: the fee, in euros.",
        "- `amount_eur`: the fee, in euros. A row without one is dropped, never counted as 0.",
        "what happens to a row without an amount",
      ),
      finish(s, "The export page says a row without an amount is dropped.", [s.world.pages.export]),
    ],
  },
  dateTask(
    "13",
    "Say when the clinic was closed",
    "Write the line for the report: the clinic was closed from 2026-12-24 to 2026-12-26.",
    ["24 Dec 2026", "26 Dec 2026"],
    "The clinic was closed from 24 Dec 2026 to 26 Dec 2026.",
  ),
  {
    n: "14",
    title: "Which clinic do we test on second?",
    request:
      "Which clinic do we try a change on second? Answer in the task's outcome with its name.",
    counts: ["d"],
    check: (facts) => ({
      answered_from_the_library: taskText(facts.world, facts.task.id).includes("Harbour"),
    }),
    standIn: (s) => [
      getTask,
      { name: "search", arguments: { q: "test clinics", scope: "library" } },
      finish(s, "Harbour.", "nothing reusable"),
    ],
  },
  ...(["a", "b"] as const).map((half): TrialTask => ({
    n: `15${half}`,
    title:
      half === "a"
        ? "Add the backup to the release checklist"
        : "Add the release notes to the release checklist",
    request:
      half === "a"
        ? "Add 'Back up the export folder' to what we do before a release."
        : "Add 'Mail the clinic the release notes' to what we do after a release.",
    counts: ["e", "d"],
    check: ({ world }) => {
      const body = pageOf(world, world.pages.checklist)?.body ?? "";
      const after = body.indexOf("## After");
      const at = body.search(
        half === "a" ? /back up the export folder/iu : /mail the clinic the release notes/iu,
      );
      return { stands: at !== -1 && (half === "a" ? at < after : at > after) };
    },
    standIn: (s) => [
      getTask,
      read(s.world.pages.checklist),
      half === "a"
        ? edit(
            s.world.pages.checklist,
            "- Run the export on the test clinics.",
            "- Run the export on the test clinics.\n- Back up the export folder.",
            "a backup before every release",
          )
        : edit(
            s.world.pages.checklist,
            "- Check the first export of the day.",
            "- Check the first export of the day.\n- Mail the clinic the release notes.",
            "the clinic hears of every release",
          ),
      finish(s, "The checklist has the new step.", [s.world.pages.checklist]),
    ],
  })),
  dateTask(
    "16",
    "Tell the clinic when December's invoices go out",
    "Write the one line telling the clinic that December's invoices go out on 2027-01-05.",
    ["5 Jan 2027"],
    "December's invoices go out on 5 Jan 2027.",
  ),
  {
    n: "17",
    title: "Who do we ask about a late export?",
    request: "An export is late. Who do we ask, and when? Answer in the task's outcome.",
    counts: ["d"],
    check: (facts) => ({
      answered_from_the_library: taskText(facts.world, facts.task.id).includes("214"),
    }),
    standIn: (s) => [
      getTask,
      read(s.world.pages.export),
      finish(s, "The export desk, extension 214, in the morning.", "nothing reusable"),
    ],
  },
  {
    n: "18",
    title: "How are invoice amounts rounded?",
    request: "How are invoice amounts rounded? Answer in one line in the task's outcome.",
    counts: ["d"],
    check: (facts) => ({
      answered_from_the_library: /whole euros?/iu.test(taskText(facts.world, facts.task.id)),
    }),
    standIn: (s) => [
      getTask,
      { name: "search", arguments: { q: "rounding", scope: "library" } },
      finish(s, "Each line to whole euros, half up; never the total.", "nothing reusable"),
    ],
  },
  dateTask(
    "19",
    "Write the line about the format change",
    "Write the line for the report saying the export's format changed on 2026-12-01.",
    ["1 Dec 2026"],
    "The export's format changed on 1 Dec 2026.",
  ),
  {
    n: "20",
    title: "Give this project a brief",
    request:
      "Give this task's project a brief: one line on what a reader finds there. Then finish the task.",
    counts: ["c", "d"],
    check: ({ world }) => ({
      project_has_a_brief: projectBrief(world, world.projectId).length >= 20,
    }),
    standIn: (s) => [
      getTask,
      read(s.world.projectId),
      {
        name: "write_page",
        arguments: {
          action: "set",
          target: s.world.projectId,
          brief: "The clinic's weekly export, its invoices and the sync's releases",
          base: s.base,
          why: "the project had no brief",
          request_id: rid(),
        },
      },
      finish(s, "The project has a brief.", "nothing reusable"),
    ],
  },
];

/** The tasks of rule (a), by number: the date lines. */
export const DATE_TASKS = TASKS.filter((t) => t.counts.includes("a")).map((t) => t.n);
