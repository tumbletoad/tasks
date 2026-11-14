// Preferences as the service's reads give them (A1 3.16): the space's from its rows through the
// registry, this machine's from machine.toml. The snapshot carries the space's (A5 3.15), and
// `readPreferences` gives every declared key with its declaration, what `describe` and `get`
// print (A3 3.4.11) and the Settings page lists. Nothing here writes: a space preference changes
// only through `pref.set` (A1 3.16), a machine one through config/preferences.ts.
import {
  PREFERENCES,
  preferenceValue,
  type PreferenceRead,
  type PreferenceSpec,
  type PrefValue,
} from "@tasks/contracts";
import { storedPreference, type Row, type WorkerConnection } from "@tasks/storage";
import { readMachinePreferences } from "../config/preferences.ts";
import type { MachineConfig } from "../config/machine-toml.ts";

/** Every preferences row: unknown keys are skipped by the readers, never dropped from the table. */
export const PREFERENCE_ROWS = "SELECT key, value, schema_ver FROM preferences";

/** Every space preference and flag the registry declares, in its order, from the stored rows. */
export function spacePreferencesOf(rows: readonly Row[]): PreferenceRead[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) if (typeof row["key"] === "string") byKey.set(row["key"], row);
  return PREFERENCES.filter((spec) => spec.scope === "space").map((spec) =>
    preferenceValue(spec, storedPreference(byKey.get(spec.key))),
  );
}

/** A preference as `describe` and `get` show it: its value and state with its declaration. */
export interface PreferenceView extends PreferenceRead {
  readonly scope: PreferenceSpec["scope"];
  readonly policy: boolean;
  readonly writers: PreferenceSpec["writers"];
  readonly default: PrefValue | null;
  readonly summary: string;
  readonly flag?: PreferenceSpec["flag"];
}

function viewOf(spec: PreferenceSpec, read: PreferenceRead): PreferenceView {
  return {
    ...read,
    scope: spec.scope,
    policy: spec.policy,
    writers: spec.writers,
    default: spec.default,
    summary: spec.summary,
    ...(spec.flag === undefined ? {} : { flag: spec.flag }),
  };
}

/** Every declared preference, space and machine, in the registry's order, in one space read. */
export async function readPreferences(
  reader: WorkerConnection,
  config: MachineConfig,
): Promise<PreferenceView[]> {
  const [rows] = await reader.transaction("deferred", [{ sql: PREFERENCE_ROWS, mode: "all" }]);
  const reads = new Map(
    [...spacePreferencesOf(rows as Row[]), ...readMachinePreferences(config)].map((r) => [
      r.key,
      r,
    ]),
  );
  return PREFERENCES.flatMap((spec) => {
    const read = reads.get(spec.key);
    return read === undefined ? [] : [viewOf(spec, read)];
  });
}
