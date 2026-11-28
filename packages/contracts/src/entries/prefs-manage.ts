// prefs.manage: read and change the space's non-policy preferences (A3 3.4.11). `describe` and
// `get` read; `set` writes through A1's `pref.set`, for the user only until agents get it
// (later.ts). The keys and their value schemas are contracts' declarations (preferences.ts).
import { z } from "zod";
import { defineEntry } from "../define.ts";
import {
  EFFORT_ABOUT_MAX,
  EFFORT_KEY_MAX,
  EFFORT_LEVELS,
  EFFORT_NAME_MAX,
  EFFORT_UNITS,
} from "../preferences.ts";
import { AsOf, Base, Mode, ProposalId, Replayed, RequestId } from "../schemas.ts";
import { AS_OF, AS_OF_NEXT, requestId } from "./fixture.ts";

/** The longest string and the longest list a value the tool shows has. */
const STRING_MAX = 64;
const LIST_MAX = 20;
/** A list sent as one text of keys and commas: room for the longest list any key takes. */
const LIST_TEXT_MAX = 1_024;

/** An effort level whole (`tasks.effort_scale`): its name, and its time and line when it has them. */
const Level = z.strictObject({
  key: z
    .string()
    .max(EFFORT_KEY_MAX)
    .describe(
      `The level's name, at most ${String(EFFORT_NAME_MAX)} characters; a longer one the space holds stays`,
    ),
  time: z
    .strictObject({
      amount: z.int().min(1).max(999).describe("How many units"),
      unit: z.enum(EFFORT_UNITS).describe("The unit"),
    })
    .describe("A typical amount of the user's own time on it")
    .optional(),
  about: z
    .string()
    .max(EFFORT_ABOUT_MAX)
    .describe("One line on what belongs on it, in the user's words")
    .optional(),
});

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
  z.array(z.union([z.string().max(STRING_MAX), Level])).max(LIST_MAX),
]);

const Size = z.string().max(EFFORT_KEY_MAX);
const SizeOrNone = z.union([Size, z.null()]);
const Count = z.int().min(0).max(9_999_999_999);
/** How many tasks, by state. */
const Counts = {
  active: Count.describe("Open tasks"),
  finished: Count.describe("Completed or archived tasks"),
  trash: Count.describe("Tasks in the Trash"),
};

/** The live tasks on a size the effort levels lack: reported, never refused. */
export const OffList = z
  .array(
    z.strictObject({
      effort: Size.describe("The size"),
      tasks: z.array(z.string()).max(10).describe("Their references, the first 10"),
      count: Count.describe("How many"),
    }),
  )
  .describe("Live tasks on a size that is not a level now: give each of them a level");

/** A change of the effort levels: the tasks each move moved, by state. */
export const Moved = z
  .array(
    z.strictObject({
      from: Size.describe("The size it moved from"),
      to: SizeOrNone.describe("The level it moved to, or null for no size"),
      ...Counts,
    }),
  )
  .describe("A change of the effort levels: the tasks each move moved, by state");

/** A stored or default value in a result: null is a default of none. */
const PrefValueOutput = z.union([
  z.string(),
  z.int().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string()),
  z.array(Level),
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
        reset: z
          .boolean()
          .describe("Put the key back to its default, instead of a value")
          .optional(),
        moves: z
          .array(
            z.strictObject({
              from: Size.describe("A level, or a size tasks hold"),
              to: SizeOrNone.describe("A level of the new list, or null for no size"),
            }),
          )
          .max(LIST_MAX)
          .describe(
            "tasks.effort_scale only, set alone: the tasks on each size move with the change",
          )
          .optional(),
      }),
    )
    .min(1)
    .max(10)
    .describe("set: the keys and their new values")
    .optional(),
  dry_run: z
    .boolean()
    .describe("Decide a set as it would be written, and write nothing")
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
  fixed: z.literal(true).describe("Fixed in this build: nobody changes it").optional(),
  held: z
    .array(z.strictObject({ effort: Size.describe("The size"), ...Counts }))
    .describe("tasks.effort_scale (get): the tasks on each size, by state")
    .optional(),
});

export const PrefsManageResult = z.strictObject({
  action: z.enum(PREFS_ACTIONS).describe("The action"),
  as_of: AsOf.describe(
    "A list's read, or this write's position: your next base. Names may be newer",
  ),
  prefs: z
    .array(PrefRow)
    .describe("The keys asked for, sorted; absent on a set when they could not be read")
    .optional(),
  result: z.enum(["updated", "no_change", "proposed"]).describe("What a change did").optional(),
  changed: z
    .array(
      z.strictObject({
        key: z.string().describe("The key"),
        from: PrefValueOutput.describe("Its value before"),
        to: PrefValueOutput.describe("The value it set"),
      }),
    )
    .describe("The keys a change changed")
    .optional(),
  moved: Moved.optional(),
  off_list: OffList.optional(),
  proposal: ProposalId.optional(),
  replayed: Replayed.optional(),
});

/** What a describe or a get returns: the keys are always there. */
export const PrefsReadResult = PrefsManageResult.extend({
  prefs: z.array(PrefRow).describe("The keys asked for, sorted"),
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
        "Use when the user asks about a setting: describe lists the keys and who may change them, get reads their values. Only the user changes them, from a terminal: tell the user. A key marked fixed nobody changes in this build. Policy stays the user's.",
    },
  },
  budget: { typical: 600, max: 2000 },
  agent: { hidden: ["dry_run"] },
  errors: [
    "invalid_input",
    "forbidden",
    "conflict",
    "space_unavailable",
    "request_id_conflict",
    "applied_earlier",
  ],
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
            fixed: true,
          },
        ],
      },
    },
    {
      title: "The user keeps three effort levels by name, each with its time and line",
      actor: "user",
      input: {
        action: "set",
        set: [{ key: "tasks.effort_scale", value: ["S", "M", "L"] }],
        base: AS_OF,
        request_id: requestId(15),
      },
      output: {
        action: "set",
        as_of: AS_OF_NEXT,
        prefs: [
          {
            key: "tasks.effort_scale",
            value: EFFORT_LEVELS.slice(1, 4),
            default: [...EFFORT_LEVELS],
            is_default: false,
            writable: true,
            held: [],
          },
        ],
        result: "updated",
        changed: [
          {
            key: "tasks.effort_scale",
            from: [...EFFORT_LEVELS],
            to: EFFORT_LEVELS.slice(1, 4),
          },
        ],
      },
    },
  ],
});
