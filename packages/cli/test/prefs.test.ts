// `ttasks prefs` as a person reads it: a key this build does not act on yet is still the person's
// to read, though an agent is not shown it. The CLI in this process against a service in this
// process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EFFORT_KEY_MAX, EFFORT_SCALE_MAX, EXIT_CODES } from "@ttasks/contracts";
import { contractWorld, type ContractWorld } from "@ttasks/service/test/contract";
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

describe("[A3.3.4.prefs.tool] ttasks prefs", () => {
  test("a person reads a key nothing acts on yet; a script is not shown it", async () => {
    const person = await tasks(["prefs", "get", "--keys", "autonomy.level", "--json"]);
    expect(person.code).toBe(0);
    expect(JSON.parse(person.stdout)).toMatchObject({
      prefs: [{ key: "autonomy.level", value: "review" }],
    });
    const script = await tasks(["prefs", "get", "--keys", "autonomy.level", "--json"], false);
    expect(script.code).toBe(EXIT_CODES.usage);
  });
});

describe("[A3.3.4.prefs.set] ttasks prefs set", () => {
  test("a person sets the effort scale, reads it back and uses a new size at once; a script and an agent's shell are refused", async () => {
    const scale = ["prefs", "set", "tasks.effort_scale", "XS,S,M,L,XL"];
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
    expect(set.stdout).toBe('tasks.effort_scale: ["S","M","L"] → ["XS","S","M","L","XL"]\n');
    const got = await tasks(["prefs", "get", "--keys", "tasks.effort_scale"]);
    expect(got.stdout).toBe('tasks.effort_scale: ["XS","S","M","L","XL"]\n');
    const added = await tasks(["add", "Fixture sized task", "--effort", "XL", "--json"]);
    expect(added.code).toBe(0);
    const ref = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
    // Dropping the size the new task holds is refused, naming it.
    const dropped = await tasks(["prefs", "set", "tasks.effort_scale", "XS,S,M,L"]);
    expect(dropped.code).toBe(EXIT_CODES.usage);
    expect(dropped.stderr).toContain(
      `Active tasks hold an effort this change removes: ${ref} (XL).`,
    );
    expect((await tasks(["prefs", "get", "--keys", "tasks.effort_scale"])).stdout).toBe(
      'tasks.effort_scale: ["XS","S","M","L","XL"]\n',
    );
  });

  test("ten sizes of the longest name are set, given to a task and printed as they are", async () => {
    const names = [
      "XS",
      "S",
      "M",
      "L",
      "XL",
      ...["Deep-work", "1.5d", "two_days", "Week"].map((n) => n.padEnd(EFFORT_KEY_MAX, "x")),
      "Q".repeat(EFFORT_KEY_MAX),
    ];
    expect(names).toHaveLength(EFFORT_SCALE_MAX);
    const set = await tasks(["prefs", "set", "tasks.effort_scale", names.join(",")]);
    expect(set.stderr).toBe("");
    expect(set.code).toBe(0);
    const longest = names.at(-1) ?? "";
    const added = await tasks(["add", "Fixture longest size", "--effort", longest, "--json"]);
    expect(added.code).toBe(0);
    const ref = (JSON.parse(added.stdout) as { tasks: { ref: string }[] }).tasks[0]?.ref ?? "";
    const found = await tasks(["find", `effort:${longest}`]);
    expect(found.stdout).toContain(`${ref} · open · ${longest} · Fixture longest size`);
  });
});
