// The space preferences this build declares (A1 3.16), as the `preferences` tool reads them
// (A3 3.4.11): each key with its value schema, its default, who may write it and whether it is
// policy. They are the keys the product reads today. M3.11 builds the rest of A1 3.16's registry
// on this list: the machine scope, feature flags, schema versions and `pref.set`.
//
// A value schema is one of four kinds, and the tool's value union (`PrefValue`) has one option per
// kind plus null, which resets a key to its default. So the union holds every declared value, and
// the request path checks a value against its own key's schema (`prefValueSchema`): never an
// unrestricted unknown (A3 3.4.11).
import { z } from "zod";

/** The shape of one preference's value. */
export type PrefKind =
  | { readonly kind: "enum"; readonly values: readonly [string, ...string[]] }
  /** An ordered list of distinct keys, such as statuses: letters, digits, `-` and `_`. */
  | { readonly kind: "keys"; readonly max: number }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "boolean" };

export type PrefPlain = string | number | boolean | readonly string[];

/** Who may write a key: A1's actor kinds a declaration lists (A1 3.16 `writers`). */
export type PrefWriter = "human" | "agent";

export interface PrefDeclaration {
  readonly key: string;
  /** One line for `describe`. */
  readonly summary: string;
  readonly value: PrefKind;
  readonly default: PrefPlain;
  readonly writers: readonly PrefWriter[];
  /** Policy (A1 3.16, A3 3.8.2): a human with the admin scope only, never an agent (R7). */
  readonly policy?: true;
}

/** A key in a list preference: what a status or an effort key may be. */
export const PREF_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;

/** A preference's key: dotted lower-case words, such as `tasks.statuses`. */
export const PREF_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** The longest string and the longest list a value of any declared kind has. */
const STRING_MAX = 40;
const LIST_MAX = 20;

/** Every space preference this build declares, sorted by key. */
export const PREFERENCES: readonly PrefDeclaration[] = [
  {
    key: "autonomy.level",
    summary: "How far agents may change tasks without the user (Full, Review, Suggest)",
    value: { kind: "enum", values: ["full", "review", "suggest"] },
    default: "review",
    writers: ["human"],
    policy: true,
  },
  {
    key: "tasks.dedupe_window_days",
    summary: "Days a finished task still matches a source key",
    value: { kind: "integer", min: 0, max: 3650 },
    default: 30,
    writers: ["human"],
  },
  {
    key: "tasks.effort_scale",
    summary: "The effort keys, smallest first",
    value: { kind: "keys", max: 8 },
    default: ["S", "M", "L"],
    writers: ["human"],
  },
  {
    key: "tasks.statuses",
    summary: "The statuses of active tasks, in order",
    value: { kind: "keys", max: 12 },
    default: ["open", "waiting", "review", "backlog"],
    writers: ["human", "agent"],
  },
];

const byKey = new Map(PREFERENCES.map((p) => [p.key, p]));

/** A declared preference by its exact key. */
export function findPreference(key: string): PrefDeclaration | undefined {
  return byKey.get(key);
}

/** The schema of one key's value (not null: null resets, and is the request path's to read). */
export function prefValueSchema(kind: PrefKind): z.ZodType {
  switch (kind.kind) {
    case "enum":
      return z.enum(kind.values);
    case "keys":
      return z
        .array(z.string().regex(PREF_KEY_PATTERN))
        .min(1)
        .max(kind.max)
        .refine((keys) => new Set(keys).size === keys.length, "Each key once");
    case "integer":
      return z.int().min(kind.min).max(kind.max);
    case "boolean":
      return z.boolean();
  }
}

/** A value's shape in words, for `describe`: product words only. */
export function prefShape(kind: PrefKind): string {
  switch (kind.kind) {
    case "enum":
      return `one of ${kind.values.join(", ")}`;
    case "keys":
      return `a list of 1 to ${String(kind.max)} keys`;
    case "integer":
      return `a whole number from ${String(kind.min)} to ${String(kind.max)}`;
    case "boolean":
      return "true or false";
  }
}

/**
 * A preference value in the tool's input: one option per declared kind and null, each of its own
 * JSON type, as the schema grammar requires of an input union (A3 3.2.1). The request path then
 * checks the value against its key's own schema.
 */
export const PrefValue = z.union([
  z.string().max(STRING_MAX),
  z.int().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string().max(STRING_MAX)).max(LIST_MAX),
  z.null(),
]);

/** A stored or default value in a result. */
export const PrefValueOutput = z.union([
  z.string(),
  z.int().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string()),
]);
