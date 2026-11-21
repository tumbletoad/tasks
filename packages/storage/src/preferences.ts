// A space's preferences as readers take them (A1 3.16): every stored row through the registry of
// @ttasks/contracts, so a value that does not fit its declared shape, a reset one and a newer
// build's all read as the default, and no reader keeps a parsing rule of its own. A stored key this
// build does not declare is kept in the table and never read (an older build never drops a newer
// build's settings). Call these inside a read or write transaction.
import {
  PREFERENCES,
  preferenceSpec,
  preferenceValue,
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
