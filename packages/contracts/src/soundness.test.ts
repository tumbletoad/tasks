// The soundness property test (A3 3.2.1). Values are generated from each generated JSON
// Schema itself: valid values at and around every limit, in ASCII and in text that SafeText
// lengthens or shortens, every enum value, pattern matches and near misses, wrong types, and
// missing and extra keys. For every entry's input, agent input and output it asserts:
//   0. the JSON Schema is the same on every render and at any time, and Ajv compiles it;
//   1. Zod and Ajv give the same verdict, on the value as sent and on Zod's normalised value, and
//      both accept every value the JSON Schema allows;
//   2. parseInput() returns a value its schema accepts again unchanged, which a second
//      parseInput() returns unchanged;
//   3. the full input accepts what the agent input accepts and parses it the same.
// A fourth property is intent: every agent rule and default the entry's data lists takes effect.
// Its expectations come from the entry's data, not from the built schemas: an agent limit is the
// agent schema's limit, a hidden field is gone, a required field is required, and a default is
// the schemas' default. A projection that skips a rule or is off by one fails it.
// The same generator then runs over hostile probe schemas: each is either rejected by the
// registry check or passes all four. Accepted by the check implies sound.
import { isDeepStrictEqual } from "node:util";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { checkSchemas } from "./check.ts";
import {
  defOf,
  inputSchemaFor,
  isAgentAllowed,
  parseInput,
  pathSteps,
  under,
  type AgentRules,
  type AnyEntry,
  type Audience,
  type Defaults,
  type Limit,
  type Rules,
} from "./define.ts";
import { toJsonSchema, type JsonSchema } from "./json-schema.ts";
import { registry } from "./registry.ts";
import { normaliseText, safeLine, safeText } from "./safe-text.ts";
import { AGENT_LIMITS, Base, USER_LIMITS } from "./schemas.ts";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const QA = "\u0958"; // NFC turns it into two code points
const ZWSP = "\u200b"; // SafeText removes it
const ASTRAL = "\u{1f600}";
/** Single code points: ASCII, line ends, what SafeText removes, combining marks, lone surrogates. */
const POOL = [
  "a",
  "b",
  " ",
  "Z",
  "0",
  "-",
  ":",
  "\t",
  "\n",
  "\r",
  QA,
  ZWSP,
  "\u{e0041}",
  "\u202e",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u0000",
  "\u007f",
  "\u0085",
  "e",
  "\u0301",
  "\u00e9",
  ASTRAL,
  "\ud800",
  "\udc00",
];
/** Keys an object must refuse, including ones every JavaScript object has. */
const EXTRA_KEYS = ["zz_extra", "__proto__", "constructor", "toString", "hasOwnProperty"];
const WRONG: Json[] = [null, 0, -1, 1.5, "", "x", true, [], {}];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const sub = (v: unknown): JsonSchema => (isRecord(v) ? v : {});
const codePoints = (s: string) => Array.from(s).length;
const uniq = <T>(values: T[]) => [...new Set(values)];
const own = (pairs: [string, Json][]): Json => Object.fromEntries(pairs);

interface Arbs {
  /** Values the JSON Schema allows. */
  readonly valid: fc.Arbitrary<Json>;
  /** Values with one defect somewhere, which may still happen to be valid. */
  readonly near: fc.Arbitrary<Json>;
  /** The smallest valid value, which fills arrays at their item limits cheaply. */
  readonly smallest: Json;
}

const wrongType = fc.constantFrom(...WRONG);
/** For probes that pass options or checks Zod's types refuse on purpose. */
const any = (value: unknown) => value as never;

/** Strings of exactly `n` code points, plain and hostile. */
function textOf(n: number): fc.Arbitrary<string> {
  const head = Math.min(n, 48);
  return fc.oneof(
    fc.constant("x".repeat(n)),
    fc.constant(ASTRAL.repeat(n)),
    fc.constant(QA.repeat(n)),
    fc.constant(ZWSP.repeat(n)),
    fc
      .array(fc.constantFrom(...POOL), { minLength: head, maxLength: head })
      .map((cs) => cs.join("") + "x".repeat(n - head)),
  );
}

/** A word and the spellings that normalise to it or nearly match it. */
function variants(word: string): string[] {
  return [word, `${word}${ZWSP}`, `${ZWSP}${word}`, `${word}\r\n`, word.toUpperCase(), ` ${word}`];
}

/** The string, enum and const values in a schema: likely near misses for every other string. */
function wordsOf(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const v of schema) wordsOf(v, into);
  else if (isRecord(schema)) {
    if (typeof schema["const"] === "string") into.add(schema["const"]);
    if (Array.isArray(schema["enum"])) {
      for (const v of schema["enum"]) if (typeof v === "string") into.add(v);
    }
    for (const [key, v] of Object.entries(schema)) if (key !== "description") wordsOf(v, into);
  }
  return into;
}

class Generator {
  /** Paths of the nodes a valid value was generated for. */
  readonly reached = new Set<string>();
  /** Every node path of the schema. */
  readonly nodes = new Set<string>();
  private readonly words: string[];

  constructor(schema: JsonSchema) {
    this.words = [...wordsOf(schema)].flatMap(variants);
  }

  arbs(s: JsonSchema, path: string): Arbs {
    this.nodes.add(path);
    const found = this.kind(s, path);
    return {
      valid: found.valid.map((v) => {
        this.reached.add(path);
        return v;
      }),
      near: found.near,
      smallest: found.smallest,
    };
  }

  private kind(s: JsonSchema, path: string): Arbs {
    if (Array.isArray(s["anyOf"])) {
      const options = s["anyOf"].map((o, i) => this.arbs(sub(o), `${path}|${String(i)}`));
      return {
        valid: fc.oneof(...options.map((o) => o.valid)),
        near: fc.oneof(...options.map((o) => o.near)),
        smallest: options[0]?.smallest ?? null,
      };
    }
    if (s["const"] !== undefined) return this.values([s["const"] as Json]);
    if (Array.isArray(s["enum"])) return this.values(s["enum"] as Json[]);
    switch (s["type"]) {
      case "string":
        return this.string(s);
      case "integer":
      case "number":
        return this.number(s, s["type"] === "integer");
      case "boolean":
        return {
          valid: fc.boolean(),
          near: fc.constantFrom<Json>("true", 0, null),
          smallest: false,
        };
      // Only as a union option: a preference value's reset (A3 3.4.11).
      case "null":
        return {
          valid: fc.constant(null),
          near: fc.constantFrom<Json>("null", 0, false, ""),
          smallest: null,
        };
      case "array":
        return this.array(s, path);
      case "object":
        return isRecord(s["additionalProperties"]) ? this.record(s, path) : this.object(s, path);
      default:
        throw new Error(`${path}: the generator does not know ${JSON.stringify(s)}`);
    }
  }

  private values(values: Json[]): Arbs {
    const misses = values.flatMap((v) =>
      typeof v === "string" ? variants(v) : [JSON.stringify(v)],
    );
    return {
      valid: fc.constantFrom(...values),
      near: fc.oneof(fc.constantFrom<Json>(...misses, "zz_none"), wrongType),
      smallest: values[0] ?? null,
    };
  }

  private string(s: JsonSchema): Arbs {
    const min = num(s["minLength"]) ?? 0;
    const max = num(s["maxLength"]);
    const top = max ?? min + 24;
    const pattern = typeof s["pattern"] === "string" ? new RegExp(s["pattern"], "u") : undefined;
    const fits = (t: string) =>
      codePoints(t) >= min && codePoints(t) <= (max ?? Infinity) && (pattern?.test(t) ?? true);
    const words = this.words.filter(fits);
    const sized = (lengths: number[]) => fc.constantFrom(...uniq(lengths)).chain((n) => textOf(n));
    // Long text is slow to parse, so the short end comes up more often. Both ends always do.
    const lengths = [min, min, min + 1, top - 1, top].filter((n) => n >= min && n <= top);
    const valid = pattern ? fc.stringMatching(pattern).filter(fits) : sized(lengths);
    const smallest = pattern
      ? (words[0] ?? fc.sample(valid, { numRuns: 1, seed: 1 })[0] ?? "")
      : "x".repeat(min);
    const near: fc.Arbitrary<Json>[] = [wrongType];
    if (max !== undefined) near.push(sized([max + 1]));
    if (min > 0) near.push(sized([min - 1]));
    if (pattern) {
      // Text of the right length that the pattern may refuse, such as an emoji for /^.$/.
      near.push(sized(lengths));
      near.push(
        fc
          .stringMatching(pattern)
          .chain((t) =>
            fc.constantFrom(
              `${t}x`,
              `x${t}`,
              t.slice(1),
              `${t}${ZWSP}`,
              t.toUpperCase(),
              t.replace(/[0-9]/u, ASTRAL),
            ),
          ),
      );
    }
    if (this.words.length > 0) near.push(fc.constantFrom(...this.words));
    return {
      valid: words.length > 0 ? fc.oneof(valid, fc.constantFrom(...words)) : valid,
      near: fc.oneof(...near),
      smallest,
    };
  }

  private number(s: JsonSchema, integer: boolean): Arbs {
    const min = num(s["minimum"]) ?? num(s["exclusiveMinimum"]);
    const max = num(s["maximum"]) ?? num(s["exclusiveMaximum"]);
    if (min === undefined || max === undefined) throw new Error("a number has bounds");
    const low =
      s["exclusiveMinimum"] === undefined ? min : integer ? min + 1 : min + (max - min) / 4;
    const high =
      s["exclusiveMaximum"] === undefined ? max : integer ? max - 1 : max - (max - min) / 4;
    const clamp = (n: number) => Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, n));
    const inside = integer
      ? fc.integer({ min: clamp(low), max: clamp(high) })
      : fc.double({ min: low, max: high, noNaN: true });
    return {
      valid: fc.oneof(fc.constantFrom(low, high), inside),
      near: fc.oneof(
        fc.constantFrom<Json>(min - 1, max + 1, min, max, low + 0.5, 2 ** 53, String(low)),
        wrongType,
      ),
      smallest: low,
    };
  }

  private array(s: JsonSchema, path: string): Arbs {
    const item = this.arbs(sub(s["items"]), `${path}[]`);
    const min = num(s["minItems"]) ?? 0;
    const max = num(s["maxItems"]);
    const top = max ?? min + 3;
    const small = Math.min(top, min + 2);
    // At an item limit, one generated item and the rest the smallest: rich items cost seconds.
    const sized = (n: number): fc.Arbitrary<Json> =>
      n === 0
        ? fc.constant([])
        : item.valid.map((v) => [v, ...Array<Json>(n - 1).fill(item.smallest)]);
    const near: fc.Arbitrary<Json>[] = [
      wrongType,
      fc
        .tuple(
          fc.array(item.valid, {
            minLength: Math.max(0, min - 1),
            maxLength: Math.max(0, small - 1),
          }),
          item.near,
          fc.nat(),
        )
        .map(([items, bad, i]) => items.toSpliced(i % (items.length + 1), 0, bad)),
    ];
    if (max !== undefined) near.push(sized(max + 1));
    if (min > 0) near.push(sized(min - 1));
    return {
      valid: fc.oneof(
        { weight: 4, arbitrary: fc.array(item.valid, { minLength: min, maxLength: small }) },
        { weight: 1, arbitrary: sized(top) },
      ),
      near: fc.oneof(...near),
      smallest: Array<Json>(min).fill(item.smallest),
    };
  }

  private object(s: JsonSchema, path: string): Arbs {
    const properties = Object.entries(sub(s["properties"]));
    const required = new Set(Array.isArray(s["required"]) ? (s["required"] as string[]) : []);
    const fields = properties.map(([key, p]) => ({
      key,
      arbs: this.arbs(sub(p), `${path}/${key}`),
    }));
    const build = (bad?: string): fc.Arbitrary<Json> =>
      fc
        .tuple(
          ...fields.map(({ key, arbs }) => {
            const value = (key === bad ? arbs.near : arbs.valid).map((v): [string, Json] => [
              key,
              v,
            ]);
            return required.has(key) || key === bad
              ? value
              : fc.option(value, { nil: undefined, freq: 3 });
          }),
        )
        .map((pairs) => own(pairs.filter((p) => p !== undefined)));
    const valid = build();
    const keys = fields.map((f) => f.key);
    const near: fc.Arbitrary<Json>[] = [
      wrongType,
      fc
        .tuple(
          valid,
          fc.constantFrom(...EXTRA_KEYS, ...keys.flatMap((k) => [`${k}${ZWSP}`, k.toUpperCase()])),
          fc.constantFrom<Json>(1, "x", null),
        )
        .map(([v, key, x]) => own([...Object.entries(v as Record<string, Json>), [key, x]])),
    ];
    if (keys.length > 0) near.push(fc.constantFrom(...keys).chain((k) => build(k)));
    if (required.size > 0) {
      near.push(
        fc
          .tuple(valid, fc.constantFrom(...required))
          .map(([v, key]) =>
            own(Object.entries(v as Record<string, Json>).filter(([k]) => k !== key)),
          ),
      );
    }
    const smallest = own(
      fields
        .filter((f) => required.has(f.key))
        .map((f): [string, Json] => [f.key, f.arbs.smallest]),
    );
    return { valid, near: fc.oneof(...near), smallest };
  }

  /** An object whose keys are free and whose values follow one schema (outputs only). */
  private record(s: JsonSchema, path: string): Arbs {
    const value = this.arbs(sub(s["additionalProperties"]), `${path}{}`);
    const key = fc.oneof(
      fc.constantFrom("open", "", `a${ZWSP}`, ...EXTRA_KEYS),
      fc.string({ maxLength: 8 }),
    );
    const valid = fc.array(fc.tuple(key, value.valid), { maxLength: 3 }).map((pairs) => own(pairs));
    return {
      valid,
      near: fc.oneof(
        wrongType,
        fc
          .tuple(valid, key, value.near)
          .map(([v, k, x]) => own([...Object.entries(v as Record<string, Json>), [k, x]])),
      ),
      smallest: {},
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The properties.

/** What the test needs of an entry: its input, rules and output. Probes need no metadata. */
interface Subject extends Rules {
  readonly label: string;
  readonly output: z.ZodType;
  /** Test the agent input too: true for agent-allowed entries. */
  readonly agentAllowed: boolean;
}

interface Run {
  readonly seed?: number;
  readonly numRuns: number;
}

type Side = "input" | "agent" | "output";

const deepEqual = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

/** Two times far apart. A schema renders the same at both, and twice at the first. */
const TIMES = ["2026-11-12T08:00:00.000Z", "2031-02-03T23:59:59.999Z"] as const;

/** The JSON Schema, which must not change between renders or with the clock. */
function stableJson(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(TIMES[0]));
    const first = toJsonSchema(schema, io);
    const again = toJsonSchema(schema, io);
    vi.setSystemTime(new Date(TIMES[1]));
    const later = toJsonSchema(schema, io);
    if (!deepEqual(first, again) || !deepEqual(first, later)) {
      throw new Error("it changes between renders");
    }
    return first;
  } finally {
    vi.useRealTimers();
  }
}

/** Runs properties 0 to 3 on one schema of a subject. Returns the failure, if any. */
function runSide(
  subject: Subject,
  side: Side,
  run: Run,
  coverage?: Generator[],
): string | undefined {
  const audience: Audience = side === "agent" ? "agent" : "user";
  const schema = side === "output" ? subject.output : inputSchemaFor(subject, audience);
  let json: JsonSchema;
  let validate: ValidateFunction;
  try {
    json = stableJson(schema, side === "output" ? "output" : "input");
    validate = ajv.compile(json);
  } catch (error) {
    return `${subject.label} ${side}: no stable JSON Schema that Ajv compiles (${String(error)})`;
  }
  const generator = new Generator(json);
  coverage?.push(generator);
  const { valid, near } = generator.arbs(json, "");
  const sample = fc.oneof(
    { weight: 3, arbitrary: valid.map((value) => ({ value, valid: true })) },
    { weight: 2, arbitrary: near.map((value) => ({ value, valid: false })) },
  );
  const property = fc.property(sample, ({ value, valid: allowed }) => {
    const zod = schema.safeParse(value);
    const ajvOk = validate(value);
    if (zod.success !== ajvOk) throw new Error(`Zod ${String(zod.success)}, Ajv ${String(ajvOk)}`);
    if (allowed && !ajvOk) throw new Error("both refuse a value the JSON Schema allows");
    if (zod.success && !deepEqual(zod.data, value)) {
      const again = schema.safeParse(zod.data).success;
      if (again !== validate(zod.data)) {
        throw new Error(`on the normalised value: Zod ${String(again)}, Ajv ${String(!again)}`);
      }
    }
    if (side === "output") return;
    const parsed = parseInput(subject, audience, value);
    // A value the JSON Schema accepts fails the boundary parse only on a limit that normalising
    // pushed it past, which the service answers with too_large.
    const codes = parsed.error?.issues.map((i) => i.code) ?? [];
    if (ajvOk && codes.some((code) => code !== "too_big")) {
      throw new Error(`parseInput refused a value the JSON Schema accepts: ${codes.join(", ")}`);
    }
    if (parsed.success) {
      const again = schema.safeParse(parsed.data);
      if (!again.success || !deepEqual(again.data, parsed.data)) {
        throw new Error("parseInput returned a value its schema refuses or changes");
      }
      if (!validate(parsed.data)) throw new Error("parseInput returned a value Ajv refuses");
      const twice = parseInput(subject, audience, parsed.data);
      if (!twice.success || !deepEqual(twice.data, parsed.data)) {
        throw new Error("a second parseInput changed the value");
      }
    }
    if (side === "agent" && zod.success) {
      if (!inputSchemaFor(subject, "user").safeParse(value).success) {
        throw new Error("the full input refuses a value the agent input accepts");
      }
      const user = parseInput(subject, "user", value);
      if (parsed.success && (!user.success || !deepEqual(user.data, parsed.data))) {
        throw new Error("the user's parse differs from the agent's");
      }
    }
  });
  const details = fc.check(property, {
    numRuns: run.numRuns,
    endOnFailure: true,
    ...(run.seed === undefined ? {} : { seed: run.seed }),
  });
  if (!details.failed) return undefined;
  const error = details.errorInstance instanceof Error ? details.errorInstance.message : "failed";
  const shown = fc.stringify(details.counterexample?.[0]).slice(0, 300);
  return `${subject.label} ${side}: ${error} for ${shown} (seed ${String(details.seed)}, path ${String(details.counterexamplePath)})`;
}

/** Every failure of properties 0 to 3 on a subject, over each run. */
function soundness(subject: Subject, runs: readonly Run[], coverage?: Generator[]): string[] {
  const sides: Side[] = subject.agentAllowed ? ["input", "agent", "output"] : ["input", "output"];
  const failures: string[] = [];
  for (const side of sides) {
    for (const run of runs) {
      const failure = runSide(subject, side, run, run.seed === SEED ? coverage : undefined);
      if (failure !== undefined) {
        failures.push(failure);
        break;
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Property 4, intent: every agent rule and default the entry's data lists takes effect. The
// expected effects come from the data, never from the built schemas. The test follows each path
// through the generated JSON Schemas and the Zod schemas, and checks the effect there. It also
// looks inside union options, which no path may name, so a rule that names one fails here too.

/** The node a path names in a JSON Schema: properties, items, and the options of an anyOf. */
function jsonAt(json: JsonSchema | undefined, steps: readonly string[]): JsonSchema | undefined {
  let node = json;
  for (const step of steps) {
    if (node === undefined) return undefined;
    if (step === "[]") {
      node = isRecord(node["items"]) ? node["items"] : undefined;
      continue;
    }
    const options = Array.isArray(node["anyOf"]) ? node["anyOf"].map(sub) : [node];
    const owner = options.find((o) => Object.hasOwn(sub(o["properties"]), step));
    node = owner === undefined ? undefined : sub(sub(owner["properties"])[step]);
  }
  return node;
}

/** The node a path names in a Zod schema, through optionals, defaults, SafeText and unions. */
function zodAt(schema: z.ZodType, steps: readonly string[]): z.ZodType | undefined {
  let node: z.ZodType | undefined = schema;
  for (const step of steps) {
    if (node === undefined) return undefined;
    const def = defOf(unwrap(node));
    if (step === "[]") {
      node = def["element"] as z.ZodType | undefined;
      continue;
    }
    const options = def.type === "union" ? (def["options"] as z.ZodType[]).map(unwrap) : [node];
    const shapes = options.map(
      (o) => (defOf(unwrap(o))["shape"] ?? {}) as Record<string, z.ZodType>,
    );
    node = shapes.find((s) => Object.hasOwn(s, step))?.[step];
  }
  return node;
}

function unwrap(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  if (def.type === "optional" || def.type === "default")
    return unwrap(def["innerType"] as z.ZodType);
  if (def.type === "pipe") return unwrap(def["in"] as z.ZodType);
  return schema;
}

const issueCodes = (result: { error?: z.ZodError | undefined }) =>
  result.error?.issues.map((i) => i.code) ?? [];
const limitOf = (json: JsonSchema | undefined) => json?.["maxLength"] ?? json?.["maxItems"];
const requiredOf = (json: JsonSchema | undefined) =>
  Array.isArray(json?.["required"]) ? (json["required"] as string[]) : [];
const stepsOf = (path: string) => pathSteps(path) ?? [path];
const within = (path: string, field: string) =>
  path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`);

/** The audience inputs the intent check judges: by default, the ones the entry's data builds. */
interface Built {
  readonly agent: z.ZodType;
  readonly user: z.ZodType;
}

const builtFor = (rules: Rules): Built => ({
  agent: inputSchemaFor(rules, "agent"),
  user: inputSchemaFor(rules, "user"),
});

/**
 * Whether every rule and default in a subject's data shows its effect in the built schemas: in the
 * agent JSON Schema and the agent Zod schema, and for a default in the user's too.
 */
function intent(subject: Subject, built: Built = builtFor(subject)): string[] {
  const agentJson = toJsonSchema(built.agent, "input");
  const userJson = toJsonSchema(built.user, "input");
  const { hidden = [], required = [], max = [] } = subject.agent ?? {};
  const problems: string[] = [];
  const say = (rule: string, problem: string) =>
    problems.push(`${subject.label}: ${rule}: ${problem}`);
  for (const path of hidden) {
    const at = stepsOf(path);
    if (jsonAt(agentJson, at) !== undefined || zodAt(built.agent, at) !== undefined) {
      say(`hidden "${path}"`, "the field reaches agents");
    }
    if (jsonAt(userJson, at) === undefined) say(`hidden "${path}"`, "the user lost the field");
  }
  for (const path of required) {
    const rule = `required "${path}"`;
    const at = stepsOf(path);
    const parent = at.slice(0, -1);
    const key = at[at.length - 1] ?? "";
    if (!requiredOf(jsonAt(agentJson, parent)).includes(key)) {
      say(rule, "the agent JSON Schema does not require the field");
    }
    if (zodAt(built.agent, at)?.safeParse(undefined).success !== false) {
      say(rule, "the agent Zod schema takes a missing value");
    }
    if (requiredOf(jsonAt(userJson, parent)).includes(key)) {
      say(rule, "the user's JSON Schema requires the field");
    }
    if (zodAt(built.user, at)?.safeParse(undefined).success !== true) {
      say(rule, "the user's Zod schema requires the field");
    }
  }
  for (const [path, n] of max) {
    const rule = `max "${path}" ${String(n)}`;
    const at = stepsOf(path);
    const json = jsonAt(agentJson, at);
    if (limitOf(json) !== n) say(rule, `the agent JSON Schema's limit is ${String(limitOf(json))}`);
    if (!((limitOf(jsonAt(userJson, at)) as number) > n))
      say(rule, "the user's limit is not above it");
    const zod = zodAt(built.agent, at);
    const sized = (k: number) =>
      json?.["type"] === "array" ? Array<null>(k).fill(null) : "x".repeat(k);
    if (
      zod === undefined ||
      !issueCodes(zod.safeParse(sized(n + 1))).includes("too_big") ||
      issueCodes(zod.safeParse(sized(n))).includes("too_big")
    ) {
      say(rule, "the agent Zod schema does not hold the limit");
    }
  }
  for (const [path, value] of subject.defaults ?? []) {
    const at = stepsOf(path);
    const sides: [string, JsonSchema, z.ZodType][] = [["user", userJson, built.user]];
    if (!hidden.some((field) => within(path, field))) sides.push(["agent", agentJson, built.agent]);
    for (const [who, json, zod] of sides) {
      if (!Object.is(jsonAt(json, at)?.["default"], value)) {
        say(`default "${path}"`, `the ${who} JSON Schema does not show the default`);
      }
      const parsed = zodAt(zod, at)?.safeParse(undefined);
      if (parsed?.success !== true || !Object.is(parsed.data, value)) {
        say(`default "${path}"`, `the ${who} Zod schema does not fill the default`);
      }
    }
  }
  return problems;
}

/** A fixed seed, so a failure reproduces, and random ones, so each run explores further. */
const SEED = 20261112;
const entryRuns: Run[] = [{ seed: SEED, numRuns: 150 }, { numRuns: 40 }, { numRuns: 40 }];

const asSubject = (entry: AnyEntry): Subject => ({
  label: entry.name,
  input: entry.input,
  ...(entry.agent === undefined ? {} : { agent: entry.agent }),
  ...(entry.defaults === undefined ? {} : { defaults: entry.defaults }),
  output: entry.output,
  agentAllowed: isAgentAllowed(entry),
});

describe("[A3.5.registry.soundness] every entry is sound under fuzzed values", () => {
  for (const entry of registry as readonly AnyEntry[]) {
    test(`${entry.name}: input, agent input and output`, () => {
      const coverage: Generator[] = [];
      expect(soundness(asSubject(entry), entryRuns, coverage)).toEqual([]);
      // The fixed seed alone reaches every node of every schema.
      for (const generator of coverage) {
        expect([...generator.nodes].filter((n) => !generator.reached.has(n))).toEqual([]);
      }
    });
  }
});

/**
 * Projections that skip one rule of an entry, or apply an agent limit off by one: the entry with
 * its data changed so, which the real projection then builds.
 */
function mutations(entry: AnyEntry): [label: string, rules: Rules][] {
  const { hidden = [], required = [], max = [] } = entry.agent ?? {};
  const defaults = entry.defaults ?? [];
  const rules = (agent: AgentRules, fallback: Defaults = defaults): Rules => ({
    input: entry.input,
    agent,
    defaults: fallback,
  });
  const agent = { hidden, required, max };
  const out: [string, Rules][] = [];
  for (const path of hidden) {
    out.push([
      `skip hidden "${path}"`,
      rules({ ...agent, hidden: hidden.filter((p) => p !== path) }),
    ]);
  }
  for (const path of required) {
    out.push([
      `skip required "${path}"`,
      rules({ ...agent, required: required.filter((p) => p !== path) }),
    ]);
  }
  for (const [path, n] of max) {
    out.push([`skip max "${path}"`, rules({ ...agent, max: max.filter(([p]) => p !== path) })]);
    for (const off of [n - 1, n + 1]) {
      const changed = max.map(([p, m]): Limit => [p, p === path ? off : m]);
      out.push([`max "${path}" ${String(off)}`, rules({ ...agent, max: changed })]);
    }
  }
  for (const [path] of defaults) {
    const others = defaults.filter(([p]) => p !== path);
    out.push([`skip default "${path}"`, rules(agent, others)]);
  }
  return out;
}

describe("[A3.5.registry.soundness] every agent rule and default the registry lists takes effect", () => {
  test("each rule and default of each entry shows its effect", () => {
    const problems = (registry as readonly AnyEntry[]).flatMap((e) => intent(asSubject(e)));
    expect(problems).toEqual([]);
  });

  test("the registry lists each kind of rule, so the property is not empty by accident", () => {
    const count = (pick: (e: AnyEntry) => number) =>
      (registry as readonly AnyEntry[]).reduce((sum, e) => sum + pick(e), 0);
    expect({
      hidden: count((e) => e.agent?.hidden?.length ?? 0),
      required: count((e) => e.agent?.required?.length ?? 0),
      max: count((e) => e.agent?.max?.length ?? 0),
      defaults: count((e) => e.defaults?.length ?? 0),
    }).toEqual({ hidden: 2, required: 2, max: 18, defaults: 9 });
  });

  test("a projection that skips a rule or is off by one fails the intent check", () => {
    const missed: string[] = [];
    let caught = 0;
    for (const entry of registry as readonly AnyEntry[]) {
      for (const [label, mutated] of mutations(entry)) {
        const problems = intent(asSubject(entry), builtFor(mutated));
        if (problems.length === 0) missed.push(`${entry.name}: ${label}`);
        else caught += 1;
      }
    }
    expect(missed).toEqual([]);
    // 2 hidden, 2 required, 18 limits three ways and 9 defaults.
    expect(caught).toBe(2 + 2 + 18 * 3 + 9);
  });

  test("task.finish: outcome is required for agents in Zod and JSON Schema", () => {
    const finish = registry.find((e) => e.name === "task.finish");
    if (finish === undefined) throw new Error("task.finish is registered");
    const agentJson = toJsonSchema(inputSchemaFor(finish, "agent"), "input");
    expect(agentJson["required"]).toContain("outcome");
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile probes: schemas and rules someone could write. The registry check must reject each, or
// it must pass every property above, with each of its rules and defaults in effect. `unsound`
// marks the probes the properties or the intent check catch without the check.

interface Probe extends Subject {
  readonly unsound: boolean;
}

const OUTPUT = z.strictObject({ ok: z.boolean().describe("Ok") });

interface ProbeOptions {
  readonly side?: "input" | "output";
  readonly unsound?: boolean;
  readonly agent?: AgentRules;
  readonly defaults?: Defaults;
}

/** A probe whose input, or output, has one field: `probe`. */
function probe(label: string, build: () => z.ZodType, options: ProbeOptions = {}): Probe {
  const { side = "input", unsound = false, agent, defaults } = options;
  const wrapped = z.strictObject({ probe: build() });
  return {
    label,
    input: side === "input" ? wrapped : z.strictObject({}),
    output: side === "input" ? OUTPUT : wrapped,
    ...(agent === undefined ? {} : { agent }),
    ...(defaults === undefined ? {} : { defaults }),
    agentAllowed: true,
    unsound,
  };
}

/** The registry check, for a probe: the grammar, then its rules and defaults. */
const checkProbe = (subject: Probe) => checkSchemas(subject);

const unsound = { unsound: true };
const A = z.strictObject({ kind: z.literal("a").describe("K"), text: safeText(3).describe("T") });

/** The third review's reproductions. Each passed the check before that round. */
const reviewProbes: Probe[] = [
  probe("Base.optional() with a check", () => Base.optional().check(any(z.maxLength(1))), unsound),
  probe(
    "SafeText optional with a minimum",
    () =>
      safeText(4)
        .optional()
        .check(any(z.minLength(2)))
        .describe("P"),
    unsound,
  ),
  probe(
    "SafeText optional with a pattern",
    () => safeText(4).optional().check(z.regex(/^ab$/u)).describe("P"),
    unsound,
  ),
  probe(
    "overlapping union options",
    () =>
      z
        .union([
          A,
          z.strictObject({
            kind: safeLine(5).describe("K"),
            text: z.string().max(2).describe("T"),
          }),
        ])
        .describe("P")
        .optional(),
    unsound,
  ),
  probe(
    "overlapping union options with Zod's default",
    () =>
      z
        .union([
          A,
          z.strictObject({
            kind: z.literal("a").default("a").describe("K"),
            text: z.string().max(2).describe("T"),
          }),
        ])
        .describe("P")
        .optional(),
    unsound,
  ),
  probe(
    "overlapping union options with a default in the data, which a path cannot name",
    () =>
      z
        .union([
          A,
          z.strictObject({
            kind: z.literal("a").describe("K").optional(),
            text: z.string().max(2).describe("T"),
          }),
        ])
        .describe("P")
        .optional(),
    { unsound: true, defaults: [["probe.kind", "a"]] },
  ),
  probe(
    "required over two optionals",
    () => safeText(USER_LIMITS.outcome).describe("P").optional().optional(),
    { unsound: true, agent: { required: ["probe"], max: [["probe", AGENT_LIMITS.outcome]] } },
  ),
  probe(
    "required over Zod's default",
    () => z.string().max(600).default("placeholder").describe("P").optional(),
    { unsound: true, agent: { required: ["probe"] } },
  ),
  probe("required with a default in the data", () => z.string().max(600).describe("P").optional(), {
    unsound: true,
    agent: { required: ["probe"] },
    defaults: [["probe", "placeholder"]],
  }),
];

/** Gaps this test found beyond the reviews, and other hostile schemas and rules. */
const ownProbes: Probe[] = [
  probe(
    "a when option that skips the check in Zod alone",
    () =>
      z
        .string()
        .max(3, any({ when: () => false }))
        .describe("P")
        .optional(),
    unsound,
  ),
  probe(
    "an optional field named constructor",
    () =>
      z
        .strictObject({ constructor: z.string().max(3).describe("C").optional() })
        .describe("P")
        .optional(),
    unsound,
  ),
  probe(
    "a default that changes between reads",
    () =>
      z
        .enum(["s", "m"])
        .default(
          (() => {
            let n = 0;
            return () => (n++ % 2 === 0 ? "s" : ("xl" as "s"));
          })(),
        )
        .describe("P"),
    unsound,
  ),
  probe(
    "a pattern without the u flag",
    () => z.string().max(3).regex(/^.$/).describe("P").optional(),
    unsound,
  ),
  probe("coercion", () => z.coerce.string().max(3).describe("P").optional(), unsound),
  probe("a SafeText default", () => safeLine(3).default(`${QA}${QA}`).describe("P"), unsound),
  probe("a SafeText default in the data", () => safeLine(3).describe("P").optional(), {
    unsound: true,
    defaults: [["probe", `${QA}${QA}`]],
  }),
  probe(
    "a pattern on SafeText",
    () => z.string().max(5).regex(/^क़$/u).transform(normaliseText).describe("P").optional(),
    unsound,
  ),
  probe(
    "a check on the normalised text",
    () => safeText(10).check(z.maxLength(5)).describe("P").optional(),
    unsound,
  ),
  probe(
    "an agent limit on a union",
    () =>
      z
        .union([z.string().max(9), z.int().min(0).max(1)])
        .describe("P")
        .optional(),
    { unsound: true, agent: { max: [["probe", 3]] } },
  ),
  probe(
    "a hidden field in a union option",
    () =>
      z
        .union([z.strictObject({ a: z.boolean().describe("A").optional() }), z.literal("x")])
        .describe("P")
        .optional(),
    { unsound: true, agent: { hidden: ["probe.a"] } },
  ),
  probe("an agent limit not below the user's", () => z.string().max(8).describe("P").optional(), {
    unsound: true,
    agent: { max: [["probe", 8]] },
  }),
  probe("a default the field refuses", () => z.int().min(1).max(4).describe("P").optional(), {
    defaults: [["probe", 9]],
  }),
  probe("a default in an output", () => z.string().default("a").describe("P"), {
    side: "output",
    unsound: true,
  }),
  probe("a transform in an output", () => safeText(5).describe("P"), {
    side: "output",
    unsound: true,
  }),
  probe(
    "a record, whose __proto__ key Zod skips without checking its value",
    () => z.record(z.string(), z.int().min(0).max(5)).describe("P"),
    { side: "output", unsound: true },
  ),
  probe(
    "SafeText as a union option, which Zod reports as invalid_union past its limit",
    () =>
      z
        .union([safeText(5), z.int().min(0).max(9)])
        .describe("P")
        .optional(),
    unsound,
  ),
  probe("a string union of an enum and SafeText", () =>
    z
      .union([z.enum(["a"]), safeLine(3)])
      .describe("P")
      .optional(),
  ),
  probe("an optional array element", () =>
    z.array(z.string().max(3).optional()).max(3).describe("P").optional(),
  ),
  probe("xor", () =>
    z
      .xor([z.string().max(3), z.string().max(5)])
      .describe("P")
      .optional(),
  ),
  probe("a nullable string", () => z.string().max(3).nullable().describe("P").optional()),
];

/** The fourth review: checks on a field's optional, rules listed twice, defaults, unions. */
const PATTERN = /^[a-z]+$/u;

const fourthProbes: Probe[] = [
  // On the optional itself, a minimum or a pattern is a check on a wrapper.
  probe(
    "hidden, on an optional with a minimum",
    () =>
      z
        .string()
        .max(8)
        .optional()
        .check(any(z.minLength(1)))
        .describe("P"),
    { unsound: true, agent: { hidden: ["probe"] } },
  ),
  probe(
    "required, on an optional with a pattern",
    () => z.string().max(8).optional().check(z.regex(PATTERN)).describe("P"),
    { unsound: true, agent: { required: ["probe"] } },
  ),
  probe("hidden listed twice", () => z.string().max(8).describe("P").optional(), {
    agent: { hidden: ["probe", "probe"] },
  }),
  probe("required listed twice", () => z.string().max(8).describe("P").optional(), {
    agent: { required: ["probe", "probe"] },
  }),
  probe(
    "a default factory: two reads agree, a render 1.1 seconds later does not",
    () =>
      z
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .default(() => Math.floor(Date.now() / 1000))
        .describe("Created at"),
    unsound,
  ),
  probe("Zod's own default of a constant", () => z.enum(["a", "b"]).default("a").describe("P")),
  probe(
    "a union of no options, whose JSON Schema Ajv refuses to compile",
    () => z.union(any([])).describe("P").optional(),
    unsound,
  ),
  probe("a union of one option", () =>
    z
      .union([z.string().max(3)])
      .describe("P")
      .optional(),
  ),
];

/** One schema used by two fields and two probes, each with its own limit. */
const shared = z.string().max(8);
/** The fifth review's field, and one derived from it as the review derived it. */
const marked = z.string().max(8).optional().describe("P");
const derived = marked.unwrap().min(1).optional().describe("P");

/** Schemas and rules the check accepts. They must pass every property. */
const soundProbes: Probe[] = [
  probe("cwd or a place", () =>
    z
      .union([
        z.literal("cwd"),
        z.strictObject({ root: safeLine(4).describe("R"), path: z.string().max(4).describe("P") }),
      ])
      .describe("P")
      .optional(),
  ),
  probe(
    "agent limits on an array and its SafeText",
    () => z.array(safeText(6)).min(1).max(4).describe("P").optional(),
    {
      agent: {
        max: [
          ["probe", 2],
          ["probe[]", 3],
        ],
      },
    },
  ),
  probe(
    "hidden, required, limited and defaulted fields in an array element",
    () =>
      z
        .array(
          z.strictObject({
            a: z.boolean().describe("A").optional(),
            b: safeText(8).describe("B").optional(),
            c: z.enum(["x", "y"]).describe("C").optional(),
            d: z
              .string()
              .min(2)
              .max(6)
              .regex(/^[a-z]+$/u)
              .describe("D")
              .optional(),
            e: z.number().gt(0).lt(1).describe("E").optional(),
          }),
        )
        .max(3)
        .describe("P")
        .optional(),
    {
      agent: { hidden: ["probe[].a"], required: ["probe[].b"], max: [["probe[].b", 4]] },
      defaults: [["probe[].c", "x"]],
    },
  ),
  probe(
    "an output union, a list of counts and a due commitment",
    () =>
      z
        .union([
          z.strictObject({
            v: z.literal("a").describe("V"),
            n: z
              .array(
                z.strictObject({
                  k: z.string().describe("K"),
                  n: z.int().min(0).max(5).describe("N"),
                }),
              )
              .describe("N"),
          }),
          z.strictObject({
            v: z.literal("b").describe("V"),
            due: z
              .union([
                z.string().max(10),
                z.strictObject({ at: z.string().describe("At"), tz: z.string().describe("Tz") }),
              ])
              .describe("D"),
          }),
        ])
        .describe("P"),
    { side: "output" },
  ),
  // The fourth and fifth reviews: fields built with every chained method the grammar allows,
  // each with its rules as data.
  probe("a limit on a string built with .min()", () => z.string().max(8).min(1).describe("P"), {
    agent: { max: [["probe", 4]] },
  }),
  probe(
    "a limit on a string built with .regex()",
    () => z.string().max(8).regex(PATTERN).describe("P").optional(),
    { agent: { max: [["probe", 4]] } },
  ),
  probe(
    "a limit on a string described with .meta()",
    () => z.string().max(8).meta({ description: "P" }).optional(),
    { agent: { max: [["probe", 4]] } },
  ),
  probe(
    "a limit on an array built with .min()",
    () => z.array(z.string().max(3)).max(8).min(1).describe("P").optional(),
    { agent: { max: [["probe", 4]] } },
  ),
  probe("a limit on SafeText", () => safeLine(8).describe("P").optional(), {
    agent: { max: [["probe", 4]] },
  }),
  probe(
    "hidden, on a field built with .min() and .regex()",
    () => z.string().min(1).max(8).regex(PATTERN).describe("P").optional(),
    { agent: { hidden: ["probe"] } },
  ),
  probe(
    "required, on a field built with .min() and .regex()",
    () => z.string().min(1).max(8).regex(PATTERN).describe("P").optional(),
    { agent: { required: ["probe"] } },
  ),
  probe("the fifth review's field, required and limited", () => marked, {
    agent: { required: ["probe"], max: [["probe", 4]] },
  }),
  probe("the field derived from it with .unwrap().min(1).optional(), required", () => derived, {
    agent: { required: ["probe"] },
  }),
  probe("the derived field, hidden", () => derived, { agent: { hidden: ["probe"] } }),
  probe(
    "one schema with two limits on two fields",
    () =>
      z
        .strictObject({
          a: shared.describe("A"),
          b: shared.describe("B"),
          c: shared.describe("C").optional(),
        })
        .describe("P"),
    {
      agent: {
        max: [
          ["probe.a", 2],
          ["probe.b", 4],
        ],
      },
    },
  ),
  probe("one schema with two limits in two entries: 2", () => shared.describe("P"), {
    agent: { max: [["probe", 2]] },
  }),
  probe("one schema with two limits in two entries: 4", () => shared.describe("P"), {
    agent: { max: [["probe", 4]] },
  }),
  probe(
    "defaults on an enum, an integer, a boolean and a literal",
    () =>
      z
        .strictObject({
          e: z.enum(["s", "m"]).describe("E").optional(),
          i: z.int().min(0).max(Number.MAX_SAFE_INTEGER).describe("I").optional(),
          b: z.boolean().describe("B").optional(),
          l: z.literal(7).describe("L").optional(),
        })
        .describe("P"),
    {
      defaults: [
        ["probe.e", "m"],
        ["probe.i", 0],
        ["probe.b", true],
        ["probe.l", 7],
      ],
    },
  ),
  probe(
    "a default inside a hidden field",
    () =>
      z
        .strictObject({ e: z.enum(["s", "m"]).describe("E").optional() })
        .describe("P")
        .optional(),
    { agent: { hidden: ["probe"] }, defaults: [["probe.e", "s"]] },
  ),
];

/**
 * The sixth review: two declarations of one path. As records, a spread kept the last and dropped
 * the first without trace. As lists of pairs, both reach the check.
 */
const sources = () =>
  z
    .array(
      z.strictObject({
        sources: z
          .array(
            z.strictObject({
              title: z.string().max(9).describe("T"),
              mode: z.enum(["a", "b"]).describe("M").optional(),
            }),
          )
          .max(3)
          .describe("S"),
      }),
    )
    .max(3)
    .describe("P")
    .optional();

const sixthProbes: Probe[] = [
  probe("two under() spreads that limit one path", sources, {
    agent: {
      max: [
        ...under("probe[]", [["sources[].title", 2]]),
        ...under("probe[].sources[]", [["title", 7]]),
      ],
    },
  }),
  probe("two under() spreads that default one path", sources, {
    defaults: [
      ...under("probe[]", [["sources[].mode", "a"]]),
      ...under("probe[].sources[]", [["mode", "b"]]),
    ],
  }),
  probe("one limit listed twice with the same value", sources, {
    agent: {
      max: [
        ["probe[].sources[].title", 7],
        ["probe[].sources[].title", 7],
      ],
    },
  }),
];

const probes = [...reviewProbes, ...ownProbes, ...fourthProbes, ...sixthProbes, ...soundProbes];

/** More runs than for entries: probes are small, and an overlapping union needs a rare value. */
const probeRuns: Run[] = [{ seed: SEED, numRuns: 1500 }, { numRuns: 150 }];

describe("[A3.5.registry.soundness] accepted by the registry check implies sound", () => {
  for (const subject of probes) {
    test(subject.label, () => {
      if (checkProbe(subject).length === 0) {
        expect([...soundness(subject, probeRuns), ...intent(subject)]).toEqual([]);
      }
    });
  }

  test("the sound probes pass the check, so the properties run on them", () => {
    for (const subject of soundProbes) expect(checkProbe(subject), subject.label).toEqual([]);
  });

  test("the reviews' probes and this test's own are rejected", () => {
    for (const subject of [...reviewProbes, ...ownProbes, ...fourthProbes]) {
      expect(checkProbe(subject).length, subject.label).toBeGreaterThan(0);
    }
  });

  test("the sixth review's paths listed twice are rejected by the check", () => {
    for (const subject of sixthProbes) {
      expect(checkProbe(subject), subject.label).toContainEqual(
        expect.stringMatching(
          /^(agent\.max|defaults) "probe\[\]\.sources\[\]\.[a-z]+": the path is listed twice, with /,
        ),
      );
      // Without the check, building the inputs refuses rather than keep one of the two.
      expect(() => builtFor(subject), subject.label).toThrow(/the path is listed twice/);
    }
  });

  test("the sound probes use every kind of rule, and a shared schema keeps its own limit", () => {
    const rules = soundProbes.flatMap((p) => [
      ...(p.agent?.hidden === undefined ? [] : ["hidden"]),
      ...(p.agent?.required === undefined ? [] : ["required"]),
      ...(p.agent?.max === undefined ? [] : ["max"]),
      ...(p.defaults === undefined ? [] : ["defaults"]),
    ]);
    for (const kind of ["hidden", "required", "max", "defaults"])
      expect(rules, kind).toContain(kind);
    expect(toJsonSchema(shared, "input")).toEqual({ type: "string", maxLength: 8 });
  });

  test("without the check, the properties or the intent check find every unsound probe", () => {
    // The guard has teeth: given only the schema and its rules, the generator finds each review
    // reproduction and each gap it found itself.
    for (const subject of probes.filter((p) => p.unsound)) {
      expect(
        [...soundness(subject, [{ seed: SEED, numRuns: 1500 }]), ...intent(subject)],
        subject.label,
      ).not.toEqual([]);
    }
  });
});
