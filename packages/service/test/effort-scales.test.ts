// The effort scale as every reader takes it: the levels of any stored list, whatever its
// version or the fields of its items, a size of the longest name through every input, and search
// that tells two sizes apart that differ only in case. Fixture text only.
import { EFFORT_KEY_MAX, EFFORT_LEVELS, EFFORT_NAME_MAX } from "@ttasks/contracts";
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
    const rows = (await w.call("task.search", { q: `effort:"${effort}"` }))["rows"] as Json[];
    added.push(...rows.map((row) => String(row["effort"])));
  }
  const wrong = await w.tool("add_tasks", {
    tasks: [{ title: "Fixture wrong size", effort: "NoSuchSize" }],
    request_id: w.rid(),
  });
  return { scale, added, wrong };
}

const level = (key: string) => EFFORT_LEVELS.find((known) => known.key === key) ?? { key };

describe("[A1.3.16.prefs.effort-any] every reader takes the names of any stored list of sizes", () => {
  test("a list of names an earlier build stored: a default level's name means that level, another stays a name", async () => {
    const w = await spaces.next();
    await w.store(JSON.stringify([{ key: "XS" }, { key: "S" }, { key: "Q" }]), 1);
    const { scale, added, wrong } = await readers(w, ["XS", "S", "Q"]);
    expect(scale).toEqual({
      key: "tasks.effort_scale",
      value: [level("XS"), level("S"), { key: "Q" }],
      state: "set",
    });
    expect(added).toEqual(["XS", "S", "Q"]);
    expect(wrong).toContain(hintFor(["XS", "S", "Q"]));
    // M is not a level of this space, though the defaults have it.
    expect(
      await w.refusal("task.add", {
        tasks: [{ title: "Fixture M", effort: "M" }],
        request_id: w.rid(),
      }),
    ).toMatchObject({ hint: hintFor(["XS", "S", "Q"]) });
    // What the tasks hold never changes by the reading; a set by names writes what was read.
    await w.setScale(["XS", "S", "Q", "XL"]);
    const shown = (await w.call("prefs.manage", { action: "get", keys: ["tasks.effort_scale"] }))[
      "prefs"
    ] as Json[];
    expect(shown[0]?.["value"]).toEqual([level("XS"), level("S"), { key: "Q" }, { key: "XL" }]);
  });

  test("a newer build's list offers its names, and stays the newer build's to change", async () => {
    const w = await spaces.next();
    await w.store(
      JSON.stringify([
        { key: "XS", time: { amount: 10, unit: "minutes" }, colour: "teal" },
        { key: "S", time: { amount: 1, unit: "fortnights" } },
        { key: "Half a day", about: "One sitting" },
      ]),
      3,
    );
    const { scale, added, wrong } = await readers(w, ["XS", "S"]);
    expect(scale).toEqual({
      key: "tasks.effort_scale",
      value: [
        { key: "XS", time: { amount: 10, unit: "minutes" } },
        { key: "S" },
        { key: "Half a day", about: "One sitting" },
      ],
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
    // Also when the change would drop a size a task holds: the reason is the newer build, said
    // first, so nobody moves tasks for a change this build cannot make.
    const dropping = await w.refusal("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", value: "S,M,L" }],
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(dropping.message).toContain("newer build");
    expect(dropping.message).not.toContain("Active tasks");
    const shown = (await w.call("prefs.manage", { action: "get", keys: ["tasks.effort_scale"] }))[
      "prefs"
    ] as Json[];
    expect(shown[0]).toMatchObject({ key: "tasks.effort_scale", writable: false });
    expect((await readSnapshot(readerOf(w.fx.reader))).preferences).toContainEqual(scale);
  });

  test("a space that never set its levels, or reset them, has the five default levels", async () => {
    const w = await spaces.next();
    const names = EFFORT_LEVELS.map((known) => known.key);
    const missing = await readers(w, names);
    expect(missing.scale).toEqual({
      key: "tasks.effort_scale",
      value: EFFORT_LEVELS,
      state: "default",
    });
    expect(missing.wrong).toContain(hintFor(names));
    await w.setScale([...names, "XXL"]);
    await w.call("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", reset: true }],
      base: await w.base(),
      request_id: w.rid(),
    });
    // A reset stores the five, so it reads as set.
    const reset = await readers(w, names);
    expect(reset.scale).toEqual({ ...missing.scale, state: "set" });
    expect(reset.wrong).toContain(hintFor(names));
  });

  test("a list the person set offers its levels; a value that is no list of levels reads as the defaults", async () => {
    const w = await spaces.next();
    await w.setScale(["S", "M", "Half a day"]);
    const own = await readers(w, ["S", "Half a day"]);
    expect(own.scale).toEqual({
      key: "tasks.effort_scale",
      value: [level("S"), level("M"), { key: "Half a day" }],
      state: "set",
    });
    expect(own.wrong).toContain(hintFor(["S", "M", "Half a day"]));
    for (const junk of [["XS", "S"], [{ name: "XS" }], { key: "XS" }, [], [{ key: "" }]]) {
      await w.store(JSON.stringify(junk), 2);
      const snapshot = await readSnapshot(readerOf(w.fx.reader));
      expect(
        snapshot.preferences.find((p) => p.key === "tasks.effort_scale")?.value,
        JSON.stringify(junk),
      ).toEqual(EFFORT_LEVELS);
    }
  });
});

describe("[A1.3.16.prefs.effort-stored] a space holds its levels, so every build reads the same", () => {
  /** The stored row of the levels, and the commit that last wrote one: by whom, from where. */
  const stored = (w: EffortWorld) =>
    w.fx.reader
      .prepare(
        "SELECT p.value AS value, p.schema_ver AS ver, k.actor_kind AS actor, k.origin AS origin, " +
          "k.undo_status AS undo FROM preferences p LEFT JOIN commits k ON k.seq = p.version " +
          "WHERE p.key = 'tasks.effort_scale'",
      )
      .get();
  const prefs = async (w: EffortWorld) =>
    (
      (await w.call("prefs.manage", { action: "get", keys: ["tasks.effort_scale"] }))[
        "prefs"
      ] as Json[]
    )[0];

  test("a space without levels stores the five as its own act, once; Undo leaves them; a reset stores them again", async () => {
    const w = await spaces.next();
    // The person's own change, then the space opens and stores its levels.
    await w.call("task.add", { tasks: [{ title: "Fixture undone task" }], request_id: w.rid() });
    expect(w.fx.writer.storeDefaults()).toBe(true);
    expect(w.fx.writer.storeDefaults()).toBe(false);
    const row = stored(w);
    expect(row).toMatchObject({ ver: 2, actor: "system", origin: "system", undo: null });
    expect(JSON.parse(String(row?.["value"]))).toEqual(EFFORT_LEVELS);
    expect(await prefs(w)).toMatchObject({ value: EFFORT_LEVELS, is_default: true });
    // Ctrl+Z takes back the person's change and leaves the levels.
    await w.call("history.undo", { request_id: w.rid() });
    expect(
      w.fx.reader
        .prepare("SELECT count(*) AS n FROM tasks WHERE deleted_at IS NULL AND title = $t")
        .get({ t: "Fixture undone task" })?.["n"],
    ).toBe(0);
    expect(JSON.parse(String(stored(w)?.["value"]))).toEqual(EFFORT_LEVELS);
    // A reset stores the five, by the person.
    await w.setScale(["XS", "S"]);
    await w.call("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", reset: true }],
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(stored(w)).toMatchObject({ ver: 2, actor: "human" });
    expect(JSON.parse(String(stored(w)?.["value"]))).toEqual(EFFORT_LEVELS);
    // A reset an earlier build left as null gets the five at the next open.
    await w.store("null", 1);
    expect(w.fx.writer.storeDefaults()).toBe(true);
    expect(stored(w)).toMatchObject({ ver: 2, actor: "system" });
    expect(JSON.parse(String(stored(w)?.["value"]))).toEqual(EFFORT_LEVELS);
  });

  test("a list of names stays as it is at an open; its untouched export saved back changes nothing", async () => {
    const w = await spaces.next();
    const names = EFFORT_LEVELS.map((known) => known.key);
    const v1 = JSON.stringify(names.map((key) => ({ key })));
    await w.store(v1, 1);
    expect(w.fx.writer.storeDefaults()).toBe(false);
    expect(stored(w)).toMatchObject({ value: v1, ver: 1 });
    const read = await prefs(w);
    expect(read).toMatchObject({ value: EFFORT_LEVELS, is_default: true });
    const saved = await w.call("prefs.manage", {
      action: "set",
      set: [{ key: "tasks.effort_scale", value: read?.["value"] }],
      base: await w.base(),
      request_id: w.rid(),
    });
    expect(saved).toMatchObject({ result: "no_change", changed: [] });
    expect(await prefs(w)).toMatchObject({ value: EFFORT_LEVELS, is_default: true });
  });

  test("the system stores only the default, only where nothing is stored", async () => {
    const w = await spaces.next();
    await w.setScale(["XS", "S"]);
    const system = String(
      w.fx.reader.prepare("SELECT id FROM actors WHERE kind = 'system'").get()?.["id"],
    );
    const result = w.fx.writer.submit({
      space_id: w.fx.spaceId,
      request_id: "fixture-system-levels-01",
      actor: {
        scope_id: "defaults",
        principal_id: system,
        actor_kind: "system",
        machine_id: w.fx.human.machine_id,
        origin: "system",
      },
      base: await w.base(),
      ops: [{ kind: "pref.set", key: "tasks.effort_scale", value: EFFORT_LEVELS }],
    });
    expect(result.error).toMatchObject({ code: "PREFERENCE_FORBIDDEN" });
  });
});

describe("[A1.3.16.prefs.effort-longest] a size of the longest name goes through every input", () => {
  test.each([
    ["a name the person sets", "Half a day"],
    [
      "a longer name an earlier build let the person set",
      "Deep-work_2.0".padEnd(EFFORT_KEY_MAX, "x"),
    ],
  ])(
    "add_tasks, update_task and a follow-up of complete_task take %s, and each answer shows it",
    async (_, longest) => {
      const w = await spaces.next();
      expect([EFFORT_NAME_MAX, EFFORT_KEY_MAX]).toContain(longest.length);
      if (longest.length > EFFORT_NAME_MAX) {
        await w.store(JSON.stringify([{ key: "S" }, { key: longest }]), 1);
        // It stays while the person changes the levels around it, and cannot be set anew.
        await w.setScale(["XS", "S", longest]);
        const anew = await w.refusal("prefs.manage", {
          action: "set",
          set: [{ key: "tasks.effort_scale", value: `XS,S,${longest},${longest.slice(0, -1)}` }],
          base: await w.base(),
          request_id: w.rid(),
        });
        expect(anew).toMatchObject({
          code: "invalid_input",
          message: `A new level's name has at most ${String(EFFORT_NAME_MAX)} characters.`,
        });
      } else await w.setScale(["S", longest]);
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
      const [large] = await refsOf(`effort:"${longest}"`);
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
      const refs = await refsOf(`effort:"${longest}"`);
      expect(refs).toHaveLength(2);
      expect(refs).toContain(small);
      const found = await w.tool("search", { q: `effort:"${longest}"` });
      for (const ref of refs) expect(found).toContain(`${ref} · open · P4 · ${longest} ·`);
      for (const ref of [...refs, large ?? ""]) {
        expect(await w.tool("get_task", { task: ref })).toContain(`Effort: ${longest}`);
        expect(w.file(ref)).toContain(longest);
      }
    },
  );
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
