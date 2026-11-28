// The library through the request path: write_page puts an agent's page on its task's project by
// default and asks it for a brief; read gives a page whole or by heading, and a node with what is
// known above it; get_task's digest lists the pages above the task; search in scope library finds
// pages, with its filters applied before the limit and the bound task's trail first; complete_task
// keeps the pages a session updated with its outcome, refuses one the space does not show and tells
// an agent that named none; a page in the Trash is not read as live; the feed's snapshot carries
// the pages. An agent's write that leaves a page or what holds it over the library's budget says
// so, and a library search that no page answers whole points to scope all. Fixture text only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, TaskGetResult } from "@ttasks/contracts";
import { readSnapshot } from "../src/http/feed.ts";
import { searchLibrary } from "../src/ops/library.ts";
import { parseQuery } from "../src/search/query.ts";
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

  test("get_task with sections lists the pages above the task too", async () => {
    const read = TaskGetResult.parse(await call("task.get", { task, sections: ["notes"] }));
    if (read.view !== "sections") throw new Error("not sections");
    expect(read.trail?.map((level) => level.kind)).toEqual(["project", "area", "space"]);
    expect(read.trail?.[0]?.pages.map((p) => p.ref)).toEqual([page]);
  });

  test("search in scope library finds the page by its words", async () => {
    const found = await call("task.search", { q: "photos", scope: "library" });
    expect((found["rows"] as Json[]).map((r) => [r["kind"], r["ref"]])).toEqual([["page", page]]);
  });

  let visa = "";
  let visaTask = "";
  test("search in scope library applies its reference and group filters, and refuses one it cannot", async () => {
    const added = await call(
      "task.add",
      {
        tasks: [{ title: "Apply for the visa", area: "Home", project: "Travel" }],
        request_id: rid(),
      },
      USER,
    );
    visaTask = String((added["tasks"] as Json[])[0]?.["id"]);
    const made = await call("page.write", {
      action: "create",
      task: visaTask,
      title: "Visa",
      brief: "What the consulate asks for",
      body: "## Photos\n\nTwo photos, white background.",
      why: "what the visa needs",
      request_id: rid(),
    });
    visa = String(made["target"]);
    const refs = async (q: string) =>
      ((await call("task.search", { q, scope: "library" }))["rows"] as Json[]).map((r) => r["ref"]);
    expect(await refs(`id:${page}`)).toEqual([page]);
    expect(await refs(`photos id:${visa}`)).toEqual([visa]);
    expect(await refs("photos project:Travel")).toEqual([visa]);
    expect(await refs("project:Papers")).toEqual([page]);
    expect(await refs("photos -consulate")).toEqual([page]);
    expect(await refs("area:Home")).toEqual(expect.arrayContaining([page, visa]));
    expect(await refused("task.search", { q: "photos status:open", scope: "library" })).toBe(
      "invalid_input",
    );
  });

  test("search in scope library puts the pages on the bound task's trail first", async () => {
    const reader = w.service.ops.spaces().find((s) => s.reader !== undefined)?.reader;
    if (reader === undefined) throw new Error("no space is served");
    const first = async (task: string) =>
      (
        (
          await searchLibrary(reader, {
            query: parseQuery("photos"),
            limit: 15,
            agent: true,
            parsed: "photos",
            task,
          })
        )["rows"] as Json[]
      )[0]?.["ref"];
    const papers = TaskGetResult.parse(await call("task.get", { task })).task.id;
    expect(await first(visaTask)).toBe(visa);
    expect(await first(papers)).toBe(page);
  });

  test("search in scope library finds a page by any of its words, the pages with every word first", async () => {
    const refs = async (q: string) =>
      ((await call("task.search", { q, scope: "library" }))["rows"] as Json[]).map((r) => r["ref"]);
    expect(await refs("consulate deadline")).toEqual([visa]);
    expect(await refs("photos consulate")).toEqual([visa, page]);
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
    // The pages it named stay with the outcome, where the person reads it.
    expect(done["library"]).toEqual([page]);
    const finished = TaskGetResult.parse(await call("task.get", { task }, USER));
    if (finished.view !== "digest") throw new Error("not a digest");
    expect(finished.task.outcome).toBe(`Renewed.\n\nLibrary: ${page}`);
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
    expect(snapshot.pages?.map((p) => p["ref"])).toEqual([page, visa]);
    expect(snapshot.pages?.[0]).not.toHaveProperty("body");
  });

  test("a page in the Trash is not read as a live page, and its history still is", async () => {
    await call("page.write", {
      action: "trash",
      target: visa,
      why: "the trip is off",
      request_id: rid(),
    });
    expect(await refused("page.read", { target: visa })).toBe("not_found");
    const history = await call("page.history", { target: visa }, USER);
    expect((history["versions"] as Json[]).length).toBeGreaterThan(0);
  });
});

describe("[A3.pages.budget] an agent's write and search say how to keep the library", () => {
  let asOf = "";
  // A set writes from the as_of the last write gave.
  const write = async (input: Json, caller: Caller = AGENT) => {
    const base = input["action"] === "set" ? { base: asOf } : {};
    const answer = await call(
      "page.write",
      { why: "keep the library", request_id: rid(), ...base, ...input },
      caller,
    );
    asOf = String(answer["as_of"]);
    return answer;
  };
  const words = (chars: number) => "word ".repeat(chars / 5);
  let task = "";

  test("a page over 16 KB is told so on each write that leaves it there, and not once under", async () => {
    const added = await call(
      "task.add",
      {
        tasks: [{ title: "Sort the receipts", area: "Home", project: "Budget" }],
        request_id: rid(),
      },
      USER,
    );
    task = String((added["tasks"] as Json[])[0]?.["ref"]);
    const made = await write({
      action: "create",
      task,
      title: "Receipts",
      brief: "How",
      body: words(7_000),
    });
    const page = String(made["target"]);
    expect(made["over"]).toBeUndefined();
    for (const _ of [1, 2]) {
      expect(
        (await write({ action: "append", target: page, text: words(4_000) }))["over"],
      ).toBeUndefined();
    }
    expect((await write({ action: "append", target: page, text: words(2_000) }))["over"]).toEqual([
      "page",
    ]);
    expect((await write({ action: "set", target: page, title: "All receipts" }))["over"]).toEqual([
      "page",
    ]);
    // The person in the app is never told: this is for agents.
    expect(
      (await write({ action: "append", target: page, text: "Done." }, USER))["over"],
    ).toBeUndefined();
    expect(
      (await write({ action: "set", target: page, body: words(1_000) }))["over"],
    ).toBeUndefined();
  });

  test("a node with more than 12 pages is told so on a write there, and not once it holds 12", async () => {
    // The project holds Receipts already.
    const made: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const answer = await write({
        action: "create",
        task,
        title: `Shop ${String(i)}`,
        brief: "Its receipts",
      });
      expect(answer["over"]).toEqual(i === 12 ? ["holder"] : undefined);
      made.push(String(answer["target"]));
    }
    expect((await write({ action: "trash", target: made[0] }))["over"]).toBeUndefined();
  });

  test("a library search that finds no page with every word says scope all searches finished tasks' logs", async () => {
    const search = (q: string) => call("task.search", { q, scope: "library" });
    expect((await search("zeppelin"))["try_scope"]).toBe("all");
    const some = await search("receipts zeppelin");
    expect((some["rows"] as Json[]).length).toBeGreaterThan(0);
    expect(some["try_scope"]).toBe("all");
    expect((await search("receipts"))["try_scope"]).toBeUndefined();
    expect((await search("shop receipts"))["try_scope"]).toBeUndefined();
  });
});
