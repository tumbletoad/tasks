// An agent that fills a space with many tasks through its tools: what one call holds, a ticket
// two tasks share, the dates of work that existed before, refusals that say what to change, paging
// through a whole space and a second pass that adds nothing. A service in this process, fixture
// text and temporary folders only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI_NAME } from "@ttasks/brand";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { toolCaller } from "../src/mcp/index.ts";
import { localDate } from "@ttasks/contracts/day";
import { localTimeZone } from "../src/ops/dates.ts";
import { opCall, type Binding, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
/** A bridge of no launch, in the world's one space, as its bind settles it. */
const inSpace = (): Binding => ({ kind: "none", space: w.space, named: false });
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("bulk");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** An agent's shell: the agent audience and its limits, with structured results. */
const AGENT: Caller = { class: "cli-script", env: {} };

async function call(op: string, input: Json, caller: Caller = AGENT): Promise<Json> {
  return (await opCall(w.service.ops, caller, { op, input })) as Json;
}
async function refusal(op: string, input: Json, caller: Caller = AGENT): Promise<ErrorBody> {
  const error = await call(op, input, caller).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}
/** What an agent reads back from a tool. */
async function tool(name: string, args: Json): Promise<string> {
  const result = await toolCaller({
    ops: w.service.ops,
    context: { space: null },
    conn: 1,
    binding: inSpace(),
  })(name, args);
  return result.content[0].text;
}

let n = 0;
const rid = () => `fixture-bulk-${String((n += 1)).padStart(6, "0")}`;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

/** Text of `length` code points that takes three bytes each in UTF-8. */
const wide = (length: number, seed: string): string =>
  `${seed} ${"界".repeat(Math.max(0, length - seed.length - 1))}`;

/** Group names no two of which are close to each other. */
const WORDS = [
  "Harbor",
  "Quartz",
  "Meadow",
  "Violet",
  "Ember",
  "Glacier",
  "Tundra",
  "Saffron",
  "Orchid",
  "Copper",
  "Lantern",
  "Pebble",
  "Falcon",
  "Juniper",
  "Marble",
  "Nimbus",
  "Oxbow",
  "Pylon",
  "Rhubarb",
  "Sextant",
  "Thistle",
  "Tapioca",
  "Walrus",
  "Yarrow",
  "Zephyr",
  "Bramble",
  "Cobalt",
  "Dynamo",
  "Fennel",
  "Ravioli",
  "Hickory",
  "Indigo",
  "Kestrel",
  "Lupine",
  "Mantis",
];

/**
 * A draft that uses every field an agent may send at its longest: a new area and project of its
 * own, ten sources with keys, a log entry and a folder.
 */
function fullDraft(k: number, label: string, folder: string): Json {
  return {
    title: wide(200, `${label} ${String(k)}`),
    summary: wide(240, "Next"),
    area: `${label} ${WORDS[k] ?? ""}`,
    project: `${WORDS[k] ?? ""} work`,
    status: "waiting",
    priority: 2,
    effort: "M",
    due: "2027-01-24",
    waiting_on: wide(80, "Ops"),
    folder,
    context: wide(8_000, "Context"),
    log: wide(2_000, "Log"),
    sources: Array.from({ length: 10 }, (_, s) => ({
      key: `fixture:${label}-${String(k)}-${String(s)}`,
      kind: "ticket",
      title: wide(200, "Ticket"),
      who: wide(120, "Who"),
      url: `https://tickets.example.test/${label}/${String(k)}/${String(s)}/${"q".repeat(1_900)}`,
      at: "2026-11-02",
    })),
  };
}

describe("[A3.bulk.one-call] twenty-five full drafts fit in one call", () => {
  test(
    "add_tasks takes 25 drafts at every agent limit, and complete_task 10 full follow-ups",
    async () => {
      const folder = join(w.root, "work", "bulk");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const added = await call("task.add", {
        tasks: Array.from({ length: 25 }, (_, k) => fullDraft(k, "Full", folder)),
        request_id: rid(),
      });
      const rows = added["tasks"] as Json[];
      expect(rows).toHaveLength(25);
      expect(rows.every((row) => row["result"] === "created" && row["log_added"] === true)).toBe(
        true,
      );
      const done = await call("task.finish", {
        task: rows[0]?.["ref"],
        outcome: "Done.",
        follow_ups: Array.from({ length: 10 }, (_, k) => fullDraft(k, "Follow", folder)),
        base: await asOf(),
        request_id: rid(),
      });
      expect(done["result"]).toBe("completed");
      expect((done["follow_ups"] as Json[]).map((f) => f["result"])).toEqual(
        Array.from({ length: 10 }, () => "created"),
      );
    },
    LONG,
  );
});

/** A task's sources as get_task shows them: each key, or "-" for a plain link. */
async function sourceKeys(ref: unknown): Promise<string[]> {
  const got = await call("task.get", { task: ref });
  const task = got["task"] as Json;
  return (task["sources"] as Json[]).map((s) => (typeof s["key"] === "string" ? s["key"] : "-"));
}

describe("[A3.bulk.shared-key] a ticket two tasks share never swallows one of them", () => {
  test(
    "a draft with a key of its own is created and links the shared key without it; a second pass matches each",
    async () => {
      const ticket = { key: "jira:LUM-1042", kind: "ticket", title: "Clinic export" };
      const draft = (id: string, log?: string): Json => ({
        title: `Shared ticket work ${id}`,
        area: "Shared",
        ...(log === undefined ? {} : { log }),
        sources: [{ key: `planning:${id}`, kind: "doc", title: `Planning ${id}` }, ticket],
      });
      const first = await call("task.add", {
        tasks: [draft("s-1"), draft("s-2", "Seen in the export.")],
        request_id: rid(),
      });
      const [a, b] = first["tasks"] as Json[];
      const held = String(a?.["ref"]);
      expect(a).toMatchObject({ result: "created" });
      expect(b).toMatchObject({
        result: "created",
        log_added: true,
        held: [{ source: 1, held_by: held }],
      });
      expect(b?.["ref"]).not.toBe(held);
      expect(await sourceKeys(held)).toEqual(["planning:s-1", "jira:LUM-1042"]);
      expect(await sourceKeys(b?.["ref"])).toEqual(["planning:s-2", "-"]);
      // In a later call too, and the agent reads which source and who holds its key.
      const third = await tool("add_tasks", { tasks: [draft("s-3")], request_id: rid() });
      expect(third).toMatch(/^tasks\.0: created [A-Z]+-\d+ · 1 source linked without its key$/mu);
      expect(third).toMatch(
        new RegExp(`^tasks\\.0\\.sources\\.1: its key is held by ${held}$`, "mu"),
      );
      // A second pass: each draft is its own task again, and nothing is added.
      const again = await call("task.add", {
        tasks: [draft("s-1"), draft("s-2", "Seen in the export."), draft("s-3")],
        request_id: rid(),
      });
      const rows = again["tasks"] as Json[];
      expect(rows.map((t) => t["result"])).toEqual(["exists", "exists", "exists"]);
      expect(rows.map((t) => t["ref"]).slice(0, 2)).toEqual([held, b?.["ref"]]);
      expect(rows[2]?.["ref"]).not.toBe(held);
      // The shared ticket alone names the task that holds it.
      const alone = await call("task.add", {
        tasks: [{ title: "The ticket alone", sources: [ticket] }],
        request_id: rid(),
      });
      expect((alone["tasks"] as Json[])[0]).toMatchObject({ result: "exists", ref: held });
    },
    LONG,
  );

  test(
    "with many held keys in one call, the agent still reads every draft's reference",
    async () => {
      const shared = ["jira:MANY-1", "jira:MANY-2", "jira:MANY-3"];
      const text = await tool("add_tasks", {
        tasks: Array.from({ length: 25 }, (_, k) => ({
          title: `Held keys ${String(k)}`,
          area: "Shared",
          sources: [`planning:many-${String(k)}`, ...shared].map((key) => ({
            key,
            kind: "ticket",
            title: "Ticket",
          })),
        })),
        request_id: rid(),
      });
      const lines = text.split("\n");
      for (let k = 0; k < 25; k += 1) {
        expect(
          lines.some((l) => new RegExp(`^tasks\\.${String(k)}: created [A-Z]+-\\d+`, "u").test(l)),
        ).toBe(true);
      }
    },
    LONG,
  );
});

const USER: Caller = { class: "cli-interactive", env: {} };

/** A finished task's row in the Completed list, by its reference. */
async function finishedRow(ref: unknown): Promise<Json | undefined> {
  const rows = (await call("task.finished", { limit: 200 }, USER))["rows"] as Json[];
  return rows.find((row) => row["ref"] === ref);
}

/** When get_task says the task was created, and when its newest log entry was made. */
async function timesOf(ref: unknown): Promise<{ created: string; log: string | undefined }> {
  const task = (await call("task.get", { task: ref }))["task"] as Json;
  const log = task["log"] as Json[];
  return { created: String(task["created"]), log: log[0]?.["at"] as string | undefined };
}

describe("[A3.bulk.dates] work recreated from another tool keeps when it happened", () => {
  test(
    "add_tasks takes when a task was created, complete_task when it was done, add_entry when a log entry was made",
    async () => {
      const added = await call("task.add", {
        tasks: [
          { title: "Dated by day", area: "History", created: "2025-03-04" },
          { title: "Dated by instant", area: "History", created: "2025-03-04T14:05:00+01:00" },
        ],
        request_id: rid(),
      });
      const [byDay, byInstant] = added["tasks"] as Json[];
      const day = (await timesOf(byDay?.["ref"])).created;
      expect(localDate(Date.parse(day), localTimeZone())).toBe("2025-03-04");
      expect((await timesOf(byInstant?.["ref"])).created).toBe("2025-03-04T13:05:00.000Z");

      await call("task.finish", {
        task: byInstant?.["ref"],
        outcome: "Shipped in the old tool.",
        finished: "2025-04-01T10:00:00Z",
        base: await asOf(),
        request_id: rid(),
      });
      expect(await finishedRow(byInstant?.["ref"])).toMatchObject({
        completed_at: Date.parse("2025-04-01T10:00:00Z"),
        finished_at: Date.parse("2025-04-01T10:00:00Z"),
      });
      await call("entry.add", {
        task: byDay?.["ref"],
        kind: "evidence",
        text: "Measured in the old tool.",
        at: "2025-03-05",
        request_id: rid(),
      });
      const log = (await timesOf(byDay?.["ref"])).log;
      expect(localDate(Date.parse(String(log)), localTimeZone())).toBe("2025-03-05");

      // A second pass finds the task finished long ago by its key: nothing new.
      const keyed = {
        title: "Done long ago",
        area: "History",
        created: "2024-12-01",
        sources: [{ key: "planning:old-1", kind: "doc", title: "Old item" }],
      };
      const first = (await call("task.add", { tasks: [keyed], request_id: rid() }))[
        "tasks"
      ] as Json[];
      await call("task.finish", {
        task: first[0]?.["ref"],
        outcome: "Done.",
        finished: "2025-01-02",
        base: await asOf(),
        request_id: rid(),
      });
      const again = (await call("task.add", { tasks: [keyed], request_id: rid() }))[
        "tasks"
      ] as Json[];
      expect(again[0]).toMatchObject({
        result: "exists",
        ref: first[0]?.["ref"],
        lifecycle: "completed",
      });
    },
    LONG,
  );

  test("a time in the future, or one it cannot read, is refused at its field", async () => {
    const future = await refusal("task.add", {
      tasks: [{ title: "Not yet", created: "2999-01-01" }],
      request_id: rid(),
    });
    expect(future).toMatchObject({
      code: "invalid_input",
      data: { issues: [{ path: "tasks.0.created", message: "In the future" }] },
    });
    const unread = await refusal("task.add", {
      tasks: [{ title: "Someday", created: "last spring" }],
      request_id: rid(),
    });
    expect(unread).toMatchObject({
      data: { issues: [{ path: "tasks.0.created", message: "Not a date or an instant" }] },
    });
    // A day the calendar lacks is a typo, never the day after.
    for (const created of ["2025-02-30T12:00:00Z", "2025-04-31T08:00:00+02:00"]) {
      const typo = await refusal("task.add", {
        tasks: [{ title: "Typo", created }],
        request_id: rid(),
      });
      expect(typo).toMatchObject({
        data: { issues: [{ path: "tasks.0.created", message: "Not a date or an instant" }] },
      });
    }
    const note = await refusal("entry.add", {
      task: "M-1",
      kind: "note",
      text: "A note.",
      at: "2025-01-01",
      request_id: rid(),
    });
    expect(note).toMatchObject({ data: { issues: [{ path: "at" }] } });
  });
});

describe("[A3.bulk.refusals] a refusal says what to change", () => {
  const plain = (title: string): Json => ({ title, area: "Refusals" });

  test("a limit names the field, what it takes and what it got, in the words of the caller's face", async () => {
    const many = await tool("add_tasks", {
      tasks: Array.from({ length: 26 }, (_, k) => plain(`Plain ${String(k)}`)),
      request_id: rid(),
    });
    expect(many.split("\n")).toEqual([
      "error too_large: The input is over a limit.",
      "- tasks: At most 25 items, not 26",
    ]);
    const long = await tool("add_tasks", {
      tasks: [plain("Fine"), { ...plain("x".repeat(250)), summary: "y".repeat(300) }],
      request_id: rid(),
    });
    expect(long).toContain("- tasks.1.title: At most 200 characters, not 250");
    expect(long).toContain("- tasks.1.summary: At most 240 characters, not 300");
    const shell = await refusal("task.add", {
      tasks: Array.from({ length: 26 }, (_, k) => plain(`Plain ${String(k)}`)),
      request_id: rid(),
    });
    expect(shell.hint).toBe(`Run ${CLI_NAME} help add for the arguments.`);
    const id = await tool("add_tasks", { tasks: [plain("Fine")], request_id: "abc" });
    expect(id).toContain("- request_id: 16 to 64 characters from A-Z, a-z, 0-9, _ and -");
  });

  test("a status or effort the space lacks lists what it has, at the draft that sent it", async () => {
    const effort = await tool("add_tasks", {
      tasks: [plain("One"), { ...plain("Two"), effort: "2h" }, plain("Three")],
      request_id: rid(),
    });
    expect(effort.split("\n")).toEqual([
      "error invalid_input: Not an effort of this space. Use one of the space's efforts: S, M, L. Put another estimate in context.",
      "- tasks.1.effort: Not an effort of this space",
    ]);
    const status = await tool("add_tasks", {
      tasks: [{ ...plain("Delegated"), status: "delegated" }],
      request_id: rid(),
    });
    expect(status).toContain("Use one of the space's statuses: open, waiting, review, backlog.");
    expect(status).toContain("- tasks.0.status: Not a status of this space");
  });

  test("a base from elsewhere and a name close to another are said plainly, with the way out", async () => {
    const added = await call("task.add", { tasks: [plain("Based")], request_id: rid() });
    const ref = String((added["tasks"] as Json[])[0]?.["ref"]);
    const stale = await tool("complete_task", {
      task: ref,
      outcome: "Done.",
      base: "1.1.aaaaaaaa",
      request_id: rid(),
    });
    expect(stale).toContain(
      "The base is from another copy of the space, or from before it was restored: read again.",
    );
    const close = await tool("add_tasks", {
      tasks: [{ title: "Close", area: "Refusal" }],
      request_id: rid(),
    });
    expect(close).toContain(
      "If it is another one, create it first with organize action create, then use its name.",
    );
  });
});

describe("[A3.bulk.paging] an agent that pages through search sees every task once", () => {
  test(
    "a page holds what the tool's text shows, and its cursor goes on from the next row",
    async () => {
      const count = 130;
      for (let start = 0; start < count; start += 25) {
        await call("task.add", {
          tasks: Array.from({ length: Math.min(25, count - start) }, (_, k) => ({
            title: `Paging ${String(start + k)} ${"long words of a title ".repeat(8)}`.slice(
              0,
              200,
            ),
            area: "Paging",
          })),
          request_id: rid(),
        });
      }
      const seen: string[] = [];
      let text = await tool("search", { q: 'area:"Paging"', limit: 50 });
      for (let pages = 0; pages < 40; pages += 1) {
        expect(text).not.toContain("not shown");
        seen.push(...[...text.matchAll(/^([A-Z]+-\d+) · /gmu)].map((m) => m[1] ?? ""));
        const next = /with cursor "(c_[0-9a-z]+)"/u.exec(text)?.[1];
        if (next === undefined) break;
        text = await tool("search", { cursor: next });
      }
      expect(new Set(seen).size).toBe(count);
      expect(seen).toHaveLength(count);
    },
    LONG,
  );
});

describe("[A3.bulk.second-pass] a second pass adds nothing", () => {
  test("a draft's log entry that its matched task has already is not added again", async () => {
    const draft = (log: string): Json => ({
      title: "Logged once",
      area: "Passes",
      log,
      sources: [{ key: "planning:log-1", kind: "doc", title: "Logged item" }],
    });
    const first = (
      await call("task.add", { tasks: [draft("Evidence: the export matches.")], request_id: rid() })
    )["tasks"] as Json[];
    const ref = first[0]?.["ref"];
    const again = await tool("add_tasks", {
      tasks: [draft("Evidence: the export matches.")],
      request_id: rid(),
    });
    expect(again).toMatch(new RegExp(`^tasks\\.0: exists ${String(ref)} · by source key$`, "mu"));
    const logOf = async (): Promise<string[]> =>
      (((await call("task.get", { task: ref }))["task"] as Json)["log"] as Json[]).map((e) =>
        String(e["text"]),
      );
    expect(await logOf()).toEqual(["Evidence: the export matches."]);
    // New evidence is still added.
    const more = (
      await call("task.add", { tasks: [draft("Evidence: seen again.")], request_id: rid() })
    )["tasks"] as Json[];
    expect(more[0]).toMatchObject({ result: "exists", log_added: true });
    expect(await logOf()).toEqual(["Evidence: seen again.", "Evidence: the export matches."]);
  });
});

describe("[A3.bulk.small] the counts and warnings an agent checks its work by", () => {
  test("two drafts of one call with the same title in one group are a possible duplicate", async () => {
    const added = await call("task.add", {
      tasks: [
        { title: "Order printer toner", area: "Twins" },
        { title: "Order printer toner", area: "Twins" },
      ],
      request_id: rid(),
    });
    expect(added["warnings"]).toEqual([
      "Made 1 new area for names that matched none (a project, none in its area): tasks.0.area.",
      "tasks.1: possible duplicate of tasks.0 (same area, similar title)",
    ]);
  });

  test("a section says how many of its tasks an earlier section lists", async () => {
    await call("task.add", {
      tasks: [
        { title: "Waits and is due", area: "Waits", status: "waiting", due: "today" },
        { title: "Waits on a person", area: "Waits", status: "waiting", waiting_on: "Ops" },
      ],
      request_id: rid(),
    });
    const status = await call("space.status", { include: ["today", "waiting"] });
    const sections = status["sections"] as Json[];
    expect(sections[1]).toMatchObject({ name: "waiting", above: 1 });
    const text = await tool("status", { include: ["today", "waiting"] });
    expect(text).toMatch(/^waiting \(\d+ of \d+, 1 listed above\):$/mu);
  });
});
