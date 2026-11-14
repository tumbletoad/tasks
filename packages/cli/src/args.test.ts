// The CLI's argument parser (A2 3.10.2, A3 3.2.2): generated verbs from cli-spec.json, and usage
// errors that name the option, never its value. Fixture text only.
import { describe, expect, test } from "vitest";
import { parseVerb, splitGlobals, UsageError, verbSpec, type VerbSpec } from "./args.ts";

const SECRET = "Fixture secret text";
const verb = (name: string): VerbSpec => {
  const found = verbSpec(name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
};
const parse = (name: string, args: string[], stdin = "") =>
  parseVerb(verb(name), args, () => Promise.resolve(stdin));

async function usage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("expected a usage error");
}

describe("[A2.3.10.cli.parse] arguments from cli-spec.json", () => {
  test("global flags anywhere, before --", () => {
    const { globals, rest } = splitGlobals([
      "add",
      "--json",
      "Title",
      "--space",
      "Mira",
      "--request-id=fixture-request-000001",
      "--timeout",
      "5",
      "-q",
      "--",
      "--json",
    ]);
    expect(globals).toMatchObject({
      json: true,
      space: "Mira",
      requestId: "fixture-request-000001",
      timeoutS: 5,
      quiet: true,
    });
    expect(rest).toEqual(["add", "Title", "--", "--json"]);
  });

  test("an item verb, flags, a short flag and a typed value", async () => {
    const { input } = await parse("add", ["Fixture title", "-p", "2", "--due", "fri", "--inbox"]);
    expect(input).toEqual({
      tasks: [{ title: "Fixture title", priority: 2, due: "fri", inbox: true }],
    });
  });

  test("key=value for the verb's object, and a repeated flag", async () => {
    const { input } = await parse("set", [
      "M-14",
      "summary=Next step",
      "priority=1",
      "--clear",
      "due",
      "--clear",
      "effort",
    ]);
    expect(input).toEqual({
      task: "M-14",
      set: { summary: "Next step", priority: 1 },
      clear: ["due", "effort"],
    });
  });

  test("two positionals, a fixed value and a text read from stdin", async () => {
    expect((await parse("log", ["M-14", "-", "--kind", "evidence"], "From stdin\n")).input).toEqual(
      {
        task: "M-14",
        text: "From stdin",
        kind: "evidence",
      },
    );
    // An optional positional before a required one is left out first.
    expect((await parse("log", ["Only text"])).input).toEqual({ text: "Only text" });
    expect((await parse("note", ["M-14", "Fixture note"])).input).toEqual({
      task: "M-14",
      text: "Fixture note",
      kind: "note",
    });
    const sections = await parse("show", ["M-14", "--section", "log", "--section", "history"]);
    expect(sections.input).toEqual({ task: "M-14", sections: ["log", "history"] });
  });

  test("--input's JSON is the base, and arguments set fields over it", async () => {
    const { input } = await parseVerb(
      verb("set"),
      ["summary=Override"],
      () => Promise.resolve(""),
      {
        task: "M-1",
        set: { summary: "Base", priority: 3 },
      },
    );
    expect(input).toEqual({ task: "M-1", set: { summary: "Override", priority: 3 } });
  });

  test("usage errors name the option or the verb, never a value", async () => {
    const messages = [
      await usage(parse("add", ["Title", "-p", SECRET])),
      await usage(parse("add", ["Title", `--${SECRET}`])),
      await usage(parse("add", ["Title", "--mode", SECRET])),
      await usage(parse("add", ["Title", SECRET])),
      await usage(parse("add", [])),
      await usage(parse("set", ["M-1", `priority=${SECRET}`])),
    ];
    for (const message of messages) expect(message).not.toContain("secret");
    expect(messages[0]).toBe("--priority takes a whole number");
    expect(messages[1]).toBe("tasks add has no such option");
    expect(messages[4]).toBe("tasks add needs <title>");
    expect(() => splitGlobals(["--request-id", SECRET])).toThrow(/^--request-id takes/);
    expect(() => splitGlobals(["--timeout", SECRET])).toThrow(
      "--timeout takes a whole number of seconds",
    );
  });
});
