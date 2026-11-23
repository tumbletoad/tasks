// prefs.manage: read and change the space's non-policy preferences (A3 3.4.11). `describe` and
// `get` read; `set` writes through A1's `pref.set`, for the user only until agents get it
// (later.ts). The keys and their value schemas are contracts' declarations (preferences.ts).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import { AsOf, Base, Mode, ProposalId, Replayed, RequestId } from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

/** The longest string and the longest list a value the tool shows has. */
const STRING_MAX = 64;
const LIST_MAX = 20;
/** A list sent as one text of keys and commas: room for the longest list any key takes. */
const LIST_TEXT_MAX = 1_024;

/**
 * A preference value in the tool's input: one option per JSON type the tool's keys take. The
 * handler then checks the value against its key's own shape in the registry (preferences.ts),
 * never an unrestricted value. A reset is `reset`, never a value: on a command line, any word
 * that meant "the default" would also be a text a key could take.
 */
const PrefValue = z.union([
  z.string().max(LIST_TEXT_MAX),
  z.int().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string().max(STRING_MAX)).max(LIST_MAX),
]);

/** A stored or default value in a result: null is a default of none. */
const PrefValueOutput = z.union([
  z.string(),
  z.int().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const PREFS_ACTIONS = ["describe", "get", "set"] as const;

export const PrefsManageInput = z.strictObject({
  action: z.enum(PREFS_ACTIONS).describe("describe: the keys; get: their values"),
  keys: z
    .array(z.string().max(64))
    .max(20)
    .describe('Keys, or prefixes ending in ".*"; default every key')
    .optional(),
  set: z
    .array(
      z.strictObject({
        key: z.string().max(64).describe("A key describe lists"),
        value: PrefValue.describe("The new value, a list as keys separated by commas").optional(),
        reset: z.boolean().describe("Put the key back to its default, instead of a value").optional(),
      }),
    )
    .min(1)
    .max(10)
    .describe("set: the keys and their new values")
    .optional(),
  base: Base.optional(),
  request_id: RequestId.optional(),
  mode: Mode,
});

const PrefRow = z.strictObject({
  key: z.string().describe("The key"),
  summary: z.string().describe("What it sets (describe)").optional(),
  shape: z.string().describe("Its values, in words (describe)").optional(),
  value: PrefValueOutput.describe("Its value now (get)").optional(),
  default: PrefValueOutput.describe("Its default"),
  is_default: z.boolean().describe("The value is the default (get)").optional(),
  writable: z.boolean().describe("Whether this caller may change it"),
  policy: z.literal(true).describe("Policy: the user's own (A3 3.8)").optional(),
  in_force: PrefValueOutput.describe(
    "What this build does whatever the key says: it does not act on the key yet",
  ).optional(),
});

export const PrefsManageResult = z.strictObject({
  action: z.enum(PREFS_ACTIONS).describe("The action"),
  as_of: AsOf,
  prefs: z.array(PrefRow).describe("The keys asked for, sorted"),
  result: z.enum(["updated", "no_change", "proposed"]).describe("What a change did").optional(),
  changed: z
    .array(
      z.strictObject({
        key: z.string().describe("The key"),
        from: PrefValueOutput.describe("Its value before"),
        to: PrefValueOutput.describe("Its value now"),
      }),
    )
    .describe("The keys a change changed")
    .optional(),
  proposal: ProposalId.optional(),
  replayed: Replayed.optional(),
});

export const prefsManage = defineEntry({
  name: "prefs.manage",
  summary: "Read and change the space's preferences that are not policy.",
  kind: "write",
  actors: "agent",
  scope: "space:write",
  remote: "write",
  audience: "caller",
  ops: ["pref.set"],
  actions: { field: "action", reads: ["describe", "get"] },
  input: PrefsManageInput,
  defaults: [["mode", "apply"]],
  output: PrefsManageResult,
  faces: {
    ui: true,
    cli: {
      verb: "prefs",
      positional: ["action", "key", "value"],
      item: "set",
      readInto: { key: "keys" },
    },
    mcp: {
      tool: "preferences",
      title: "Read settings",
      description:
        "Use when the user asks about a setting: describe lists the keys and who may change them, get reads their values. Only the user changes them, from a terminal: tell the user. Policy stays the user's.",
    },
  },
  budget: { typical: 600, max: 2000 },
  errors: ["invalid_input", "forbidden", "conflict", "space_unavailable", "request_id_conflict"],
  examples: [
    {
      title: "The statuses, with their default",
      input: { action: "get", keys: ["tasks.statuses"] },
      output: {
        action: "get",
        as_of: AS_OF,
        prefs: [
          {
            key: "tasks.statuses",
            value: ["open", "waiting", "review", "backlog"],
            default: ["open", "waiting", "review", "backlog"],
            is_default: true,
            writable: false,
          },
        ],
      },
    },
    {
      title: "The user adds sizes",
      actor: "user",
      input: {
        action: "set",
        set: [{ key: "tasks.effort_scale", value: ["XS", "S", "M", "L", "XL"] }],
        base: AS_OF,
        request_id: requestId(15),
      },
      output: {
        action: "set",
        as_of: AS_OF_NEXT,
        prefs: [
          {
            key: "tasks.effort_scale",
            value: ["XS", "S", "M", "L", "XL"],
            default: ["S", "M", "L"],
            is_default: false,
            writable: true,
          },
        ],
        result: "updated",
        changed: [
          {
            key: "tasks.effort_scale",
            from: ["S", "M", "L"],
            to: ["XS", "S", "M", "L", "XL"],
          },
        ],
      },
    },
  ],
});
