// The page's actions export, given with `--actions` (A7 3.15.4, 3.15.7): the check-offs and stars
// the page holds in its browser storage, so that none held only there is lost at the switch-over.
//
// The page saves `planning-actions-YYYY-MM-DD.json` as `{"version": 1, "exported": "<ISO time>",
// "events": [...]}`, where `events` holds every event the page knew, those of events/ included,
// de-duplicated and sorted. The prototype's own import command reads only `events`, at most 10,000
// of them, and checks the whole list before it writes anything: each `action` one of the four, `id`
// and `task` of 1 to 100 characters from [a-zA-Z0-9_-], `at` an RFC 3339 time with `Z` or an offset
// and up to nine fraction digits. Extra fields are allowed. This parser checks the same way, so a
// file that command refuses is refused here as a whole (`actions-invalid`), with one difference:
// `at` is read with the grammar of events/ (events.ts), which lets the seconds out, because the
// export carries the times of events/ as they are written there. The merge with events/ by ID is
// events.ts's.

import { ACTIONS, ACTIONS_FILE, eventInstant, type PrototypeEvent } from "./events.ts";
import { isObject, readJson } from "./json.ts";
import { limitsWith, type Limits } from "./limits.ts";
import { problem, type Problem } from "./problems.ts";
import type { Source } from "./text.ts";

/** The most events the prototype's import command reads from one export. */
export const ACTIONS_MAX = 10_000;

const ID = /^[a-zA-Z0-9_-]{1,100}$/;

export interface ActionsParse {
  /** True when the whole file is accepted. Otherwise `events` is empty. */
  readonly ok: boolean;
  /** In the file's order, each with its position in `events`. */
  readonly events: readonly PrototypeEvent[];
  readonly problems: readonly Problem[];
}

const refused = (problems: Problem[], index?: number): ActionsParse => ({
  ok: false,
  events: [],
  problems: [...problems, problem("actions-invalid", { file: ACTIONS_FILE, index })],
});

/** Parses the export. Total: whatever the bytes, it returns a result and never throws. */
export function parseActions(source: Source, overrides?: Partial<Limits>): ActionsParse {
  const limits = limitsWith(overrides);
  const read = readJson(source, ACTIONS_FILE, limits.jsonBytes);
  if (!read.ok) return refused(read.problems);
  const problems = read.problems;
  if (problems.some((p) => p.severity === "error")) return refused(problems);
  const list = isObject(read.value) ? read.value["events"] : undefined;
  if (!Array.isArray(list) || list.length > ACTIONS_MAX) return refused(problems);
  const events: PrototypeEvent[] = [];
  for (const [index, item] of (list as unknown[]).entries()) {
    if (!isObject(item)) return refused(problems, index);
    const { id, task, action, at } = item;
    if (
      typeof id !== "string" ||
      !ID.test(id) ||
      typeof task !== "string" ||
      !ID.test(task) ||
      typeof action !== "string" ||
      !(ACTIONS as readonly string[]).includes(action) ||
      typeof at !== "string" ||
      eventInstant(at) === undefined
    ) {
      return refused(problems, index);
    }
    events.push({
      id,
      task,
      action: action as PrototypeEvent["action"],
      at,
      file: ACTIONS_FILE,
      index,
    });
  }
  return { ok: true, events, problems };
}
