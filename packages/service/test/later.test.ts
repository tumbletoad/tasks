// What an agent's call meets for what a later step builds (contracts' later.ts): each row on a
// field is refused naming its step and writes nothing, whatever else the call holds. And a name
// that matched no area or project says that it made one. A service in this process.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, LATER, type ErrorBody } from "@ttasks/contracts";
import { opCall, type Caller } from "../src/ops/index.ts";
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

  test("add_tasks says when a name made a new area or project, and not for a name it found", async () => {
    const made = await call("task.add", {
      tasks: [{ title: "Fixture filed task", area: "Fixture Harbor", project: "Fixture Quay" }],
      request_id: rid(),
    });
    expect(made["warnings"]).toEqual([
      "New area for tasks.0.area: no area had this name.",
      "New project for tasks.0.project: no project had this name.",
    ]);
    const found = await call("task.add", {
      tasks: [{ title: "Fixture second task", area: "fixture harbor", project: "Fixture Quay" }],
      request_id: rid(),
    });
    expect(found["warnings"] ?? []).toEqual([]);
  });
});
