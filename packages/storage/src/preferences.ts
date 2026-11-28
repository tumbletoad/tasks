// A space's preferences as readers take them (A1 3.16): every stored row through the registry of
// @ttasks/contracts, so a value that does not fit its declared shape, a reset one and a newer
// build's read as the declaration says (the default, or what its `salvage` takes), and no reader
// keeps a parsing rule of its own. A stored key this build does not declare is kept in the table
// and never read (an older build never drops a newer build's settings). Call these inside a read
// or write transaction.
import {
  mayWrite,
  PREFERENCES,
  preferenceSpec,
  preferenceValue,
  samePrefValue,
  type PreferenceRead,
  type StoredPreference,
} from "@ttasks/contracts/preferences";
import type { Connection, Row } from "./driver.ts";
import { misuse } from "./errors.ts";

const SQL = {
  one: "SELECT value, schema_ver FROM preferences WHERE key = $key",
  all: "SELECT key, value, schema_ver FROM preferences",
} as const;

/** A preferences row as the registry reads it, or undefined for a row without a usable form. */
export function storedPreference(row: Row | undefined): StoredPreference | undefined {
  if (row === undefined) return undefined;
  const { value, schema_ver: schemaVer } = row;
  return typeof value === "string" && typeof schemaVer === "number"
    ? { value, schemaVer }
    : { value: "", schemaVer: 1 };
}

/** One space preference the registry declares. */
export function readSpacePreference(conn: Connection, key: string): PreferenceRead {
  const spec = preferenceSpec(key);
  if (spec?.scope !== "space") throw misuse("Not a space preference of this build");
  return preferenceValue(spec, storedPreference(conn.prepare(SQL.one).get({ key })));
}

/** Every space preference and flag the registry declares, in its order. */
export function readSpacePreferences(conn: Connection): PreferenceRead[] {
  const rows = new Map<string, Row>();
  for (const row of conn.prepare(SQL.all).all()) {
    if (typeof row["key"] === "string") rows.set(row["key"], row);
  }
  return PREFERENCES.filter((spec) => spec.scope === "space").map((spec) =>
    preferenceValue(spec, storedPreference(rows.get(spec.key))),
  );
}

export type ScaleKey = "tasks.statuses" | "tasks.effort_scale";

export const isScaleKey = (key: string): key is ScaleKey =>
  key === "tasks.statuses" || key === "tasks.effort_scale";

/** A scale's keys from its value: a list of keys, or of `{key}` objects. */
export function scaleKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw misuse("A list preference reads as a list");
  return value.map((item: unknown) =>
    typeof item === "string" ? item : String((item as { key?: unknown }).key),
  );
}

/** The keys of `tasks.statuses` or `tasks.effort_scale` as the registry reads them (A1 3.16). */
export function listPreference(conn: Connection, key: ScaleKey): string[] {
  return scaleKeys(readSpacePreference(conn, key).value);
}

type PrefSpec = NonNullable<ReturnType<typeof preferenceSpec>>;

/** A refusal of a preference's change, as both writers say it. */
export interface PrefRefusal {
  code: "PREFERENCE_FORBIDDEN" | "VALIDATION_FAILED" | "BASE_REQUIRED";
  message: string;
  field: "key" | "base";
}

/**
 * What decides a preference's change before anything it changes is read, for today's writer and
 * the tree's: whether it is the space's own filling of a default (a value every space holds,
 * where it holds none), and why it is refused. Who may write the key comes first; then a newer
 * build's value, read-only here, said before any other reason so nobody changes tasks for a change
 * this build cannot make; then a first setting of the effort levels without a base, which would
 * race the person who read the levels it replaces. A stored value is held to the base whatever the
 * change writes (`held`).
 */
export function prefSetRule(
  spec: PrefSpec,
  row: Row | undefined,
  op: { key: string; value: unknown; moves?: readonly unknown[] },
  actorKind: string,
  based: boolean,
  /** Today's writer keeps a newer build's value as it is; the tree reads no other build's rows. */
  newerBuilds: boolean,
): { fills: boolean; held: boolean; refused?: PrefRefusal } {
  const fills =
    actorKind === "system" &&
    spec.stored === true &&
    (row === undefined || row["value"] === "null") &&
    samePrefValue(op.value, spec.default) &&
    op.moves === undefined;
  const held = row !== undefined;
  const refuse = (refused: PrefRefusal) => ({ fills, held, refused });
  if (!fills && !mayWrite(spec, actorKind)) {
    return refuse({
      code: "PREFERENCE_FORBIDDEN",
      message: "Only the user changes this preference",
      field: "key",
    });
  }
  if (newerBuilds && row !== undefined && Number(row["schema_ver"]) > spec.schemaVer) {
    return refuse({
      code: "VALIDATION_FAILED",
      message: "A newer build wrote this preference: it is read-only here",
      field: "key",
    });
  }
  if (op.key === "tasks.effort_scale" && !fills && row === undefined && !based) {
    return refuse({
      code: "BASE_REQUIRED",
      message: "This change needs the as_of of a read as its base",
      field: "base",
    });
  }
  return { fills, held };
}
