// The registry check: the lint rules for entries (A3 3.2.1), exposure (3.2.3), naming (3.2.4),
// result budgets (3.2.5) and A6 3.3's metadata. A tool definition's size is reported, not
// checked (A3 3.2.5: `mcp-definitions.json`). `pnpm gen` refuses to write output for a
// registry that fails it, so `pnpm verify` runs it in its generated-files step. Each rule has a
// failing fixture in check.test.ts. The schema rules are a closed grammar (`checkSchemas`).
import { z } from "zod";
import { AUTO_FIELDS, faceFields, keyValueFields } from "./cli.ts";
import {
  ACTOR_CLASSES,
  AUDIENCE_FILTERS,
  ENTRY_KINDS,
  REMOTE_CLASSES,
  SCOPES,
  checksOf,
  cliFaces,
  defOf,
  descriptionOf,
  inputSchemaFor,
  isAgentAllowed,
  isNormaliser,
  pathSteps,
  type AnyEntry,
  type CliFace,
  type LooseDef,
  type Pair,
  type Pairs,
} from "./define.ts";
import { isErrorCode } from "./errors.ts";
import { opSpec } from "./operations.ts";
import { Base, RequestId, SessionTask } from "./schemas.ts";

export const LIMITS = {
  /** A field description (A3 3.2.1). */
  description: 80,
  summary: 120,
  toolName: 24,
  toolTitle: 60,
  /** A3 3.2.5. */
  toolDescription: 280,
  /**
   * Any result, in estimated tokens (A3 3.2.5). A tool definition has no cap: its size is
   * reported in `mcp-definitions.json`, so growth is a reviewed change (A3 3.2.5).
   */
  result: 4000,
} as const;

export interface CheckOptions {
  /**
   * The MCP server key (A3 3.2.4), from the brand package. The client puts it before every tool
   * name (`mcp__ttasks__search`), so no tool name starts with it as its first word.
   */
  readonly serverKey?: string;
}

type Say = (message: string) => void;

const ENTRY_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const VERB = /^[a-z][a-z0-9-]*$/;
const SHORT = /^[a-zA-Z]$/;

const READ_SCOPES = new Set(["space:read", "machine:read"]);
const AGENT_FORBIDDEN_SCOPES = new Set(["launch:open", "launch:run", "admin"]);

export function checkRegistry(entries: readonly AnyEntry[], options: CheckOptions = {}): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const tools = new Set<string>();
  const verbs = new Set<string>();
  for (const entry of entries) {
    const own: string[] = [];
    const say: Say = (m) => {
      if (!own.includes(m)) own.push(m);
    };
    if (names.has(entry.name)) say(`name "${entry.name}" is used twice`);
    names.add(entry.name);
    checkMetadata(entry, say);
    const schemaProblems = checkSchemas(entry);
    for (const m of schemaProblems) say(m);
    const schemasOk = schemaProblems.length === 0;
    checkFaces(entry, say, options, schemasOk, { tools, verbs });
    checkExamples(entry, say, schemasOk);
    problems.push(...own.map((m) => `${entry.name}: ${m}`));
  }
  return problems;
}

function oneOf(value: unknown, list: readonly string[], what: string, say: Say): boolean {
  if (typeof value === "string" && list.includes(value)) return true;
  say(`${what} ${JSON.stringify(value)} is not one of ${list.join(", ")}`);
  return false;
}

function hasField(entry: AnyEntry, name: string): boolean {
  return Object.hasOwn(entry.input.shape, name);
}

function checkMetadata(entry: AnyEntry, say: Say): void {
  if (!ENTRY_NAME.test(entry.name)) say("name must be dotted lower case, such as task.update");
  const summary = entry.summary as unknown;
  if (
    typeof summary !== "string" ||
    summary.trim() === "" ||
    summary.length > LIMITS.summary ||
    /[\r\n]/.test(summary)
  ) {
    say(`summary must be one line of 1 to ${String(LIMITS.summary)} characters`);
  }
  const valid = [
    oneOf(entry.kind, ENTRY_KINDS, "kind", say),
    oneOf(entry.actors, ACTOR_CLASSES, "actors", say),
    oneOf(entry.scope, SCOPES, "scope", say),
    oneOf(entry.remote, REMOTE_CLASSES, "remote", say),
    oneOf(entry.audience, AUDIENCE_FILTERS, "audience", say),
  ].every(Boolean);
  if (!valid) return;

  checkOps(entry, say);
  const mixed = entry.actions !== undefined;
  if (mixed) checkActions(entry, say);
  if (entry.kind === "write") {
    if (entry.ops.length === 0) say("a write entry names the A1 operations it may emit");
    if (READ_SCOPES.has(entry.scope))
      say(`a write entry needs a write scope, not "${entry.scope}"`);
    if (entry.remote === "read") say('a write entry cannot have remote class "read"');
    const requestId = entry.input.shape["request_id"] as z.ZodType | undefined;
    if (requestId === undefined) say("a write entry requires request_id");
    else if (mixed) {
      // A read action takes none, so the field is optional; the request path requires it for a
      // write action (A3 3.2.3).
      if (requestId === RequestId || !isShared(requestId, RequestId, true)) {
        say("request_id of an entry with read actions is RequestId.optional() (A3 3.2.3)");
      }
    } else if (!isShared(requestId, RequestId, false)) {
      say("request_id must be the shared RequestId schema from schemas.ts (A3 3.4.1)");
    }
    checkBase(entry, say);
    if (!entry.errors.includes("request_id_conflict")) {
      say("a write entry lists the error request_id_conflict");
    }
  } else {
    if (entry.ops.length > 0) say("a read entry emits no A1 operations");
    if (entry.remote !== "never" && entry.remote !== "read") {
      say('a read entry has remote class "never" or "read"');
    }
    if (!READ_SCOPES.has(entry.scope))
      say('a read entry needs scope "space:read" or "machine:read"');
    if (entry.audience !== "caller") say('a read entry filters its result by audience ("caller")');
    if (hasField(entry, "request_id")) say("a read entry takes no request_id");
  }

  if (isAgentAllowed(entry)) {
    if (entry.remote === "execute") {
      say('an agent-allowed entry cannot have remote class "execute" (R7)');
    }
    if (AGENT_FORBIDDEN_SCOPES.has(entry.scope)) {
      say(`an agent-allowed entry cannot need scope "${entry.scope}" (R7)`);
    }
    const budget = entry.budget;
    if (budget === undefined) say("an agent-allowed entry declares a budget (A3 3.2.5)");
    else if (!(budget.typical > 0 && budget.typical <= budget.max && budget.max <= LIMITS.result)) {
      say(
        `budget: typical ${String(budget.typical)} must not exceed max ${String(budget.max)}, and max must not exceed ${String(LIMITS.result)}`,
      );
    }
  } else if (entry.agent !== undefined) {
    say("a user-only entry has no agent rules: agents never call it");
  }

  const task = entry.input.shape["task"] as z.ZodType | undefined;
  if (
    task !== undefined &&
    task !== SessionTask &&
    /session's task/u.test(descriptionOf(task) ?? "")
  ) {
    say("a task that defaults to the session's is the shared SessionTask schema from schemas.ts");
  }
  if (task === SessionTask && !entry.errors.includes("unbound")) {
    say("an entry whose task defaults to the session's lists the error unbound");
  }

  const seen = new Set<string>();
  for (const code of entry.errors as readonly string[]) {
    if (seen.has(code)) say(`error "${code}" is listed twice`);
    else if (!isErrorCode(code)) say(`error "${code}" is not in the catalogue`);
    seen.add(code);
  }
}

/**
 * Each declared operation kind must be in the operation table (operations.ts), need the entry's
 * scope, and be one its actors may emit: never R7's launches, runs and routines for an agent.
 */
function checkOps(entry: AnyEntry, say: Say): void {
  for (const op of entry.ops) {
    const spec = opSpec(op);
    if (spec === undefined) {
      say(`operation kind ${JSON.stringify(op)} is not in the operation table (operations.ts)`);
      continue;
    }
    if (spec.class === "system") {
      say(`operation kind "${op}" is the service's own: no entry emits it`);
      continue;
    }
    if (!spec.scopes.includes(entry.scope)) {
      const scopes = spec.scopes.map((s) => `"${s}"`).join(" or ");
      say(`operation kind "${op}" needs scope ${scopes}, not "${entry.scope}"`);
    }
    if (spec.class === "run") {
      if (entry.actors !== "run") say(`only a run-only entry emits "${op}" (A3 3.4.12)`);
    } else if (isAgentAllowed(entry) && spec.r7 === true) {
      say(
        `an agent-allowed entry cannot emit "${op}" (R7: launches, runs and routines are the user's)`,
      );
    } else if (isAgentAllowed(entry) && spec.class === "user") {
      say(`an agent-allowed entry cannot emit the user-only "${op}" (A3 3.2.3)`);
    }
  }
}

/**
 * `schema` is `shared` itself or, where `optional` allows, `shared.optional()` with nothing
 * added: no other wrapper, check or description of its own.
 */
function isShared(schema: z.ZodType, shared: z.ZodType, optional: boolean): boolean {
  if (schema === shared) return true;
  const def = defOf(schema);
  return (
    optional &&
    def.type === "optional" &&
    def["innerType"] === shared &&
    Reflect.ownKeys(def).length === 2 &&
    z.globalRegistry.get(schema) === undefined
  );
}

/**
 * `base` is the shared Base schema, or `Base.optional()`. A write that may emit an operation that
 * always needs a base takes it, and requires it when every operation it emits does (A1 3.5,
 * A3 3.4.1).
 */
function checkBase(entry: AnyEntry, say: Say): void {
  const base = entry.input.shape["base"] as z.ZodType | undefined;
  const guarded = entry.ops.filter((op) => opSpec(op)?.base === true);
  if (base === undefined) {
    if (guarded.length > 0) {
      say(`a write entry that may emit ${guarded.join(", ")} takes base (A1 3.5)`);
    }
  } else if (!isShared(base, Base, true)) {
    say("base must be the shared Base schema from schemas.ts, or Base.optional() (A3 3.4.1)");
  } else if (entry.actions !== undefined) {
    // A read action takes no base: the request path requires it for a write action (A3 3.2.3).
    if (base === Base) say("base of an entry with read actions is Base.optional() (A3 3.2.3)");
  } else if (base !== Base && guarded.length > 0 && guarded.length === entry.ops.length) {
    say("base is required: every operation of the entry changes existing fields (A1 3.5)");
  }
}

/**
 * A mixed entry (A3 3.2.3): a write entry whose required enum `field` picks the action, `reads`
 * naming some of its values but not all of them. An entry that only reads is a read entry.
 */
function checkActions(entry: AnyEntry, say: Say): void {
  const actions = entry.actions;
  if (actions === undefined) return;
  if (entry.kind !== "write") {
    say("only a write entry declares read actions: a read entry reads in every action");
    return;
  }
  const field = Object.hasOwn(entry.input.shape, actions.field)
    ? (entry.input.shape[actions.field] as z.ZodType)
    : undefined;
  const def = field === undefined ? undefined : defOf(field);
  if (def?.type !== "enum") {
    say(`actions.field "${actions.field}" is a required enum field of the input`);
    return;
  }
  const values = Object.values(def["entries"] as Record<string, string>);
  const reads = actions.reads as readonly unknown[];
  if (reads.length === 0) say("actions.reads names at least one read action");
  reads.forEach((read, i) => {
    if (typeof read !== "string" || !values.includes(read)) {
      say(`actions.reads ${JSON.stringify(read)} is not a value of "${actions.field}"`);
    } else if (reads.indexOf(read) !== i) {
      say(`actions.reads "${read}" is listed twice`);
    }
  });
  if (values.every((value) => reads.includes(value))) {
    say("every action only reads: make it a read entry");
  }
}

// ---------------------------------------------------------------------------------------------
// The schema grammar (A3 3.2.1). An allow-list over the whole tree of an entry's
// input and output. Every node must be one of the shapes in SHAPES, and may carry only the
// definition options and checks its row lists. Anything else fails with the node's path. Each
// shape is one that Zod and the generated JSON Schema judge alike, and that parses to a value the
// same schema accepts again unchanged (parseInput, define.ts). The grammar holds what the entries
// need and no more. A step that needs another shape adds it here, with a test and a decision.
// Schemas carry no policy: the agent rules and the defaults are entry data (checkRules).

/** The input or the output. */
type Side = "input" | "output";
const ALL: readonly Side[] = ["input", "output"];
const INPUTS: readonly Side[] = ["input"];

interface At {
  readonly path: string;
  readonly side: Side;
  readonly say: Say;
  /** The node is an option of a union, where `null` may stand (A3 3.4.11). */
  readonly option?: boolean;
}

type CheckName = "min_length" | "max_length" | "pattern" | "greater_than" | "less_than";

interface Shape {
  /** Definition options it may carry besides `type` and `checks`. */
  readonly keys: readonly string[];
  readonly checks: readonly CheckName[];
  readonly sides: readonly Side[];
  /** Its own rules and its children. */
  readonly inspect: (def: LooseDef, at: At) => void;
}

/** Zod's own `when` for length checks. Any other `when` could skip the check in Zod alone. */
const LENGTH_WHEN = z.maxLength(1)._zod.def["when"];

type CheckDef = Record<string, unknown>;

const only = (def: object, keys: readonly string[]) =>
  Reflect.ownKeys(def).every((key) => typeof key === "string" && keys.includes(key));

const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

const length = (c: CheckDef, key: string) =>
  only(c, ["check", key, "when"]) && c["when"] === LENGTH_WHEN && isCount(c[key]);

const bound = (c: CheckDef) =>
  only(c, ["check", "value", "inclusive"]) && Number.isFinite(c["value"]);

/** Each check the grammar knows: the options it may carry. */
const CHECKS: Record<CheckName, (c: CheckDef) => boolean> = {
  min_length: (c) => length(c, "minimum"),
  max_length: (c) => length(c, "maximum"),
  // JSON Schema reads a pattern by code point, as the u flag does. Without it Zod reads UTF-16
  // units, so /^.$/ would reject one emoji that Ajv accepts. Other flags have no JSON form.
  pattern: (c) =>
    only(c, ["check", "format", "pattern"]) &&
    c["pattern"] instanceof RegExp &&
    c["pattern"].flags === "u",
  greater_than: bound,
  less_than: bound,
};

const CHECK_HINTS: Readonly<Record<string, string>> = {
  custom: ": refinements belong in the handler",
  overwrite: ": normalise text with SafeText",
};

const TYPE_HINTS: Readonly<Record<string, string>> = {
  default: "; a default belongs in the entry's defaults",
};

function checkName(c: CheckDef): string {
  if (c["check"] === "string_format")
    return c["format"] === "regex" ? "pattern" : String(c["format"]);
  return String(c["check"]);
}

const checkDefs = (def: LooseDef) => checksOf(def).map((c) => c._zod.def);

/** "a string", "an optional", "SafeText". */
const a = (name: string) => {
  if (name === "text") return "SafeText";
  if (name === "null") return "null";
  return `${["array", "enum", "integer", "object", "optional"].includes(name) ? "an" : "a"} ${name}`;
};

/** The maximum length or item count a string or array declares. */
function maxOf(def: LooseDef): number | undefined {
  const max = checkDefs(def).find((c) => c["check"] === "max_length")?.["maximum"];
  return typeof max === "number" ? max : undefined;
}

/** The shape a definition claims to be. `node` then checks that it is. */
function shapeName(def: LooseDef): string {
  if (def.type === "number" && def["format"] !== undefined) return "integer";
  if (def.type === "pipe") return "text";
  return def.type;
}

const SCALARS = new Set(["enum", "literal", "string", "integer", "number", "boolean"]);

/**
 * The JSON types a value of the schema can have. Two options of an input union must not share
 * one: a value then matches one option only, and normalising keeps its type, so the second parse
 * of parseInput() picks the option the first parse picked.
 */
function jsonTypes(schema: z.ZodType): string[] {
  const def = defOf(schema);
  switch (shapeName(def)) {
    case "object":
      return ["object"];
    case "array":
      return ["array"];
    case "string":
    case "text":
    case "enum":
      return ["string"];
    case "integer":
    case "number":
      return ["number"];
    case "boolean":
      return ["boolean"];
    case "null":
      return ["null"];
    case "literal":
      return (def["values"] as unknown[]).map((v) => typeof v);
    default:
      return [];
  }
}

const SHAPES: Readonly<Record<string, Shape>> = {
  object: { keys: ["shape", "catchall"], checks: [], sides: ALL, inspect: inspectObject },
  array: {
    keys: ["element"],
    checks: ["min_length", "max_length"],
    sides: ALL,
    inspect: (def, at) => {
      limits(def, at, "array");
      child(def["element"] as z.ZodType, { ...at, path: `${at.path}[]`, option: false });
    },
  },
  enum: {
    keys: ["entries"],
    checks: [],
    sides: ALL,
    inspect: (def, at) => {
      const values = Object.values(def["entries"] as object);
      if (!values.every((v) => typeof v === "string"))
        at.say(`${at.path}: enum values are strings`);
    },
  },
  literal: {
    keys: ["values"],
    checks: [],
    sides: ALL,
    inspect: (def, at) => {
      const values = def["values"] as unknown[];
      if (!values.every(isScalar)) at.say(`${at.path}: a literal is a string, number or boolean`);
    },
  },
  string: {
    keys: [],
    checks: ["min_length", "max_length", "pattern"],
    sides: ALL,
    inspect: (def, at) => {
      limits(def, at, "string");
    },
  },
  text: { keys: ["in", "out"], checks: [], sides: INPUTS, inspect: inspectText },
  integer: {
    keys: ["check", "abort", "format"],
    checks: ["greater_than", "less_than"],
    sides: ALL,
    inspect: (def, at) => {
      if (
        def["check"] !== "number_format" ||
        def["format"] !== "safeint" ||
        def["abort"] !== false
      ) {
        at.say(`${at.path}: number format "${String(def["format"])}" is not allowed; use z.int()`);
      }
      bounds(def, at);
    },
  },
  number: { keys: [], checks: ["greater_than", "less_than"], sides: ALL, inspect: bounds },
  boolean: { keys: [], checks: [], sides: ALL, inspect: () => undefined },
  // Only as a union option (`node` refuses it elsewhere): a preference value's reset to its
  // default (A3 3.4.11). Never a field of its own, so no field is "absent or null".
  null: { keys: [], checks: [], sides: ALL, inspect: () => undefined },
  union: { keys: ["options"], checks: [], sides: ALL, inspect: inspectUnion },
  optional: {
    keys: ["innerType"],
    checks: [],
    sides: ALL,
    inspect: (def, at) => {
      child(def["innerType"] as z.ZodType, at);
    },
  },
};

/**
 * Checks an entry's schemas against the grammar, then its agent rules and defaults against its
 * input. Returns one message per problem, with the node's path or the rule's path.
 */
export function checkSchemas(
  entry: Pick<AnyEntry, "input" | "output" | "agent" | "defaults">,
): string[] {
  const problems: string[] = [];
  const say: Say = (m) => {
    if (!problems.includes(m)) problems.push(m);
  };
  if (defOf(entry.input).type !== "object") say("input: the input is a strict object");
  node(entry.input, { path: "input", side: "input", say });
  if (problems.length === 0) checkRules(entry, say);
  node(entry.output, { path: "output", side: "output", say });
  return problems;
}

function node(schema: z.ZodType, at: At): void {
  const def = defOf(schema);
  const name = shapeName(def);
  const shape = Object.hasOwn(SHAPES, name) ? SHAPES[name] : undefined;
  if (shape === undefined) {
    at.say(
      `${at.path}: type "${def.type}" is not in the schema grammar (A3 3.2.1)${TYPE_HINTS[def.type] ?? ""}`,
    );
    return;
  }
  if (!shape.sides.includes(at.side)) {
    at.say(`${at.path}: ${name === "text" ? "a transform" : a(name)} is not allowed in outputs`);
    return;
  }
  if (name === "null" && at.option !== true) {
    at.say(
      `${at.path}: null stands only as a union option, such as a preference value (A3 3.4.11)`,
    );
    return;
  }
  // Every own key, symbols too.
  for (const key of Reflect.ownKeys(def)) {
    if (
      typeof key !== "string" ||
      (key !== "type" && key !== "checks" && !shape.keys.includes(key))
    ) {
      at.say(`${at.path}: ${a(name)} takes no option "${String(key)}"`);
    }
  }
  checkChecks(def, name, shape, at);
  checkMeta(schema, at);
  shape.inspect(def, at);
}

/** A child that is not optional: an optional's content, an array element or a union option. */
function child(schema: z.ZodType, at: At): void {
  if (defOf(schema).type === "optional") {
    at.say(
      `${at.path}: an optional's content, an array element and a union option are not optional`,
    );
  }
  node(schema, at);
}

function checkChecks(def: LooseDef, name: string, shape: Shape, at: At): void {
  const seen = new Set<string>();
  for (const c of checkDefs(def)) {
    const kind = checkName(c);
    if (!(shape.checks as readonly string[]).includes(kind)) {
      at.say(`${at.path}: ${a(name)} takes no check "${kind}"${CHECK_HINTS[kind] ?? ""}`);
    } else if (!CHECKS[kind as CheckName](c)) {
      at.say(
        kind === "pattern"
          ? `${at.path}: a pattern is a RegExp with exactly the u flag, so Zod reads it by code point as JSON Schema does`
          : `${at.path}: the ${kind} check takes no options such as when, abort or error`,
      );
    } else if (seen.has(kind)) {
      at.say(`${at.path}: ${a(name)} takes one ${kind} check`);
    }
    seen.add(kind);
  }
}

/** The description is the only metadata (A3 3.2.1). */
function checkMeta(schema: z.ZodType, at: At): void {
  for (const [key, value] of Object.entries(z.globalRegistry.get(schema) ?? {})) {
    if (key !== "description" || typeof value !== "string") {
      at.say(`${at.path}: metadata "${key}" is not allowed; the description is the only prose`);
    }
  }
}

/** An input string or array has a maximum. */
function limits(def: LooseDef, at: At, what: string): void {
  if (at.side === "input" && maxOf(def) === undefined) {
    at.say(
      `${at.path}: an input ${what} needs a maximum ${what === "array" ? "item count" : "length"}`,
    );
  }
}

function bounds(def: LooseDef, at: At): void {
  const kinds = checkDefs(def).map((c) => c["check"]);
  if (!kinds.includes("greater_than") || !kinds.includes("less_than")) {
    at.say(`${at.path}: a number has a minimum and a maximum`);
  }
}

/** A strict object whose fields have snake_case names and descriptions. */
function inspectObject(def: LooseDef, at: At): void {
  const catchall = def["catchall"] as z.ZodType | undefined;
  if (
    catchall === undefined ||
    defOf(catchall).type !== "never" ||
    !only(defOf(catchall), ["type"])
  ) {
    at.say(`${at.path}: objects must be strict (z.strictObject)`);
  }
  for (const [key, field] of Object.entries(def["shape"] as Record<string, z.ZodType>)) {
    const path = `${at.path}.${key}`;
    if (!SNAKE.test(key)) at.say(`${path}: field names are snake_case`);
    else if (key in Object.prototype) {
      // Validators read it from the prototype of an object that lacks it: Zod and Ajv both
      // reject {} for an optional field called constructor.
      at.say(`${path}: "${key}" is a property of every object, so it cannot be a field name`);
    }
    const description = descriptionOf(field);
    if (description === undefined) at.say(`${path}: field has no .describe()`);
    else if (description.length > LIMITS.description) {
      at.say(
        `${path}: description is ${String(description.length)} characters, the limit is ${String(LIMITS.description)}`,
      );
    }
    node(field, { ...at, path, option: false });
  }
}

/**
 * SafeText: a string with a maximum length and nothing else, piped into a registered normaliser.
 * parseInput() parses the normalised text again. A maximum is the one check that may fail there
 * (too_large). A pattern or a minimum could fail on text that passed, and a check after the
 * normaliser runs where the JSON Schema cannot see it.
 */
function inspectText(def: LooseDef, at: At): void {
  const input = def["in"] as z.ZodType;
  const out = def["out"] as z.ZodType;
  const inDef = defOf(input);
  const outDef = defOf(out);
  const [check, ...rest] = checkDefs(inDef);
  const safe =
    inDef.type === "string" &&
    only(inDef, ["type", "checks"]) &&
    check !== undefined &&
    rest.length === 0 &&
    check["check"] === "max_length" &&
    CHECKS.max_length(check) &&
    outDef.type === "transform" &&
    only(outDef, ["type", "transform"]) &&
    isNormaliser(outDef["transform"]);
  if (!safe) {
    at.say(
      `${at.path}: a transform is allowed only as SafeText: a z.string() with a maximum length and no other check, piped into a registered normaliser`,
    );
  }
  for (const part of [input, out]) checkMeta(part, at);
}

/**
 * Two or more options of a plain kind. In an input, their JSON types are disjoint (see
 * jsonTypes). No entry needs a union of one option, and a union of none has an empty `anyOf`,
 * which Ajv refuses to compile.
 */
function inspectUnion(def: LooseDef, at: At): void {
  const options = def["options"] as z.ZodType[];
  if (options.length < 2) at.say(`${at.path}: a union has at least two options`);
  const taken = new Map<string, number>();
  options.forEach((option, i) => {
    const path = `${at.path}|${String(i)}`;
    if (defOf(option).type === "union") at.say(`${path}: a union option is not another union`);
    child(option, { ...at, path, option: true });
    if (at.side === "output") return;
    if (shapeName(defOf(option)) === "text") {
      // When normalising pushes it past its limit, Zod reports invalid_union instead of
      // too_big, so the service could not answer too_large. Inside an object option it reports
      // too_big at the field.
      at.say(`${path}: an input union option is not SafeText itself; put it in an object option`);
    }
    for (const type of new Set(jsonTypes(option))) {
      const other = taken.get(type);
      if (other !== undefined) {
        at.say(
          `${at.path}: input union options take different JSON types; options ${String(other)} and ${String(i)} both take ${type}`,
        );
      }
      taken.set(type, i);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The agent rules and the defaults (A3 3.2.1): plain data on the entry, keyed by path. Each
// path must name a node of the input that its rule fits. The audience inputs are built from them
// (define.ts), so what is written here is what the generated files and parseInput() apply.

const unwrapOptional = (schema: z.ZodType): z.ZodType => {
  const def = defOf(schema);
  return def.type === "optional" ? (def["innerType"] as z.ZodType) : schema;
};

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * The node a path names, through objects, fields' optionals and array elements: a field's outer
 * layer, or an array's element. A message when there is none.
 */
function locate(input: z.ZodType, path: string): { node: z.ZodType; field: boolean } | string {
  const steps = pathSteps(path);
  if (steps === undefined) return "a path is field names joined by dots, with [] for an element";
  let node = input;
  let field = false;
  let walked = "";
  for (const step of steps) {
    const def = defOf(unwrapOptional(node));
    if (def.type === "union") return `"${walked}" is a union, which a path does not enter`;
    if (step === "[]") {
      if (def.type !== "array") return `"${walked}" is not an array`;
      node = def["element"] as z.ZodType;
      field = false;
      walked += "[]";
      continue;
    }
    if (def.type === "array") return `"${walked}" is an array: name its element with []`;
    if (def.type !== "object") return `"${walked}" is not an object`;
    walked = walked === "" ? step : `${walked}.${step}`;
    const shape = def["shape"] as Record<string, z.ZodType>;
    const next = Object.hasOwn(shape, step) ? shape[step] : undefined;
    if (next === undefined) return `the input has no field "${walked}"`;
    node = next;
    field = true;
  }
  return { node, field };
}

/** True when `path` is `field` or a node inside it. */
const within = (path: string, field: string) =>
  path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`);

/** A value in a message: a string quoted, a number or boolean as is. */
const show = (value: unknown): string => {
  if (typeof value === "function") return "a function";
  const text = JSON.stringify(value) as string | undefined;
  return text ?? String(value);
};

/** A `[path, value]` pair, checked at run time: the data may come from untyped code. */
const isPair = (pair: unknown): boolean =>
  Array.isArray(pair) && pair.length === 2 && typeof (pair as unknown[])[0] === "string";

/**
 * The `[path, value]` pairs of a list, each path once. A path listed twice is reported with both
 * values, whether they are equal or not, and only its first pair is checked further. A list that
 * is not made of pairs is reported, and none of it is used.
 */
function pairsOf<V>(list: string, pairs: Pairs<V>, say: Say): Pair<V>[] {
  const raw: unknown = pairs;
  if (!Array.isArray(raw) || !(raw as unknown[]).every(isPair)) {
    say(`${list}: the list is made of [path, value] pairs`);
    return [];
  }
  const first = new Map<string, V>();
  const kept: Pair<V>[] = [];
  for (const [path, value] of pairs) {
    if (first.has(path)) {
      say(
        `${list} "${path}": the path is listed twice, with ${show(first.get(path))} and ${show(value)}`,
      );
    } else {
      first.set(path, value);
      kept.push([path, value]);
    }
  }
  return kept;
}

function checkRules(entry: Pick<AnyEntry, "input" | "agent" | "defaults">, say: Say): void {
  const { hidden = [], required = [] } = entry.agent ?? {};
  const max = pairsOf("agent.max", entry.agent?.max ?? [], say);
  const defaults = pairsOf("defaults", entry.defaults ?? [], say);
  /** Reports a path that names no node, or the problem `fits` finds with the node it names. */
  const rule = (list: string, path: string, fits: (node: z.ZodType, field: boolean) => string) => {
    const found = locate(entry.input, path);
    const problem = typeof found === "string" ? found : fits(found.node, found.field);
    if (problem !== "") say(`${list} "${path}": ${problem}`);
  };
  for (const [list, paths] of [
    ["agent.hidden", hidden],
    ["agent.required", required],
  ] as const) {
    paths.forEach((path, i) => {
      if (paths.indexOf(path) !== i) say(`${list} "${path}": the path is listed twice`);
      else {
        rule(list, path, (node, field) =>
          field && defOf(node).type === "optional"
            ? ""
            : `it names an optional field, and "${path}" is not one`,
        );
      }
    });
  }
  for (const [path, n] of max) {
    rule("agent.max", path, (node) => {
      const def = defOf(unwrapOptional(node));
      const name = shapeName(def);
      if (name !== "string" && name !== "text" && name !== "array") {
        return `an agent limit sits on a string, SafeText or array, not ${a(name)}`;
      }
      const user = maxOf(name === "text" ? defOf(def["in"] as z.ZodType) : def);
      return Number.isSafeInteger(n) && n >= 1 && user !== undefined && n < user
        ? ""
        : `the agent limit ${String(n)} must be a whole number from 1 to below the user limit ${String(user)}`;
    });
  }
  for (const [path, value] of defaults) {
    rule("defaults", path, (node, field) => {
      const inner = unwrapOptional(node);
      if (!field || inner === node) {
        return `a default sits on an optional field, and "${path}" is not one`;
      }
      if (!SCALARS.has(shapeName(defOf(inner)))) {
        return "only a plain scalar may have a default: an enum, literal, string, integer, number or boolean, without SafeText";
      }
      if (!isScalar(value)) return "a default is one constant string, finite number or boolean";
      const parsed = inner.safeParse(value);
      return parsed.success && Object.is(parsed.data, value)
        ? ""
        : `the default ${JSON.stringify(value)} is not one value the field accepts`;
    });
  }
  // Agents never see a hidden field, so no other agent rule applies at or inside it, and no other
  // hidden path inside it either. A default is the value of a field nobody gave, so no agent rule
  // applies to a field that has one.
  const limited = max.map(([path]) => path);
  for (const field of hidden) {
    for (const [list, paths] of [
      ["agent.hidden", hidden.filter((path) => path !== field)],
      ["agent.required", required],
      ["agent.max", limited],
    ] as const) {
      for (const path of paths) {
        if (within(path, field))
          say(`${list} "${path}": agents never see the hidden field "${field}"`);
      }
    }
  }
  for (const [path] of defaults) {
    if (hidden.includes(path) || required.includes(path) || limited.includes(path)) {
      say(`defaults "${path}": a field with a default takes no agent rule`);
    }
  }
}

function checkFaces(
  entry: AnyEntry,
  say: Say,
  options: CheckOptions,
  schemasOk: boolean,
  seen: { tools: Set<string>; verbs: Set<string> },
): void {
  const { faces } = entry;
  const clis = cliFaces(entry);
  if (faces.ui !== true && clis.length === 0 && faces.mcp === undefined) {
    say("an entry has at least one face");
  }
  if (faces.mcp !== undefined && !isAgentAllowed(entry)) {
    say("only agent-allowed entries have an MCP face (A3 3.2.3)");
  }
  if (entry.actors === "ui" && clis.length > 0) say("a UI-only entry has no CLI face");
  if (entry.actors === "run" && faces.ui === true) say("a run-only entry has no UI face");

  const mcp = faces.mcp;
  if (mcp !== undefined) {
    const tool = mcp.tool;
    if (!SNAKE.test(tool) || tool.length > LIMITS.toolName) {
      say(
        `tool name "${tool}" must be snake_case and at most ${String(LIMITS.toolName)} characters`,
      );
    } else if (tool === "tasks") {
      say('no tool is called "tasks": it clashes with MCP\'s tasks extension');
    } else if (
      options.serverKey !== undefined &&
      (tool === options.serverKey || tool.startsWith(`${options.serverKey}_`))
    ) {
      // The client namespaces every tool by the server key (mcp__ttasks__search), so a name that
      // starts with it says it twice. A later word may be the key's word: add_tasks (A3 3.2.4).
      say(`a tool name does not start with the MCP server key ("${options.serverKey}")`);
    }
    if (seen.tools.has(tool)) say(`tool name "${tool}" is used twice`);
    seen.tools.add(tool);
    if (mcp.title.trim() === "" || mcp.title.length > LIMITS.toolTitle) {
      say(`tool title must be 1 to ${String(LIMITS.toolTitle)} characters`);
    }
    const length = mcp.description.length;
    if (mcp.description.trim() === "" || length > LIMITS.toolDescription) {
      say(
        `tool description is ${String(length)} characters, the limit is ${String(LIMITS.toolDescription)}`,
      );
    }
    const alwaysLoad = mcp.alwaysLoad as unknown;
    if (alwaysLoad !== undefined && typeof alwaysLoad !== "boolean") {
      say("tool alwaysLoad is true or false");
    }
  }

  for (const face of clis) {
    if (!VERB.test(face.verb)) {
      say(`verb "${face.verb}" must be lower case letters, digits and hyphens`);
    }
    if (seen.verbs.has(face.verb)) say(`verb "${face.verb}" is used twice`);
    seen.verbs.add(face.verb);
    if (schemasOk) {
      checkCliFace(entry, face, (m) => {
        say(`cli "${face.verb}": ${m}`);
      });
    }
  }
}

function checkCliFace(entry: AnyEntry, face: CliFace, say: Say): void {
  const fields = faceFields(entry, face);
  const known = (name: string) => fields.has(name);
  if (face.item !== undefined) {
    const item = fields.get(face.item);
    const items = item?.json["items"] as Record<string, unknown> | undefined;
    if (item === undefined || item.json["type"] !== "array" || items?.["type"] !== "object") {
      say(`item "${face.item}" is not an array-of-objects input field`);
    }
  }
  for (const name of face.positional ?? []) {
    const info = fields.get(name);
    if (info?.scalar === undefined || (AUTO_FIELDS as readonly string[]).includes(name)) {
      say(`positional "${name}" is not a scalar input field`);
    }
  }
  if (face.keyValue !== undefined && keyValueFields(entry, face.keyValue) === undefined) {
    say(`keyValue "${face.keyValue}" is not an object input field`);
  }
  for (const name of Object.keys(face.flags ?? {})) {
    if (!known(name)) say(`flags names unknown field "${name}"`);
  }
  const letters = new Set<string>();
  for (const [name, letter] of Object.entries(face.short ?? {})) {
    if (!known(name)) say(`short names unknown field "${name}"`);
    if (!SHORT.test(letter)) say(`short name "${letter}" for "${name}" must be one letter`);
    if (letters.has(letter)) say(`short name "${letter}" is used twice`);
    letters.add(letter);
  }
  for (const name of face.exclude ?? []) {
    if (!known(name)) say(`exclude names unknown field "${name}"`);
  }
  for (const [name, value] of Object.entries(face.fixed ?? {})) {
    const info = fields.get(name);
    if (info === undefined) say(`fixed names unknown field "${name}"`);
    else if (!info.schema.safeParse(value).success) say(`fixed value for "${name}" is not valid`);
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid";
  const where = issue.path.map(String).join(".");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/**
 * Every example's input matches its audience's input and its output the output schema. The
 * audience inputs are built only from rules that passed the check (`schemasOk`).
 */
function checkExamples(entry: AnyEntry, say: Say, schemasOk: boolean): void {
  if (entry.examples.length === 0) say("needs at least one example (A3 3.2.1)");
  for (const example of entry.examples) {
    const at = `example "${example.title}"`;
    const actor = example.actor ?? (isAgentAllowed(entry) ? "agent" : "user");
    if (actor === "agent" && !isAgentAllowed(entry)) {
      say(`${at}: a user-only entry has user examples only`);
      continue;
    }
    const input = schemasOk ? inputSchemaFor(entry, actor).safeParse(example.input) : undefined;
    if (input?.success === false) {
      const which = actor === "agent" ? "the agent input" : "the input schema";
      say(`${at}: input does not match ${which}: ${firstIssue(input.error)}`);
    }
    const output = entry.output.safeParse(example.output);
    if (!output.success) {
      say(`${at}: output does not match the output schema: ${firstIssue(output.error)}`);
    }
  }
}
