// `prefs.manage set` through the request path: the person changes a scale and every reader of it
// follows on the next call, a change that would leave active tasks with a key the scale no longer
// has is refused naming them, and scripts and agents' shells are refused the change. Fixture text.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AppError, PrefsManageResult, TaskAddResult, type ErrorBody } from "@ttasks/contracts";
import type { ReceiptLookup, SpaceWriterHandle, WriteRequest } from "@ttasks/storage";
import { MACHINE, writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;

beforeEach(async () => {
  temp = tempRoot("prefs-set");
  mkdirSync(join(temp.root, "fx"));
  fx = await writeFixture(join(temp.root, "fx"));
});

afterEach(() => {
  fx.close();
  temp.cleanup();
});

const host = (): OpsHost => ({
  machine: { id: MACHINE.id },
  spaces: () => [
    {
      id: fx.spaceId,
      name: "Mira",
      state: "open",
      writer: {
        spaceId: fx.spaceId,
        submit: (request: WriteRequest) => Promise.resolve(fx.writer.submit(request)),
        receipt: (lookup: ReceiptLookup) => Promise.resolve(fx.writer.receipt(lookup)),
        actor: (kind: "human" | "agent", label: string) =>
          Promise.resolve(fx.writer.actor(kind, label)),
      } as unknown as SpaceWriterHandle,
      reader: readerOf(fx.reader),
    },
  ],
  now: () => Date.UTC(2026, 10, 23, 9, 0, 0),
  timeZone: () => "Europe/Lisbon",
});

const person: Caller = { class: "cli-interactive", env: {} };
const script: Caller = { class: "cli-script", env: {} };
const agentShell: Caller = { class: "cli-agent", env: {} };

type Json = Record<string, unknown>;
let n = 0;
const rid = (): string => `fixture-prefs-${String((n += 1)).padStart(8, "0")}`;
const call = async (caller: Caller, op: string, input: Json): Promise<Json> =>
  (await opCall(host(), caller, { op, input })) as Json;
const asOf = async (): Promise<string> =>
  (await call(person, "prefs.manage", { action: "get" }))["as_of"] as string;

async function refusal(promise: Promise<unknown>): Promise<ErrorBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.toBody();
    throw error;
  }
  throw new Error("expected a refusal");
}

/** `ttasks prefs set <key> <value>` as the command line sends it: the value as one text. */
const set = (caller: Caller, key: string, value: unknown) =>
  asOf().then(async (base) =>
    PrefsManageResult.parse(
      await call(caller, "prefs.manage", {
        action: "set",
        set: [{ key, value }],
        base,
        request_id: rid(),
      }),
    ),
  );

const get = async (key: string): Promise<unknown> =>
  PrefsManageResult.parse(await call(person, "prefs.manage", { action: "get", keys: [key] }))
    .prefs[0]?.value;

const add = async (tasks: Json[]) =>
  TaskAddResult.parse(await call(script, "task.add", { tasks, request_id: rid() })).tasks.map(
    (t) => t.ref,
  );

const effortOf = async (ref: string): Promise<unknown> =>
  ((await call(person, "task.get", { task: ref }))["task"] as Json)["effort"];

describe("[A3.3.4.prefs.set] the person changes a space's settings, and everything follows", () => {
  test("adding sizes keeps every task's size, and each reader of the scale uses it on the next call", async () => {
    const refs = await add([
      { title: "Fixture small", effort: "S" },
      { title: "Fixture medium", effort: "M" },
      { title: "Fixture large", effort: "L" },
    ]);
    const changed = await set(person, "tasks.effort_scale", "XS, S, M, L, XL");
    expect(changed).toMatchObject({
      action: "set",
      result: "updated",
      changed: [
        { key: "tasks.effort_scale", from: ["S", "M", "L"], to: ["XS", "S", "M", "L", "XL"] },
      ],
      prefs: [{ key: "tasks.effort_scale", value: ["XS", "S", "M", "L", "XL"], is_default: false }],
    });
    expect(await get("tasks.effort_scale")).toEqual(["XS", "S", "M", "L", "XL"]);
    expect(await Promise.all(refs.map((ref) => effortOf(ref ?? "")))).toEqual(["S", "M", "L"]);

    // The writer's check of a size an agent sends, and its hint.
    const [tiny] = await add([{ title: "Fixture tiny", effort: "XS" }]);
    expect(await effortOf(tiny ?? "")).toBe("XS");
    const wrong = await refusal(add([{ title: "Fixture huge", effort: "XXL" }]));
    expect(wrong.hint).toBe(
      "Use one of the space's efforts: XS, S, M, L, XL. Put another estimate in context.",
    );
    // Search's effort: filter.
    const found = (await call(script, "task.search", { q: "effort:XS" }))["rows"] as Json[];
    expect(found.map((row) => row["ref"])).toEqual([tiny]);
    // Undo of a change to a new size.
    const large = refs[2] ?? "";
    await call(person, "task.update", {
      task: large,
      set: { effort: "XL" },
      base: await asOf(),
      request_id: rid(),
    });
    expect(await effortOf(large)).toBe("XL");
    await call(person, "history.undo", { request_id: rid() });
    expect(await effortOf(large)).toBe("L");
  });

  test("the statuses are fixed in this build: the refusal and the read say so, and nothing is written", async () => {
    const before = await asOf();
    expect(await refusal(set(person, "tasks.statuses", "open,parked,waiting"))).toMatchObject({
      code: "invalid_input",
      message: "This setting is fixed in this build.",
    });
    expect(await asOf()).toBe(before);
    expect(await get("tasks.statuses")).toEqual(["open", "waiting", "review", "backlog"]);
    for (const who of [person, script]) {
      const read = PrefsManageResult.parse(
        await call(who, "prefs.manage", { action: "describe", keys: ["tasks.statuses"] }),
      );
      expect(read.prefs[0]).toMatchObject({ writable: false, fixed: true });
    }
  });

  test("a change that drops a size active tasks hold is refused naming them, and nothing changes", async () => {
    const [large] = await add([{ title: "Fixture large", effort: "L" }]);
    const effort = await refusal(set(person, "tasks.effort_scale", "S,M"));
    expect(effort).toMatchObject({
      code: "invalid_input",
      message: `Active tasks hold an effort this change removes: ${large ?? ""} (L). Nothing was changed.`,
      data: { tasks: [large], task_count: 1 },
    });
    expect(await get("tasks.effort_scale")).toEqual(["S", "M", "L"]);
  });

  test("a size the scale takes is one every task input takes, and no two differ only in case", async () => {
    const longest = "X".repeat(20);
    await set(person, "tasks.effort_scale", `S,M,L,${longest}`);
    const [sized] = await add([{ title: "Fixture longest size", effort: longest }]);
    expect(await effortOf(sized ?? "")).toBe(longest);
    expect(
      await refusal(set(person, "tasks.effort_scale", `S,M,L,${longest},${longest}X`)),
    ).toMatchObject({ code: "invalid_input", hint: "It takes a list of 1 to 10 keys." });
    expect(await refusal(set(person, "tasks.effort_scale", "S,M,L,l"))).toMatchObject({
      code: "invalid_input",
    });
    expect(await get("tasks.effort_scale")).toEqual(["S", "M", "L", longest]);
  });

  test("the same value again changes nothing, and says so", async () => {
    await set(person, "tasks.dedupe_window_days", "14");
    const again = await set(person, "tasks.dedupe_window_days", "14");
    expect(again).toMatchObject({ result: "no_change", changed: [] });
    expect(await get("tasks.dedupe_window_days")).toBe(14);
  });

  test("a key this build does not act on, an unknown key and a value that does not fit are refused", async () => {
    const before = await asOf();
    expect(await refusal(set(person, "features.search_trigram", "true"))).toMatchObject({
      code: "invalid_input",
      message: "This build does not act on this key yet, so it is not changed.",
    });
    // A machine key nothing reads yet answers the same, not as a key no declaration has.
    expect(await refusal(set(person, "projection.dir", "/srv/view"))).toMatchObject({
      code: "invalid_input",
      message: "This build does not act on this key yet, so it is not changed.",
    });
    expect(await refusal(set(person, "tasks.statuss", "open"))).toMatchObject({
      code: "invalid_input",
      hint: "Did you mean tasks.statuses?",
    });
    expect(await refusal(set(person, "tasks.dedupe_window_days", "a month"))).toMatchObject({
      code: "invalid_input",
      hint: "It takes a whole number from 0 to 3650.",
    });
    expect(await refusal(set(person, "tasks.effort_scale", "S,S"))).toMatchObject({
      code: "invalid_input",
    });
    expect(await asOf()).toBe(before);
  });

  test("a script and an agent's shell are refused the change as anything only the user may do", async () => {
    const before = await asOf();
    for (const caller of [script, agentShell]) {
      expect(await refusal(set(caller, "tasks.effort_scale", "XS,S,M,L,XL"))).toMatchObject({
        code: "forbidden",
        data: { rule: "user_only" },
      });
    }
    expect(await asOf()).toBe(before);
    expect(await get("tasks.effort_scale")).toEqual(["S", "M", "L"]);
  });
});
