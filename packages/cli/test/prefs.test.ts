// `ttasks prefs` as a person reads it: a key this build does not act on yet is still the person's
// to read, though an agent is not shown it. The CLI in this process against a service in this
// process; fixture text and temporary folders only.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EFFORT_LEVELS, EFFORT_NAME_MAX, EFFORT_SCALE_MAX, EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
import { openSpaceConnection } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
import { runMain, type Ran } from "./cli-harness.ts";

let w: ContractWorld & { root: string };
const LONG = 120_000;

beforeAll(async () => {
  w = await contractWorld("cp");
}, LONG);
afterAll(async () => {
  await w.close();
}, LONG);

/** `ttasks <args>` from a terminal (the person), or from a script. */
const tasks = (args: readonly string[], terminal = true): Promise<Ran> =>
  runMain(args, { home: w.home, tty: terminal });

/** The first line of a prefs answer: the key and its value, a list of levels by their names. */
const firstLine = (ran: Ran): string => ran.stdout.split("\n")[0] ?? "";

describe("[A3.3.4.prefs.tool] ttasks prefs", () => {
  test("a person reads a key nothing acts on yet, with what is in force; a script is not shown it", async () => {
    const person = await tasks(["prefs", "get", "--keys", "autonomy.level", "--json"]);
    expect(person.code).toBe(0);
    expect(JSON.parse(person.stdout)).toMatchObject({
      prefs: [{ key: "autonomy.level", value: "review", in_force: "full" }],
    });
    expect((await tasks(["prefs", "get", "autonomy.level"])).stdout).toBe(
      'autonomy.level: "review" (default) · policy · in force: "full", as this build does not read it yet\n',
    );
    const script = await tasks(["prefs", "get", "--keys", "autonomy.level", "--json"], false);
    expect(script.code).toBe(EXIT_CODES.usage);
  });
});

describe("[A1.3.16.prefs.effort-stored] a new space holds its levels", () => {
  test("a space made through the service has the five default levels stored, by its own act", async () => {
    const conn = openSpaceConnection(
      await checkedDriver(),
      join(w.root, "s", "mira", "space.db"),
      "reader",
    );
    try {
      const row = conn
        .prepare(
          "SELECT p.value AS value, k.actor_kind AS actor, k.undo_status AS undo " +
            "FROM preferences p JOIN commits k ON k.seq = p.version " +
            "WHERE p.key = 'tasks.effort_scale'",
        )
        .get();
      expect(row).toMatchObject({ actor: "system", undo: null });
      expect(JSON.parse(String(row?.["value"]))).toEqual(EFFORT_LEVELS);
    } finally {
      conn.close();
    }
    expect(firstLine(await tasks(["prefs", "get", "tasks.effort_scale"]))).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL"] (default)',
    );
  });
});

describe("[A3.3.4.prefs.set] ttasks prefs set", () => {
  test("--reset puts the default levels back; a level called null is refused; get <key> reads that key", async () => {
    expect((await tasks(["prefs", "set", "tasks.effort_scale", "S,M,L,XL"])).code).toBe(0);
    const typed = await tasks(["prefs", "set", "tasks.effort_scale", "null"]);
    expect(typed.code).toBe(EXIT_CODES.usage);
    expect(typed.stderr).toContain("reset puts it back to its default");
    const got = await tasks(["prefs", "get", "tasks.effort_scale"]);
    expect(got.code).toBe(0);
    // Each level that stayed kept its time and line: one line each under the names.
    expect(got.stdout.split("\n")).toEqual([
      'tasks.effort_scale: ["S","M","L","XL"]',
      "  S: about 1 hour. A reply that needs some reading first; a small, clear fix; checking an agent's short change",
      "  M: about 4 hours. One long focused sitting: a summary of a few sources; a meeting prepared with its papers",
      "  L: about 2 days. Work over several sittings: a first draft of a report; a design for a feature; a tax return",
      "  XL: about 1 week. A week or more: too big to plan as one piece, a signal to split it",
      "",
    ]);
    const reset = await tasks(["prefs", "set", "tasks.effort_scale", "--reset"]);
    expect(reset.code).toBe(0);
    expect(firstLine(reset)).toBe(
      'tasks.effort_scale: ["S","M","L","XL"] → ["XS","S","M","L","XL"]',
    );
    expect(reset.stdout).toContain("\n  XS: about 10 minutes. A quick reply");
    expect(firstLine(await tasks(["prefs", "get", "tasks.effort_scale"]))).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL"] (default)',
    );
    const both = await tasks(["prefs", "set", "tasks.effort_scale", "S,M", "--reset"]);
    expect(both.code).toBe(EXIT_CODES.usage);
  });

  test("a person adds a level, reads it back and uses it at once; a script and an agent's shell are refused", async () => {
    const scale = ["prefs", "set", "tasks.effort_scale", "XS, S, M, L, XL, Two weeks"];
    for (const refused of [
      await tasks(scale, false),
      await runMain([...scale, "--space", w.space], {
        home: w.home,
        tty: true,
        env: { CLAUDECODE: "1" },
      }),
    ]) {
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toBe(
        "error forbidden: Only the user can do this. Ask the user to do this in TTasks.\n",
      );
    }
    const set = await tasks(scale);
    expect(set.code).toBe(0);
    expect(firstLine(set)).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL"] → ["XS","S","M","L","XL","Two weeks"]',
    );
    const got = await tasks(["prefs", "get", "--keys", "tasks.effort_scale"]);
    expect(firstLine(got)).toBe('tasks.effort_scale: ["XS","S","M","L","XL","Two weeks"]');
    // A level with neither a time nor a line has no line of its own.
    expect(got.stdout).not.toContain("  Two weeks");
    const added = await tasks(["add", "Fixture sized task", "--effort", "Two weeks", "--json"]);
    expect(added.code).toBe(0);
    // Dropping the level the new task holds is refused, saying how to take it along.
    const dropped = await tasks(["prefs", "set", "tasks.effort_scale", "XS,S,M,L,XL"]);
    expect(dropped.code).toBe(EXIT_CODES.usage);
    expect(dropped.stderr).toContain(
      "Tasks hold a size this change removes: Two weeks (1 active). Nothing was changed.",
    );
    expect(dropped.stderr).toContain('--move "Two weeks=<level>"');
    // A new name longer than a level's name may be is refused, saying so.
    const long = await tasks([
      "prefs",
      "set",
      "tasks.effort_scale",
      `XS,S,M,L,XL,Two weeks,${"W".repeat(EFFORT_NAME_MAX + 1)}`,
    ]);
    expect(long.code).toBe(EXIT_CODES.usage);
    expect(long.stderr).toContain(
      `A new level's name has at most ${String(EFFORT_NAME_MAX)} characters`,
    );
    expect(firstLine(await tasks(["prefs", "get", "--keys", "tasks.effort_scale"]))).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL","Two weeks"]',
    );
  });

  test("[A3.3.4.prefs.file] the levels go out with --json and back in whole with --file, against the base they were read at", async () => {
    const read = await tasks(["prefs", "get", "tasks.effort_scale", "--json"]);
    expect(read.code).toBe(0);
    const out = JSON.parse(read.stdout) as {
      as_of: string;
      prefs: { key: string; value: { key: string; time?: unknown; about?: string }[] }[];
    };
    const row = out.prefs[0];
    if (row === undefined) throw new Error("no row");
    expect(row.value.map((level) => level.key)).toEqual(["XS", "S", "M", "L", "XL", "Two weeks"]);
    // The person edits the file: a time and a line for the new level, another line for S.
    const two = row.value.find((level) => level.key === "Two weeks");
    const small = row.value.find((level) => level.key === "S");
    if (two === undefined || small === undefined) throw new Error("no level");
    two.time = { amount: 2, unit: "weeks" };
    two.about = "A project of its own";
    small.about = "A reply after some reading";
    const file = join(w.root, "levels.json");
    writeFileSync(file, JSON.stringify(out, null, 2));
    const set = await tasks(["prefs", "set", "tasks.effort_scale", "--file", file]);
    expect(set.stderr).toBe("");
    expect(set.code).toBe(0);
    const got = await tasks(["prefs", "get", "tasks.effort_scale"]);
    expect(got.stdout).toContain("\n  S: about 1 hour. A reply after some reading\n");
    expect(got.stdout).toContain("\n  Two weeks: about 2 weeks. A project of its own\n");
    // A newer line for S, from a fresh read.
    const fresh = JSON.parse(
      (await tasks(["prefs", "get", "tasks.effort_scale", "--json"])).stdout,
    ) as typeof out;
    const freshSmall = fresh.prefs[0]?.value.find((level) => level.key === "S");
    if (freshSmall === undefined) throw new Error("no level");
    freshSmall.about = "The newest line for S";
    const newer = join(w.root, "newer.json");
    writeFileSync(newer, JSON.stringify(fresh));
    expect((await tasks(["prefs", "set", "tasks.effort_scale", "--file", newer])).code).toBe(0);
    // The older file again: its base is older than the newer line, so it is refused, saying how
    // to go on; and so is the same file with its as_of lost in an edit.
    const before = readFileSync(file, "utf8");
    const again = await tasks(["prefs", "set", "tasks.effort_scale", "--file", file]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toMatch(/^error conflict/u);
    expect(again.stderr).toContain("read it again, make your change to what it holds now");
    expect(again.stderr).not.toContain("Read the task again");
    for (const as_of of [undefined, null, "1.1"]) {
      const lost = join(w.root, "lost.json");
      writeFileSync(lost, JSON.stringify({ ...out, as_of }));
      const ran = await tasks(["prefs", "set", "tasks.effort_scale", "--file", lost]);
      expect(ran.code).toBe(EXIT_CODES.usage);
      expect(ran.stderr).toContain("without its as_of");
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await tasks(["prefs", "get", "tasks.effort_scale"])).stdout).toContain(
      "\n  S: about 1 hour. The newest line for S\n",
    );
    // The value alone, as a person writes it by hand, needs no base.
    const bare = join(w.root, "bare.json");
    writeFileSync(bare, JSON.stringify([...row.value, { key: "Later" }]));
    const added = await tasks(["prefs", "set", "tasks.effort_scale", `--file=${bare}`]);
    expect(added.code).toBe(0);
    expect(firstLine(await tasks(["prefs", "get", "tasks.effort_scale"]))).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL","Two weeks","Later"]',
    );
    for (const wrong of [
      ["--file", join(w.root, "missing.json")],
      ["--file", file, "--reset"],
      ["XS", "--file", file],
    ]) {
      expect((await tasks(["prefs", "set", "tasks.effort_scale", ...wrong])).code).toBe(
        EXIT_CODES.usage,
      );
    }
  });

  test("ten levels of the longest name are set, given to a task and printed as they are", async () => {
    const names = [
      "XS",
      "S",
      "M",
      "L",
      "Two weeks",
      "Later",
      ...["Deep-work", "1.5d", "two days"].map((n) => n.padEnd(EFFORT_NAME_MAX, "x")),
      "Q".repeat(EFFORT_NAME_MAX),
    ];
    expect(names).toHaveLength(EFFORT_SCALE_MAX);
    const set = await tasks(["prefs", "set", "tasks.effort_scale", names.join(",")]);
    expect(set.stderr).toBe("");
    expect(set.code).toBe(0);
    for (const longest of [names.at(-1) ?? "", names.at(-2) ?? ""]) {
      const added = await tasks(["add", "Fixture longest size", "--effort", longest, "--json"]);
      expect(added.code).toBe(0);
      const ref = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
      const found = await tasks(["find", `effort:"${longest}"`]);
      expect(found.stdout).toContain(`${ref} · open · ${longest} · Fixture longest size`);
    }
  });
});

describe("[A3.3.4.prefs.move] ttasks prefs set --move", () => {
  test("--dry-run says how many tasks would move; --move moves them with the change; X= takes the size off", async () => {
    const levels = async (): Promise<string[]> =>
      (
        JSON.parse((await tasks(["prefs", "get", "tasks.effort_scale", "--json"])).stdout) as {
          prefs: { value: { key: string }[] }[];
        }
      ).prefs[0]?.value.map((level) => level.key) ?? [];
    const before = await levels();
    const added = await tasks(["add", "Fixture later task", "--effort", "Later", "--json"]);
    const ref = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
    const renamed = before.map((name) => (name === "Later" ? "Soon" : name)).join(",");
    const set = ["prefs", "set", "tasks.effort_scale", renamed, "--move", "Later=Soon"];
    const dry = await tasks([...set, "--dry-run"]);
    expect([dry.code, dry.stdout]).toEqual([
      0,
      "Would move 1 task from Later to Soon. Nothing was changed.\n",
    ]);
    expect(await levels()).toEqual(before);
    const moved = await tasks(set);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain("1 task moved from Later to Soon.\n");
    expect((await tasks(["find", "effort:Soon"])).stdout).toContain(ref);
    const undone = await tasks(["undo"]);
    expect(undone.stdout).toMatch(/^Undid your change to the effort levels and 1 task in /u);
    expect(await levels()).toEqual(before);
    expect((await tasks(["redo"])).code).toBe(0);
    const dropped = before.filter((name) => name !== "Later").join(",");
    const off = await tasks(["prefs", "set", "tasks.effort_scale", dropped, "--move", "Soon="]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("1 task moved from Soon to no size.\n");
  });
});

describe("[A3.3.4.prefs.move-preview] ttasks prefs set --dry-run answers as the write would", () => {
  test("a move the write refuses is refused, and a move to the same name moves nothing, in the preview and the answer", async () => {
    const read = await tasks(["prefs", "get", "tasks.effort_scale", "--json"]);
    const names =
      (JSON.parse(read.stdout) as { prefs: { value: { key: string }[] }[] }).prefs[0]?.value.map(
        (level) => level.key,
      ) ?? [];
    const [first = ""] = names;
    const set = ["prefs", "set", "tasks.effort_scale", names.join(",")];
    const missing = await tasks([...set, "--move", `${first}=Missing`, "--dry-run"]);
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.stderr).toContain("A move goes to a level of the new list, or to no size.");
    const same = await tasks([...set, "--move", `${first}=${first}`, "--dry-run"]);
    expect([same.code, same.stdout]).toEqual([
      0,
      `Would move 0 tasks from ${first} to ${first}. Nothing was changed.\n`,
    ]);
    const applied = await tasks([...set, "--move", `${first}=${first}`]);
    expect(applied.stdout).toContain(`0 tasks moved from ${first} to ${first}.`);
  });
});
