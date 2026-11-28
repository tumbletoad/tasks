// Preferences as the service's reads give them (A1 3.16): the space's from its rows through the
// registry, this machine's from machine.toml. The snapshot carries the space's (A5 3.15), and
// `readPreferences` gives every declared key with its declaration, what `describe` and `get`
// print (A3 3.4.11) and the Settings page lists. Nothing here writes: a space preference changes
// only through `pref.set` (A1 3.16), a machine one through config/preferences.ts.
import {
  PREFERENCES,
  type PreferenceRead,
  type PreferenceSpec,
  type PrefValue,
} from "@ttasks/contracts";
import type { Row, WorkerConnection } from "@ttasks/storage";
import { readMachinePreferences } from "../config/preferences.ts";
import type { MachineConfig } from "../config/machine-toml.ts";
import { PREFERENCE_ROWS, spacePreferencesOf } from "./read.ts";

// The space's rows are read where every other read lives (read.ts), which imports nothing of the
// configuration; these names stay here for the snapshot's reader (http/feed.ts).
export { PREFERENCE_ROWS, spacePreferencesOf };

/** A preference as `describe` and `get` show it: its value and state with its declaration. */
export interface PreferenceView extends PreferenceRead {
  readonly scope: PreferenceSpec["scope"];
  readonly policy: boolean;
  readonly writers: PreferenceSpec["writers"];
  readonly default: PrefValue | null;
  readonly summary: string;
}

function viewOf(spec: PreferenceSpec, read: PreferenceRead): PreferenceView {
  return {
    ...read,
    scope: spec.scope,
    policy: spec.policy,
    writers: spec.writers,
    default: spec.default,
    summary: spec.summary,
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
