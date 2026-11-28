// The agent input, built from the entry's rules by path, and the MCP tool list
// it feeds.
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  inputSchemaFor,
  isAgentAllowed,
  parseInput,
  under,
  type AgentRules,
  type AnyEntry,
  type Defaults,
  type Pairs,
} from "./define.ts";
import { entryAdd, EntryAddInput } from "./entries/entry-add.ts";
import { taskAdd } from "./entries/task-add.ts";
import { taskFinish, TaskFinishInput } from "./entries/task-finish.ts";
import { TaskGetInput } from "./entries/task-get.ts";
import { receiptGet, ReceiptGetInput } from "./entries/receipt-get.ts";
import { taskUpdate, TaskUpdateInput } from "./entries/task-update.ts";
import { mcpTools, rpcMethods } from "./gen/artefacts.ts";
import { isOffered } from "./later.ts";
import { agentInputJsonSchema, inputJsonSchema, toJsonSchema } from "./json-schema.ts";
import { registry, type ParsedInputOf } from "./registry.ts";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });

const request_id = "7f3c2a10-5d4e-4b8a-9c61-2e0f3a7b9d55";
const agentOf = (entry: AnyEntry) => inputSchemaFor(entry, "agent");

describe("[A3.5.registry.agent-projection] agent projection and the MCP tool list", () => {
  test("a hidden field is dropped, so an agent cannot send it", () => {
    const note = { task: "M-14", kind: "note", text: "For agents.", for_agents: true, request_id };
    expect(EntryAddInput.safeParse(note).success).toBe(true);
    const agent = agentOf(entryAdd);
    expect(agent.safeParse(note).success).toBe(false);
    const withoutFlag: Partial<typeof note> = { ...note };
    delete withoutFlag.for_agents;
    expect(agent.safeParse(withoutFlag).success).toBe(true);
  });

  test("a required field is optional for the user and required for agents", () => {
    const checkOff = { task: "M-15", base: "1.1046.5n0w8k3q", request_id };
    expect(TaskFinishInput.safeParse(checkOff).success).toBe(true);
    expect(agentOf(taskFinish).safeParse(checkOff).success).toBe(false);
    const schema = agentInputJsonSchema(taskFinish);
    expect(schema["required"]).toContain("outcome");
    const outcome = (schema["properties"] as Record<string, Record<string, unknown>>)["outcome"];
    expect(outcome?.["description"]).toMatch(/^What changed and the evidence; agents must give it/);
  });

  test("the tools that create or change a task send the agent to the sizing skill for effort, never to a time", () => {
    const effortOf = (schema: unknown): unknown[] => {
      if (typeof schema !== "object" || schema === null) return [];
      const here = (schema as Record<string, unknown>)["properties"] as
        Record<string, { description?: unknown }> | undefined;
      return [
        ...(here?.["effort"] === undefined ? [] : [here["effort"].description]),
        ...Object.values(schema).flatMap(effortOf),
      ];
    };
    for (const entry of [taskAdd, taskFinish, taskUpdate]) {
      const said = effortOf(agentInputJsonSchema(entry));
      expect(said, entry.name).not.toEqual([]);
      for (const text of said) {
        expect(text, entry.name).toMatch(/\bskill sizing-effort\b/u);
        expect(text, entry.name).not.toMatch(/\b(?:min|minutes|hours?|day)\b/u);
      }
    }
  });

  test("rules apply at any depth, and an entry without rules gets its input as is", () => {
    const Outer = z.strictObject({
      items: z
        .array(
          z.strictObject({
            title: z.string().max(9).describe("Title"),
            secret: z.boolean().describe("User only").optional(),
            reason: z.string().max(9).describe("Why").optional(),
          }),
        )
        .max(9)
        .describe("Items"),
    });
    const entry = {
      input: Outer,
      agent: {
        hidden: ["items[].secret"],
        required: ["items[].reason"],
        max: [["items", 3]],
      } satisfies AgentRules,
    };
    const agent = inputSchemaFor(entry, "agent");
    expect(agent.safeParse({ items: [{ title: "a", reason: "b" }] }).success).toBe(true);
    expect(agent.safeParse({ items: [{ title: "a" }] }).success).toBe(false);
    expect(agent.safeParse({ items: [{ title: "a", reason: "b", secret: true }] }).success).toBe(
      false,
    );
    expect(agent.safeParse({ items: Array(4).fill({ title: "a", reason: "b" }) }).success).toBe(
      false,
    );
    expect(inputSchemaFor(entry, "user")).toBe(Outer);
    expect(agentOf(receiptGet)).toBe(ReceiptGetInput);
  });

  test("the rules are data on the entry, and the input schemas carry none", () => {
    expect(entryAdd.agent).toEqual({ hidden: ["for_agents"], max: [["text", 2000]] });
    expect(entryAdd.defaults).toEqual([["kind", "progress"]]);
    expect(taskFinish.agent?.required).toEqual(["outcome"]);
    // The full schema is plain Zod: no default, so the user's default comes from the entry.
    expect(TaskFinishInput.safeParse({ base: "1.1046.5n0w8k3q", request_id }).data).toEqual({
      base: "1.1046.5n0w8k3q",
      request_id,
    });
    const parsed = parseInput(taskFinish, "user", { base: "1.1046.5n0w8k3q", request_id });
    expect(parsed.data?.status).toBe("done");
    expect(parsed.data?.mode).toBe("apply");
    // A handler's input type has each top-level default filled (checked by tsc).
    expectTypeOf<ParsedInputOf<"task.finish">["status"]>().toEqualTypeOf<"done" | "dropped">();
    expectTypeOf<ParsedInputOf<"task.finish">["outcome"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ParsedInputOf<"task.get">>().toEqualTypeOf<z.output<typeof TaskGetInput>>();
  });

  test("under() moves a shared list of agent limits under a path", () => {
    expect(
      under("tasks[]", [
        ["title", 200],
        ["sources[].title", 200],
      ]),
    ).toEqual([
      ["tasks[].title", 200],
      ["tasks[].sources[].title", 200],
    ]);
    expect((taskAdd.agent?.max ?? []).map(([path]) => path)).toEqual([
      "tasks[].title",
      "tasks[].summary",
      "tasks[].context",
      "tasks[].log",
      "tasks[].sources[].title",
    ]);
  });

  describe("rules keyed by path are lists of pairs, so no declaration is lost", () => {
    // The sixth review's composition: both spreads reach items[].sources[].title.
    const max = [
      ...under("items[]", [["sources[].title", 2]]),
      ...under("items[].sources[]", [["title", 7]]),
    ];

    test("under() keeps both declarations of one path, for the check to reject", () => {
      expect(max).toEqual([
        ["items[].sources[].title", 2],
        ["items[].sources[].title", 7],
      ]);
    });

    test("a record cannot take the place of a list of pairs (checked by tsc)", () => {
      const table: Record<string, number> = { title: 2 };
      // Never called: each body only has to fail to compile.
      const misuses = [
        // @ts-expect-error A record is not a list of [path, value] pairs.
        (): AgentRules => ({ max: table }),
        // @ts-expect-error A record cannot be spread into a list.
        (): AgentRules => ({ max: [...table] }),
        // @ts-expect-error A record spread into a record is not a list either.
        (): AgentRules => ({ max: { ...table, ...table } }),
        // @ts-expect-error under() takes pairs, not a record.
        () => under("items[]", table),
        // @ts-expect-error Defaults are pairs too.
        (): Defaults => ({ mode: "apply" }),
      ];
      expect(misuses).toHaveLength(5);
      expectTypeOf<NonNullable<AgentRules["max"]>>().toEqualTypeOf<
        readonly (readonly [path: string, value: number])[]
      >();
      expectTypeOf<Defaults>().toEqualTypeOf<
        readonly (readonly [path: string, value: string | number | boolean])[]
      >();
    });

    test("building an input from a path listed twice throws instead of picking one", () => {
      const input = z.strictObject({
        items: z
          .array(
            z.strictObject({
              mode: z.enum(["a", "b"]).describe("Mode").optional(),
              sources: z
                .array(z.strictObject({ title: z.string().max(9).describe("Title") }))
                .max(4)
                .describe("Sources"),
            }),
          )
          .max(4)
          .describe("Items"),
      });
      const twice = /the path is listed twice; the registry check rejects this entry/;
      expect(() => inputSchemaFor({ input, agent: { max } }, "agent")).toThrow(twice);
      const equal: Pairs<number> = [
        ["items", 2],
        ["items", 2],
      ];
      expect(() => inputSchemaFor({ input, agent: { max: equal } }, "agent")).toThrow(twice);
      const defaults: Defaults = [
        ["items[].mode", "a"],
        ["items[].mode", "b"],
      ];
      for (const audience of ["agent", "user"] as const) {
        expect(() => inputSchemaFor({ input, defaults }, audience)).toThrow(twice);
      }
      expect(() => parseInput({ input, defaults }, "user", { items: [] })).toThrow(twice);
    });
  });

  test("mcp-tools.json holds exactly the agent-allowed entries with an MCP face that are offered", () => {
    const { tools } = mcpTools(registry);
    const expected = registry
      .filter((e) => isAgentAllowed(e) && e.faces.mcp !== undefined && isOffered(e.name))
      .map((e) => e.faces.mcp?.tool)
      .sort();
    expect(tools.map((t) => t.name)).toEqual(expected);
    // The tools of every connection.
    expect(tools.map((t) => t.name)).toEqual([
      "add_entry",
      "add_tasks",
      "complete_task",
      "delete_tasks",
      "get_task",
      "organize",
      "preferences",
      "read",
      "reopen_task",
      "search",
      "status",
      "update_task",
      "write_page",
    ]);
    const addEntry = tools.find((t) => t.name === "add_entry");
    expect(Object.keys(addEntry?.inputSchema["properties"] as object)).not.toContain("for_agents");
  });

  describe("agent limits are tighter than the user's", () => {
    const x = (n: number) => "x".repeat(n);
    const base = "1.1046.5n0w8k3q";
    const cases: [
      label: string,
      entry: AnyEntry,
      user: number,
      agent: number,
      at: (n: number) => unknown,
    ][] = [
      ["task.add title", taskAdd, 300, 200, (n) => ({ tasks: [{ title: x(n) }], request_id })],
      [
        "task.update set.title",
        taskUpdate,
        300,
        200,
        (n) => ({ set: { title: x(n) }, request_id }),
      ],
      [
        "task.update set.summary",
        taskUpdate,
        400,
        240,
        (n) => ({ set: { summary: x(n) }, request_id }),
      ],
      [
        "task.update context.text",
        taskUpdate,
        65_536,
        8_000,
        (n) => ({ context: { mode: "append", text: x(n) }, request_id }),
      ],
      [
        "task.update add_sources[].title",
        taskUpdate,
        300,
        200,
        (n) => ({ add_sources: [{ kind: "ticket", title: x(n) }], request_id }),
      ],
      [
        "entry.add text",
        entryAdd,
        65_536,
        2_000,
        (n) => ({ kind: "note", text: x(n), request_id }),
      ],
      ["task.finish outcome", taskFinish, 4_096, 600, (n) => ({ outcome: x(n), base, request_id })],
      [
        "task.finish learnings[]",
        taskFinish,
        1_024,
        300,
        (n) => ({ outcome: "o", learnings: [x(n)], base, request_id }),
      ],
      [
        "task.finish learnings count",
        taskFinish,
        20,
        8,
        (n) => ({ outcome: "o", learnings: Array<string>(n).fill("l"), base, request_id }),
      ],
      [
        "task.finish follow_ups[].log",
        taskFinish,
        16_384,
        2_000,
        (n) => ({ outcome: "o", follow_ups: [{ title: "t", log: x(n) }], base, request_id }),
      ],
    ];

    for (const [label, entry, user, agent, at] of cases) {
      test(`${label}: user ${String(user)}, agent ${String(agent)}, in Zod and JSON Schema`, () => {
        const userAjv = ajv.compile(inputJsonSchema(entry));
        const agentAjv = ajv.compile(agentInputJsonSchema(entry));
        const verdicts = (n: number) => [
          entry.input.safeParse(at(n)).success,
          userAjv(at(n)),
          agentOf(entry).safeParse(at(n)).success,
          agentAjv(at(n)),
        ];
        // [user Zod, user Ajv, agent Zod, agent Ajv]
        expect(verdicts(agent)).toEqual([true, true, true, true]);
        expect(verdicts(agent + 1)).toEqual([true, true, false, false]);
        expect(verdicts(user)).toEqual([true, true, false, false]);
        expect(verdicts(user + 1)).toEqual([false, false, false, false]);
      });
    }

    test("the review's probes fit A1 for the user and are too long for agents", () => {
      const title = { tasks: [{ title: x(250) }], request_id };
      const note = { kind: "note", text: x(3_000), request_id };
      const append = { context: { mode: "append", text: x(10_000) }, request_id };
      const probes: [AnyEntry, unknown][] = [
        [taskAdd, title],
        [entryAdd, note],
        [taskUpdate, append],
      ];
      for (const [entry, input] of probes) {
        expect(parseInput(entry, "user", input).success, entry.name).toBe(true);
        expect(parseInput(entry, "agent", input).success, entry.name).toBe(false);
      }
    });

    test("mcp-tools.json carries the agent limits, rpc-methods.json the user limits", () => {
      const tool = mcpTools(registry).tools.find((t) => t.name === "update_task");
      const method = rpcMethods(registry).methods.find((m) => m.name === "task.update");
      const title = (schema: unknown) =>
        (schema as { properties: { set: { properties: Record<string, { maxLength: number }> } } })
          .properties.set.properties["title"]?.maxLength;
      expect(title(tool?.inputSchema)).toBe(200);
      expect(title(method?.input)).toBe(300);
    });

    test("the full schema stays the same instance; the agent input is a copy", () => {
      const projected = agentOf(taskUpdate);
      expect(projected).not.toBe(TaskUpdateInput);
      expect(taskUpdate.input).toBe(TaskUpdateInput);
      expect(TaskUpdateInput.safeParse({ set: { title: x(300) }, request_id }).success).toBe(true);
    });

    test("two entries that share a schema each get their own agent limit", () => {
      const shared = z.string().max(8).describe("P").optional();
      const entries = [2, 4].map((n) => ({
        input: z.strictObject({ p: shared }),
        agent: { max: [["p", n]] } satisfies AgentRules,
      }));
      const limit = (e: (typeof entries)[number], audience: "agent" | "user") =>
        (toJsonSchema(inputSchemaFor(e, audience), "input") as { properties: { p: object } })
          .properties.p;
      expect(entries.map((e) => limit(e, "agent"))).toMatchObject([
        { maxLength: 2 },
        { maxLength: 4 },
      ]);
      expect(entries.map((e) => limit(e, "user"))).toMatchObject([
        { maxLength: 8 },
        { maxLength: 8 },
      ]);
      expect(toJsonSchema(shared, "input")).toMatchObject({ maxLength: 8 });
    });
  });

  test("annotations are explicit: reads are read-only, nothing is destructive or open-world", () => {
    for (const tool of mcpTools(registry).tools) {
      // A tool with write actions is no read, even when most calls of it only read (organize). One
      // whose write actions are all a later step's only reads now (preferences).
      const read = ["status", "get_task", "search", "preferences", "read"].includes(tool.name);
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: read,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });
});
