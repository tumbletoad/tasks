// The effort scale as every reader takes it: the names of any stored list of sizes, whatever its
// version or the fields of its items, a size of the longest name through every input, and search
// that tells two sizes apart that differ only in case. Fixture text only.
import { EFFORT_KEY_MAX } from "@ttasks/contracts";
import { afterAll, describe, expect, test } from "vitest";
import { readSnapshot } from "../src/http/feed.ts";
import { effortSpaces, type EffortWorld, type Json } from "./effort-world.ts";
import { readerOf } from "./harness.ts";

const spaces = effortSpaces("effort-scales");
afterAll(spaces.cleanup);

const hintFor = (names: readonly string[]) =>
  `Use one of the space's efforts: ${names.join(", ")}. Put another estimate in context.`;

/** What each reader of the scale offers: the snapshot's value, the hint, and the sizes taken. */
async function readers(w: EffortWorld, names: readonly string[]) {
  const snapshot = await readSnapshot(readerOf(w.fx.reader));
  const scale = snapshot.preferences.find((p) => p.key === "tasks.effort_scale");
  const added: string[] = [];
  for (const effort of names) {
    const text = await w.tool("add_tasks", {
      tasks: [{ title: `Fixture sized ${effort}`, effort }],
      request_id: w.rid(),
    });
    expect(text, effort).not.toMatch(/^error/u);
    const rows = (await w.call("task.search", { q: `effort:${effort}` }))["rows"] as Json[];
    added.push(...rows.map((row) => String(row["effort"])));
  }
  const wrong = await w.tool("add_tasks", {
    tasks: [{ title: "Fixture wrong size", effort: "NoSuchSize" }],
    request_id: w.rid(),
  });
  return { scale, added, wrong };
}

describe("[A1.3.16.prefs.effort-any] every reader takes the names of any stored list of sizes", () => {
  test("a list whose sizes carry fields this build does not know offers exactly its names", async () => {
    const w = await spaces.next();
    await w.store(
      JSON.stringify([
        { key: "XS", time: { amount: 10, unit: "minutes" } },
        { key: "S" },
        { key: "XL", about: "Too big to plan as one piece" },
      ]),
      1,
    );
    const { scale, added, wrong } = await readers(w, ["XS", "S", "XL"]);
    expect(scale).toEqual({
      key: "tasks.effort_scale",
      value: [{ key: "XS" }, { key: "S" }, { key: "XL" }],
      state: "set",
    });
    expect(added).toEqual(["XS", "S", "XL"]);
    expect(wrong).toContain(hintFor(["XS", "S", "XL"]));
    // M is not a size of this space, though the fallback has it.
    expect(
      await w.refusal("task.add", {
        tasks: [{ title: "Fixture M", effort: "M" }],
        request_id: w.rid(),
      }),
    ).toMatchObject({ hint: hintFor(["XS", "S", "XL"]) });
  });

  test("a newer build's list offers its names, and stays the newer build's to change", async () => {
    const w = await spaces.next();
    await w.store(
      JSON.stringify([
        { key: "XS", time: { amount: 10, unit: "minutes" } },
        { key: "S" },
        { key: "Half a day" },
      ]),
      2,
    );
    const { scale, added, wrong } = await readers(w, ["XS", "S"]);
    expect(scale).toEqual({
      key: "tasks.effort_scale",
      value: [{ key: "XS" }, { key: "S" }, { key: "Half a day" }],
      state: "newer",
    });
    expect(added).toEqual(["XS", "S"]);
    expect(wrong).toContain(hintFor(["XS", "S", "Half a day"]));
    const changed = await w.refusal("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", value: "XS,S,M" }],
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(changed.code).toBe("invalid_input");
    expect((await readSnapshot(readerOf(w.fx.reader))).preferences).toContainEqual(scale);
  });

  test("a space that never set its sizes, or reset them, offers the fallback S, M and L", async () => {
    const w = await spaces.next();
    const missing = await readers(w, ["S", "M", "L"]);
    expect(missing.scale).toEqual({
      key: "tasks.effort_scale",
      value: [{ key: "S" }, { key: "M" }, { key: "L" }],
      state: "default",
    });
    expect(missing.wrong).toContain(hintFor(["S", "M", "L"]));
    await w.call("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", value: null }],
      base: await w.base(),
      request_id: w.rid(),
    });
    const reset = await readers(w, ["S", "M", "L"]);
    expect(reset.scale).toEqual(missing.scale);
    expect(reset.wrong).toContain(hintFor(["S", "M", "L"]));
  });

  test("a list the person set offers its names; a value that is no list of sizes reads as the fallback", async () => {
    const w = await spaces.next();
    await w.setScale(["XS", "S", "M", "L", "XL"]);
    const own = await readers(w, ["XS", "XL"]);
    expect(own.scale).toMatchObject({
      value: [{ key: "XS" }, { key: "S" }, { key: "M" }, { key: "L" }, { key: "XL" }],
      state: "set",
    });
    expect(own.wrong).toContain(hintFor(["XS", "S", "M", "L", "XL"]));
    for (const junk of [["XS", "S"], [{ name: "XS" }], { key: "XS" }, [], [{ key: "" }]]) {
      await w.store(JSON.stringify(junk), 2);
      const snapshot = await readSnapshot(readerOf(w.fx.reader));
      expect(
        snapshot.preferences.find((p) => p.key === "tasks.effort_scale")?.value,
        JSON.stringify(junk),
      ).toEqual([{ key: "S" }, { key: "M" }, { key: "L" }]);
    }
  });
});

describe("[A1.3.16.prefs.effort-longest] a size of the longest name goes through every input", () => {
  test("add_tasks, update_task and a follow-up of complete_task take it, and each answer shows it", async () => {
    const w = await spaces.next();
    const longest = "Deep-work_2.0".padEnd(EFFORT_KEY_MAX, "x");
    expect(longest).toHaveLength(EFFORT_KEY_MAX);
    await w.setScale(["S", longest]);
    const added = await w.tool("add_tasks", {
      tasks: [
        { title: "Fixture added", effort: longest },
        { title: "Fixture updated", effort: "S" },
      ],
      request_id: w.rid(),
    });
    expect(added).not.toMatch(/^error/u);
    const refsOf = async (q: string) =>
      ((await w.call("task.search", { q }))["rows"] as Json[]).map((r) => String(r["ref"]));
    const [small] = await refsOf("effort:S");
    const [large] = await refsOf(`effort:${longest}`);
    const updated = await w.tool("update_task", {
      task: small ?? "",
      set: { effort: longest },
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(updated).not.toMatch(/^error/u);
    const finished = await w.tool("complete_task", {
      task: large ?? "",
      outcome: "Fixture outcome with the evidence",
      follow_ups: [{ title: "Fixture follow-up", effort: longest }],
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(finished).not.toMatch(/^error/u);
    // The updated task and the follow-up are open on it; the finished one keeps it.
    const refs = await refsOf(`effort:${longest}`);
    expect(refs).toHaveLength(2);
    expect(refs).toContain(small);
    const found = await w.tool("search", { q: `effort:${longest}` });
    for (const ref of refs) expect(found).toContain(`${ref} · open · P4 · ${longest} ·`);
    for (const ref of [...refs, large ?? ""]) {
      expect(await w.tool("get_task", { task: ref })).toContain(`Effort: ${longest}`);
      expect(w.file(ref)).toContain(longest);
    }
  });
});

describe("[A3.5.search.effort-exact] search tells apart two sizes that differ only in case", () => {
  test("effort:s finds the tasks on s and effort:S those on S; another case still finds one", async () => {
    const w = await spaces.next();
    await w.store(JSON.stringify([{ key: "s" }, { key: "S" }, { key: "Long" }]), 1);
    await w.tool("add_tasks", {
      tasks: [
        { title: "Fixture lower", effort: "s" },
        { title: "Fixture upper", effort: "S" },
        { title: "Fixture long", effort: "Long" },
      ],
      request_id: w.rid(),
    });
    const titles = async (q: string) =>
      ((await w.call("task.search", { q }))["rows"] as Json[]).map((r) => String(r["title"]));
    expect(await titles("effort:s")).toEqual(["Fixture lower"]);
    expect(await titles("effort:S")).toEqual(["Fixture upper"]);
    expect(await titles("effort:LONG")).toEqual(["Fixture long"]);
  });
});
