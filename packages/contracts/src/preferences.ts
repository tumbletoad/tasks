// The preferences registry (A1 3.16): every preference and feature flag, declared once with its
// value shape, its default, its scope (the space or this machine), its writers and whether it is a
// policy key. The writer checks `pref.set` against it, machine.toml's `[preferences]` is read with
// it, and every reader takes a stored value through `preferenceValue`, so no reader keeps a rule of
// its own.
//
// This module imports nothing, not even Zod: storage's writer imports it (`@ttasks/contracts/
// preferences`), and the storage worker should load no more than it needs.
//
// Rules a declaration keeps (checkPreferences, tested):
// - A value shape is one of the closed set below, never an unrestricted value. Every shape is
//   bounded: lists, maps and text have a maximum.
// - `null` is never a value: it resets a key to its default. A default may be null, meaning "none".
// - A policy key has the human as its only writer (A3 3.8.2, R7).
// - A feature flag lives under `features.` and is a boolean or an enum (A1 3.16).
// - A key's name is never reused once removed: it moves to RETIRED_PREFERENCES.

/** Plain JSON data, as a preference's value is stored. */
export type PrefValue =
  string | number | boolean | readonly PrefValue[] | { readonly [key: string]: PrefValue };

export type PrefScope = "space" | "machine";
export type PrefWriter = "human" | "agent";

/** A value's declared shape. Text is always one line, without control characters, in NFC. */
export type ValueShape =
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "boolean" }
  | { readonly type: "integer"; readonly min: number; readonly max: number }
  | { readonly type: "text"; readonly max: number; readonly pattern?: RegExp }
  /** An absolute path in either OS's form. machine.toml's reader adds the platform's own rule. */
  | { readonly type: "path" }
  | {
      readonly type: "list";
      readonly item: ValueShape;
      readonly min: number;
      readonly max: number;
      /**
       * Items are unique: as a whole (`self`), or by their `key` field ignoring case (`key`), as a
       * person tells sizes apart.
       */
      readonly unique?: "self" | "key";
    }
  /** Exactly these fields, each required. */
  | { readonly type: "object"; readonly fields: Readonly<Record<string, ValueShape>> }
  | {
      readonly type: "map";
      readonly key: RegExp;
      readonly value: ValueShape;
      readonly max: number;
    };

export interface PreferenceSpec {
  readonly key: string;
  readonly scope: PrefScope;
  readonly shape: ValueShape;
  /** The value of a key that is not set. Null: none. */
  readonly default: PrefValue | null;
  readonly writers: readonly PrefWriter[];
  /** Autonomy, targets and the like: the human with `admin` only (A3 3.8.2, A6 3.6.3). */
  readonly policy: boolean;
  /** The value shape's version. A stored value with a newer one is read-only here (A1 3.16). */
  readonly schemaVer: number;
  /**
   * What a reader still takes from a stored value the shape refuses or a newer build wrote, in the
   * shape; undefined when nothing can be taken and the default is read.
   */
  readonly salvage?: (value: unknown) => PrefValue | undefined;
  /** One line for `describe` (A3 3.4.11). */
  readonly summary: string;
  /** A feature flag (A1 3.16). A graduated flag stays readable and is ignored. */
  readonly flag?: { readonly stability: "preview" | "graduated" };
}

/** A preference's name: dotted lower-case words, `features.search_trigram`. */
export const PREFERENCE_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
export const PREFERENCE_KEY_MAX = 64;
/** The largest stored value, as JSON. Every shape stays far below it. */
export const PREFERENCE_VALUE_BYTES = 16 * 1024;

/** A status or effort key, as the writer checks `tasks.status` and `tasks.effort` (A1 3.6). */
const STATUS_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** The longest effort key: the scale's and every task input's, so each size can be used. */
export const EFFORT_KEY_MAX = 20;
const EFFORT_KEY = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,${String(EFFORT_KEY_MAX - 1)}}$`);
/** The most sizes a space has. */
export const EFFORT_SCALE_MAX = 10;
/**
 * The sizes of a space that stores none. Never changed: an older build on the same space reads
 * the same sizes.
 */
export const EFFORT_FALLBACK: readonly string[] = ["S", "M", "L"];
/** An instance's key in machine.toml (A4 3.2). */
const INSTANCE_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** An area's or project's slug (A1 3.3). */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** An autonomy action key: an operation kind, with the field for `task.patch` (A3 3.8.1). */
const ACTION_KEY = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*){1,2}$/;

const LEVELS = ["full", "review", "suggest"] as const;

function pref(
  key: string,
  spec: Omit<PreferenceSpec, "key" | "writers" | "policy" | "schemaVer"> &
    Partial<Pick<PreferenceSpec, "writers" | "policy" | "schemaVer">>,
): PreferenceSpec {
  return { key, writers: ["human"], policy: false, schemaVer: 1, ...spec };
}

function flag(
  key: string,
  spec: { default: boolean; stability: "preview" | "graduated"; summary: string },
): PreferenceSpec {
  return pref(key, {
    scope: "space",
    shape: { type: "boolean" },
    default: spec.default,
    summary: spec.summary,
    flag: { stability: spec.stability },
  });
}

/**
 * Every preference and feature flag. Writers are the human unless a declaration lists the agent
 * too (A1 3.16: "An agent writes only keys whose declaration lists it").
 */
export const PREFERENCES: readonly PreferenceSpec[] = [
  // The page's look and keys are the person's on this machine, the same in every space and tab.
  // A per-space theme, if one comes, is a key of its own that overrides this one.
  pref("ui.theme", {
    scope: "machine",
    shape: { type: "enum", values: ["sumi", "washi", "system"] },
    default: "sumi",
    summary: "The page's theme on this machine: Sumi (dark), Washi (light) or the system's",
  }),
  pref("ui.single_keys", {
    scope: "machine",
    shape: { type: "boolean" },
    default: true,
    summary: "Keys without Ctrl or Alt, such as n and /, on this machine",
  }),
  pref("tasks.statuses", {
    scope: "space",
    shape: {
      type: "list",
      item: { type: "text", max: 40, pattern: STATUS_KEY },
      min: 1,
      max: 20,
      unique: "self",
    },
    default: ["open", "waiting", "review", "backlog"],
    writers: ["human", "agent"],
    summary: "The status keys a task may take, in their order",
  }),
  pref("tasks.effort_scale", {
    scope: "space",
    shape: {
      type: "list",
      item: {
        type: "object",
        fields: { key: { type: "text", max: EFFORT_KEY_MAX, pattern: EFFORT_KEY } },
      },
      min: 1,
      max: EFFORT_SCALE_MAX,
      unique: "key",
    },
    default: EFFORT_FALLBACK.map((key) => ({ key })),
    summary: "The effort keys a task may take, smallest first",
    salvage: (value) => effortKeys(value)?.map((key) => ({ key })),
  }),
  pref("tasks.dedupe_window_days", {
    scope: "space",
    shape: { type: "integer", min: 0, max: 3_650 },
    default: 30,
    summary: "Days a finished task still matches a new draft by source key",
  }),
  pref("grouping.names", {
    scope: "space",
    shape: {
      type: "object",
      fields: { area: { type: "text", max: 40 }, project: { type: "text", max: 40 } },
    },
    default: { area: "Area", project: "Project" },
    summary: "What the space calls its areas and projects",
  }),
  pref("autonomy.level", {
    scope: "space",
    policy: true,
    shape: { type: "enum", values: LEVELS },
    default: "review",
    summary: "What agents may change without the user: full, review or suggest",
  }),
  pref("autonomy.agent_tasks_to_inbox", {
    scope: "space",
    policy: true,
    shape: { type: "boolean" },
    default: false,
    summary: "Tasks agents create go to the Inbox, at every level",
  }),
  pref("autonomy.overrides", {
    scope: "space",
    policy: true,
    shape: {
      type: "map",
      key: ACTION_KEY,
      value: { type: "enum", values: ["apply", "mark", "propose", "deny"] },
      max: 100,
    },
    default: {},
    summary: "Per action key: apply, mark, propose or deny, over the level's default",
  }),
  pref("autonomy.areas", {
    scope: "space",
    policy: true,
    shape: { type: "map", key: SLUG, value: { type: "enum", values: LEVELS }, max: 200 },
    default: {},
    summary: "Per area or project slug: its own level; the nearest wins",
  }),
  pref("targets.default", {
    scope: "space",
    policy: true,
    shape: { type: "text", max: 64, pattern: INSTANCE_KEY },
    default: null,
    summary: "The instance Open uses when none is chosen: a key of machine.toml, never a command",
  }),
  pref("projection.enabled", {
    scope: "space",
    shape: { type: "boolean" },
    default: true,
    summary: "Keep the generated folder of readable files",
  }),
  pref("projection.dir", {
    scope: "machine",
    shape: { type: "path" },
    default: null,
    summary: "Where this machine writes the readable files; none is inside the space folder",
  }),
  flag("features.search_trigram", {
    default: false,
    stability: "preview",
    summary: "Substring search through a trigram index",
  }),
];

/** Names of removed preferences. A name here is never declared again (A1 3.16). */
export const RETIRED_PREFERENCES: readonly string[] = [];

const BY_KEY = new Map(PREFERENCES.map((spec) => [spec.key, spec]));

/** The declaration of `key`, or undefined for a key this build does not know. */
export function preferenceSpec(key: string): PreferenceSpec | undefined {
  return BY_KEY.get(key);
}

/** The feature flags (A1 3.16). */
export const FEATURE_FLAGS: readonly PreferenceSpec[] = PREFERENCES.filter((p) => p.flag);

// ---------------------------------------------------------------------------------------------
// Values

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Control and format characters, line and paragraph separators: never in a preference's text. */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.isWellFormed() &&
    value.normalize("NFC") === value &&
    !NOT_ONE_LINE.test(value) &&
    Array.from(value).length <= max
  );
}

/**
 * The size names of a stored effort scale of any version: a list of 1 to EFFORT_SCALE_MAX objects
 * that each have a `key` of one line, whatever their other fields, each name once. Undefined for
 * anything else. A name a later version allows (a space inside) is taken too, so this build offers
 * the sizes the space has rather than ones it removed.
 */
export function effortKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > EFFORT_SCALE_MAX)
    return undefined;
  const keys: string[] = [];
  for (const item of value) {
    const key = isRecord(item) ? item["key"] : undefined;
    if (!isLine(key, EFFORT_KEY_MAX) || key.trim() !== key) return undefined;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

const PATH_MAX = 1_024;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Whether `value` fits `shape`. It never says why: a reason could quote the value. */
export function fitsShape(shape: ValueShape, value: unknown): boolean {
  switch (shape.type) {
    case "enum":
      return typeof value === "string" && shape.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= shape.min &&
        value <= shape.max
      );
    case "text":
      return isLine(value, shape.max) && (shape.pattern?.test(value) ?? true);
    case "path":
      return isLine(value, PATH_MAX) && ABSOLUTE.test(value);
    case "list": {
      if (!Array.isArray(value) || value.length < shape.min || value.length > shape.max) {
        return false;
      }
      if (!value.every((item) => fitsShape(shape.item, item))) return false;
      if (shape.unique === undefined) return true;
      const ids = value.map((item: unknown) =>
        shape.unique === "key" && isRecord(item) ? String(item["key"]).toLowerCase() : item,
      );
      return new Set(ids).size === ids.length;
    }
    case "object": {
      if (!isRecord(value)) return false;
      const names = Object.keys(shape.fields);
      return (
        Object.keys(value).length === names.length &&
        names.every((name) => {
          const field = shape.fields[name];
          return field !== undefined && Object.hasOwn(value, name) && fitsShape(field, value[name]);
        })
      );
    }
    case "map": {
      if (!isRecord(value)) return false;
      const entries = Object.entries(value);
      return (
        entries.length <= shape.max &&
        entries.every(([key, item]) => shape.key.test(key) && fitsShape(shape.value, item))
      );
    }
  }
}

/** A list of objects with one field `key`, such as `tasks.effort_scale`: a list of keys to a reader. */
export function isKeyList(shape: ValueShape): boolean {
  return (
    shape.type === "list" &&
    shape.item.type === "object" &&
    Object.keys(shape.item.fields).length === 1 &&
    Object.hasOwn(shape.item.fields, "key")
  );
}

/** A shape in words, for `describe` (A3 3.4.11): product words only, never a pattern. */
export function shapeText(shape: ValueShape): string {
  switch (shape.type) {
    case "enum":
      return `one of ${shape.values.join(", ")}`;
    case "boolean":
      return "true or false";
    case "integer":
      return `a whole number from ${String(shape.min)} to ${String(shape.max)}`;
    case "text":
      return `one line of up to ${String(shape.max)} characters`;
    case "path":
      return "an absolute path";
    case "list":
      return shape.item.type === "text" || isKeyList(shape)
        ? `a list of ${String(shape.min)} to ${String(shape.max)} keys`
        : `a list of ${String(shape.min)} to ${String(shape.max)} items`;
    case "object":
      return `the fields ${Object.keys(shape.fields).join(", ")}`;
    case "map":
      return `up to ${String(shape.max)} names, each with a value`;
  }
}

/** Who a writer is, by the commit's actor kind: routines are agents (A3 3.8.1). */
export function writerOf(actorKind: string): PrefWriter | undefined {
  if (actorKind === "human") return "human";
  if (actorKind === "agent" || actorKind === "routine") return "agent";
  return undefined;
}

/** Whether an actor of `actorKind` may write `spec` (A1 3.16). Admin is the caller's check. */
export function mayWrite(spec: PreferenceSpec, actorKind: string): boolean {
  const writer = writerOf(actorKind);
  return writer !== undefined && spec.writers.includes(writer);
}

/** A stored preference: its value as JSON text and its shape's version. */
export interface StoredPreference {
  readonly value: string;
  readonly schemaVer: number;
}

/**
 * What a reader sees of a preference (A1 3.16):
 * - `set`: the stored value fits the shape.
 * - `default`: nothing stored, or a value reset with null.
 * - `invalid`: a stored value that does not fit; the default is used.
 * - `newer`: a newer build's value: kept unchanged and read-only here; the default is used.
 * A declaration's `salvage` reads what it can of a value that does not fit or is newer: `set` or
 * `newer` then carries what it took instead of the default.
 */
export interface PreferenceRead {
  readonly key: string;
  readonly value: PrefValue | null;
  readonly state: "set" | "default" | "invalid" | "newer";
}

/** A stored value as readers take it: the value when it fits, else the default. */
export function preferenceValue(
  spec: PreferenceSpec,
  stored: StoredPreference | undefined,
): PreferenceRead {
  const fallback = (state: PreferenceRead["state"]): PreferenceRead => ({
    key: spec.key,
    value: spec.default,
    state,
  });
  if (stored === undefined) return fallback("default");
  let value: unknown;
  try {
    value = JSON.parse(stored.value) as unknown;
  } catch {
    value = undefined;
  }
  const newer = stored.schemaVer > spec.schemaVer;
  if (value === null && !newer) return fallback("default");
  if (!newer && fitsShape(spec.shape, value)) {
    return { key: spec.key, value: value as PrefValue, state: "set" };
  }
  const salvaged = spec.salvage?.(value);
  if (salvaged === undefined) return fallback(newer ? "newer" : "invalid");
  return { key: spec.key, value: salvaged, state: newer ? "newer" : "set" };
}

/**
 * The value of a declared key from its stored row, the default when it has none. A key this build
 * does not declare is a bug of the caller.
 */
export function readPreference(key: string, stored: StoredPreference | undefined): PreferenceRead {
  const spec = preferenceSpec(key);
  if (spec === undefined) throw new Error("No preference has this name");
  return preferenceValue(spec, stored);
}

// ---------------------------------------------------------------------------------------------
// The registry's own rules

/** Every rule a declaration keeps, as one sentence per broken rule naming the key. */
export function checkPreferences(
  list: readonly PreferenceSpec[] = PREFERENCES,
  retired: readonly string[] = RETIRED_PREFERENCES,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const spec of list) {
    const { key } = spec;
    if (!PREFERENCE_KEY.test(key) || key.length > PREFERENCE_KEY_MAX) {
      problems.push(`${key}: not a preference name`);
    }
    if (seen.has(key)) problems.push(`${key}: declared twice`);
    seen.add(key);
    if (retired.includes(key)) problems.push(`${key}: a retired name`);
    if (spec.default !== null && !fitsShape(spec.shape, spec.default)) {
      problems.push(`${key}: the default does not fit the shape`);
    }
    if (spec.default !== null && JSON.stringify(spec.default).length > PREFERENCE_VALUE_BYTES) {
      problems.push(`${key}: the default is too large`);
    }
    if (spec.writers.length === 0 || !spec.writers.includes("human")) {
      problems.push(`${key}: the human must be a writer`);
    }
    if (spec.policy && spec.writers.some((w) => w !== "human")) {
      problems.push(`${key}: a policy key has the human as its only writer`);
    }
    if (spec.scope === "machine" && spec.writers.includes("agent")) {
      problems.push(`${key}: a machine preference is the user's (A2 3.2.4)`);
    }
    if (!Number.isSafeInteger(spec.schemaVer) || spec.schemaVer < 1) {
      problems.push(`${key}: the schema version is a whole number from 1`);
    }
    const isFlag = spec.flag !== undefined;
    if (isFlag !== key.startsWith("features.")) {
      problems.push(`${key}: flags, and only flags, live under features.`);
    }
    if (isFlag && spec.shape.type !== "boolean" && spec.shape.type !== "enum") {
      problems.push(`${key}: a flag is a boolean or an enum`);
    }
    if (isFlag && (spec.default === null || spec.policy || spec.scope !== "space")) {
      problems.push(`${key}: a flag has a default and is a space preference that is not policy`);
    }
    if (!isLine(spec.summary, 120)) problems.push(`${key}: the summary is one short line`);
  }
  return problems;
}
