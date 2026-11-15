// The registry entry (A3 3.2.1) and its metadata (A6 3.3). One `defineEntry()` per operation or
// query. Everything the faces need is generated from it (A3 3.2.2): the MCP tool, the RPC method,
// the CLI verb, the HTTP route, the typed client and the docs.
import { z } from "zod";
import type { ErrorCode } from "./errors.ts";

/** "read": a query. "write": one A1 operation kind, or a fixed bundle of them, as one request. */
export const ENTRY_KINDS = ["read", "write"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * Who may call an entry: the exposure classes of A3 3.2.3.
 * - `agent`: agents and the user. Listed as an MCP tool when the entry has an MCP face.
 * - `run`: agent-allowed, but only on a connection bound to a run or routine.
 * - `user`: the user only, through the `ui` and `cli-interactive` connection classes.
 * - `ui`: the browser UI only.
 */
export const ACTOR_CLASSES = ["agent", "run", "user", "ui"] as const;
export type ActorClass = (typeof ACTOR_CLASSES)[number];

/** A1's actor kinds, recorded on every operation and taken from the credential (A6 3.3). */
export const ACTOR_KINDS = ["human", "agent", "routine", "system", "import"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * The actor kinds each class admits. `system` (migrations, A4's launch records) and `import` (file
 * imports a human applies, X15) never call an entry directly: no connection presents them.
 */
export const ACTOR_KINDS_BY_CLASS = {
  agent: ["human", "agent", "routine"],
  run: ["agent", "routine"],
  user: ["human"],
  ui: ["human"],
} as const satisfies Record<ActorClass, readonly ActorKind[]>;

/** The grant scope an entry requires (A6 3.6.3). */
export const SCOPES = [
  "space:read",
  "space:write",
  "machine:read",
  "launch:open",
  "launch:run",
  "admin",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Whether a linked device may call the entry, and how (A6 3.3). Unused until L1. */
export const REMOTE_CLASSES = ["never", "read", "write", "execute"] as const;
export type RemoteClass = (typeof REMOTE_CLASSES)[number];

/**
 * The audience filter (A6 3.3, A1 D14).
 * - `caller`: the result carries stored records, filtered to what the caller's audience may read.
 *   In v1 every note has audience `all`, so the filter passes everything.
 * - `none`: the result carries no stored record content, so there is nothing to filter.
 */
export const AUDIENCE_FILTERS = ["caller", "none"] as const;
export type AudienceFilter = (typeof AUDIENCE_FILTERS)[number];

/** The MCP tool (A3 3.4). Its input schema is the agent projection of the entry's input. */
export interface McpFace {
  /** snake_case, at most 24 characters, permanent (A3 3.2.4). */
  readonly tool: string;
  readonly title: string;
  /** At most 280 characters. The first sentence says when to use the tool (A3 3.2.5). */
  readonly description: string;
  /**
   * Claude Code loads this tool's definition at start, not on demand (`_meta["anthropic/
   * alwaysLoad"]`, M0 row A09). For the tools a session calls first: `status` and `get_task`.
   */
  readonly alwaysLoad?: boolean;
}

/** One CLI verb (A2 3.10, A3 3.4.13). Field names refer to top-level input fields or `item` fields. */
export interface CliFace {
  /** The verb: `tasks <verb>`. Lower case, unique. */
  readonly verb: string;
  /** Scalar fields taken as positional arguments, in order. */
  readonly positional?: readonly string[];
  /** An object field whose keys are given as `key=value` arguments (`tasks set M-14 due=fri`). */
  readonly keyValue?: string;
  /** An array-of-objects field whose single element the verb's arguments fill (`tasks add`). */
  readonly item?: string;
  /** Flag names that differ from the field name in kebab case, such as `{ learnings: "learning" }`. */
  readonly flags?: Readonly<Record<string, string>>;
  /** One-letter flags, such as `{ priority: "p" }` for `-p`. */
  readonly short?: Readonly<Record<string, string>>;
  /** Field values the verb sets itself, such as `{ kind: "note" }` for `tasks note`. */
  readonly fixed?: Readonly<Record<string, unknown>>;
  /** Fields the verb does not offer as arguments. `--input` still reaches them. */
  readonly exclude?: readonly string[];
}

export interface Faces {
  /** `POST /api/v1/op/<name>` and a method on the typed client. */
  readonly ui?: boolean;
  readonly cli?: CliFace | readonly CliFace[];
  readonly mcp?: McpFace;
}

/**
 * A result's size in estimated tokens, `ceil(utf8 bytes / 1.5)` (A3 3.2.5, M0 row A08). A tool
 * definition has no budget: its size is reported in `mcp-definitions.json` (A3 3.2.5).
 */
export interface Budget {
  /** A typical result. */
  readonly typical: number;
  /** The largest result, at most 4,000. The MCP endpoint cuts a longer text to it. */
  readonly max: number;
}

/** A fixture input and the output it gives. Tests check both, and the docs show them. */
export interface Example<I = unknown, O = unknown> {
  readonly title: string;
  /** Who calls. Agent examples must fit the agent input. Default: `agent` when allowed. */
  readonly actor?: "agent" | "user";
  readonly input: I;
  readonly output: O;
}

/** The input is always a strict object: unknown fields are `invalid_input`. */
export type InputSchema = z.ZodObject;

/** A constant default: a string, a finite number or a boolean. */
export type Scalar = string | number | boolean;

/** One declaration keyed by path: `[path, value]`. */
export type Pair<V> = readonly [path: string, value: V];

/**
 * Declarations keyed by path are lists of pairs, not records. A record built from two spread
 * tables keeps one value for a path both name and drops the other without trace, so no check of
 * the result could find it. A list keeps every declaration until the registry check rejects a
 * path listed twice, and a record cannot be spread into it (a type error).
 */
export type Pairs<V> = readonly Pair<V>[];

/** One agent limit: a path and the maximum length or item count agents get there. */
export type Limit = Pair<number>;

/** One default: a path and the constant value a missing field gets. */
export type Default = Pair<Scalar>;

/**
 * What the agent input changes, by path (A3 3.2.1, 3.2.3, 3.4). A path names a node of the input:
 * field names joined by dots, and `[]` for an array's element, such as `outcome`, `learnings[]`
 * or `tasks[].sources[].title`. It passes through a field's `.optional()` and never enters a
 * union. The registry check refuses a path that names no node, a node its rule does not fit, and
 * a path listed twice in one list.
 */
export interface AgentRules {
  /** User-only fields, such as `for_agents` on a note: optional fields agents never see. */
  readonly hidden?: readonly string[];
  /** Optional fields agents must give, such as `outcome` on `task.finish`. */
  readonly required?: readonly string[];
  /**
   * Tighter agent limits (A3 3.1): the maximum length of a string or SafeText, or the item count
   * of an array, below the user's maximum, which the input keeps. `[path, limit]` pairs.
   */
  readonly max?: Pairs<number>;
}

/**
 * Defaults of optional scalar fields: `[path, value]` pairs. `parseInput()` fills them for both
 * audiences.
 */
export type Defaults = Pairs<Scalar>;

/**
 * A write entry that also answers reads (A3 3.2.3 "Mixed actions"), such as `organize` and
 * `preferences`: `field` names the required enum of the input that picks the action, and `reads`
 * lists its values that only read. A read action takes no request ID and writes nothing. A write
 * action needs `request_id`, and `base` when every operation the entry may emit needs one. The
 * schema cannot tie one field's presence to another's value within the grammar, so the request
 * path checks both, before the handler runs.
 */
export interface Actions {
  readonly field: string;
  readonly reads: readonly string[];
}

export interface Entry<
  N extends string = string,
  I extends InputSchema = InputSchema,
  O extends z.ZodType = z.ZodType,
  D extends Defaults = Defaults,
> {
  /** The RPC method and HTTP route, such as `task.update`. */
  readonly name: N;
  /** One line for help and docs. */
  readonly summary: string;
  readonly kind: EntryKind;
  readonly actors: ActorClass;
  readonly scope: Scope;
  readonly remote: RemoteClass;
  readonly audience: AudienceFilter;
  /** The A1 operation kinds a write may emit. Empty for reads. */
  readonly ops: readonly string[];
  /** A write entry whose action field also picks read actions (A3 3.2.3). */
  readonly actions?: Actions;
  /** The full input, including user-only fields. Plain Zod: rules and defaults are data below. */
  readonly input: I;
  /** How the agent input differs from the full input. Agent-allowed entries only. */
  readonly agent?: AgentRules;
  readonly defaults?: D;
  /** The structured result, used by the UI and the CLI's `--json`. */
  readonly output: O;
  readonly faces: Faces;
  /** Required for agent-allowed entries. */
  readonly budget?: Budget;
  readonly errors: readonly ErrorCode[];
  readonly examples: readonly Example<z.input<I>, z.input<O>>[];
}

export type AnyEntry = Entry;

/** Declares a registry entry. `pnpm gen` and the registry check validate it (check.ts). */
export function defineEntry<
  const N extends string,
  I extends InputSchema,
  O extends z.ZodType,
  const D extends Defaults = never,
>(entry: Entry<N, I, O, D>): Entry<N, I, O, D> {
  return Object.freeze(entry);
}

/** A parsed input: a field with a top-level default is always there. Nested ones stay optional. */
export type Filled<T, D extends Defaults> = [D] extends [never]
  ? T
  : T & { [K in D[number][0] & keyof T]-?: Exclude<T[K], undefined> };

export function isAgentAllowed(entry: Pick<AnyEntry, "actors">): boolean {
  return entry.actors === "agent" || entry.actors === "run";
}

/**
 * Whether a call of `entry` with `input` only reads: a read entry, or a mixed entry's read action
 * (A3 3.2.3). Such a call takes no request ID and writes nothing.
 */
export function readsOnly(entry: Pick<AnyEntry, "kind" | "actions">, input: unknown): boolean {
  if (entry.kind === "read") return true;
  const actions = entry.actions;
  if (actions === undefined || typeof input !== "object" || input === null) return false;
  const action = (input as Record<string, unknown>)[actions.field];
  return typeof action === "string" && actions.reads.includes(action);
}

/** The CLI faces of an entry as a list. */
export function cliFaces(entry: Pick<AnyEntry, "faces">): readonly CliFace[] {
  const cli = entry.faces.cli;
  if (cli === undefined) return [];
  return "verb" in cli ? [cli] : cli;
}

/**
 * A shared schema's pairs, keyed by its own paths, moved under `prefix`: every pair is kept, in
 * order, so a path that two spreads both reach is listed twice and the registry check rejects it.
 */
export function under<V>(prefix: string, pairs: Pairs<V>): Pairs<V> {
  return pairs.map(([path, value]): Pair<V> => [`${prefix}.${path}`, value]);
}

const PATH = /^[a-z][a-z0-9_]*(?:\[\])*(?:\.[a-z][a-z0-9_]*(?:\[\])*)*$/u;

/** A path's steps: field names, and `[]` for an array's element. Undefined when malformed. */
export function pathSteps(path: unknown): string[] | undefined {
  if (typeof path !== "string" || !PATH.test(path)) return undefined;
  return path.match(/[a-z][a-z0-9_]*|\[\]/gu) ?? [];
}

const normalisers = new WeakSet<object>();

/**
 * Registers a normalising function, the only kind of `.transform` a schema may use. It must never
 * reject input (A3 3.2.1). SafeText is the one in use (safe-text.ts).
 */
export function normaliser<F extends (value: string) => string>(fn: F): F {
  normalisers.add(fn);
  return fn;
}

export function isNormaliser(fn: unknown): boolean {
  return typeof fn === "function" && normalisers.has(fn);
}

/** The fields of a definition this package reads. Zod 4 keeps them on `_zod.def`. */
export interface LooseDef {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function defOf(schema: z.ZodType): LooseDef {
  return schema._zod.def as unknown as LooseDef;
}

/** The checks of one layer, such as a maximum length or a pattern. */
export function checksOf(def: LooseDef): { _zod: { def: Record<string, unknown> } }[] {
  return (def["checks"] ?? []) as { _zod: { def: Record<string, unknown> } }[];
}

/**
 * The schemas a field is made of, outermost first: `.optional()`, a default the entry's defaults
 * added, and for SafeText its input side. The last layer is the field's core type.
 */
export function layers(schema: z.ZodType): z.ZodType[] {
  const found: z.ZodType[] = [];
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    found.push(current);
    const def = defOf(current);
    if (def.type === "optional" || def.type === "default") current = def["innerType"] as z.ZodType;
    else if (def.type === "pipe") current = def["in"] as z.ZodType;
    else current = undefined;
  }
  return found;
}

export function coreOf(schema: z.ZodType): z.ZodType {
  const all = layers(schema);
  return all[all.length - 1] ?? schema;
}

export function descriptionOf(schema: z.ZodType): string | undefined {
  for (const layer of layers(schema)) if (layer.description !== undefined) return layer.description;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The audience inputs (A3 3.2.1). Each is the entry's input with its rules applied by path: for
// the user the defaults, for agents the defaults and the agent rules. They are built here, never
// written by hand, so a schema carries no policy that composition could lose (A3 3.2.1). A
// rule that does not fit its node changes nothing here, and the registry check reports it. A path
// listed twice in one list throws here, and the check reports it first.

/** Who an input is parsed for: agent and routine actors get the agent input (A3 3.2.1). */
export type Audience = "agent" | "user";

/** What an audience input is built from. */
export interface Rules<I extends InputSchema = InputSchema, D extends Defaults = Defaults> {
  readonly input: I;
  readonly agent?: AgentRules;
  readonly defaults?: D;
}

/** The rules at one node of the input, and those of the nodes below it by step. */
interface Rule {
  hidden?: boolean;
  required?: boolean;
  max?: number;
  fallback?: Scalar;
  readonly below: Map<string, Rule>;
}

/**
 * The paths of one list, refusing a path listed twice. The registry check rejects that first;
 * this guards a build that skipped the check, so it never picks one of two declarations.
 */
function once(list: string, paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      throw new Error(
        `${list} "${path}": the path is listed twice; the registry check rejects this entry`,
      );
    }
    seen.add(path);
  }
  return paths;
}

const pathsOf = (pairs: Pairs<unknown>) => pairs.map(([path]) => path);

function ruleTree(entry: Rules, audience: Audience): Rule {
  const root: Rule = { below: new Map() };
  const at = (path: string, set: (rule: Rule) => void) => {
    let rule = root;
    for (const step of pathSteps(path) ?? []) {
      let next = rule.below.get(step);
      if (next === undefined) {
        next = { below: new Map() };
        rule.below.set(step, next);
      }
      rule = next;
    }
    if (rule !== root) set(rule);
  };
  const defaults = entry.defaults ?? [];
  once("defaults", pathsOf(defaults));
  for (const [path, value] of defaults) at(path, (r) => (r.fallback = value));
  if (audience === "agent") {
    const { hidden = [], required = [], max = [] } = entry.agent ?? {};
    for (const path of once("agent.hidden", hidden)) at(path, (r) => (r.hidden = true));
    for (const path of once("agent.required", required)) at(path, (r) => (r.required = true));
    once("agent.max", pathsOf(max));
    for (const [path, n] of max) at(path, (r) => (r.max = n));
  }
  return root;
}

const built = new WeakMap<object, Partial<Record<Audience, z.ZodType>>>();

/** The schema an audience's input must match. Without rules it is the input itself. */
export function inputSchemaFor(entry: Rules, audience: Audience): z.ZodType {
  let found = built.get(entry);
  if (found === undefined) {
    found = {};
    built.set(entry, found);
  }
  return (found[audience] ??= applyNode(entry.input, ruleTree(entry, audience)));
}

/** A field with its rules: kept, made required, given its default, or limited inside. */
function applyField(schema: z.ZodType, rule: Rule): z.ZodType {
  const def = defOf(schema);
  if (def.type !== "optional") return applyNode(schema, rule);
  const inner = def["innerType"] as z.ZodType;
  const next = applyNode(inner, rule);
  if (rule.required !== true && rule.fallback === undefined) {
    return next === inner ? schema : rebuild(schema, { innerType: next });
  }
  const description = schema.description;
  const described =
    description !== undefined && next.description === undefined ? next.describe(description) : next;
  return rule.required === true ? described : described.default(rule.fallback as never);
}

/** A node with its agent limit, and the rules of its fields or its element. */
function applyNode(schema: z.ZodType, rule: Rule): z.ZodType {
  const node = rule.max === undefined ? schema : withMax(schema, rule.max);
  if (rule.below.size === 0) return node;
  const def = defOf(node);
  if (def.type === "object") {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, field] of Object.entries(def["shape"] as Record<string, z.ZodType>)) {
      const below = rule.below.get(key);
      if (below === undefined) shape[key] = field;
      else if (below.hidden !== true || defOf(field).type !== "optional") {
        shape[key] = applyField(field, below);
      }
    }
    return rebuild(node, { shape });
  }
  const element = rule.below.get("[]");
  if (def.type !== "array" || element === undefined) return node;
  return rebuild(node, { element: applyField(def["element"] as z.ZodType, element) });
}

/** A string, SafeText or array whose maximum length or item count is `max`. */
function withMax(schema: z.ZodType, max: number): z.ZodType {
  const def = defOf(schema);
  if (def.type === "pipe") return rebuild(schema, { in: withMax(def["in"] as z.ZodType, max) });
  if (def.type !== "string" && def.type !== "array") return schema;
  const checks = checksOf(def).filter((c) => c._zod.def["check"] !== "max_length");
  return rebuild(schema, { checks: [...checks, z.maxLength(max)] });
}

/** A new schema with a changed definition, keeping the original's description only. */
function rebuild(schema: z.ZodType, changes: Record<string, unknown>): z.ZodType {
  const copy = schema.clone({ ...schema._zod.def, ...changes });
  const description = schema.description;
  return description === undefined ? copy : copy.describe(description);
}

/**
 * Parses an entry's input at the registry boundary. Every face parses with it (A3 3.10 item 4).
 * SafeText can lengthen text (NFC turns U+0958 into two code points), and A1 stores the
 * normalised text, so the limits must hold on the normalised value. The JSON Schema can state them
 * only on the text as sent, so this parses twice: once to normalise and fill defaults, then again
 * on that value. The registry check's grammar makes that safe. Normalising is idempotent and keeps
 * a value's JSON type. A normalised string carries no check but its maximum length. A default is
 * one constant plain scalar the field accepts unchanged, never SafeText. The options of an input
 * union take different JSON types, so both parses pick the same option. Wrappers carry no checks.
 * So the second parse changes nothing, the value it returns passes its own schema again, and it
 * fails only on a maximum length, which the service answers with `too_large`. The soundness
 * property test holds this (soundness.test.ts).
 */
export function parseInput<I extends InputSchema, D extends Defaults = never>(
  entry: Rules<I, D>,
  audience: Audience,
  input: unknown,
): z.ZodSafeParseResult<Filled<z.output<I>, D>> {
  const schema = inputSchemaFor(entry, audience);
  const first = schema.safeParse(input);
  const result = first.success ? schema.safeParse(first.data) : first;
  return result as z.ZodSafeParseResult<Filled<z.output<I>, D>>;
}
