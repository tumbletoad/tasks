// A space's preferences on the tree, by today's writer's rules (write/writer.ts `pref.set`): who may
// change a key, a value a newer build wrote kept as it is, a status that active tasks hold never
// dropped, and a change of the effort levels that names where the tasks on a dropped level go
// (contracts' `checkEffortMoves`, the writer's and a preview's alike). Its input is read by today's
// check (write/request.ts `prefSet`). A request may ask for a preview: decided whole and rolled
// back, with no receipt (core.ts).
import {
  checkEffortMoves,
  EFFORT_NAME_MAX,
  effortNamesFit,
  preferenceSpec,
  samePrefValue,
} from "@ttasks/contracts/preferences";
import { isScaleKey, listPreference, prefSetRule, scaleKeys } from "../preferences.ts";
import { prefSet, type PrefSet } from "../write/request.ts";
import { problem, type Check } from "./commands.ts";
import type { Command } from "./tx.ts";

const SQL = {
  row: "SELECT * FROM preferences WHERE key = $key",
  statusInUse:
    "SELECT 1 FROM tasks t JOIN nodes n ON n.id = t.id WHERE t.lifecycle = 'active' " +
    "AND n.deleted_at IS NULL AND t.status IN (SELECT value FROM json_each($keys)) LIMIT 1",
  /** How many tasks hold each size, live and active, live and finished, and in the Trash. */
  held:
    "SELECT t.effort AS effort, sum(n.deleted_at IS NULL AND t.lifecycle = 'active') AS active, " +
    "sum(n.deleted_at IS NULL AND t.lifecycle <> 'active') AS finished, " +
    "sum(n.deleted_at IS NOT NULL) AS trash FROM tasks t JOIN nodes n ON n.id = t.id " +
    "WHERE t.effort IS NOT NULL GROUP BY t.effort",
  movers: "SELECT id FROM tasks WHERE effort = $from",
} as const;

const check: Check = (f) => {
  const set = prefSet(f, 0);
  f.done();
  return { ...set };
};

const run: Command["run"] = (tx, input) => {
  const { key, value, moves } = input as unknown as PrefSet;
  const spec = preferenceSpec(key);
  if (spec === undefined)
    return problem("VALIDATION_FAILED", "Not a preference of this build", "key");
  const row = tx.get(SQL.row, { key });
  const rule = prefSetRule(
    spec,
    row,
    { key, value, ...(moves === undefined ? {} : { moves }) },
    tx.request.actor.actor_kind,
    tx.request.base !== undefined,
  );
  if (rule.refused !== undefined) {
    problem(rule.refused.code, rule.refused.message, rule.refused.field);
  }
  // A stored value is held to the base whatever the change writes; a stale request is a conflict,
  // whatever it says of a list its person never saw.
  if (rule.held && tx.held("preferences", key, null, ["value"])) return { key };
  let moved: { from: string; to: string | null; tasks: number }[] = [];
  if (isScaleKey(key)) {
    const next = scaleKeys(value ?? spec.default);
    const now = listPreference(tx.conn, key);
    if (key === "tasks.statuses") {
      const removed = now.filter((k) => !next.includes(k));
      if (removed.length > 0 && tx.get(SQL.statusInUse, { keys: JSON.stringify(removed) })) {
        problem(
          "VALIDATION_FAILED",
          "Active tasks hold a key this change removes: give them another first",
          "value",
        );
      }
    } else {
      if (!effortNamesFit(next, now)) {
        problem(
          "VALIDATION_FAILED",
          `A new level's name has at most ${String(EFFORT_NAME_MAX)} characters`,
          "value",
        );
      }
      const held = tx.all(SQL.held).map((r) => ({
        effort: String(r["effort"]),
        active: Number(r["active"]),
        finished: Number(r["finished"]),
        trash: Number(r["trash"]),
      }));
      const refused = checkEffortMoves(now, next, held, moves ?? []);
      if (refused !== undefined) problem("VALIDATION_FAILED", refused.message, refused.field);
      moved = (moves ?? [])
        .filter((m) => m.to !== m.from)
        .map((m) => {
          const ids = tx.all(SQL.movers, { from: m.from }).map((r) => String(r["id"]));
          // The tasks on a dropped level go where the person says, whatever else changed on them.
          for (const id of ids) tx.set("tasks", id, id, { effort: m.to }, false);
          return { from: m.from, to: m.to, tasks: ids.length };
        });
    }
  }
  const stored = JSON.stringify(value);
  if (row === undefined) {
    if (value !== null) {
      tx.create("preferences", { key, value: stored, schema_ver: spec.schemaVer }, null);
    }
  } else if (!samePrefValue(JSON.parse(String(row["value"])), value)) {
    tx.set(
      "preferences",
      key,
      null,
      { value: { value: stored, schema_ver: spec.schemaVer } },
      false,
    );
  }
  return { key, ...(moved.length === 0 ? {} : { moved }) };
};

export const PREFS: Readonly<Record<string, Command>> = { "pref.set": { check, run } };
