// The machine's spaces and its default space (A2 3.1, A5 3.3), through the service's
// `/api/v1/space/list` and `/api/v1/space/default`. The default decides only what a new tab opens:
// a tab that shows a space keeps it, whatever the default becomes. Every answer is checked by its
// shape before the page uses it.
import type { Api } from "../api.ts";
import { SPACE_ID } from "../route.ts";

export interface SpaceItem {
  readonly id: string;
  readonly name: string;
  /** `open`, `read_only`, `opening`, `unavailable`, … (A2 3.1). */
  readonly state: string;
}

export interface SpaceList {
  readonly spaces: readonly SpaceItem[];
  /** The machine's default space, or null when it has none. */
  readonly default: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a space can be shown now: open, or read-only. */
export const isServed = (space: SpaceItem): boolean =>
  space.state === "open" || space.state === "read_only";

async function result(api: Api, path: string, input: unknown): Promise<unknown> {
  const reply = await api.post(path, JSON.stringify(input));
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body) as unknown;
  } catch {
    parsed = undefined;
  }
  if (reply.status !== 200 || !isRecord(parsed) || !("result" in parsed)) {
    throw new Error(`The service answered ${String(reply.status)}`);
  }
  return parsed["result"];
}

export async function listSpaces(api: Api): Promise<SpaceList> {
  const value = await result(api, "/api/v1/space/list", {});
  if (!isRecord(value) || !Array.isArray(value["spaces"])) throw new Error("No space list");
  const spaces = value["spaces"].filter(
    (s): s is SpaceItem =>
      isRecord(s) &&
      typeof s["id"] === "string" &&
      SPACE_ID.test(s["id"]) &&
      typeof s["name"] === "string" &&
      typeof s["state"] === "string",
  );
  const chosen = value["default"];
  return {
    spaces,
    default: typeof chosen === "string" && SPACE_ID.test(chosen) ? chosen : null,
  };
}

/** Make default: the machine's default space becomes `space`. Resolves with it. */
export async function makeDefault(api: Api, space: string): Promise<string> {
  const value = await result(api, "/api/v1/space/default", { space });
  const made = isRecord(value) ? value["default"] : undefined;
  if (typeof made !== "string" || made !== space) throw new Error("The default did not change");
  return made;
}

/**
 * The space a new tab opens (A2 3.1): the machine's default when it is served; when the machine
 * has no default, its one served space. A default that is not served is never replaced by another
 * space, and several spaces without a default leave the choice to the person.
 */
export function landingSpace(list: SpaceList): string | undefined {
  if (list.default !== null) {
    const chosen = list.spaces.find((s) => s.id === list.default);
    return chosen !== undefined && isServed(chosen) ? chosen.id : undefined;
  }
  const served = list.spaces.filter(isServed);
  return served.length === 1 ? served[0]?.id : undefined;
}
