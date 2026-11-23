// A source detached from a task and put back, through real requests: the person at a terminal and
// an agent's shell call the request path in this process, and an agent reads the MCP text. Every
// read lists each source's ID; a key or URL names one link among all of the task's links or is
// refused with the candidates; put back is refused while another active task holds the key, naming
// it; a retry gets its first answer; a finished task takes a detach alone. Fixture text only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { renderResult } from "../src/mcp/index.ts";
import { opCall, type Caller } from "../src/ops/index.ts";
import { contractWorld, type ContractWorld } from "./contract/suite.ts";

type Json = Record<string, unknown>;
interface Source {
  id: string;
  key?: string;
  title: string;
  url?: string;
  ref?: string;
  captures_to?: string[];
  removed?: { at: string; by: string };
}

let w: ContractWorld & { root: string };
const LONG = 180_000;

beforeAll(async () => {
  w = await contractWorld("detach");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

const PERSON: Caller = { class: "cli-interactive", env: {} };
/** An agent's shell: the agent audience. */
const AGENT: Caller = { class: "cli-script", env: {} };

let n = 0;
const rid = () => `fixture-detach-${String((n += 1)).padStart(6, "0")}`;
const call = async (op: string, input: Json, who: Caller = PERSON): Promise<Json> =>
  (await opCall(w.service.ops, who, { op, input })) as Json;
async function refusal(op: string, input: Json, who: Caller = PERSON): Promise<ErrorBody> {
  const error = await call(op, input, who).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`${op} was not refused`);
  return error.toBody();
}
const asOf = async () => (await call("space.status", {}))["as_of"] as string;

async function add(draft: Json, who: Caller = PERSON): Promise<{ ref: string; result: string }> {
  const added = await call("task.add", { tasks: [draft], request_id: rid() }, who);
  return (added["tasks"] as { ref: string; result: string }[])[0] ?? { ref: "", result: "" };
}
/** The task's sources as a sections read lists them: the live ones, then the detached ones. */
async function sources(ref: string): Promise<Source[]> {
  const read = await call("task.get", { task: ref, sections: ["sources"] });
  return ((read["sections"] as Json)["sources"] ?? []) as Source[];
}
const update = async (input: Json, who: Caller = PERSON): Promise<Json> =>
  call("task.update", { base: await asOf(), request_id: rid(), ...input }, who);

const ticket = (key: string) => ({ kind: "ticket", key, title: `Fixture ticket ${key}` });

describe("[A3.source.detach] detaching a source and putting it back, through real requests", () => {
  test("every read lists each source's ID; a key, a URL or an ID names one link, several are refused with their IDs", async () => {
    const url = "https://tickets.example/shared";
    const { ref } = await add({
      title: "Fixture detach by name",
      sources: [
        ticket("fix:DT-1"),
        { kind: "issue", title: "First copy", url },
        { kind: "issue", title: "Second copy", url },
        { kind: "chat", title: "Fixture call notes" },
      ],
    });
    const listed = await sources(ref);
    expect(listed).toHaveLength(4);
    for (const s of listed) expect(s.id).toMatch(/^s_[0-9a-z]{26}$/u);
    const digest = await call("task.get", { task: ref });
    expect(((digest["task"] as Json)["sources"] as Source[]).map((s) => s.id)).toEqual(
      listed.map((s) => s.id),
    );

    // A URL two links share is ambiguous: the refusal names both IDs and changes nothing.
    const both = await refusal("task.update", {
      task: ref,
      remove_sources: [url],
      base: await asOf(),
      request_id: rid(),
    });
    expect(both).toMatchObject({
      code: "ambiguous",
      data: { issues: [{ path: "remove_sources.0" }] },
    });
    for (const s of listed.slice(1, 3)) expect(both.hint).toContain(s.id);
    // A name of no link is not found.
    expect(
      await refusal("task.update", {
        task: ref,
        remove_sources: ["fix:NONE"],
        base: await asOf(),
        request_id: rid(),
      }),
    ).toMatchObject({ code: "not_found", data: { issues: [{ path: "remove_sources.0" }] } });

    // By key, then by ID for the title-only source: both detached, the others stay.
    const [keyed, first, second, titled] = listed as [Source, Source, Source, Source];
    const done = await update({ task: ref, remove_sources: ["fix:DT-1", titled.id] });
    expect(done).toMatchObject({ result: "updated", fields: ["sources"] });
    const after = await sources(ref);
    expect(after.filter((s) => s.removed === undefined).map((s) => s.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(after.filter((s) => s.removed !== undefined)).toMatchObject([
      { removed: { by: "user" } },
      { removed: { by: "user" } },
    ]);
    // The digest lists only what is linked.
    const read = await call("task.get", { task: ref });
    expect(((read["task"] as Json)["sources"] as Source[]).map((s) => s.id)).toEqual([
      first.id,
      second.id,
    ]);
    // Detaching again changes nothing; the key names the detached link.
    expect(await update({ task: ref, remove_sources: ["fix:DT-1"] })).toMatchObject({
      result: "no_change",
    });
    // Put back by key brings back the same source.
    expect(await update({ task: ref, put_back_sources: ["fix:DT-1"] })).toMatchObject({
      result: "updated",
    });
    expect((await sources(ref)).find((s) => s.id === keyed.id)?.removed).toBeUndefined();
    // Detach and put back of one source in one call is refused.
    expect(
      await refusal("task.update", {
        task: ref,
        remove_sources: [keyed.id],
        put_back_sources: [keyed.id],
        base: await asOf(),
        request_id: rid(),
      }),
    ).toMatchObject({ code: "invalid_input" });
  });

  test("a capture after a detach is new work; put back is refused while that task holds the key, and works once it no longer does", async () => {
    const { ref } = await add({ title: "Fixture wrong ticket", sources: [ticket("fix:DT-2")] });
    // An agent detaches the wrong ticket through its tool's entry.
    await update({ task: ref, remove_sources: ["fix:DT-2"] }, AGENT);
    const [gone] = await sources(ref);
    expect(gone?.removed?.by).not.toBe("user");
    expect(gone?.captures_to).toBeUndefined();
    // The agent's next capture of the ticket is new work.
    const other = await add({ title: "Fixture right task", sources: [ticket("fix:DT-2")] }, AGENT);
    expect(other).toMatchObject({ result: "created" });
    expect(other.ref).not.toBe(ref);
    // The removed line says where captures go, read now.
    expect((await sources(ref))[0]?.captures_to).toEqual([other.ref]);
    // Put back is refused, naming the task that holds the key; nothing is copied.
    const refused = await refusal("task.update", {
      task: ref,
      put_back_sources: [gone?.id ?? ""],
      base: await asOf(),
      request_id: rid(),
    });
    expect(refused).toMatchObject({
      code: "conflict",
      message: `fix:DT-2 is on ${other.ref} now: captures go there. Nothing was put back.`,
      data: { reason: "key_held", conflicts: [{ task: other.ref }] },
    });
    const now = await sources(ref);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ id: gone?.id, removed: {}, captures_to: [other.ref] });
    // An agent reads where captures go, and each source's ID, in its tool's text.
    const text = renderResult(
      "task.get",
      await call("task.get", { task: ref, sections: ["sources"] }),
    );
    expect(text).toContain(`captures go to ${other.ref}`);
    expect(text).toContain(gone?.id ?? "?");
    // The next capture still goes to the other task.
    expect(await add({ title: "Fixture again", sources: [ticket("fix:DT-2")] }, AGENT)).toEqual(
      expect.objectContaining({ ref: other.ref }),
    );
    // The other task detaches it too: put back works, and captures find this task again.
    await update({ task: other.ref, remove_sources: ["fix:DT-2"] });
    expect((await sources(ref))[0]?.captures_to).toBeUndefined();
    expect(await update({ task: ref, put_back_sources: ["fix:DT-2"] })).toMatchObject({
      result: "updated",
      warnings: [],
    });
    expect(await add({ title: "Fixture once more", sources: [ticket("fix:DT-2")] }, AGENT)).toEqual(
      expect.objectContaining({ ref }),
    );
  });

  test("where two active tasks share a key, the read and the refusal name both, as a capture does", async () => {
    const { ref } = await add({ title: "Fixture shared one", sources: [ticket("fix:DT-5")] });
    await update({ task: ref, remove_sources: ["fix:DT-5"] });
    const b = await add({ title: "Fixture shared two", sources: [ticket("fix:DT-5")] });
    const c = await add({ title: "Fixture shared three", sources: [{ kind: "chat", title: "x" }] });
    await update({ task: c.ref, add_sources: [ticket("fix:DT-5")] });
    const captured = await call("task.add", {
      tasks: [{ title: "Fixture capture", sources: [ticket("fix:DT-5")] }],
      request_id: rid(),
    });
    expect((captured["tasks"] as Json[])[0]).toMatchObject({ ambiguous: [b.ref, c.ref] });
    expect((await sources(ref))[0]?.captures_to).toEqual([b.ref, c.ref]);
    const refused = await refusal("task.update", {
      task: ref,
      put_back_sources: ["fix:DT-5"],
      base: await asOf(),
      request_id: rid(),
    });
    expect(refused.message).toBe(
      `fix:DT-5 is on ${b.ref} and ${c.ref} now: a capture of it asks which. Nothing was put back.`,
    );
  });

  test("a put back with a base from before a later detach is a conflict; without a base it is checked against the link as it is now", async () => {
    const { ref } = await add({ title: "Fixture stale", sources: [ticket("fix:DT-6")] });
    await update({ task: ref, remove_sources: ["fix:DT-6"] });
    const old = await asOf();
    await update({ task: ref, put_back_sources: ["fix:DT-6"] });
    await update({ task: ref, remove_sources: ["fix:DT-6"] });
    const stale = await refusal("task.update", {
      task: ref,
      put_back_sources: ["fix:DT-6"],
      base: old,
      request_id: rid(),
    });
    expect(stale.code).toBe("conflict");
    expect(stale.data?.["reason"]).toBeUndefined();
    expect((await sources(ref))[0]?.removed).toBeDefined();
    // An agent without a base: the link's version as read now.
    expect(
      await call(
        "task.update",
        { task: ref, put_back_sources: ["fix:DT-6"], request_id: rid() },
        AGENT,
      ),
    ).toMatchObject({ result: "updated" });
    expect(
      await call(
        "task.update",
        { task: ref, remove_sources: ["fix:DT-6"], request_id: rid() },
        AGENT,
      ),
    ).toMatchObject({ result: "updated" });
  });

  test("a URL two links share is ambiguous whether each is linked or detached; a key is normalised; a key and an ID of one link are that link once", async () => {
    const url = "https://tickets.example/twice";
    const { ref } = await add({
      title: "Fixture shared URL",
      sources: [
        { ...ticket("fix:DT-7"), url },
        { ...ticket("fix:DT-8"), url },
      ],
    });
    const [first, second] = (await sources(ref)) as [Source, Source];
    await update({ task: ref, remove_sources: [first.id] });
    for (const field of ["remove_sources", "put_back_sources"]) {
      const both = await refusal("task.update", {
        task: ref,
        [field]: [url],
        base: await asOf(),
        request_id: rid(),
      });
      expect(both).toMatchObject({ code: "ambiguous", data: { issues: [{ path: `${field}.0` }] } });
      expect(both.hint).toContain(first.id);
      expect(both.hint).toContain(second.id);
    }
    expect((await sources(ref)).find((s) => s.id === second.id)?.removed).toBeUndefined();
    // The key as the caller spelled it at capture finds the stored one.
    expect(await update({ task: ref, put_back_sources: ["FIX:DT-7"] })).toMatchObject({
      result: "updated",
    });
    // Its key and its ID in one request: one link, detached once.
    const once = await update({ task: ref, remove_sources: ["fix:DT-7", first.id] });
    expect(once).toMatchObject({ result: "updated" });
    expect((await sources(ref)).filter((s) => s.removed !== undefined).map((s) => s.id)).toEqual([
      first.id,
    ]);
  });

  test("a retry of a request that committed gets its first answer, even when its names fit other links by then", async () => {
    const url = "https://tickets.example/retry";
    const { ref } = await add({
      title: "Fixture retry",
      sources: [{ kind: "issue", title: "Only copy", url }],
    });
    const input = { task: ref, remove_sources: [url], base: await asOf(), request_id: rid() };
    const first = await call("task.update", input);
    expect(first).toMatchObject({ result: "updated" });
    await update({
      task: ref,
      add_sources: [
        { kind: "issue", title: "Later copy", url },
        { kind: "issue", title: "Another copy", url },
      ],
    });
    expect(await call("task.update", input)).toMatchObject({ ...first, replayed: true });
  });

  test("a finished task takes a detach alone; mixed with another change it is refused whole", async () => {
    const { ref } = await add({ title: "Fixture finished", sources: [ticket("fix:DT-3")] });
    await call("task.finish", {
      task: ref,
      outcome: "Fixture done.",
      base: await asOf(),
      request_id: rid(),
    });
    const mixed = await refusal("task.update", {
      task: ref,
      set: { summary: "Fixture next" },
      remove_sources: ["fix:DT-3"],
      base: await asOf(),
      request_id: rid(),
    });
    expect(mixed.code).toBe("wrong_tool");
    expect((await sources(ref))[0]?.removed).toBeUndefined();
    expect(await update({ task: ref, remove_sources: ["fix:DT-3"] })).toMatchObject({
      result: "updated",
    });
    expect((await sources(ref))[0]?.removed).toBeDefined();
    expect(await update({ task: ref, put_back_sources: ["fix:DT-3"] })).toMatchObject({
      result: "updated",
    });
    // A retry with the same request ID answers the same.
    const id = rid();
    const input = { task: ref, remove_sources: ["fix:DT-3"], base: await asOf(), request_id: id };
    const first = await call("task.update", input);
    expect(await call("task.update", input)).toMatchObject({ ...first, replayed: true });
  });
});
