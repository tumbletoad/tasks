// The library through the request path: write_page puts an agent's page on its task's project by
// default and asks it for a brief; read gives a page whole or by heading, and a node with what is
// known above it; get_task's digest lists the pages above the task; search in scope library finds
// pages; complete_task takes the pages a session updated, refuses one the space does not show and
// tells an agent that named none; the feed's snapshot carries the pages. Fixture text only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, TaskGetResult } from "@ttasks/contracts";
import { readSnapshot } from "../src/http/feed.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("library");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const AGENT: Caller = { class: "cli-script", env: {} };
const USER: Caller = { class: "cli-interactive", env: {} };

const call = async (op: string, input: Json, caller: Caller = AGENT): Promise<Json> =>
  (await opCall(w.service.ops, caller, { op, input })) as Json;
const refused = async (op: string, input: Json, caller: Caller = AGENT): Promise<string> => {
  const error = await call(op, input, caller).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.code;
};

let n = 0;
const rid = () => `fixture-library-${String((n += 1)).padStart(6, "0")}`;
const BODY = "## Steps\n\nBring a photo.\n\n## Fees\n\nPay at the desk.";

describe("[A3.pages.service] the library through the request path", () => {
  let task = "";
  let page = "";

  test("an agent's page goes to its task's project, with a brief it must give", async () => {
    const added = await call(
      "task.add",
      {
        tasks: [{ title: "Renew the passport", area: "Home", project: "Papers" }],
        request_id: rid(),
      },
      USER,
    );
    task = String((added["tasks"] as Json[])[0]?.["ref"]);
    expect(
      await refused("page.write", {
        action: "create",
        task,
        title: "Passport",
        why: "x",
        request_id: rid(),
      }),
    ).toBe("invalid_input");
    const made = await call("page.write", {
      action: "create",
      task,
      title: "Passport",
      brief: "What to bring",
      body: BODY,
      why: "what the renewal needs",
      request_id: rid(),
    });
    expect(made).toMatchObject({ result: "created", on: "Papers" });
    page = String(made["target"]);
  });

  test("read gives a page by heading, and a node with what is known above it", async () => {
    const fees = await call("page.read", { target: page, section: "Fees" });
    expect(fees).toMatchObject({
      view: "page",
      ref: page,
      section: "Fees",
      body: "## Fees\n\nPay at the desk.",
    });
    expect(fees["owner"]).toMatchObject({ kind: "project", title: "Papers" });
    const node = await call("page.read", { target: "Home/Papers" });
    expect(node).toMatchObject({ view: "node", kind: "project", title: "Papers" });
    expect((node["pages"] as Json[]).map((p) => p["ref"])).toEqual([page]);
    expect((node["above"] as Json[]).map((l) => l["kind"])).toEqual(["area", "space"]);
  });

  test("an edit whose words are gone writes nothing and holds the page's start", async () => {
    const stale = await call("page.write", {
      action: "edit",
      target: page,
      old: "Bring a pen.",
      new: "Bring two.",
      why: "fix the list",
      request_id: rid(),
    });
    expect(stale).toMatchObject({ result: "stale", found: 0, excerpt: BODY });
    const edited = await call("page.write", {
      action: "edit",
      target: page,
      old: "Bring a photo.",
      new: "Bring two photos.",
      why: "the office asks for two",
      request_id: rid(),
    });
    expect(edited).toMatchObject({ result: "edited", target: page });
  });

  test("get_task's digest lists the pages above the task, nearest first", async () => {
    const read = TaskGetResult.parse(await call("task.get", { task }));
    if (read.view !== "digest") throw new Error("not a digest");
    expect(read.trail?.map((level) => level.kind)).toEqual(["project", "area", "space"]);
    expect(read.trail?.[0]?.pages.map((p) => p.ref)).toEqual([page]);
  });

  test("search in scope library finds the page by its words", async () => {
    const found = await call("task.search", { q: "photos", scope: "library" });
    expect((found["rows"] as Json[]).map((r) => [r["kind"], r["ref"]])).toEqual([["page", page]]);
  });

  test("complete_task takes the pages updated, refuses one the space does not show, and tells an agent that named none", async () => {
    const base = async () => String((await call("space.status", {}))["as_of"]);
    expect(
      await refused("task.finish", {
        task,
        outcome: "Renewed.",
        library: ["M-999"],
        base: await base(),
        request_id: rid(),
      }),
    ).toBe("not_found");
    const done = await call("task.finish", {
      task,
      outcome: "Renewed.",
      library: [page],
      base: await base(),
      request_id: rid(),
    });
    expect(done["warnings"]).toBeUndefined();
    const other = await call(
      "task.add",
      { tasks: [{ title: "Book the photo booth" }], request_id: rid() },
      USER,
    );
    const quiet = await call("task.finish", {
      task: String((other["tasks"] as Json[])[0]?.["ref"]),
      outcome: "Booked.",
      base: await base(),
      request_id: rid(),
    });
    expect(quiet["warnings"]).toEqual([expect.stringMatching(/library/u)]);
  });

  test("Activity names the page an agent changed, by its reference", async () => {
    const read = await call("activity.list", {}, USER);
    const targets = (read["lines"] as Json[]).flatMap((line) => line["targets"] as Json[]);
    expect(targets).toContainEqual(
      expect.objectContaining({ kind: "page", ref: page, name: "Passport" }),
    );
  });

  test("the feed's snapshot carries every page the space shows, without its body", async () => {
    const reader = w.service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
    if (reader === undefined) throw new Error("no space is served");
    const snapshot = await readSnapshot(reader);
    expect(snapshot.pages?.map((p) => p["ref"])).toEqual([page]);
    expect(snapshot.pages?.[0]).not.toHaveProperty("body");
  });
});
