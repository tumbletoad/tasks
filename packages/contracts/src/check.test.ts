// The registry check (A3 3.2.1 schema rules, 3.2.3 exposure, 3.2.4 naming, 3.2.5 budgets, A6 3.3
// metadata). Each rule is proven on a fixture entry that breaks only that rule.
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import * as check_ from "./check.ts";
import { checkRegistry, checkSchemas } from "./check.ts";
import * as define from "./define.ts";
import {
  defineEntry,
  inputSchemaFor,
  parseInput,
  under,
  type AgentRules,
  type AnyEntry,
  type Defaults,
  type InputSchema,
  type McpFace,
} from "./define.ts";
import { entryAdd } from "./entries/entry-add.ts";
import { AS_OF } from "./entries/fixture.ts";
import { taskFinish } from "./entries/task-finish.ts";
import { taskReopen } from "./entries/task-reopen.ts";
import { taskUpdate } from "./entries/task-update.ts";
import { agentInputJsonSchema, inputJsonSchema, toJsonSchema } from "./json-schema.ts";
import * as registryModule from "./registry.ts";
import { registry } from "./registry.ts";
import { normaliseText, safeLine, safeText } from "./safe-text.ts";
import { Base, RequestId, SessionTask } from "./schemas.ts";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });

/** U+0958: one code point that NFC turns into two. */
const QA = String.fromCodePoint(0x0958);
/** U+200B: one code point that SafeText removes. */
const ZWSP = String.fromCodePoint(0x200b);

const TaskRef = z
  .string()
  .regex(/^[A-Z]{1,6}-[1-9][0-9]*$/u)
  .describe("Task reference");

const input = z.strictObject({
  task: TaskRef.max(40).describe("Task ref (M-14) or ID"),
  text: safeText(200).describe("Note text"),
  pinned: z.boolean().describe("Pin the note").optional(),
  request_id: RequestId,
});
const output = z.strictObject({
  result: z.enum(["logged"]).describe("What happened"),
  task: TaskRef,
});
const example = {
  title: "A note on M-14",
  input: { task: "M-14", text: "Checked the clinic export.", request_id: "fixture-request-0001" },
  output: { result: "logged" as const, task: "M-14" },
};

const mcp: McpFace = {
  tool: "fixture_note",
  title: "Record a fixture note",
  description: "Use to record a fixture note on a task.",
};

/** A valid entry. Each test below breaks one rule. */
const base = defineEntry({
  name: "fixture.note",
  summary: "Record a fixture note on a task.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["note.add"],
  input,
  output,
  faces: { ui: true, cli: { verb: "fixture-note", positional: ["task", "text"] }, mcp },
  budget: { typical: 40, max: 150 },
  errors: ["not_found", "request_id_conflict"],
  examples: [example],
});

const check = (...entries: AnyEntry[]) => checkRegistry(entries, { serverKey: "acme" });

/** Asserts that the variant fails with exactly the problems matching `pattern`. */
function rejects(variant: AnyEntry, pattern: RegExp): void {
  const problems = check(variant);
  expect(problems.length, problems.join("\n")).toBeGreaterThan(0);
  for (const p of problems) expect(p).toMatch(pattern);
}

describe("[A3.5.registry.lint-describe] lint rejects a field without .describe()", () => {
  test("the fixture entry passes", () => {
    expect(check(base)).toEqual([]);
  });

  test("an input field without a description fails", () => {
    const variant = defineEntry({
      ...base,
      input: input.extend({ text: safeText(200) }),
    });
    expect(check(variant)).toEqual(["fixture.note: input.text: field has no .describe()"]);
  });

  test("a nested field and an output field without a description fail", () => {
    const variant = defineEntry({
      ...base,
      input: input.extend({
        link: z
          .strictObject({ url: z.string().max(200) })
          .describe("A link")
          .optional(),
      }),
      output: output.extend({ entry: z.string().optional() }),
    });
    expect(check(variant)).toEqual([
      "fixture.note: input.link.url: field has no .describe()",
      "fixture.note: output.entry: field has no .describe()",
    ]);
  });

  test("a description over 80 characters fails", () => {
    const variant = defineEntry({
      ...base,
      input: input.extend({ text: safeText(200).describe("x".repeat(81)) }),
    });
    rejects(variant, /input\.text: description is 81 characters, the limit is 80/);
  });
});

describe("[A3.5.registry.lint-rules] the registry check rejects each rule on a failing fixture entry", () => {
  test("the real registry passes", () => {
    // The product-name rule runs with the brand constant in `pnpm gen` (scripts/generated.ts).
    expect(checkRegistry(registry)).toEqual([]);
  });

  /**
   * The fixture with one more input field, `probe`, and the agent rules and defaults given. With
   * `value`, the example fills the probe.
   */
  const withInput = (
    field: z.ZodType,
    agent: AgentRules = {},
    defaults?: Defaults,
    value?: unknown,
  ): AnyEntry =>
    defineEntry<string, InputSchema, z.ZodType, Defaults>({
      ...base,
      input: input.extend({ probe: field }),
      agent,
      ...(defaults === undefined ? {} : { defaults }),
      ...(value === undefined
        ? {}
        : { examples: [{ ...example, input: { ...example.input, probe: value } }] }),
    });
  const withOutput = (field: z.ZodType): AnyEntry =>
    defineEntry<string, InputSchema, z.ZodType, Defaults>({
      ...base,
      output: output.extend({ probe: field }),
    });
  const any = (value: unknown) => value as never;
  /** The probe field of the agent JSON Schema, or of the user's. */
  const probeOf = (entry: AnyEntry, who: "agent" | "user" = "agent") =>
    (
      (who === "agent" ? agentInputJsonSchema(entry) : inputJsonSchema(entry))[
        "properties"
      ] as Record<string, Record<string, unknown>>
    )["probe"] ?? {};
  const codes = (entry: AnyEntry, audience: "agent" | "user", probe: unknown) =>
    parseInput(entry, audience, { ...example.input, probe }).error?.issues.map((i) => i.code) ?? [];

  /** Asserts that the check fails, every problem names the path, and one says `phrase`. */
  function rejectsAt(entry: AnyEntry, path: string, phrase: RegExp | string, label = ""): void {
    const problems = check(entry);
    expect(problems.length, `${label}: no problem`).toBeGreaterThan(0);
    for (const p of problems) expect(p, label).toContain(`fixture.note: ${path}`);
    expect(
      problems.some((p) => (typeof phrase === "string" ? p.includes(phrase) : phrase.test(p))),
      `${label}: ${problems.join("\n")}`,
    ).toBe(true);
  }

  const NOT_IN_GRAMMAR = 'type "default" is not in the schema grammar (A3 3.2.1)';

  describe("the schema grammar (A3 3.2.1)", () => {
    test("accepts every shape it lists, in the places it lists", () => {
      const accepted: [string, AnyEntry][] = [
        ["string with a maximum", withInput(z.string().max(10).describe("P").optional())],
        [
          "string with a minimum, a maximum and a pattern",
          withInput(
            z
              .string()
              .min(2)
              .max(10)
              .regex(/^[a-z]+$/u)
              .describe("P")
              .optional(),
          ),
        ],
        ["SafeText", withInput(safeText(10).describe("P").optional())],
        [
          "SafeLine with an agent limit",
          withInput(safeLine(10).describe("P").optional(), { max: [["probe", 5]] }),
        ],
        ["integer with bounds", withInput(z.int().min(0).max(9).describe("P").optional())],
        [
          "number with exclusive bounds",
          withInput(z.number().gt(0).lt(1).describe("P").optional()),
        ],
        [
          "boolean with a default",
          withInput(z.boolean().describe("P").optional(), {}, [["probe", false]]),
        ],
        [
          "enum with a default",
          withInput(z.enum(["a", "b"]).describe("P").optional(), {}, [["probe", "a"]]),
        ],
        [
          "integer with a default",
          withInput(z.int().min(0).max(9).describe("P").optional(), {}, [["probe", 0]]),
        ],
        ["literal", withInput(z.literal("x").describe("P").optional())],
        [
          "array with agent limits on it and on its element",
          withInput(z.array(safeText(10)).min(1).max(4).describe("P").optional(), {
            max: [
              ["probe", 2],
              ["probe[]", 5],
            ],
          }),
        ],
        [
          "union of different JSON types",
          withInput(
            z
              .union([
                z.literal("cwd"),
                z.strictObject({ path: safeLine(10).describe("Path") }),
                z.int().min(0).max(3),
              ])
              .describe("P")
              .optional(),
          ),
        ],
        [
          "hidden, required and limited fields in an array element",
          withInput(
            z
              .array(
                z.strictObject({
                  a: z.boolean().describe("A").optional(),
                  b: safeText(10).describe("B").optional(),
                }),
              )
              .max(3)
              .describe("P")
              .optional(),
            { hidden: ["probe[].a"], required: ["probe[].b"], max: [["probe[].b", 5]] },
          ),
        ],
        [
          "output union of objects",
          withOutput(
            z
              .union([
                z.strictObject({ v: z.literal("a").describe("V") }),
                z.strictObject({ v: z.literal("b").describe("V"), w: z.string().describe("W") }),
              ])
              .describe("P")
              .optional(),
          ),
        ],
        [
          "output array of unbounded strings",
          withOutput(z.array(z.string()).describe("P").optional()),
        ],
        [
          "null as an input union option, a preference value's reset (A3 3.4.11)",
          withInput(
            z
              .union([z.string().max(5), z.array(z.string().max(5)).max(3), z.null()])
              .describe("P")
              .optional(),
          ),
        ],
      ];
      for (const [label, entry] of accepted) expect(check(entry), label).toEqual([]);
    });

    test("null stands only as a union option, never as a field, element or nested value", () => {
      const n = (s: z.ZodType) => withInput(s.describe("P").optional());
      const nested = n(z.union([z.strictObject({ v: z.null().describe("V") }), z.string().max(3)]));
      expect(check(nested)).toEqual([
        "fixture.note: input.probe|0.v: null stands only as a union option, such as a preference value (A3 3.4.11)",
      ]);
      const element = n(z.union([z.array(z.null()).max(2), z.string().max(3)]));
      expect(check(element)).toEqual([
        "fixture.note: input.probe|0[]: null stands only as a union option, such as a preference value (A3 3.4.11)",
      ]);
      const twice = n(z.union([z.null(), z.literal(null)]));
      expect(check(twice).length).toBeGreaterThan(0);
    });

    test("rejects every other type, option and check, naming the node", () => {
      const n = (s: z.ZodType) => withInput(s.describe("P").optional());
      const cases: [string, AnyEntry, string, RegExp | string][] = [
        ["date", n(z.date()), "input.probe", 'type "date" is not in the schema grammar'],
        ["null", n(z.null()), "input.probe", "null stands only as a union option"],
        ["unknown", n(z.unknown()), "input.probe", 'type "unknown" is not in the schema grammar'],
        ["nullable", n(z.string().max(5).nullable()), "input.probe", 'type "nullable"'],
        ["tuple", n(z.tuple([z.string().max(5)])), "input.probe", 'type "tuple"'],
        [
          "refinement",
          n(
            z
              .string()
              .max(10)
              .refine((t) => t !== "x"),
          ),
          "input.probe",
          'a string takes no check "custom": refinements belong in the handler',
        ],
        [
          ".trim()",
          n(z.string().trim().max(10)),
          "input.probe",
          'takes no check "overwrite": normalise text with SafeText',
        ],
        ["string format", n(z.email()), "input.probe", 'a string takes no option "format"'],
        ["coercion", n(z.coerce.string().max(10)), "input.probe", 'takes no option "coerce"'],
        ["exact length", n(z.string().length(3)), "input.probe", 'no check "length_equals"'],
        ["no maximum", n(z.string()), "input.probe", "an input string needs a maximum length"],
        [
          "two patterns",
          n(z.string().max(5).regex(/a/u).regex(/b/u)),
          "input.probe",
          "a string takes one pattern check",
        ],
        [
          "a check option such as when, which skips the check in Zod alone",
          n(z.string().max(10, any({ when: () => false }))),
          "input.probe",
          "the max_length check takes no options such as when, abort or error",
        ],
        [
          "abort",
          n(z.string().max(10, { abort: true })),
          "input.probe",
          "takes no options such as when",
        ],
        [
          "custom error",
          n(z.string().max(10, { error: "Too long" })),
          "input.probe",
          "takes no options such as when",
        ],
        [
          "multiple of",
          n(z.int().min(0).max(9).multipleOf(2)),
          "input.probe",
          'an integer takes no check "multiple_of"',
        ],
        ["int32", n(z.int32().min(0).max(9)), "input.probe", 'number format "int32"'],
        ["unbounded number", n(z.number()), "input.probe", "a number has a minimum and a maximum"],
        ["numeric enum", n(z.enum(any({ a: 1 }))), "input.probe", "enum values are strings"],
        [
          "undefined literal",
          n(z.literal(undefined)),
          "input.probe",
          "a literal is a string, number or boolean",
        ],
        [
          "array without a maximum",
          n(z.array(z.string().max(3))),
          "input.probe",
          "an input array needs a maximum item count",
        ],
        [
          "optional array element",
          n(z.array(z.string().max(3).optional()).max(3)),
          "input.probe[]",
          "are not optional",
        ],
        [
          "loose object",
          n(z.object({ a: z.string().max(3).describe("A") })),
          "input.probe",
          "objects must be strict (z.strictObject)",
        ],
        [
          "object catchall",
          n(z.strictObject({}).catchall(z.string().max(3))),
          "input.probe",
          "objects must be strict",
        ],
        [
          "object refinement",
          n(z.strictObject({}).refine(() => true)),
          "input.probe",
          'an object takes no check "custom"',
        ],
        [
          "field name",
          n(z.strictObject({ waitingOn: z.string().max(3).describe("W") })),
          "input.probe.waitingOn",
          "field names are snake_case",
        ],
        [
          "a field Object.prototype also has",
          n(z.strictObject({ constructor: z.string().max(3).describe("C").optional() })),
          "input.probe.constructor",
          '"constructor" is a property of every object',
        ],
        [
          "metadata other than the description",
          withInput(z.string().max(3).meta({ description: "P", title: "T" }).optional()),
          "input.probe",
          'metadata "title" is not allowed',
        ],
        [
          "transform",
          n(
            z
              .string()
              .max(10)
              .transform((t) => t.toUpperCase()),
          ),
          "input.probe",
          "a transform is allowed only as SafeText",
        ],
        [
          "SafeText with a pattern: the second parse could fail it",
          n(
            z
              .string()
              .max(5)
              .regex(/^\u0958$/u)
              .transform(normaliseText),
          ),
          "input.probe",
          "a transform is allowed only as SafeText",
        ],
        [
          "SafeText with a minimum: normalising can shorten text below it",
          n(z.string().min(2).max(5).transform(normaliseText)),
          "input.probe",
          "a transform is allowed only as SafeText",
        ],
        [
          "a check after the normaliser, which the JSON Schema cannot see",
          n(safeText(10).check(z.maxLength(5))),
          "input.probe",
          'SafeText takes no check "max_length"',
        ],
        [
          "optional of optional",
          withInput(z.string().max(3).describe("P").optional().optional()),
          "input.probe",
          "are not optional",
        ],
        // Every .default() is refused: a default is entry data (A3 3.2.1).
        [
          "default inside optional",
          withInput(z.string().max(3).default("a").describe("P").optional()),
          "input.probe",
          NOT_IN_GRAMMAR,
        ],
        [
          "default on SafeText",
          withInput(safeLine(3).default("a").describe("P")),
          "input.probe",
          NOT_IN_GRAMMAR,
        ],
        [
          "default on a container",
          withInput(z.array(z.string().max(3)).max(2).default(["a"]).describe("P")),
          "input.probe",
          NOT_IN_GRAMMAR,
        ],
        [
          "Zod's own default, even of a valid constant",
          withInput(z.int().min(1).max(4).default(2).describe("P")),
          "input.probe",
          "a default belongs in the entry's defaults",
        ],
        [
          "Zod's own default of an invalid value",
          withInput(z.int().min(1).max(4).default(9).describe("P")),
          "input.probe",
          NOT_IN_GRAMMAR,
        ],
        [
          "default that changes",
          withInput(
            z
              .enum(["s", "m"])
              .default(
                (() => {
                  let n = 0;
                  return () => (n++ % 2 === 0 ? "s" : "m");
                })(),
              )
              .describe("P"),
          ),
          "input.probe",
          NOT_IN_GRAMMAR,
        ],
        [
          "a union of no options, whose JSON Schema Ajv refuses to compile",
          n(z.union(any([]))),
          "input.probe",
          "a union has at least two options",
        ],
        [
          "a union of one option",
          n(z.union([z.string().max(3)])),
          "input.probe",
          "a union has at least two options",
        ],
        [
          "union options of one JSON type",
          n(z.union([z.enum(["a"]), safeLine(3)])),
          "input.probe",
          "input union options take different JSON types; options 0 and 1 both take string",
        ],
        [
          "optional union option",
          n(z.union([z.string().max(3).optional(), z.int().min(0).max(3)])),
          "input.probe|0",
          "are not optional",
        ],
        [
          "nested union",
          n(z.union([z.union([z.literal("a"), z.int().min(0).max(1)]), z.boolean()])),
          "input.probe|0",
          "a union option is not another union",
        ],
        [
          "xor",
          n(z.xor([z.literal("a"), z.int().min(0).max(1)])),
          "input.probe",
          'a union takes no option "inclusive"',
        ],
        [
          "discriminated union",
          n(z.discriminatedUnion("k", [z.strictObject({ k: z.literal("a").describe("K") })])),
          "input.probe",
          'a union takes no option "discriminator"',
        ],
        [
          "record: Zod skips a __proto__ key without checking its value",
          withOutput(z.record(z.string(), z.int().min(0).max(5)).describe("P").optional()),
          "output.probe",
          'type "record" is not in the schema grammar',
        ],
        [
          "transform in an output",
          withOutput(safeText(10).describe("P").optional()),
          "output.probe",
          "a transform is not allowed in outputs",
        ],
        [
          "default in an output",
          withOutput(z.string().default("a").describe("P").optional()),
          "output.probe",
          NOT_IN_GRAMMAR,
        ],
      ];
      for (const [label, entry, path, phrase] of cases) rejectsAt(entry, path, phrase, label);
    });

    test("an input that is not a strict object fails", () => {
      rejects(
        defineEntry({ ...base, input: z.object(input.shape) }),
        /input: objects must be strict/,
      );
    });

    describe("every Zod 4.6.7 schema that holds another schema is rejected, or takes the rules", () => {
      const s = () => z.string().max(10);
      const ruleSets: Record<string, AgentRules> = {
        max: { max: [["probe", 3]] },
        hidden: { hidden: ["probe"] },
        required: { required: ["probe"] },
      };
      type Wrap = (m: z.ZodType) => z.ZodType;
      // Every Zod 4.6.7 schema that holds another schema, in each of its slots.
      const wrappers: Record<string, Wrap> = {
        nullable: (m) => m.nullable(),
        nullish: (m) => m.nullish(),
        default: (m) => m.default(any("abc")),
        prefault: (m) => m.prefault(any("abc")),
        nonoptional: (m) => m.nonoptional(),
        readonly: (m) => m.readonly(),
        catch: (m) => m.catch(any("abc")),
        success: (m) => z.success(m),
        "pipe input": (m) => m.pipe(z.string()),
        "pipe output": (m) => z.string().pipe(any(m)),
        "normaliser input": (m) => m.transform(any(normaliseText)),
        codec: (m) => z.codec(any(m), z.string(), any({ decode: String, encode: String })),
        preprocess: (m) => z.preprocess((v) => v, m),
        lazy: (m) => z.lazy(() => m),
        promise: (m) => z.promise(m),
        set: (m) => z.set(m),
        "map key": (m) => z.map(m, z.string()),
        "map value": (m) => z.map(z.string(), m),
        "record key": (m) => z.record(any(m), z.string()),
        "record value": (m) => z.record(z.string(), m),
        "partial record": (m) => z.partialRecord(z.string(), m),
        "loose record": (m) => z.looseRecord(z.string(), m),
        "tuple item": (m) => z.tuple([m]),
        "tuple rest": (m) => z.tuple([z.string()], m),
        union: (m) => z.union([m, z.int().min(0).max(1)]),
        xor: (m) => z.xor([m, z.number()]),
        "discriminated union": (m) =>
          z.discriminatedUnion("k", [z.strictObject({ k: z.literal("a"), v: m })]),
        intersection: (m) => z.intersection(m, z.string()),
        catchall: (m) => z.strictObject({}).catchall(m),
        "function input": (m) => z.function({ input: [m], output: z.string() }),
        "function output": (m) => z.function({ input: [], output: m }),
        "template literal": (m) => z.templateLiteral([any(m)]),
        "property check": (m) => z.string().check(any(z.property("length", any(m)))),
      };
      const accepted: string[] = [];

      for (const [name, wrap] of Object.entries(wrappers)) {
        test(name, () => {
          for (const [kind, rules] of Object.entries(ruleSets)) {
            const entry = withInput(wrap(s()).describe("Probe").optional(), rules);
            const problems = checkSchemas(entry);
            if (problems.length > 0) {
              for (const p of problems) {
                expect(p, `${name} ${kind}`).toMatch(/^(input\.probe|agent\.[a-z]+ "probe")/);
              }
              continue;
            }
            // The grammar accepts SafeText and a union. Every rule the check accepts takes effect.
            accepted.push(`${name} ${kind}`);
            const agent = agentInputJsonSchema(entry);
            const probe = (agent["properties"] as Record<string, Record<string, unknown>>)["probe"];
            if (kind === "max") expect(probe?.["maxLength"]).toBe(3);
            if (kind === "hidden") expect(probe).toBeUndefined();
            if (kind === "required") expect(agent["required"]).toContain("probe");
          }
        });
      }

      test("only SafeText takes every rule, and a union field is hidden or required whole", () => {
        expect(accepted).toEqual([
          "normaliser input max",
          "normaliser input hidden",
          "normaliser input required",
          "union hidden",
          "union required",
        ]);
      });

      test("the places a limit applies: a field, its optional, an array and its element", () => {
        const applied: Record<
          string,
          [z.ZodType, string, unknown, (json: Record<string, unknown>) => unknown]
        > = {
          field: [s().describe("Probe"), "probe", "abc", (p) => p["maxLength"]],
          optional: [s().describe("Probe").optional(), "probe", undefined, (p) => p["maxLength"]],
          "exact optional": [
            s().describe("Probe").exactOptional(),
            "probe",
            undefined,
            (p) => p["maxLength"],
          ],
          array: [
            z.array(s()).max(4).describe("Probe").optional(),
            "probe",
            undefined,
            (p) => p["maxItems"],
          ],
          "array element": [
            z.array(s()).max(4).describe("Probe").optional(),
            "probe[]",
            undefined,
            (p) => (p["items"] as Record<string, unknown>)["maxLength"],
          ],
        };
        for (const [name, [field, path, value, limit]] of Object.entries(applied)) {
          const entry = withInput(field, { max: [[path, 3]] }, undefined, value);
          expect(check(entry), name).toEqual([]);
          expect(limit(probeOf(entry)), name).toBe(3);
        }
        // hidden and required name an optional field, never an element or a required field.
        for (const list of ["hidden", "required"] as const) {
          const onField = withInput(
            s().describe("Probe").optional(),
            { [list]: ["probe"] },
            undefined,
            list === "required" ? "abc" : undefined,
          );
          expect(check(onField), list).toEqual([]);
          for (const [place, field, path] of [
            ["a required field", s().describe("Probe"), "probe"],
            ["an array element", z.array(s()).max(4).describe("Probe").optional(), "probe[]"],
          ] as const) {
            expect(check(withInput(field, { [list]: [path] })), `${place} ${list}`).toContainEqual(
              `fixture.note: agent.${list} "${path}": it names an optional field, and "${path}" is not one`,
            );
          }
        }
      });
    });

    describe("agent rules and defaults are entry data, checked by path", () => {
      const s = () => z.string().max(10);
      const object = () =>
        z
          .strictObject({
            a: s().describe("A").optional(),
            b: z.int().min(0).max(9).describe("B"),
          })
          .describe("P")
          .optional();
      const place = () =>
        z
          .union([z.literal("cwd"), z.strictObject({ root: s().describe("Root") })])
          .describe("P")
          .optional();
      const items = () =>
        z
          .array(z.strictObject({ title: s().describe("T").optional() }))
          .max(4)
          .describe("P")
          .optional();
      type Case = [label: string, entry: AnyEntry, problem: string];

      test("each path names a node of the input, in the path grammar", () => {
        const cases: Case[] = [
          [
            "an unknown path",
            withInput(s().describe("P").optional(), { hidden: ["nope"] }),
            'agent.hidden "nope": the input has no field "nope"',
          ],
          [
            "an unknown nested path",
            withInput(object(), { max: [["probe.c", 3]] }),
            'agent.max "probe.c": the input has no field "probe.c"',
          ],
          [
            "a malformed path",
            withInput(s().describe("P").optional(), { required: ["probe[0]"] }),
            'agent.required "probe[0]": a path is field names joined by dots, with [] for an element',
          ],
          [
            "an empty path",
            withInput(s().describe("P").optional(), {}, [["", "a"]]),
            'defaults "": a path is field names joined by dots, with [] for an element',
          ],
          [
            "an array's field without []",
            withInput(items(), { max: [["probe.title", 3]] }),
            'agent.max "probe.title": "probe" is an array: name its element with []',
          ],
          [
            "[] on a field that is not an array",
            withInput(s().describe("P").optional(), { max: [["probe[]", 3]] }),
            'agent.max "probe[]": "probe" is not an array',
          ],
          [
            "a field of a scalar",
            withInput(s().describe("P").optional(), { hidden: ["probe.x"] }),
            'agent.hidden "probe.x": "probe" is not an object',
          ],
          [
            "a path into a union, which the grammar does not address",
            withInput(place(), { max: [["probe.root", 3]] }),
            'agent.max "probe.root": "probe" is a union, which a path does not enter',
          ],
          [
            "a default in a union option",
            withInput(place(), {}, [["probe.root", "a"]]),
            'defaults "probe.root": "probe" is a union, which a path does not enter',
          ],
          [
            "the same path listed twice",
            withInput(s().describe("P").optional(), { hidden: ["probe", "probe"] }),
            'agent.hidden "probe": the path is listed twice',
          ],
          [
            "the same required path listed twice",
            withInput(s().describe("P").optional(), { required: ["probe", "probe"] }, [], "abc"),
            'agent.required "probe": the path is listed twice',
          ],
        ];
        for (const [label, entry, problem] of cases) {
          expect(check(entry), label).toEqual([`fixture.note: ${problem}`]);
        }
      });

      test("each rule fits the node its path names", () => {
        const cases: Case[] = [
          [
            "hidden on a required field",
            withInput(s().describe("P"), { hidden: ["probe"] }, undefined, "abc"),
            'agent.hidden "probe": it names an optional field, and "probe" is not one',
          ],
          [
            "required on a required field",
            withInput(object(), { required: ["probe.b"] }),
            'agent.required "probe.b": it names an optional field, and "probe.b" is not one',
          ],
          [
            "a field both hidden and required",
            withInput(s().describe("P").optional(), { hidden: ["probe"], required: ["probe"] }),
            'agent.required "probe": agents never see the hidden field "probe"',
          ],
          [
            "a limit inside a hidden field",
            withInput(object(), { hidden: ["probe"], max: [["probe.a", 3]] }),
            'agent.max "probe.a": agents never see the hidden field "probe"',
          ],
          [
            "a limit not below the user's",
            withInput(safeLine(10).describe("P").optional(), { max: [["probe", 10]] }),
            'agent.max "probe": the agent limit 10 must be a whole number from 1 to below the user limit 10',
          ],
          [
            "a limit of zero",
            withInput(s().describe("P").optional(), { max: [["probe", 0]] }),
            'agent.max "probe": the agent limit 0 must be a whole number from 1 to below the user limit 10',
          ],
          [
            "a fractional limit",
            withInput(s().describe("P").optional(), { max: [["probe", 2.5]] }),
            'agent.max "probe": the agent limit 2.5 must be a whole number from 1 to below the user limit 10',
          ],
          [
            "a limit on an integer, which has no maximum length",
            withInput(object(), { max: [["probe.b", 3]] }),
            'agent.max "probe.b": an agent limit sits on a string, SafeText or array, not an integer',
          ],
          [
            "a limit on an object",
            withInput(object(), { max: [["probe", 3]] }),
            'agent.max "probe": an agent limit sits on a string, SafeText or array, not an object',
          ],
          [
            "a limit on a union",
            withInput(place(), { max: [["probe", 3]] }),
            'agent.max "probe": an agent limit sits on a string, SafeText or array, not a union',
          ],
          [
            "a default on a required field",
            withInput(z.enum(["a", "b"]).describe("P"), {}, [["probe", "a"]], "a"),
            'defaults "probe": a default sits on an optional field, and "probe" is not one',
          ],
          [
            "a default on an array element",
            withInput(z.array(s()).max(3).describe("P").optional(), {}, [["probe[]", "a"]]),
            'defaults "probe[]": a default sits on an optional field, and "probe[]" is not one',
          ],
          [
            "a default on an object",
            withInput(object(), {}, [["probe", any({ b: 1 })]]),
            'defaults "probe": only a plain scalar may have a default: an enum, literal, string, integer, number or boolean, without SafeText',
          ],
          [
            "a default on an array",
            withInput(z.array(s()).max(3).describe("P").optional(), {}, [["probe", any(["a"])]]),
            'defaults "probe": only a plain scalar may have a default: an enum, literal, string, integer, number or boolean, without SafeText',
          ],
          [
            "a default on SafeText, which normalising could change",
            withInput(safeLine(3).describe("P").optional(), {}, [["probe", `${QA}${QA}`]]),
            'defaults "probe": only a plain scalar may have a default: an enum, literal, string, integer, number or boolean, without SafeText',
          ],
          [
            "a default the field rejects",
            withInput(z.int().min(1).max(4).describe("P").optional(), {}, [["probe", 9]]),
            'defaults "probe": the default 9 is not one value the field accepts',
          ],
          [
            "a default of the wrong type",
            withInput(z.enum(["a", "b"]).describe("P").optional(), {}, [["probe", true]]),
            'defaults "probe": the default true is not one value the field accepts',
          ],
          [
            "a default function",
            withInput(z.int().min(1).max(4).describe("P").optional(), {}, [
              ["probe", any(() => 2)],
            ]),
            'defaults "probe": a default is one constant string, finite number or boolean',
          ],
          [
            "an infinite default",
            withInput(z.number().gte(0).lte(1).describe("P").optional(), {}, [["probe", Infinity]]),
            'defaults "probe": a default is one constant string, finite number or boolean',
          ],
          [
            "a default on a field agents must give",
            withInput(
              z.enum(["a", "b"]).describe("P").optional(),
              { required: ["probe"] },
              [["probe", "a"]],
              "a",
            ),
            'defaults "probe": a field with a default takes no agent rule',
          ],
          [
            "a default on a hidden field",
            withInput(z.enum(["a", "b"]).describe("P").optional(), { hidden: ["probe"] }, [
              ["probe", "a"],
            ]),
            'defaults "probe": a field with a default takes no agent rule',
          ],
        ];
        for (const [label, entry, problem] of cases) {
          expect(check(entry), label).toEqual([`fixture.note: ${problem}`]);
        }
      });

      test("a path listed twice in agent.max or defaults is rejected with both values", () => {
        const sources = () =>
          z
            .array(
              z.strictObject({
                sources: z
                  .array(
                    z.strictObject({
                      title: s().describe("T"),
                      mode: z.enum(["a", "b"]).describe("M").optional(),
                    }),
                  )
                  .max(4)
                  .describe("S"),
              }),
            )
            .max(4)
            .describe("P")
            .optional();
        const title = "probe[].sources[].title";
        const mode = "probe[].sources[].mode";
        const cases: Case[] = [
          [
            "the sixth review's reproduction: two under() spreads reach one limit",
            withInput(sources(), {
              max: [
                ...under("probe[]", [["sources[].title", 2]]),
                ...under("probe[].sources[]", [["title", 7]]),
              ],
            }),
            `agent.max "${title}": the path is listed twice, with 2 and 7`,
          ],
          [
            "the same shape for defaults",
            withInput(sources(), {}, [
              ...under("probe[]", [["sources[].mode", "a"]]),
              ...under("probe[].sources[]", [["mode", "b"]]),
            ]),
            `defaults "${mode}": the path is listed twice, with "a" and "b"`,
          ],
          [
            "a limit listed twice with equal values",
            withInput(sources(), {
              max: [
                [title, 2],
                [title, 2],
              ],
            }),
            `agent.max "${title}": the path is listed twice, with 2 and 2`,
          ],
          [
            "a default listed twice with equal values",
            withInput(sources(), {}, [
              [mode, "a"],
              [mode, "a"],
            ]),
            `defaults "${mode}": the path is listed twice, with "a" and "a"`,
          ],
          [
            "a direct limit and an under() limit on one path",
            withInput(sources(), {
              max: [[title, 2], ...under("probe[]", [["sources[].title", 3]])],
            }),
            `agent.max "${title}": the path is listed twice, with 2 and 3`,
          ],
          [
            "a direct default and an under() default on one path",
            withInput(sources(), {}, [[mode, "b"], ...under("probe[].sources[]", [["mode", "a"]])]),
            `defaults "${mode}": the path is listed twice, with "b" and "a"`,
          ],
          [
            "a record where a list of pairs belongs",
            withInput(s().describe("P").optional(), { max: any({ probe: 3 }) }),
            "agent.max: the list is made of [path, value] pairs",
          ],
          [
            "a default record where a list of pairs belongs",
            withInput(z.enum(["a", "b"]).describe("P").optional(), {}, any({ probe: "a" })),
            "defaults: the list is made of [path, value] pairs",
          ],
        ];
        for (const [label, entry, problem] of cases) {
          expect(check(entry), label).toEqual([`fixture.note: ${problem}`]);
          // Nothing builds an input from the unchecked data: it would have to pick one value.
          expect(() => inputSchemaFor(entry, "agent"), label).toThrow();
        }
      });

      test("a hidden path at or inside another hidden path is rejected once", () => {
        const cases: Case[] = [
          [
            "a field inside a hidden field",
            withInput(object(), { hidden: ["probe", "probe.a"] }),
            'agent.hidden "probe.a": agents never see the hidden field "probe"',
          ],
          [
            "listed before the field that hides it",
            withInput(object(), { hidden: ["probe.a", "probe"] }),
            'agent.hidden "probe.a": agents never see the hidden field "probe"',
          ],
          [
            "the same hidden field twice",
            withInput(object(), { hidden: ["probe", "probe"] }),
            'agent.hidden "probe": the path is listed twice',
          ],
        ];
        for (const [label, entry, problem] of cases) {
          expect(check(entry), label).toEqual([`fixture.note: ${problem}`]);
        }
      });

      test("a rule that does not fit changes nothing, and only the check reports it", () => {
        // The agent input never grows to support a misplaced rule.
        const union = withInput(place(), { max: [["probe", 3]] });
        expect(
          parseInput(union, "agent", { ...example.input, probe: { root: "abcd" } }).success,
        ).toBe(true);
        expect(probeOf(union)).toEqual(probeOf(union, "user"));
        const required = withInput(s().describe("P"), { hidden: ["probe"] }, undefined, "abc");
        expect(inputSchemaFor(required, "agent").safeParse(example.input).success).toBe(false);
      });

      test("a user-only entry has no agent rules", () => {
        const user = (agent?: AgentRules) =>
          defineEntry({
            ...base,
            actors: "user",
            ...(agent === undefined ? {} : { agent }),
            faces: { ui: true, cli: { verb: "fixture-note", positional: ["task", "text"] } },
            budget: undefined as never,
            examples: [{ ...example, actor: "user" }],
          });
        expect(check(user({ hidden: ["pinned"] }))).toEqual([
          "fixture.note: a user-only entry has no agent rules: agents never call it",
        ]);
        expect(check(user())).toEqual([]);
      });
    });

    test("the first two reviews' probes", () => {
      // A defaulted object with a hidden and a required field: as Zod's default and as data.
      const nested = z.strictObject({
        hidden: z.boolean().describe("Hidden").optional(),
        reason: z.string().max(10).describe("Why").optional(),
      });
      const rules = { hidden: ["probe.hidden"], required: ["probe.reason"] };
      rejectsAt(
        withInput(nested.default({ hidden: true }).describe("Nested"), rules),
        "input.probe",
        NOT_IN_GRAMMAR,
      );
      expect(
        check(withInput(nested.describe("Nested").optional(), rules, [["probe", any({})]])),
      ).toEqual([
        'fixture.note: defaults "probe": only a plain scalar may have a default: an enum, literal, string, integer, number or boolean, without SafeText',
      ]);
      // A SafeText default fits 3 code points as written and is 4 once normalised, as Zod's
      // default and as data.
      const label = withInput(safeLine(3).default(`${QA}${QA}`).describe("Label"));
      const parsed = parseInput(label, "user", example.input).data?.["probe"];
      expect(Array.from(String(parsed))).toHaveLength(4);
      rejectsAt(label, "input.probe", NOT_IN_GRAMMAR);
      const data = withInput(safeLine(3).describe("Label").optional(), {}, [
        ["probe", `${QA}${QA}`],
      ]);
      expect(
        Array.from(String(parseInput(data, "user", example.input).data?.["probe"])),
      ).toHaveLength(4);
      expect(check(data)).toContainEqual(
        expect.stringMatching(/^fixture\.note: defaults "probe": only a plain scalar/),
      );
      // A pattern that the first parse passes and the second fails on the normalised text.
      const pattern = withInput(
        z
          .string()
          .max(5)
          .regex(/^\u0958$/u)
          .transform(normaliseText)
          .describe("Code")
          .optional(),
      );
      const second = parseInput(pattern, "user", { ...example.input, probe: QA });
      expect(second.error?.issues.map((i) => i.code)).toEqual(["invalid_format"]);
      // Without the u flag, /^.$/ rejects one emoji that Zod reads as two units and Ajv as one.
      const emoji = String.fromCodePoint(0x1f600);
      expect(z.string().regex(/^.$/).safeParse(emoji).success).toBe(false);
      for (const regex of [/^[a-z]+$/iu, /^[a-z]+$/i, /^.$/]) {
        rejectsAt(
          n(regex),
          "input.probe",
          "a pattern is a RegExp with exactly the u flag",
          String(regex),
        );
      }
      function n(regex: RegExp) {
        return withInput(z.string().max(5).regex(regex).describe("P").optional());
      }
    });

    describe("the third review's probes", () => {
      const ajvOf = (schema: z.ZodType) => ajv.compile(toJsonSchema(schema, "input"));

      test("a check on a wrapper: Zod refuses what the JSON Schema accepts", () => {
        // Base.optional() with a check of its own: Zod refuses an ordinary as_of, and the JSON
        // Schema still says maxLength 40.
        const base_ = withInput(Base.optional().check(any(z.maxLength(1))));
        const value = { ...example.input, probe: AS_OF };
        expect(base_.input.safeParse(value).success).toBe(false);
        expect(ajvOf(base_.input)(value)).toBe(true);
        rejectsAt(base_, "input.probe", 'an optional takes no check "max_length"');
        const inUpdate = defineEntry({
          ...taskUpdate,
          input: taskUpdate.input.extend({ base: Base.optional().check(any(z.maxLength(1))) }),
        });
        expect(check(inUpdate)).toContain(
          "task.update: base must be a shared base schema from schemas.ts, or one made optional (A3 3.4.1)",
        );
        // SafeText with a minimum or a pattern on its optional: both run after normalising.
        for (const field of [
          safeText(4)
            .optional()
            .check(any(z.minLength(2))),
          safeText(4).optional().check(z.regex(/^ab$/u)),
        ]) {
          const entry = withInput(field.describe("Code"));
          const sent = { ...example.input, probe: `a${ZWSP}` };
          expect(entry.input.safeParse(sent).success).toBe(false);
          expect(ajvOf(entry.input)(sent)).toBe(true);
          rejectsAt(entry, "input.probe", /an optional takes no check "(min_length|pattern)"/);
        }
      });

      test("overlapping input union options: parseInput returned a value its schema refuses", () => {
        const a = z.strictObject({
          kind: z.literal("a").describe("K"),
          text: safeText(3).describe("T"),
        });
        const pairs: [z.ZodType, unknown][] = [
          [
            z.strictObject({
              kind: safeLine(5).describe("K"),
              text: z.string().max(2).describe("T"),
            }),
            { kind: `a${ZWSP}`, text: `${QA}${QA}` },
          ],
          // The scalar-default variant: the default picks option 0 on the second parse. A default
          // is entry data now, and a path does not enter a union, so it takes Zod's own default.
          [
            z.strictObject({
              kind: z.literal("a").default("a").describe("K"),
              text: z.string().max(2).describe("T"),
            }),
            { text: `${QA}${QA}` },
          ],
        ];
        for (const [b, sent] of pairs) {
          const entry = withInput(z.union([a, b]).describe("Pick").optional());
          for (const audience of ["user", "agent"] as const) {
            const parsed = parseInput(entry, audience, { ...example.input, probe: sent });
            expect(parsed.success, audience).toBe(true);
            expect(entry.input.safeParse(parsed.data).success, audience).toBe(false);
          }
          rejectsAt(
            entry,
            "input.probe",
            "input union options take different JSON types; options 0 and 1 both take object",
          );
        }
      });

      test("required on a field that still takes no value once its optional is gone", () => {
        for (const outcome of [
          safeText(4096).describe("What changed").optional().optional(),
          z.string().max(600).default("placeholder").describe("What changed").optional(),
        ]) {
          const entry = defineEntry({ ...taskFinish, input: taskFinish.input.extend({ outcome }) });
          // The agent schema lost the requirement, and an agent call without an outcome passed.
          expect(agentInputJsonSchema(entry)["required"]).not.toContain("outcome");
          expect(
            parseInput(entry, "agent", { base: AS_OF, request_id: example.input.request_id })
              .success,
          ).toBe(true);
          expect(check(entry)).toContainEqual(
            expect.stringMatching(
              /^task\.finish: input\.outcome: .*(are not optional|type "default" is not in the schema grammar)/,
            ),
          );
        }
      });
    });

    describe("the fourth review's probes: composition cannot lose a rule", () => {
      test("a field built with .min(), .regex() or .describe() keeps its agent limit", () => {
        const fields: [string, z.ZodType][] = [
          [".min()", z.string().max(8).min(1).describe("Probe")],
          [
            ".regex()",
            z
              .string()
              .max(8)
              .regex(/^[a-z]+$/u)
              .describe("Probe"),
          ],
          [".describe() first", z.string().max(8).min(1).describe("Probe")],
        ];
        for (const [label, field] of fields) {
          const entry = withInput(field, { max: [["probe", 4]] }, undefined, "abcd");
          expect(check(entry), label).toEqual([]);
          expect(probeOf(entry)["maxLength"], label).toBe(4);
          expect(codes(entry, "agent", "abcde"), label).toEqual(["too_big"]);
          expect(codes(entry, "user", "abcde"), label).toEqual([]);
          expect(codes(entry, "user", "abcdefghi"), label).toEqual(["too_big"]);
        }
      });

      test("a shared schema with two limits: neither changes it or the other field", () => {
        const shared = z.string().max(8);
        const entry = withInput(
          z.strictObject({ a: shared.describe("A"), b: shared.describe("B") }).describe("Probe"),
          {
            max: [
              ["probe.a", 2],
              ["probe.b", 4],
            ],
          },
          undefined,
          { a: "ab", b: "abcd" },
        );
        expect(check(entry)).toEqual([]);
        const properties = probeOf(entry)["properties"] as Record<string, { maxLength: number }>;
        expect([properties["a"]?.maxLength, properties["b"]?.maxLength]).toEqual([2, 4]);
        expect(toJsonSchema(shared, "input")).toEqual({ type: "string", maxLength: 8 });
        // In two entries too.
        const two = [2, 4].map((n) =>
          withInput(shared.describe("P"), { max: [["probe", n]] }, undefined, "ab"),
        );
        expect(two.map((e) => probeOf(e)["maxLength"])).toEqual([2, 4]);
        expect(two.map((e) => codes(e, "agent", "abc"))).toEqual([["too_big"], []]);
      });

      test("a schema copied from its definition's named keys gets the same rules", () => {
        // The fourth round's guard: a copy without what the helper had put on the definition.
        // Rules are entry data now, so a copy has nothing to lose.
        const field = z.string().max(8).describe("Probe");
        const copy = field.clone(
          Object.fromEntries(Object.entries(field._zod.def)) as typeof field._zod.def,
        );
        const entries = [field, copy].map((f) =>
          withInput(f.describe("Probe"), { max: [["probe", 4]] }, undefined, "abcd"),
        );
        for (const entry of entries) {
          expect(check(entry)).toEqual([]);
          expect(probeOf(entry)["maxLength"]).toBe(4);
        }
      });

      test("a default is data: it fills for both audiences and shows in both JSON Schemas", () => {
        const entry = withInput(z.int().min(1).max(4).describe("Probe").optional(), {}, [
          ["probe", 2],
        ]);
        expect(check(entry)).toEqual([]);
        for (const audience of ["agent", "user"] as const) {
          expect(parseInput(entry, audience, example.input).data?.["probe"], audience).toBe(2);
          expect(probeOf(entry, audience)["default"], audience).toBe(2);
        }
        // The schema itself has no default.
        expect(entry.input.safeParse(example.input).data).not.toHaveProperty("probe");
      });

      describe("a default factory cannot reach the generated files", () => {
        afterEach(() => {
          vi.useRealTimers();
        });
        const at = (time: string, entry: AnyEntry) => {
          vi.setSystemTime(new Date(time));
          return JSON.stringify(agentInputJsonSchema(entry));
        };

        test("the review's reproduction: two reads agree, and the render changes a second later", () => {
          vi.useFakeTimers();
          vi.setSystemTime(new Date("2026-11-12T08:00:00.000Z"));
          const createdAt = z
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .default(() => Math.floor(Date.now() / 1000))
            .describe("Created at");
          const factory = withInput(createdAt);
          const def = createdAt._zod.def;
          expect(def.defaultValue).toBe(def.defaultValue);
          expect(at("2026-11-12T08:00:00.000Z", factory)).not.toBe(
            at("2026-11-12T08:00:01.100Z", factory),
          );
          rejectsAt(factory, "input.probe", NOT_IN_GRAMMAR);
        });

        test("a default in the entry's data renders the same at any time", () => {
          vi.useFakeTimers();
          const constant = withInput(
            z.int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Created at").optional(),
            {},
            [["probe", 0]],
          );
          expect(check(constant)).toEqual([]);
          const first = at("2026-11-12T08:00:00.000Z", constant);
          expect(at("2031-02-03T23:59:59.000Z", constant)).toBe(first);
          expect(first).toContain('"default":0');
        });
      });

      test("an empty union: its JSON Schema does not compile, and the check refuses it", () => {
        const empty = z.union(any([]));
        expect(toJsonSchema(empty, "input")).toEqual({ anyOf: [] });
        expect(() => ajv.compile(toJsonSchema(empty, "input"))).toThrow();
        expect(checkSchemas({ input: z.strictObject({ p: empty.describe("P") }), output })).toEqual(
          ["input.p: a union has at least two options"],
        );
      });
    });

    describe("the fifth review's probe: rules live on the entry, not on a schema", () => {
      // The review's reproduction derived a field from a marked one with .unwrap().min(1)
      // .optional(), so the derived field lost its agentRequired() mark without a trace. The
      // mark helpers are gone: each entry lists its own rules, by path.
      const shared = z.string().max(8).optional().describe("P");
      const derived = shared.unwrap().min(1).optional().describe("P");

      test("the mark helpers, their records and the guard over them are gone", () => {
        for (const name of [
          "agentMax",
          "userOnly",
          "agentRequired",
          "withDefault",
          "agentProjection",
          "createdMarks",
          "marksOf",
          "ownMarks",
          "appliedMarks",
          "markSite",
        ]) {
          expect(Object.keys(define), name).not.toContain(name);
        }
        expect(Object.keys(registryModule)).not.toContain("registryMarks");
        expect(Object.keys(check_)).not.toContain("uneffectiveMarks");
      });

      test("two entries share a field schema, and each agent input follows its own rules", () => {
        const kept = withInput(
          shared,
          { required: ["probe"], max: [["probe", 4]] },
          undefined,
          "ab",
        );
        const made = withInput(derived, { required: ["probe"] }, undefined, "ab");
        expect([check(kept), check(made)]).toEqual([[], []]);
        for (const entry of [kept, made]) {
          // The review's symptom: the derived agent schema accepted {}.
          expect(codes(entry, "agent", undefined), entry === kept ? "kept" : "derived").toEqual([
            "invalid_type",
          ]);
          expect(codes(entry, "user", undefined)).toEqual([]);
          expect(agentInputJsonSchema(entry)["required"]).toContain("probe");
        }
        expect([probeOf(kept)["maxLength"], probeOf(made)["maxLength"]]).toEqual([4, 8]);
        expect(probeOf(made)["minLength"]).toBe(1);
        // With hidden instead: neither entry shows the field to agents.
        for (const field of [shared, derived]) {
          const entry = withInput(field, { hidden: ["probe"] });
          expect(check(entry)).toEqual([]);
          expect(agentInputJsonSchema(entry)["properties"]).not.toHaveProperty("probe");
          expect(codes(entry, "agent", "ab")).toEqual(["unrecognized_keys"]);
        }
      });

      test("an entry whose rules no longer fit its derived input fails the check", () => {
        // Derived again, without the optional: the field is required for everyone now.
        const required = shared.unwrap().min(1).describe("P");
        for (const list of ["hidden", "required"] as const) {
          expect(check(withInput(required, { [list]: ["probe"] }, undefined, "ab"))).toEqual([
            `fixture.note: agent.${list} "probe": it names an optional field, and "probe" is not one`,
          ]);
        }
        // Derived into a shorter field: the agent limit is no longer below the user's.
        expect(
          check(withInput(z.string().max(4).describe("P").optional(), { max: [["probe", 4]] })),
        ).toEqual([
          'fixture.note: agent.max "probe": the agent limit 4 must be a whole number from 1 to below the user limit 4',
        ]);
        // Derived into another shape: an enum takes no agent limit.
        expect(
          check(withInput(z.enum(["a"]).describe("P").optional(), { max: [["probe", 4]] })),
        ).toEqual([
          'fixture.note: agent.max "probe": an agent limit sits on a string, SafeText or array, not an enum',
        ]);
      });
    });
  });

  describe("entry metadata (A3 3.2.1, 3.2.3, A6 3.3)", () => {
    test("names are dotted lower case and unique", () => {
      rejects(defineEntry({ ...base, name: "FixtureNote" }), /name must be dotted lower case/);
      const twice = check(base, base);
      expect(twice).toContain('fixture.note: name "fixture.note" is used twice');
    });

    test("the summary is one short line", () => {
      rejects(
        defineEntry({ ...base, summary: "x".repeat(121) }),
        /summary must be one line of 1 to 120 characters/,
      );
    });

    test("metadata values come from their lists", () => {
      const variant = defineEntry({ ...base, scope: "space:everything" as "space:write" });
      rejects(variant, /scope "space:everything" is not one of/);
    });

    test("a write entry declares its A1 operations, a request_id and request_id_conflict", () => {
      const variant = defineEntry({
        ...base,
        ops: [],
        input: input.omit({ request_id: true }),
        errors: ["not_found"],
        examples: [{ ...example, input: { task: "M-14", text: "Checked the clinic export." } }],
      });
      expect(check(variant)).toEqual([
        "fixture.note: a write entry names the A1 operations it may emit",
        "fixture.note: a write entry requires request_id",
        "fixture.note: a write entry lists the error request_id_conflict",
      ]);
    });

    test("an entry whose task defaults to the session's takes the shared schema and lists unbound", () => {
      const session = input.extend({ task: SessionTask });
      const unlisted = defineEntry({ ...base, input: session });
      expect(check(unlisted)).toEqual([
        "fixture.note: an entry whose task defaults to the session's lists the error unbound",
      ]);
      expect(
        check(defineEntry({ ...base, input: session, errors: [...base.errors, "unbound"] })),
      ).toEqual([]);
      // Any other optional task is refused, whatever its words or what it lists: a copy, and the
      // shared schema described again.
      for (const task of [
        TaskRef.max(40).describe("Optional task reference").optional(),
        SessionTask.describe("Task ref (M-14) or ID"),
      ]) {
        const copy = input.extend({ task });
        expect(
          check(defineEntry({ ...base, input: copy, errors: [...base.errors, "unbound"] })),
        ).toEqual([
          "fixture.note: an optional task is the shared SessionTask schema from schemas.ts",
        ]);
      }
    });

    test("a read entry emits no operations and is readable remotely at most", () => {
      const variant = defineEntry({ ...base, kind: "read" });
      expect(check(variant)).toEqual([
        "fixture.note: a read entry emits no A1 operations",
        'fixture.note: a read entry has remote class "never" or "read"',
        'fixture.note: a read entry needs scope "space:read" or "machine:read"',
        "fixture.note: a read entry takes no request_id",
      ]);
    });

    test("a write entry needs a write scope and cannot be read-only remotely", () => {
      const variant = defineEntry({ ...base, scope: "space:read", remote: "read" });
      expect(check(variant)).toEqual([
        'fixture.note: operation kind "note.add" needs scope "space:write", not "space:read"',
        'fixture.note: a write entry needs a write scope, not "space:read"',
        'fixture.note: a write entry cannot have remote class "read"',
      ]);
    });

    test("request_id is the shared RequestId schema, not a look-alike (A3 3.4.1)", () => {
      // The review's probe: an integer request_id with a description passed the old check.
      const integer = defineEntry({
        ...base,
        input: input.extend({ request_id: z.int().min(0).max(99).describe("Request ID") }),
        examples: [{ ...example, input: { ...example.input, request_id: 7 } }],
      });
      expect(check(integer)).toEqual([
        "fixture.note: request_id must be the shared RequestId schema from schemas.ts (A3 3.4.1)",
      ]);
      const lookAlike = defineEntry({
        ...base,
        input: input.extend({
          request_id: z
            .string()
            .max(64)
            .regex(/^[A-Za-z0-9_-]{16,64}$/u)
            .describe("Request ID"),
        }),
      });
      expect(check(lookAlike)).toEqual([
        "fixture.note: request_id must be the shared RequestId schema from schemas.ts (A3 3.4.1)",
      ]);
      expect(
        check(defineEntry({ ...base, input: input.extend({ request_id: RequestId }) })),
      ).toEqual([]);
      // Exactly RequestId: no wrapper and no description of its own.
      for (const wrapped of [
        RequestId.optional(),
        RequestId.nullable(),
        RequestId.default("fixture-request-0001"),
        RequestId.describe("Request ID"),
      ]) {
        expect(
          check(defineEntry({ ...base, input: input.extend({ request_id: wrapped }) })),
        ).toContainEqual(
          "fixture.note: request_id must be the shared RequestId schema from schemas.ts (A3 3.4.1)",
        );
      }
    });

    test("a write that changes fields takes the shared Base schema (A1 3.5)", () => {
      const missing = defineEntry({ ...taskReopen, input: taskReopen.input.omit({ base: true }) });
      expect(check(missing)).toContainEqual(
        "task.reopen: a write entry that may emit task.reopen takes base (A1 3.5)",
      );
      const optional = defineEntry({
        ...taskReopen,
        input: taskReopen.input.extend({ base: Base.optional() }),
      });
      expect(check(optional)).toEqual([
        "task.reopen: base is required: every operation of the entry changes existing fields (A1 3.5)",
      ]);
      const lookAlike = defineEntry({
        ...taskReopen,
        input: taskReopen.input.extend({ base: z.string().max(40).describe("Base") }),
      });
      expect(check(lookAlike)).toEqual([
        "task.reopen: base must be a shared base schema from schemas.ts, or one made optional (A3 3.4.1)",
      ]);
      // task.finish also emits task.create, which needs no base, so base could be optional there.
      const finish = defineEntry({
        ...taskFinish,
        input: taskFinish.input.extend({ base: Base.optional() }),
      });
      expect(check(finish)).toEqual([]);
      // The review's probe: Base.nullable() passed, and both validators then took base: null.
      // Exactly Base or Base.optional(): no other wrapper, check or description.
      for (const entry of [taskReopen, taskUpdate] as AnyEntry[]) {
        for (const wrapped of [
          Base.nullable(),
          Base.nullable().optional(),
          Base.optional().nullable(),
          Base.default(AS_OF),
          Base.optional().describe("Base"),
          Base.min(1).optional(),
        ]) {
          expect(
            check(defineEntry({ ...entry, input: entry.input.extend({ base: wrapped }) })),
          ).toContainEqual(
            `${entry.name}: base must be a shared base schema from schemas.ts, or one made optional (A3 3.4.1)`,
          );
        }
      }
    });

    describe("[A3.3.2.3.registry.mixed-actions] an entry with read and write actions (A3 3.2.3)", () => {
      const mixedInput = z.strictObject({
        action: z.enum(["list", "add"]).describe("list reads; add writes"),
        task: SessionTask,
        text: safeText(200).describe("Note text").optional(),
        base: Base.optional(),
        request_id: RequestId.optional(),
      });
      const mixed = defineEntry({
        ...base,
        ops: ["note.add"],
        actions: { field: "action", reads: ["list"] },
        input: mixedInput,
        errors: [...base.errors, "unbound"],
        examples: [{ ...example, input: { action: "list" } }],
      });

      test("a write entry whose action field names its read actions passes", () => {
        expect(check(mixed)).toEqual([]);
      });

      test("its request_id and base are optional, the shared schemas, and nothing else", () => {
        const full = { action: "add", request_id: "fixture-request-0001", base: AS_OF } as const;
        const required = defineEntry({
          ...mixed,
          input: mixedInput.extend({ request_id: RequestId }),
          examples: [{ ...example, input: full }],
        });
        expect(check(required)).toEqual([
          "fixture.note: request_id of an entry with read actions is RequestId.optional() (A3 3.2.3)",
        ]);
        expect(
          check(
            defineEntry({
              ...mixed,
              input: mixedInput.extend({ request_id: RequestId.describe("ID").optional() }),
            }),
          ),
        ).toEqual([
          "fixture.note: request_id of an entry with read actions is RequestId.optional() (A3 3.2.3)",
        ]);
        const base_ = defineEntry({
          ...mixed,
          input: mixedInput.extend({ base: Base }),
          examples: [{ ...example, input: full }],
        });
        expect(check(base_)).toEqual([
          "fixture.note: base of an entry with read actions is Base.optional() (A3 3.2.3)",
        ]);
      });

      test("the action field is a required enum, and reads name some of its values", () => {
        const optional = defineEntry({
          ...mixed,
          input: mixedInput.extend({ action: z.enum(["list", "add"]).describe("A").optional() }),
        });
        expect(check(optional)).toContainEqual(
          'fixture.note: actions.field "action" is a required enum field of the input',
        );
        const missing = defineEntry({ ...mixed, actions: { field: "verb", reads: ["list"] } });
        expect(check(missing)).toContainEqual(
          'fixture.note: actions.field "verb" is a required enum field of the input',
        );
        expect(check(defineEntry({ ...mixed, actions: { field: "action", reads: [] } }))).toEqual([
          "fixture.note: actions.reads names at least one read action",
        ]);
        expect(
          check(defineEntry({ ...mixed, actions: { field: "action", reads: ["list", "show"] } })),
        ).toEqual(['fixture.note: actions.reads "show" is not a value of "action"']);
        expect(
          check(defineEntry({ ...mixed, actions: { field: "action", reads: ["list", "list"] } })),
        ).toEqual(['fixture.note: actions.reads "list" is listed twice']);
        expect(
          check(defineEntry({ ...mixed, actions: { field: "action", reads: ["list", "add"] } })),
        ).toEqual(["fixture.note: every action only reads: make it a read entry"]);
      });

      test("a read entry declares no actions, and an entry without them keeps request_id required", () => {
        const read = defineEntry({
          ...mixed,
          kind: "read",
          ops: [],
          remote: "read",
          scope: "space:read",
          errors: ["not_found", "unbound"],
          input: mixedInput.omit({ request_id: true, base: true }),
        });
        expect(check(read)).toEqual([
          "fixture.note: only a write entry declares read actions: a read entry reads in every action",
        ]);
        const plain: AnyEntry = { ...mixed };
        delete (plain as { actions?: unknown }).actions;
        expect(check(defineEntry(plain))).toContainEqual(
          "fixture.note: request_id must be the shared RequestId schema from schemas.ts (A3 3.4.1)",
        );
      });

      test("readsOnly tells a read action from a write action", () => {
        expect(define.readsOnly(mixed, { action: "list" })).toBe(true);
        expect(define.readsOnly(mixed, { action: "add" })).toBe(false);
        expect(define.readsOnly(mixed, {})).toBe(false);
        expect(define.readsOnly(base, { action: "list" })).toBe(false);
        expect(define.readsOnly({ ...base, kind: "read" }, {})).toBe(true);
      });
    });

    test("a read entry filters its result by audience", () => {
      const variant = defineEntry({
        ...base,
        kind: "read",
        ops: [],
        remote: "read",
        scope: "space:read",
        audience: "none",
        input: input.omit({ request_id: true }),
        examples: [{ ...example, input: { task: "M-14", text: "Checked the clinic export." } }],
      });
      expect(check(variant)).toEqual([
        'fixture.note: a read entry filters its result by audience ("caller")',
      ]);
    });

    test("operation kinds come from the operation table", () => {
      expect(check(defineEntry({ ...base, ops: ["Note Add", "note.shout"] }))).toEqual([
        'fixture.note: operation kind "Note Add" is not in the operation table (operations.ts)',
        'fixture.note: operation kind "note.shout" is not in the operation table (operations.ts)',
      ]);
      expect(check(defineEntry({ ...base, ops: ["launch.*"] }))).toEqual([
        'fixture.note: operation kind "launch.*" is not in the operation table (operations.ts)',
      ]);
      expect(check(defineEntry({ ...base, ops: ["machine.register"] }))).toEqual([
        'fixture.note: operation kind "machine.register" is the service\'s own: no entry emits it',
      ]);
    });

    test("agent-allowed entries never execute, launch or administer (R7)", () => {
      const variant = defineEntry({ ...base, remote: "execute", scope: "launch:run" });
      expect(check(variant)).toEqual([
        'fixture.note: operation kind "note.add" needs scope "space:write", not "launch:run"',
        'fixture.note: an agent-allowed entry cannot have remote class "execute" (R7)',
        'fixture.note: an agent-allowed entry cannot need scope "launch:run" (R7)',
      ]);
    });

    test("an agent-allowed entry cannot declare an operation R7 keeps for the user", () => {
      // The review's probe: ops ["run.start"] with scope space:write and remote write passed.
      expect(check(defineEntry({ ...entryAdd, ops: ["run.start"] }))).toEqual([
        'entry.add: operation kind "run.start" needs scope "launch:run", not "space:write"',
        'entry.add: an agent-allowed entry cannot emit "run.start" (R7: launches, runs and routines are the user\'s)',
      ]);
      for (const op of ["launch.create", "routine.patch"]) {
        rejects(
          defineEntry({ ...entryAdd, ops: [op] }),
          new RegExp(
            `entry\\.add: (operation kind "${op}" needs scope|an agent-allowed entry cannot emit "${op}" \\(R7)`,
          ),
        );
      }
      expect(check(defineEntry({ ...entryAdd, ops: ["log.add", "proposal.accept"] }))).toEqual([
        'entry.add: an agent-allowed entry cannot emit the user-only "proposal.accept" (A3 3.2.3)',
      ]);
      // The same operations are fine on a user-only entry with the right scope.
      const userEntry = defineEntry({
        ...base,
        actors: "user",
        ops: ["proposal.accept"],
        faces: { ui: true, cli: { verb: "fixture-note", positional: ["task", "text"] } },
        examples: [{ ...example, actor: "user" }],
      });
      expect(check(userEntry)).toEqual([]);
    });

    describe("operations a user-only entry emits", () => {
      const withBase = input.extend({ base: Base });
      const userEntry = (ops: string[], scope: AnyEntry["scope"]) =>
        defineEntry({
          ...base,
          actors: "user",
          scope,
          remote: "never",
          ops,
          input: withBase,
          faces: { ui: true },
          budget: undefined as never,
          examples: [{ ...example, actor: "user", input: { ...example.input, base: AS_OF } }],
        });

      test("editing a routine needs admin, running one launch:run (A6 3.6.3)", () => {
        // The review's probe: routine.patch passed with the execution scope.
        expect(check(userEntry(["routine.patch"], "launch:run"))).toEqual([
          'fixture.note: operation kind "routine.patch" needs scope "admin", not "launch:run"',
        ]);
        expect(check(userEntry(["routine.create", "routine.patch"], "admin"))).toEqual([]);
        expect(check(userEntry(["routine.run"], "launch:run"))).toEqual([]);
        expect(check(userEntry(["routine.run"], "admin"))).toEqual([
          'fixture.note: operation kind "routine.run" needs scope "launch:run", not "admin"',
        ]);
        // Policy keys travel in pref.set, so an entry for them may need admin. The handler
        // refuses a policy key without it (A1 3.16, A6 3.6.3).
        expect(check(userEntry(["pref.set"], "admin"))).toEqual([]);
        expect(check(userEntry(["pref.set"], "space:write"))).toEqual([]);
      });
    });

    test("the table holds only unconditional preconditions (A1 3.6)", () => {
      // The review's probe: source.unlink with a link version and no base failed. A1 takes a
      // link version or a base, so the handler checks it.
      const unlink = defineEntry({
        ...base,
        ops: ["source.unlink"],
        input: input.extend({
          link_version: z.int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Link version"),
        }),
        examples: [{ ...example, input: { ...example.input, link_version: 3 } }],
      });
      expect(check(unlink)).toEqual([]);
      // A base only for an existing place, a link version only for a removal or a revival.
      for (const op of ["place.set", "place.clear", "source.add", "task.label"]) {
        expect(check(defineEntry({ ...base, ops: [op] })), op).toEqual([]);
      }
      // An unconditional base stays required.
      expect(check(defineEntry({ ...base, ops: ["log.delete"] }))).toEqual([
        "fixture.note: a write entry that may emit log.delete takes base (A1 3.5)",
      ]);
    });

    test("only agent-allowed entries have an MCP face, and user-only entries have no examples as an agent", () => {
      const variant = defineEntry({
        ...base,
        actors: "user",
        budget: undefined as never,
        examples: [{ ...example, actor: "user" }],
      });
      rejects(variant, /only agent-allowed entries have an MCP face/);
      const agentExample = defineEntry({
        ...variant,
        faces: { ...base.faces, mcp: undefined as never },
        examples: [{ ...example, actor: "agent" }],
      });
      rejects(agentExample, /example "A note on M-14": a user-only entry has user examples only/);
    });

    test("UI-only entries have no CLI face", () => {
      const uiOnly = defineEntry({
        ...base,
        actors: "ui",
        faces: { ui: true, cli: { verb: "fixture-note" } },
        examples: [{ ...example, actor: "user" }],
      });
      rejects(uiOnly, /a UI-only entry has no CLI face/);
    });

    test("error codes come from the catalogue, once each", () => {
      const variant = defineEntry({
        ...base,
        errors: ["request_id_conflict", "request_id_conflict", "teapot" as "not_found"],
      });
      expect(check(variant)).toEqual([
        'fixture.note: error "request_id_conflict" is listed twice',
        'fixture.note: error "teapot" is not in the catalogue',
      ]);
    });
  });

  describe("MCP names and budgets (A3 3.2.4, 3.2.5)", () => {
    const withTool = (tool: string) =>
      defineEntry({ ...base, faces: { ...base.faces, mcp: { ...mcp, tool } } });

    test("tool names are snake_case, at most 24 characters, not tasks, not led by the server key", () => {
      rejects(withTool("fixtureNote"), /tool name "fixtureNote" must be snake_case/);
      rejects(withTool("record_a_fixture_note_now"), /at most 24 characters/);
      rejects(withTool("tasks"), /no tool is called "tasks"/);
      rejects(withTool("acme"), /a tool name does not start with the MCP server key \("acme"\)/);
      rejects(withTool("acme_note"), /a tool name does not start with the MCP server key/);
      // A later word may be the key's own word (A3 3.2.4): add_tasks under the key tasks.
      expect(check(withTool("add_acme"))).toEqual([]);
      expect(check(withTool("acmenote"))).toEqual([]);
    });

    test("tool names are unique", () => {
      const other = defineEntry({
        ...base,
        name: "fixture.other",
        faces: { ...base.faces, cli: { verb: "fixture-other" } },
      });
      expect(check(base, other)).toEqual(['fixture.other: tool name "fixture_note" is used twice']);
    });

    test("the tool description is at most 280 characters", () => {
      const variant = defineEntry({
        ...base,
        faces: { ...base.faces, mcp: { ...mcp, description: "Use it. " + "x".repeat(280) } },
      });
      rejects(variant, /tool description is 288 characters, the limit is 280/);
    });

    test("an agent-allowed entry declares a result budget within the caps", () => {
      rejects(defineEntry({ ...base, budget: undefined as never }), /declares a budget/);
      rejects(
        defineEntry({ ...base, budget: { typical: 500, max: 5000 } }),
        /budget: typical 500 must not exceed max 5000, and max must not exceed 4000/,
      );
    });

    test("a tool definition's size is reported, never refused (A3 3.2.5)", () => {
      // 80 tools with long descriptions: far over A3 3.2.5's old caps, and still no problem.
      const many = Array.from({ length: 80 }, (_, i) =>
        defineEntry({
          ...base,
          name: `fixture.note${String(i)}`,
          faces: {
            ui: true,
            mcp: {
              ...mcp,
              tool: `fixture_note_${String(i)}`,
              description: `Use it. ${"x".repeat(270)}`,
            },
          },
        }),
      );
      expect(check(...many)).toEqual([]);
    });

    test("alwaysLoad is true or false", () => {
      expect(
        check(
          defineEntry({ ...base, faces: { ...base.faces, mcp: { ...mcp, alwaysLoad: true } } }),
        ),
      ).toEqual([]);
      rejects(
        defineEntry({
          ...base,
          faces: { ...base.faces, mcp: { ...mcp, alwaysLoad: "yes" as unknown as boolean } },
        }),
        /tool alwaysLoad is true or false/,
      );
    });
  });

  describe("CLI faces (A2 3.10, A3 3.4.13)", () => {
    test("verbs are lower case and unique", () => {
      rejects(
        defineEntry({ ...base, faces: { ...base.faces, cli: { verb: "Note" } } }),
        /verb "Note" must be lower case/,
      );
      const other = defineEntry({
        ...base,
        name: "fixture.other",
        faces: { ui: true, cli: { verb: "fixture-note" } },
      });
      expect(check(base, other)).toEqual(['fixture.other: verb "fixture-note" is used twice']);
    });

    test("a verb is shared only through when: one face without it, flags of the other's own fields", () => {
      const input = base.input.extend({ drop: z.string().max(10).describe("Drop it").optional() });
      const sharing = (when: string[]) =>
        defineEntry({
          ...base,
          name: "fixture.other",
          input,
          faces: { ui: true, cli: { verb: "fixture-note", positional: ["task"], when } },
        });
      expect(check(base, sharing(["drop"]))).toEqual([]);
      expect(check(sharing(["drop"]))).toEqual([
        'fixture.other: verb "fixture-note" with when needs a face without when',
      ]);
      expect(check(base, sharing(["task"]))).toEqual([
        'fixture.other: cli "fixture-note": when "task" is not a flag of a scalar input field',
        'fixture.other: when "task" is a field of fixture.note too',
      ]);
      expect(check(base, sharing(["text"]))).toEqual([
        'fixture.other: when "text" is a field of fixture.note too',
      ]);
    });

    test("positionals, flags and short names name existing scalar fields", () => {
      const variant = defineEntry({
        ...base,
        faces: {
          ...base.faces,
          cli: {
            verb: "fixture-note",
            positional: ["task", "nope"],
            flags: { missing: "gone" },
            short: { text: "tx" },
          },
        },
      });
      expect(check(variant)).toEqual([
        'fixture.note: cli "fixture-note": positional "nope" is not a scalar input field',
        'fixture.note: cli "fixture-note": flags names unknown field "missing"',
        'fixture.note: cli "fixture-note": short name "tx" for "text" must be one letter',
      ]);
    });

    test("fixed values must be valid for their field", () => {
      const variant = defineEntry({
        ...base,
        faces: { ...base.faces, cli: { verb: "fixture-note", fixed: { task: "nope" } } },
      });
      rejects(variant, /cli "fixture-note": fixed value for "task" is not valid/);
    });
  });

  describe("examples (A3 3.2.1)", () => {
    test("every entry has an example", () => {
      rejects(defineEntry({ ...base, examples: [] }), /needs at least one example/);
    });

    test("an agent example must fit the agent projection", () => {
      const variant = defineEntry({
        ...base,
        agent: { hidden: ["pinned"] },
        examples: [{ ...example, input: { ...example.input, pinned: true } }],
      });
      rejects(variant, /example "A note on M-14": input does not match the agent input/);
    });

    test("a field agents must give may be left out by the user only", () => {
      const variant = defineEntry({
        ...base,
        input: input.extend({ text: safeText(200).describe("Note text").optional() }),
        agent: { required: ["text"] },
        examples: [
          {
            ...example,
            title: "User check",
            actor: "user",
            input: { task: "M-14", request_id: "fixture-request-0002" },
          },
          {
            ...example,
            title: "Agent",
            input: { task: "M-14", request_id: "fixture-request-0003" },
          },
        ],
      });
      expect(check(variant)).toEqual([
        'fixture.note: example "Agent": input does not match the agent input: text: Invalid input: expected string, received undefined',
      ]);
    });

    test("an example output must match the output schema", () => {
      const variant = defineEntry({
        ...base,
        examples: [{ ...example, output: { result: "logged" as const, task: "nope" } }],
      });
      rejects(variant, /example "A note on M-14": output does not match the output schema/);
    });
  });
});
