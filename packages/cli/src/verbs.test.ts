// The base a verb's write needs when the person gives none: every verb whose contract says the CLI
// fills `base` can read one, for each of its writes, by a read that writes nothing.
import { describe, expect, test } from "vitest";
import { CLI_SPEC, type VerbSpec } from "./args.ts";
import { baseRead } from "./verbs.ts";

/** A verb's writes as inputs: one per write action, or one about a task. */
function writesOf(verb: VerbSpec): Record<string, unknown>[] {
  const actions = verb.actions;
  if (actions === undefined) return [{}, { task: "M-14" }];
  const values = verb.positionals.find((p) => p.field === actions.field)?.values ?? [];
  return values
    .filter((value) => !actions.reads.includes(String(value)))
    .map((value) => ({ [actions.field]: value }));
}

describe("[A3.2.cli.base] every verb whose base the command line fills can read one", () => {
  const filled = CLI_SPEC.verbs.filter((verb) => verb.auto.includes("base"));

  test.each(filled.map((verb) => [verb.verb, verb] as const))(
    "tasks %s reads a base for each of its writes, by a read",
    (_name, verb) => {
      const writes = writesOf(verb);
      expect(writes.length, verb.verb).toBeGreaterThan(0);
      for (const input of writes) {
        const read = baseRead(verb, input);
        // A create makes something new: nothing to base it on.
        if (input["action"] === "create") {
          expect(read, JSON.stringify(input)).toBeUndefined();
          continue;
        }
        expect(read, `${verb.verb} ${JSON.stringify(input)}`).toBeDefined();
        const reads =
          read?.op === "task.get" ||
          (read?.op === verb.entry &&
            verb.actions?.reads.includes(String(read.input[verb.actions.field])) === true);
        expect(reads, `${verb.verb} ${JSON.stringify(input)}`).toBe(true);
      }
    },
  );

  test("a task verb reads the task it names, or without one the bound task, as its write does", () => {
    const set = CLI_SPEC.verbs.find((verb) => verb.entry === "task.update");
    expect(set).toBeDefined();
    if (set === undefined) return;
    expect(baseRead(set, { task: "M-14" })).toEqual({ op: "task.get", input: { task: "M-14" } });
    expect(baseRead(set, {})).toEqual({ op: "task.get", input: {} });
  });
});
