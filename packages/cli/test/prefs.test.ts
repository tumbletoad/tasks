// `ttasks prefs` as a person reads it: a key this build does not act on yet is still the person's
// to read, though an agent is not shown it. The CLI in this process against a service in this
// process; fixture text and temporary folders only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT_CODES } from "@ttasks/contracts";
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
