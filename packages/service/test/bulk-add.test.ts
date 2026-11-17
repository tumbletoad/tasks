// An agent that fills a space with many tasks through its tools: what one call holds, a ticket
// two tasks share, the dates of work that existed before, refusals that say what to change, paging
// through a whole space and a second pass that adds nothing. A service in this process, fixture
// text and temporary folders only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toolCaller } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
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
/** What an agent reads back from a tool. */
async function tool(name: string, args: Json): Promise<string> {
  const result = await toolCaller({ ops: w.service.ops, context: { space: null }, conn: 1 })(
    name,
    args,
  );
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
      expect(third).toMatch(
        new RegExp(
          `^tasks\\.0: created [A-Z]+-\\d+ · sources\\.1 linked without its key, which ${held} holds$`,
          "mu",
        ),
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
});
