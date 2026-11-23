// What an entry declares and this build always refuses: one list, read by both sides. The MCP tool
// list and docs/agents/tools.md leave every row out, and the request path refuses a call that uses
// one, naming its step. The step that builds a row deletes it. The command line's help still lists
// them: a person who uses one gets the same refusal. A row for agents only is built for the person
// already: agents, and the scripts and agent shells that call as agents, are refused it.

/** Who a call is for, as the request path sets it (A3 3.2.1). */
export type LaterAudience = "user" | "agent";

/** A whole entry, a top-level input field, or one value of an enum field, and the step that brings it. */
export type Later =
  | { readonly entry: string; readonly step: string }
  | {
      readonly entry: string;
      readonly field: string;
      readonly value?: string;
      readonly step: string;
      /** Refused to agents only: the person has it in this build. */
      readonly audience?: "agent";
    };

const PROPOSALS = "M4.02 (autonomy and proposals)";
const SET_PREFERENCES = "M3.11 (agents changing preferences)";

export const LATER: readonly Later[] = [
  { entry: "run.report", step: "M6.06 (run and routine bindings)" },
  {
    entry: "prefs.manage",
    field: "action",
    value: "set",
    step: SET_PREFERENCES,
    audience: "agent",
  },
  { entry: "prefs.manage", field: "set", step: SET_PREFERENCES, audience: "agent" },
  { entry: "task.update", field: "remove_sources", step: "M3's source.unlink operation" },
  { entry: "space.status", field: "guide", value: "refresh", step: "M4.07 (the refresh guide)" },
  ...["task.add", "task.update", "task.finish", "task.reopen", "group.manage", "prefs.manage"].map(
    (entry): Later => ({ entry, field: "mode", value: "propose", step: PROPOSALS }),
  ),
];

/**
 * Preference keys this build reads and nobody sets yet: a change of them needs more than its value.
 * A space's statuses: the page's Open and the finished statuses assume `open`, and search tells
 * statuses apart that differ only in case.
 */
export const LATER_SETS: readonly { readonly key: string; readonly step: string }[] = [
  { key: "tasks.statuses", step: "the step that lets a space change its statuses" },
];

/**
 * Preference keys this build declares but does not act on: nothing reads them, so `preferences`
 * leaves them out rather than show a setting that changes nothing.
 */
export const LATER_PREFERENCES: readonly { readonly key: string; readonly step: string }[] = [
  { key: "autonomy.level", step: PROPOSALS },
  { key: "autonomy.agent_tasks_to_inbox", step: PROPOSALS },
  { key: "targets.default", step: "the step that makes Open use the default instance" },
  { key: "projection.enabled", step: "the step that makes the projection read it" },
  { key: "features.search_trigram", step: "M3.16 (trigram search)" },
];

/**
 * Results an entry declares and this build never gives, by output path: the docs leave them out.
 * A path names a field (`proposal`) or, with a value, one value of an enum field.
 */
export const LATER_RESULTS: readonly {
  readonly entry: string;
  readonly path: string;
  readonly value?: string;
  readonly step: string;
}[] = [
  ...["task.finish", "task.update"].map((entry) => ({ entry, path: "result", value: "review" })),
  { entry: "task.finish", path: "follow_ups[].result", value: "proposed" },
  { entry: "task.add", path: "tasks[].result", value: "proposed" },
  ...["task.finish", "task.update", "task.reopen", "group.manage", "prefs.manage"].map((entry) => ({
    entry,
    path: "result",
    value: "proposed",
  })),
  ...["task.add", "task.finish", "task.update", "task.reopen", "group.manage", "prefs.manage"].map(
    (entry) => ({ entry, path: "proposal" }),
  ),
].map((row) => ({ ...row, step: PROPOSALS }));

/** Whether an entry is offered at all: no row takes the whole of it. */
export function isOffered(entry: string): boolean {
  return !LATER.some((row) => row.entry === entry && !("field" in row));
}

/** The rows on an entry's fields that `audience` meets. */
export function laterFields(
  entry: string,
  audience: LaterAudience,
): readonly Extract<Later, { field: string }>[] {
  return LATER.filter(
    (row): row is Extract<Later, { field: string }> =>
      row.entry === entry &&
      "field" in row &&
      (row.audience === undefined || row.audience === audience),
  );
}

/**
 * The row a call's input uses: a listed field it asks something of, or a listed value it gives
 * one. An empty list asks nothing, so it is no use of its field.
 */
export function laterIn(
  entry: string,
  input: Readonly<Record<string, unknown>>,
  audience: LaterAudience,
): Extract<Later, { field: string }> | undefined {
  return laterFields(entry, audience).find((row) =>
    row.value === undefined ? asks(input[row.field]) : input[row.field] === row.value,
  );
}

const asks = (value: unknown): boolean =>
  value !== undefined && !(Array.isArray(value) && value.length === 0);
