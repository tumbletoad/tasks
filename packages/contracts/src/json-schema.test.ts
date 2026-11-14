// Every generated JSON Schema is valid draft 2020-12 (A3 5), and the RPC methods carry A6 3.3's
// metadata.
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { ACTOR_KINDS_BY_CLASS, SCOPES, REMOTE_CLASSES, type AnyEntry } from "./define.ts";
import { entryAdd } from "./entries/entry-add.ts";
import { taskGet, TaskGetResult, TaskSections } from "./entries/task-get.ts";
import { taskUpdate } from "./entries/task-update.ts";
import { rpcMethods } from "./gen/artefacts.ts";
import {
  agentInputJsonSchema,
  inputJsonSchema,
  outputJsonSchema,
  type JsonSchema,
} from "./json-schema.ts";
import { registry } from "./registry.ts";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });

describe("[A3.5.registry.json-schema] generated JSON Schema and registry metadata", () => {
  for (const entry of registry as readonly AnyEntry[]) {
    test(`${entry.name}: input, agent input and output are valid draft 2020-12`, () => {
      for (const schema of [
        inputJsonSchema(entry),
        agentInputJsonSchema(entry),
        outputJsonSchema(entry),
      ]) {
        expect(ajv.validateSchema(schema), JSON.stringify(ajv.errors)).toBe(true);
        expect(() => ajv.compile(schema)).not.toThrow();
        expect(schema["$schema"]).toBeUndefined();
        // A result with variants is a union of strict objects.
        const variants = (schema["anyOf"] as Record<string, unknown>[] | undefined) ?? [schema];
        for (const v of variants) expect(v["additionalProperties"]).toBe(false);
      }
    });
  }

  test("task.get's result has a typed payload for every section its input accepts", () => {
    const input = inputJsonSchema(taskGet) as {
      properties: { sections: { items: { enum: string[] } } };
    };
    const offered = input.properties.sections.items.enum;
    // proposals waits for M4.02, which defines its records.
    expect(offered).toEqual([
      "instructions",
      "context",
      "notes",
      "log",
      "sources",
      "outcome",
      "history",
      "sessions",
    ]);
    // A section's payload, and for the context the part a page holds of it (`context_slice`).
    const payloads = Object.keys(TaskSections.shape).filter((key) => key !== "context_slice");
    expect(payloads.sort()).toEqual([...offered].sort());
    expect(TaskSections.shape.context_slice).toBeDefined();
    const shown = new Set<string>();
    const views = new Set<string>();
    for (const example of taskGet.examples) {
      const output = TaskGetResult.parse(example.output);
      views.add(output.view);
      if (output.view === "sections") {
        const asked = example.input.sections ?? [];
        expect(Object.keys(output.sections).sort(), example.title).toEqual([...asked].sort());
        for (const section of asked) shown.add(section);
      }
    }
    expect([...shown].sort()).toEqual([...offered].sort());
    // The digest, the sections and a routine's launch, which returns the status overview.
    expect([...views].sort()).toEqual(["digest", "sections", "status"]);
  });

  test("a result accepts every value A1 can store, not only what an agent may write", () => {
    // A1 3.4: log_entries.kind and sources.kind.
    const storedLogKinds = ["progress", "evidence", "blocker", "decision", "question", "handoff"];
    const storedSourceKinds = [
      "email",
      "chat",
      "ticket",
      "pr",
      "issue",
      "doc",
      "calendar",
      "crash",
      "session",
      "book",
      "web",
      "other",
    ];
    // The review's probe: a stored handoff entry failed task.get's result in Zod and Ajv.
    const [digest] = taskGet.examples;
    if (digest?.output.view !== "digest") throw new Error("the first example is a digest");
    const { task } = digest.output;
    const validate = ajv.compile(outputJsonSchema(taskGet));
    const verdict = (value: unknown) => [taskGet.output.safeParse(value).success, validate(value)];
    const [log] = task.log;
    const [source] = task.sources;
    for (const kind of storedLogKinds) {
      const value = { ...digest.output, task: { ...task, log: [{ ...log, kind }] } };
      expect(verdict(value), kind).toEqual([true, true]);
    }
    for (const kind of storedSourceKinds) {
      const value = { ...digest.output, task: { ...task, sources: [{ ...source, kind }] } };
      expect(verdict(value), kind).toEqual([true, true]);
    }
    // What a caller may write is a subset of what is stored.
    const entryKinds = (inputJsonSchema(entryAdd)["properties"] as Record<string, JsonSchema>)[
      "kind"
    ]?.["enum"] as string[];
    expect(entryKinds.filter((k) => k !== "note").every((k) => storedLogKinds.includes(k))).toBe(
      true,
    );
    const sourceKinds = (
      (
        (inputJsonSchema(taskUpdate)["properties"] as Record<string, JsonSchema>)["add_sources"]?.[
          "items"
        ] as { properties: Record<string, JsonSchema> }
      ).properties["kind"]?.["enum"] as string[]
    ).filter((k) => !storedSourceKinds.includes(k));
    expect(sourceKinds).toEqual([]);
  });

  test("a task's due is A1's date-only or timed commitment, never a bare offset time", () => {
    // A1 3.4: due_date, never shifted to UTC, or due_at with its IANA zone due_tz.
    const [digest] = taskGet.examples;
    if (digest?.output.view !== "digest") throw new Error("the first example is a digest");
    const { output } = digest;
    const validate = ajv.compile(outputJsonSchema(taskGet));
    const verdict = (due: unknown) => {
      const value = { ...output, task: { ...output.task, due } };
      return [taskGet.output.safeParse(value).success, validate(value)];
    };
    expect(verdict("2026-11-13")).toEqual([true, true]);
    expect(verdict({ at: "2026-11-13T09:30:00Z", tz: "Europe/Lisbon" })).toEqual([true, true]);
    expect(verdict({ at: "2026-11-13T09:30:00.000Z", tz: "America/New_York" })).toEqual([
      true,
      true,
    ]);
    // An offset time loses the zone, and a timed due without its zone is not what A1 stores.
    for (const due of [
      "2026-11-13T09:30:00+00:00",
      { at: "2026-11-13T09:30:00Z" },
      { at: "2026-11-13T10:30:00+01:00", tz: "Europe/Lisbon" },
      { at: "2026-11-13T09:30:00Z", tz: "Europe/Lisbon", date: "2026-11-13" },
    ]) {
      expect(verdict(due), JSON.stringify(due)).toEqual([false, false]);
    }
    // A task without a due commitment leaves the field out.
    const withoutDue = Object.fromEntries(Object.entries(output.task).filter(([k]) => k !== "due"));
    expect(taskGet.output.safeParse({ ...output, task: withoutDue }).success).toBe(true);
  });

  test("every RPC method carries its actor kinds, scope, remote class and audience filter", () => {
    const { methods } = rpcMethods(registry);
    expect(methods.map((m) => m.name)).toEqual(registry.map((e) => e.name));
    for (const m of methods) {
      expect(m.actorKinds).toEqual(ACTOR_KINDS_BY_CLASS[m.actors]);
      expect(SCOPES).toContain(m.scope);
      expect(REMOTE_CLASSES).toContain(m.remote);
      expect(["caller", "none"]).toContain(m.audience);
      // R7: nothing an agent can call executes on a machine.
      expect(m.remote).not.toBe("execute");
    }
  });
});
