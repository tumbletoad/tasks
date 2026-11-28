// A space's preferences on the tree, by today's writer's rules (write/writer.ts `pref.set`): who may
// change a key, a status that active tasks hold never dropped, and a change of the effort levels that names where the tasks on a dropped level go
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
import {
  isScaleKey,
  levelMoves,
  listPreference,
  movedOf,
  offListOf,
  prefSetRule,
  scaleKeys,
  type Mover,
} from "../preferences.ts";
import { canonicalJson } from "../write/canonical.ts";
import { prefSet, type PrefSet } from "../write/request.ts";
import { problem, type Check } from "./commands.ts";
import { TreeProblem } from "./fields.ts";
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
  /** Every task a change of levels moves, with the size it holds and where it is. */
  movers:
    "SELECT t.id AS id, t.effort AS effort, n.deleted_at IS NOT NULL AS trash, " +
    "t.lifecycle = 'active' AS active FROM tasks t JOIN nodes n ON n.id = t.id " +
    "WHERE t.effort IN (SELECT value FROM json_each($from)) ORDER BY t.id",
  offList:
    "SELECT t.effort AS effort, t.ref AS ref FROM tasks t JOIN nodes n ON n.id = t.id " +
    "WHERE n.deleted_at IS NULL AND t.effort IS NOT NULL " +
    "AND t.effort NOT IN (SELECT value FROM json_each($keys)) ORDER BY t.effort, t.ref",
} as const;

const check: Check = (f) => {
  const set = prefSet(f, 0);
  f.done();
  return { ...set };
};

const run: Command["run"] = (tx, input) => {
  const { key, value: given, moves } = input as unknown as PrefSet;
  const spec = preferenceSpec(key);
  if (spec === undefined)
    return problem("VALIDATION_FAILED", "Not a preference of this build", "key");
  // A reset of a key a space always holds stores its default, as today's writer does.
  const value = given === null && spec.stored === true ? spec.default : given;
  const row = tx.get(SQL.row, { key });
  const rule = prefSetRule(
    spec,
    row,
    { key, value: given, ...(moves === undefined ? {} : { moves }) },
    tx.request.actor.actor_kind,
    tx.request.base !== undefined,
    false,
  );
  if (rule.refused !== undefined) {
    problem(rule.refused.code, rule.refused.message, rule.refused.field);
  }
  // A stored value is held to the base whatever the change writes; a stale request is a conflict,
  // whatever it says of a list its person never saw.
  if (rule.held && tx.held("preferences", key, null, ["value"])) return { key };
  let movers: Mover[] | undefined;
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
      if (refused !== undefined) {
        // With the tasks that hold a dropped size, which the answer counts for the person.
        const { message, field, holders } = refused;
        throw new TreeProblem("VALIDATION_FAILED", message, field, holders && { holders });
      }
      // Every mover is read before any is written (preferences.ts `Mover`).
      const from = (moves ?? []).filter((m) => m.to !== m.from).map((m) => m.from);
      movers = tx.all(SQL.movers, { from: JSON.stringify(from) }).map((r) => ({
        id: String(r["id"]),
        from: String(r["effort"]),
        state:
          Number(r["trash"]) === 1 ? "trash" : Number(r["active"]) === 1 ? "active" : "finished",
      }));
      // The tasks on a dropped level go where the person says, whatever else changed on them.
      for (const { id, effort } of levelMoves(moves ?? [], movers)) {
        tx.set("tasks", id, id, { effort }, false);
      }
    }
  }
  const stored = value === null ? "null" : canonicalJson(value);
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
  if (movers === undefined) return { key };
  const keys = listPreference(tx.conn, "tasks.effort_scale");
  return {
    key,
    moved: movedOf(moves ?? [], movers),
    ...offListOf(tx.all(SQL.offList, { keys: JSON.stringify(keys) }), tx.space.refPrefix),
  };
};

export const PREFS: Readonly<Record<string, Command>> = { "pref.set": { check, run } };
