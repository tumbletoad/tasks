// What an agent's call meets for what a later step builds (contracts' later.ts): each row on a
// field is refused naming its step and writes nothing, whatever else the call holds. What an
// agent takes its base from never hides a person's change it was not shown. And a name that
// matched no area or project says that it made one. A service in this process.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, LATER, type ErrorBody } from "@ttasks/contracts";
import { renderResult, toolCaller } from "../src/mcp/index.ts";
import { opCall, type Binding, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("later");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** An agent's shell: the agent audience, with structured results. */
const AGENT: Caller = { class: "cli-script", env: {} };

let n = 0;
const rid = () => `fixture-later-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Json): Promise<Json> =>
  (await opCall(w.service.ops, AGENT, { op, input })) as Json;
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

/** The person at a terminal. */
const PERSON: Caller = { class: "cli-interactive", env: {} };

/** What an agent reads back from a tool, as a bridge of no launch in the world's space. */
async function tool(name: string, args: Json): Promise<string> {
  const binding: Binding = { kind: "none", space: w.space, named: false };
  const result = await toolCaller({
    ops: w.service.ops,
    context: { space: null },
    conn: 1,
    binding,
  })(name, args);
  return result.content[0].text;
}

const AS_OF = /as_of ([0-9]+\.[0-9]+\.[0-9a-z]{8})/u;

async function refusal(op: string, input: Json): Promise<ErrorBody> {
  const error = await call(op, input).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}

/** A call each entry would take, which a row's field then spoils. */
const CALLS: Readonly<Record<string, (base: string) => Json>> = {
  "task.add": () => ({ tasks: [{ title: "Fixture task" }], request_id: rid() }),
  "task.update": (base) => ({ task: "M-1", set: { summary: "Fixture" }, base, request_id: rid() }),
  "task.finish": (base) => ({ task: "M-1", outcome: "Fixture.", base, request_id: rid() }),
  "task.reopen": (base) => ({ task: "M-1", reason: "Fixture.", base, request_id: rid() }),
  "group.manage": () => ({ action: "create", path: "Fixture area", request_id: rid() }),
  "prefs.manage": () => ({ action: "get" }),
  "space.status": () => ({}),
};

/** What a field without a listed value is given. */
const GIVEN: Readonly<Record<string, unknown>> = {
  set: [{ key: "tasks.statuses", value: ["open"] }],
  remove_sources: ["jira:FIX-1"],
};

describe("[A3.3.3.mcp.later] what a later step builds", () => {
  test(
    "every listed field or value is refused naming its step, and nothing is written",
    { timeout: LONG },
    async () => {
      const rows = LATER.flatMap((row) => ("field" in row ? [row] : []));
      expect(rows.length).toBeGreaterThan(5);
      for (const row of rows) {
        const before = await asOf();
        const make = CALLS[row.entry];
        if (make === undefined) throw new Error(`no call for ${row.entry}`);
        const value = row.value ?? GIVEN[row.field];
        if (value === undefined) throw new Error(`nothing to give ${row.field}`);
        const body = await refusal(row.entry, { ...make(before), [row.field]: value });
        const where = `${row.entry} ${row.field}`;
        expect(body.code, where).toBe("invalid_input");
        expect(body.hint, where).toBe(`It arrives with ${row.step}.`);
        expect(body.data?.["issues"], where).toEqual([
          { path: row.field, message: "Not supported by this service yet" },
        ]);
        expect(await asOf(), where).toBe(before);
      }
    },
  );

  test("an empty list for a listed field asks nothing of it, and the call is applied", async () => {
    const added = await call("task.add", {
      tasks: [{ title: "Fixture empty" }],
      request_id: rid(),
    });
    const ref = ((added["tasks"] as Json[])[0] ?? {})["ref"] as string;
    const updated = await call("task.update", {
      task: ref,
      set: { summary: "Fixture next step" },
      remove_sources: [],
      base: await asOf(),
      request_id: rid(),
    });
    expect(updated["result"]).toBe("updated");
  });

  test("a person's change after the agent's read conflicts, and an answer that showed no field offers no base", async () => {
    const added = await tool("add_tasks", {
      tasks: [
        { title: "Fixture overwrite", sources: [{ kind: "ticket", title: "T", key: "fix:OW-1" }] },
      ],
      request_id: rid(),
    });
    const ref = /created ([A-Z]+-[0-9]+)/u.exec(added)?.[1] ?? "";
    const read = await tool("get_task", { task: ref });
    const base = AS_OF.exec(read)?.[1] ?? "";
    expect(base).not.toBe("");
    await opCall(w.service.ops, PERSON, {
      op: "task.update",
      input: {
        task: ref,
        set: { summary: "The person's summary" },
        base: await asOf(),
        request_id: rid(),
      },
    });
    // Logging shows none of the task's fields: no as_of to take a base from.
    const logged = await tool("add_entry", {
      task: ref,
      kind: "progress",
      text: "Fixture milestone.",
      request_id: rid(),
    });
    expect(logged).toMatch(/^logged l[0-9]+ on /u);
    expect(logged).not.toMatch(AS_OF);
    // Nor does an add_tasks that only found the task again.
    const again = await tool("add_tasks", {
      tasks: [
        { title: "Fixture overwrite", sources: [{ kind: "ticket", title: "T", key: "fix:OW-1" }] },
      ],
      request_id: rid(),
    });
    expect(again).toMatch(/^0 created · 1 existing/u);
    expect(again).not.toMatch(AS_OF);
    // The base of the last answer that showed the summary: the person's change is a conflict.
    const write = await tool("update_task", {
      task: ref,
      set: { summary: "The agent's summary" },
      base,
      request_id: rid(),
    });
    expect(write).toMatch(/^error conflict/u);
    const task = (await call("task.get", { task: ref }))["task"] as Json;
    expect(task["summary"]).toBe("The person's summary");
  });

  test("an append, another field's write and a search or status row offer no base for a person's change", async () => {
    const create = async (title: string, key: string) => {
      const text = await tool("add_tasks", {
        tasks: [{ title, sources: [{ kind: "ticket", title: "T", key }] }],
        request_id: rid(),
      });
      return {
        ref: /created ([A-Z]+-[0-9]+)/u.exec(text)?.[1] ?? "",
        base: AS_OF.exec(text)?.[1] ?? "",
      };
    };
    const person = async (op: string, input: Json) =>
      opCall(w.service.ops, PERSON, { op, input: { ...input, request_id: rid() } });

    // An append: the person appends a condition, the agent appends its note. The append's answer
    // offers no base, and a replace with the creating answer's conflicts.
    const a = await create("Fixture appended", "fix:AP-1");
    await person("task.update", {
      task: a.ref,
      context: { mode: "append", text: "Only on Fridays." },
    });
    const appended = await tool("update_task", {
      task: a.ref,
      context: { mode: "append", text: "Agent note." },
      request_id: rid(),
    });
    expect(appended).toMatch(/^updated /u);
    expect(appended).not.toMatch(AS_OF);
    const replaced = await tool("update_task", {
      task: a.ref,
      context: { mode: "replace", text: "Agent rewrite." },
      base: a.base,
      request_id: rid(),
    });
    expect(replaced).toMatch(/^error conflict/u);

    // Another field's write: the person completes and reopens, the agent changes the title. A
    // completion with the base of the rule conflicts, and the task stays open.
    const b = await create("Fixture reopened", "fix:RO-1");
    await person("task.finish", { task: b.ref, base: await asOf() });
    await person("task.reopen", { task: b.ref, base: await asOf() });
    const titled = await tool("update_task", {
      task: b.ref,
      set: { title: "Fixture reopened, renamed" },
      base: b.base,
      request_id: rid(),
    });
    expect(titled).toMatch(/^updated /u);
    const completed = await tool("complete_task", {
      task: b.ref,
      outcome: "Fixture outcome.",
      base: b.base,
      request_id: rid(),
    });
    expect(completed).toMatch(/^error conflict/u);
    expect(((await call("task.get", { task: b.ref }))["task"] as Json)["lifecycle"]).toBe("active");

    // An add that finds the task answers with the task's stored title, never the draft's.
    const c = await create("Fixture draft title", "fix:TI-1");
    await person("task.update", {
      task: c.ref,
      set: { title: "The person's title" },
      base: await asOf(),
    });
    const found = await call("task.add", {
      tasks: [
        {
          title: "Fixture draft title",
          sources: [{ kind: "ticket", title: "T", key: "fix:TI-1" }],
        },
      ],
      request_id: rid(),
    });
    expect((found["tasks"] as Json[])[0]).toMatchObject({
      result: "exists",
      title: "The person's title",
    });

    // A search row and a status row show part of a task: their answers offer no as_of.
    expect(await tool("search", { q: "Fixture" })).not.toMatch(AS_OF);
    expect(await tool("status", {})).not.toMatch(AS_OF);
    expect(await tool("status", { guide: "work" })).not.toMatch(AS_OF);
  });

  test("the groups line survives the largest add: 25 drafts, every source held", () => {
    const tasks = Array.from({ length: 25 }, (_, k) => ({
      result: "created",
      id: `t_${"0".repeat(25)}${String(k % 10)}`,
      ref: `M-${String(k + 1)}`,
      title: "Fixture",
      lifecycle: "active",
      log_added: false,
      held: Array.from({ length: 10 }, (_, s) => ({ source: s, held_by: "M-999" })),
    }));
    const warning =
      "Made 25 new areas and 25 new projects for names that matched none (a project, none in its area): tasks.0.area, tasks.1.area, tasks.2.area, tasks.3.area, tasks.4.area and 45 more.";
    const text = renderResult("task.add", {
      as_of: "1.9.5n0w8k3q",
      tasks,
      warnings: [warning],
    });
    expect(text).toContain(`warning: ${warning}`);
  });

  test("add_tasks says in one line which names made a new area or project, and nothing for a name it found", async () => {
    const made = await call("task.add", {
      tasks: [{ title: "Fixture filed task", area: "Fixture Harbor", project: "Fixture Quay" }],
      request_id: rid(),
    });
    expect(made["warnings"]).toEqual([
      "Made 1 new area and 1 new project for names that matched none (a project, none in its area): tasks.0.area, tasks.0.project.",
    ]);
    const many = await call("task.add", {
      tasks: [
        ["Lantern", "Marble"],
        ["Pebble", "Nimbus"],
        ["Falcon", "Oxbow"],
        ["Juniper", "Pylon"],
      ].map(([area, project]) => ({ title: `Fixture in ${String(area)}`, area, project })),
      request_id: rid(),
    });
    expect(many["warnings"]).toEqual([
      "Made 4 new areas and 4 new projects for names that matched none (a project, none in its area): tasks.0.area, tasks.1.area, tasks.2.area, tasks.3.area, tasks.0.project and 3 more.",
    ]);
    const found = await call("task.add", {
      tasks: [{ title: "Fixture second task", area: "fixture harbor", project: "Fixture Quay" }],
      request_id: rid(),
    });
    expect(found["warnings"] ?? []).toEqual([]);
  });
});
