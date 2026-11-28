// The two switches of step 1's trial of the library (tests/trial): read only while a trial runs,
// and removed once it has decided whether the trail stays as it is. Neither is a setting a person
// meets. The log holds tool names and references only, never text.
import { appendFileSync, existsSync } from "node:fs";

/** The trial's condition without the trail: get_task's digest lists nothing above the task. */
export const trailOff = (): boolean => process.env["TTASKS_TRIAL_TRAIL"] === "off";

/** A reference, an ID or "space": what a call names, kept; anything else is left out. */
const NAMED = /^(?:[A-Z]{1,6}-[1-9][0-9]{0,9}|space|[a-z]{1,2}_[0-9a-hjkmnp-tv-z]{26})$/u;

const named = (value: unknown): string | undefined =>
  typeof value === "string" && NAMED.test(value) ? value : undefined;

/**
 * One tool call of an agent, for the trial's count of what it read: appended to the file
 * TTASKS_TRIAL_CALLS names when that file exists (the trial makes it).
 */
export function trialCall(instance: string | undefined, tool: string, args: unknown): void {
  const file = process.env["TTASKS_TRIAL_CALLS"];
  if (file === undefined || file === "" || !existsSync(file)) return;
  const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const target = named(input["target"]);
  const task = named(input["task"]);
  const action = typeof input["action"] === "string" ? input["action"] : undefined;
  const scope = typeof input["scope"] === "string" ? input["scope"] : undefined;
  appendFileSync(
    file,
    `${JSON.stringify({
      at: Date.now(),
      instance: instance ?? null,
      tool,
      ...(target === undefined ? {} : { target }),
      ...(task === undefined ? {} : { task }),
      ...(action === undefined ? {} : { action }),
      ...(scope === undefined ? {} : { scope }),
    })}\n`,
  );
}
