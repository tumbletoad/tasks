// What an entry declares and this build always refuses: one list, read by both sides. What an
// agent is shown (the MCP tools, docs/agents) leaves every row out, and the request path refuses a
// call that uses one, naming its step. The step that builds a row deletes it.

/** A whole entry, a top-level input field, or one value of an enum field, and the step that brings it. */
export type Later =
  | { readonly entry: string; readonly step: string }
  | {
      readonly entry: string;
      readonly field: string;
      readonly value?: string;
      readonly step: string;
    };

const PROPOSALS = "M4.02 (autonomy and proposals)";
const SET_PREFERENCES = "M3.11 (changing preferences)";

export const LATER: readonly Later[] = [
  { entry: "run.report", step: "M6.06 (run and routine bindings)" },
  { entry: "prefs.manage", field: "action", value: "set", step: SET_PREFERENCES },
  { entry: "prefs.manage", field: "set", step: SET_PREFERENCES },
  { entry: "task.update", field: "remove_sources", step: "M3's source.unlink operation" },
  { entry: "space.status", field: "guide", value: "refresh", step: "M4.07 (the refresh guide)" },
  ...["task.add", "task.update", "task.finish", "task.reopen", "group.manage", "prefs.manage"].map(
    (entry): Later => ({ entry, field: "mode", value: "propose", step: PROPOSALS }),
  ),
];

/** Whether an entry is offered at all: no row takes the whole of it. */
export function isOffered(entry: string): boolean {
  return !LATER.some((row) => row.entry === entry && !("field" in row));
}

/** The rows on an entry's fields. */
export function laterFields(entry: string): readonly Extract<Later, { field: string }>[] {
  return LATER.filter(
    (row): row is Extract<Later, { field: string }> => row.entry === entry && "field" in row,
  );
}

/** The row a call's input uses: a listed field it gives, or a listed value it gives one. */
export function laterIn(
  entry: string,
  input: Readonly<Record<string, unknown>>,
): Extract<Later, { field: string }> | undefined {
  return laterFields(entry).find((row) =>
    row.value === undefined ? input[row.field] !== undefined : input[row.field] === row.value,
  );
}
