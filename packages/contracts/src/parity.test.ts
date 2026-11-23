// Zod and Ajv agree on every example (A3 5, decision 2): the service validates with Zod, and
// clients and the CLI see the generated JSON Schema. A disagreement means the conversion lost a
// constraint. Each example is checked as given and with deterministic mutations, so the test sees
// rejections as well as acceptances.
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  inputSchemaFor,
  isAgentAllowed,
  parseInput,
  shownSchemaFor,
  type AnyEntry,
  type Audience,
  type Defaults,
} from "./define.ts";
import {
  agentInputJsonSchema,
  inputJsonSchema,
  outputJsonSchema,
  toJsonSchema,
  type JsonSchema,
} from "./json-schema.ts";
import { laterIn } from "./later.ts";
import { registry } from "./registry.ts";
import { safeLine } from "./safe-text.ts";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];

function at(value: Json, path: Path): Json {
  let v: Json = value;
  for (const key of path) v = (v as Record<string | number, Json>)[key] as Json;
  return v;
}

function replaced(value: Json, path: Path, next: Json | undefined): Json {
  if (path.length === 0) return next ?? null;
  const copy = structuredClone(value);
  const parent = at(copy, path.slice(0, -1)) as Record<string | number, Json>;
  const key = path[path.length - 1] as string | number;
  if (next !== undefined) parent[key] = next;
  else if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else Reflect.deleteProperty(parent, key);
  return copy;
}

function paths(value: Json, prefix: Path = []): Path[] {
  const found: Path[] = [prefix];
  if (Array.isArray(value)) value.forEach((v, i) => found.push(...paths(v, [...prefix, i])));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) found.push(...paths(v, [...prefix, k]));
  }
  return found;
}

/** The value as given, then one variant per mutation at every path. */
function mutations(value: Json): [label: string, value: Json][] {
  const out: [string, Json][] = [["as given", value]];
  for (const path of paths(value)) {
    const v = at(value, path);
    const where = `/${path.join("/")}`;
    const put = (label: string, next: Json | undefined) => {
      out.push([`${where} ${label}`, replaced(value, path, next)]);
    };
    put("null", null);
    if (typeof v === "string") {
      put("number", 42);
      put("empty", "");
      put("short", "zz");
      put("two lines", "a\nb");
      put("long", "x".repeat(10_001));
    } else if (typeof v === "number") {
      put("string", "42");
      put("negative", -1);
      put("fraction", 1.5);
      put("huge", 1e9);
    } else if (typeof v === "boolean") {
      put("string", "yes");
    } else if (Array.isArray(v)) {
      put("object", {});
      put("empty", []);
      if (v.length > 0)
        put(
          "many",
          Array.from({ length: 60 }, () => v[0] ?? null),
        );
    } else if (v !== null) {
      put("string", "x");
      put("extra key", { ...v, zz_extra: 1 });
      if (path.length > 0) put("removed", undefined);
      for (const key of Object.keys(v)) {
        out.push([`${where}/${key} removed`, replaced(value, [...path, key], undefined)]);
      }
    }
  }
  return out;
}

interface Pair {
  label: string;
  zod: z.ZodType;
  json: JsonSchema;
}

/**
 * The schemas to compare. Agents are shown their input without what a later step builds, so the
 * agent pair compares that, and an example of a later feature has no agent pair.
 */
function pairsFor(
  entry: AnyEntry,
  actor: "agent" | "user",
  example: Json,
): { input: Pair[]; output: Pair } {
  const input: Pair[] = [
    { label: "input", zod: inputSchemaFor(entry, "user"), json: inputJsonSchema(entry) },
  ];
  if (
    actor === "agent" &&
    isAgentAllowed(entry) &&
    laterIn(entry.name, example as Record<string, unknown>) === undefined
  ) {
    input.push({
      label: "agent input",
      zod: shownSchemaFor(entry, "agent"),
      json: agentInputJsonSchema(entry),
    });
  }
  return { input, output: { label: "output", zod: entry.output, json: outputJsonSchema(entry) } };
}

function verdicts(pair: Pair, value: Json) {
  const validate = ajv.compile(pair.json);
  const disagreements: string[] = [];
  let rejected = 0;
  for (const [label, candidate] of mutations(value)) {
    const zodOk = pair.zod.safeParse(candidate).success;
    const ajvOk = validate(candidate);
    if (!zodOk) rejected += 1;
    if (zodOk !== ajvOk) {
      disagreements.push(`${pair.label} ${label}: Zod ${String(zodOk)}, Ajv ${String(ajvOk)}`);
    }
  }
  return { disagreements, rejected };
}

// ---------------------------------------------------------------------------------------------
// Schema-driven boundary values. Examples leave optional fields out, and an omitted field hides
// its constraints from the mutations above. So every node of each JSON Schema becomes a slot: a
// valid value built around it, with candidates at the slot's boundaries. Zod and Ajv must agree on
// each one. The valid surroundings come from the schema itself, with pattern samples taken from
// the examples.

type Schema = Record<string, unknown>;

interface Slot {
  readonly path: string;
  readonly schema: Schema;
  /** The whole value with `v` at this slot and valid values around it. */
  readonly build: (v: Json) => Json;
}

const ASTRAL = String.fromCodePoint(0x1f600);
/** One code point that NFC turns into two, so SafeText lengthens it. */
const QA = String.fromCodePoint(0x0958);
/** One code point that SafeText removes, so it shortens text. */
const ZWSP = String.fromCodePoint(0x200b);

const asSchema = (value: unknown): Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : {};

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function allStrings(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, into);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) allStrings(v, into);
  }
  return into;
}

/** Strings that appear in some example, as samples for patterns. */
const exampleStrings = allStrings(
  (registry as readonly AnyEntry[]).flatMap((e) => e.examples.map((x) => [x.input, x.output])),
  new Set(),
);
/** Patterns no example happens to use. */
const extraSamples = [
  "24h",
  "pr_5k2m8q0w3z7r1c9d4f6h8j0n2p",
  "ui.theme",
  "lr_6p1r4t7v0x3z6b9d2f5h8k1m4n",
  "c_7m2k9q4w1z8r3c6d",
];

function sampleFor(pattern: string): string {
  const re = new RegExp(pattern, "u");
  for (const s of [...exampleStrings, ...extraSamples]) if (re.test(s)) return s;
  throw new Error(`no sample matches the pattern ${pattern}; add one to extraSamples`);
}

/** A valid value for a schema: required properties only, minimum sizes. */
function synth(s: Schema): Json {
  if (s["const"] !== undefined) return s["const"] as Json;
  if (Array.isArray(s["enum"])) return s["enum"][0] as Json;
  if (Array.isArray(s["anyOf"])) return synth(asSchema(s["anyOf"][0]));
  switch (s["type"]) {
    case "string": {
      if (typeof s["pattern"] === "string") return sampleFor(s["pattern"]);
      return "x".repeat(Math.max(1, num(s["minLength"]) ?? 0));
    }
    case "integer":
    case "number":
      return num(s["minimum"]) ?? Math.min(0, num(s["maximum"]) ?? 0);
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return Array.from({ length: num(s["minItems"]) ?? 0 }, () => synth(asSchema(s["items"])));
    case "object": {
      const properties = asSchema(s["properties"]);
      const required = (s["required"] ?? []) as string[];
      return Object.fromEntries(required.map((k) => [k, synth(asSchema(properties[k]))]));
    }
    default:
      return "x";
  }
}

/** Every node of a schema, with a builder that puts a value there inside a valid whole. */
function slots(s: Schema, path: string, build: (v: Json) => Json, out: Slot[]): Slot[] {
  out.push({ path, schema: s, build });
  if (Array.isArray(s["anyOf"])) {
    s["anyOf"].forEach((o, i) => slots(asSchema(o), `${path}|${String(i)}`, build, out));
  } else if (s["type"] === "object" && s["properties"] !== undefined) {
    for (const [key, property] of Object.entries(asSchema(s["properties"]))) {
      slots(
        asSchema(property),
        `${path}/${key}`,
        (v) => build({ ...asObject(synth(s)), [key]: v }),
        out,
      );
    }
  } else if (s["type"] === "object" && s["additionalProperties"] !== undefined) {
    const values = asSchema(s["additionalProperties"]);
    const keys = asSchema(s["propertyNames"]);
    const key = typeof synth(keys) === "string" ? (synth(keys) as string) : "k";
    slots(values, `${path}/{value}`, (v) => build({ [key]: v }), out);
    out.push({
      path: `${path}/{key}`,
      schema: keys,
      // JSON keys are strings, so only string candidates mean anything here.
      build: (k) => build(typeof k === "string" ? { [k]: synth(values) } : {}),
    });
  } else if (s["type"] === "array") {
    const items = asSchema(s["items"]);
    const length = Math.max(1, num(s["minItems"]) ?? 0);
    slots(
      items,
      `${path}[]`,
      (v) => build(Array.from({ length }, (_, i) => (i === 0 ? v : synth(items)))),
      out,
    );
  }
  return out;
}

function asObject(value: Json): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Values at and around the slot's limits, plus values of the wrong type. */
function candidates(s: Schema): Json[] {
  const out: Json[] = [synth(s), null, 42, 1.5, "x", "", true, [], {}];
  const sizes = (min: number | undefined, max: number | undefined) =>
    [
      0,
      1,
      min === undefined ? -1 : min - 1,
      min ?? -1,
      max ?? -1,
      max === undefined ? -1 : max + 1,
    ].filter((n) => n >= 0);
  if (s["type"] === "string") {
    for (const n of sizes(num(s["minLength"]), num(s["maxLength"]))) {
      out.push("x".repeat(n), ASTRAL.repeat(n), QA.repeat(n), QA.repeat(Math.ceil(n / 2)));
      out.push(`x${ZWSP.repeat(Math.max(0, n - 1))}`, `a\r\n${"b".repeat(Math.max(0, n - 3))}`);
    }
    if (typeof s["pattern"] === "string") {
      const sample = sampleFor(s["pattern"]);
      out.push(sample, `${sample}x`, `x${sample}`, sample.slice(1), `${ASTRAL}${sample.slice(1)}`);
    }
    out.push("a\nb", ASTRAL);
  }
  if (s["type"] === "integer" || s["type"] === "number") {
    for (const bound of [num(s["minimum"]), num(s["maximum"])]) {
      if (bound !== undefined) out.push(bound, bound - 1, bound + 1);
    }
    out.push(-1, 0, 2 ** 53, "1");
  }
  if (Array.isArray(s["enum"])) out.push(...(s["enum"] as Json[]), "zz_none");
  if (s["type"] === "array") {
    const item = synth(asSchema(s["items"]));
    for (const n of sizes(num(s["minItems"]), num(s["maxItems"]))) {
      out.push(Array.from({ length: n }, () => item));
    }
  }
  if (s["type"] === "object") {
    const valid = asObject(synth(s));
    out.push({ ...valid, zz_extra: 1 });
    for (const key of Object.keys(valid)) {
      const copy = { ...valid };
      Reflect.deleteProperty(copy, key);
      out.push(copy);
    }
  }
  return out;
}

function boundaryDisagreements(pair: Pair) {
  const validate = ajv.compile(pair.json);
  const disagreements: string[] = [];
  const verdicts = { accepted: 0, rejected: 0 };
  const all = slots(pair.json, "", (v) => v, []);
  for (const slot of all) {
    const valid = slot.build(synth(slot.schema));
    if (!pair.zod.safeParse(valid).success) {
      disagreements.push(`${pair.label} ${slot.path || "/"}: the synthesised value fails Zod`);
      continue;
    }
    for (const candidate of candidates(slot.schema)) {
      const value = slot.build(candidate);
      const zodOk = pair.zod.safeParse(value).success;
      const ajvOk = validate(value);
      verdicts[zodOk ? "accepted" : "rejected"] += 1;
      if (zodOk !== ajvOk) {
        const shown = JSON.stringify(candidate).slice(0, 60);
        disagreements.push(
          `${pair.label} ${slot.path || "/"} = ${shown}: Zod ${String(zodOk)}, Ajv ${String(ajvOk)}`,
        );
      }
    }
  }
  return { disagreements, verdicts, slots: all.map((s) => s.path) };
}

describe("[A3.5.registry.zod-ajv-parity] Zod and Ajv agree at every field's boundaries", () => {
  for (const entry of registry as readonly AnyEntry[]) {
    test(`${entry.name}: every field, used by an example or not`, () => {
      const { input, output } = pairsFor(entry, "agent", {});
      for (const pair of [...input, output]) {
        const { disagreements, verdicts, slots: visited } = boundaryDisagreements(pair);
        expect(disagreements, `${entry.name} ${pair.label}`).toEqual([]);
        expect(visited.length).toBeGreaterThan(1);
        expect(verdicts.accepted, `${entry.name} ${pair.label} accepts`).toBeGreaterThan(0);
        expect(verdicts.rejected, `${entry.name} ${pair.label} rejects`).toBeGreaterThan(0);
      }
    });
  }

  test("the walk reaches fields that no example uses", () => {
    const update = registry.find((e) => e.name === "task.update");
    const status = registry.find((e) => e.name === "space.status");
    if (update === undefined || status === undefined) throw new Error("entries are registered");
    const updateSlots = slots(inputJsonSchema(update), "", (v) => v, []).map((s) => s.path);
    expect(updateSlots).toContain("/add_sources[]/key");
    expect(updateSlots).toContain("/set/folder");
    // A branch of a union no example takes: a digest's folder on another machine.
    const get = registry.find((e) => e.name === "task.get");
    if (get === undefined) throw new Error("task.get is registered");
    const getSlots = slots(outputJsonSchema(get), "", (v) => v, []).map((s) => s.path);
    expect(getSlots.some((path) => path.endsWith("/folder|1/machine"))).toBe(true);
    const statusSlots = slots(outputJsonSchema(status), "", (v) => v, []).map((s) => s.path);
    expect(statusSlots).toContain("/counts/statuses[]/count");
    expect(statusSlots).toContain("/here[]/live_sessions");
  });

  test("status since takes the ISO times Date.toISOString() and offsets produce", () => {
    const status = registry.find((e) => e.name === "space.status");
    if (status === undefined) throw new Error("space.status is registered");
    const validate = ajv.compile(inputJsonSchema(status));
    const verdict = (since: string) => [
      status.input.safeParse({ since }).success,
      validate({ since }),
    ];
    for (const since of [
      "24h",
      "7d",
      "2026-11-12T09:00Z",
      "2026-11-12T09:00:00Z",
      new Date("2026-11-12T09:00:00Z").toISOString(),
      "2026-11-12T09:00:00.5+01:00",
      "2026-11-12T09:00:00.123456789-05:30",
    ]) {
      expect(verdict(since), since).toEqual([true, true]);
    }
    for (const since of [
      "2026-11-12",
      "2026-11-12T09:00:00",
      "2026-11-12T09:00:00.Z",
      "2026-11-12T09:00:00.1234567890Z",
      "yesterday",
    ]) {
      expect(verdict(since), since).toEqual([false, false]);
    }
  });

  test("a lossy schema shows up as a disagreement", () => {
    // The review's probes, which the registry check now refuses: each makes Zod and Ajv differ.
    const lossy: [string, z.ZodType, Json][] = [
      ["coercion", z.coerce.string().max(10), 42],
      ["pattern without u", z.string().regex(/^.$/), ASTRAL],
    ];
    for (const [label, schema, value] of lossy) {
      const zodOk = schema.safeParse(value).success;
      const ajvOk = ajv.compile(toJsonSchema(schema, "input"))(value);
      expect(zodOk, label).not.toBe(ajvOk);
    }
  });
});

/**
 * Values parseInput() returned that its own schema refuses, or that a further parse changes. The
 * candidates are the boundary values above, with text that SafeText lengthens and shortens, and
 * the smallest valid input, which leaves every default to Zod.
 */
function unstableResults(entry: Pick<AnyEntry, "input" | "defaults">, audience: Audience) {
  const schema = inputSchemaFor(entry, audience);
  const json = toJsonSchema(schema, "input");
  const values: [label: string, value: Json][] = [["smallest", synth(json)]];
  for (const slot of slots(json, "", (v) => v, [])) {
    for (const candidate of candidates(slot.schema)) {
      const label = `${slot.path || "/"} = ${JSON.stringify(candidate).slice(0, 60)}`;
      values.push([label, slot.build(candidate)]);
    }
  }
  const problems: string[] = [];
  let returned = 0;
  for (const [label, value] of values) {
    const parsed = parseInput(entry, audience, value);
    if (!parsed.success) continue;
    returned += 1;
    const again = schema.safeParse(parsed.data);
    if (!again.success || !isDeepStrictEqual(again.data, parsed.data)) problems.push(label);
  }
  return { problems, returned };
}

describe("[A3.5.registry.zod-ajv-parity] the boundary parse returns a value its schema accepts", () => {
  for (const entry of registry as readonly AnyEntry[]) {
    test(`${entry.name}: for both audiences, at every field's boundaries`, () => {
      for (const audience of ["user", "agent"] as const) {
        const { problems, returned } = unstableResults(entry, audience);
        expect(problems, `${entry.name} ${audience}`).toEqual([]);
        expect(returned, `${entry.name} ${audience}`).toBeGreaterThan(0);
      }
    });
  }

  test("the review's probe fails it: a SafeText default normalised past its limit", () => {
    // The registry check refuses this field. The property must still see it.
    const probe = { input: z.strictObject({ label: safeLine(3).default(`${QA}${QA}`) }) };
    expect(unstableResults(probe, "user").problems).not.toEqual([]);
    // The same default as entry data, which the check also refuses: SafeText takes no default.
    const data = {
      input: z.strictObject({ label: safeLine(3).optional() }),
      defaults: [["label", `${QA}${QA}`]] satisfies Defaults,
    };
    expect(unstableResults(data, "user").problems).not.toEqual([]);
  });
});

describe("[A3.5.registry.zod-ajv-parity] Zod and Ajv agree on every example", () => {
  test("the registry has examples to check", () => {
    expect(registry.length).toBeGreaterThan(0);
    for (const entry of registry) expect(entry.examples.length, entry.name).toBeGreaterThan(0);
  });

  for (const entry of registry as readonly AnyEntry[]) {
    test(`${entry.name}: every example and its mutations get the same verdict`, () => {
      for (const example of entry.examples) {
        const actor = example.actor ?? (isAgentAllowed(entry) ? "agent" : "user");
        const { input, output } = pairsFor(entry, actor, example.input as Json);
        for (const [pair, value] of [
          ...input.map((p) => [p, example.input] as const),
          [output, example.output] as const,
        ]) {
          const where = `${entry.name} "${example.title}" ${pair.label}`;
          expect(pair.zod.safeParse(value).success, `${where} parses`).toBe(true);
          const { disagreements, rejected } = verdicts(pair, value as Json);
          expect(disagreements, where).toEqual([]);
          expect(rejected, `${where}: mutations reach a rejection`).toBeGreaterThan(0);
        }
      }
    });
  }
});
