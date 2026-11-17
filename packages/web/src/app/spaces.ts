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
  /** Why it is read-only or unavailable: a fixed word, such as `needs_recovery`. */
  readonly reason?: string;
  /** Why its backups are not working, while it is open: a fixed word, such as `disk_full`. */
  readonly backup?: string;
}

/** A space that never opened: it has no ID or name yet. */
export interface UnopenedSpace {
  readonly state: string;
  readonly reason?: string;
}

export interface SpaceList {
  readonly spaces: readonly SpaceItem[];
  readonly unopened: readonly UnopenedSpace[];
  /** The machine's default space, or null when it has none. */
  readonly default: string | null;
}

const REASON = /^[a-z_]{1,40}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a space can be shown now: open, or read-only. */
export const isServed = (space: SpaceItem | UnopenedSpace): boolean =>
  space.state === "open" || space.state === "read_only";

/** A space the person cannot open now, and the word that picks what to tell them. */
export interface NotOpen {
  readonly name?: string;
  /** A reason such as `needs_recovery`, `opening`, or `other`. */
  readonly why: string;
}

/** The spaces of `list` that are not open now, named ones first. */
export function notOpen(list: SpaceList): NotOpen[] {
  const why = (s: SpaceItem | UnopenedSpace) =>
    s.reason ?? (s.state === "opening" ? "opening" : "other");
  return [
    ...list.spaces
      .filter((s) => !isServed(s))
      .map((s) => ({ ...(s.name === "" ? {} : { name: s.name }), why: why(s) })),
    ...list.unopened.filter((s) => !isServed(s)).map((s) => ({ why: why(s) })),
  ];
}

/** An open space whose backups are not working, and the word that picks what to tell them. */
export interface BackupTrouble {
  readonly id: string;
  readonly name: string;
  readonly why: string;
}

/** The open spaces of `list` whose backups are not working. */
export const backupTrouble = (list: SpaceList): BackupTrouble[] =>
  list.spaces.flatMap((s) =>
    s.state === "open" && s.backup !== undefined ? [{ id: s.id, name: s.name, why: s.backup }] : [],
  );

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
  const reasonOf = (s: Record<string, unknown>) => {
    const reason = s["reason"];
    return typeof reason === "string" && REASON.test(reason) ? { reason } : {};
  };
  const backupOf = (s: Record<string, unknown>) => {
    const backup = s["backup"];
    return typeof backup === "string" && REASON.test(backup) ? { backup } : {};
  };
  const spaces = value["spaces"].flatMap((s): SpaceItem[] =>
    isRecord(s) &&
    typeof s["id"] === "string" &&
    SPACE_ID.test(s["id"]) &&
    typeof s["name"] === "string" &&
    typeof s["state"] === "string"
      ? [{ id: s["id"], name: s["name"], state: s["state"], ...reasonOf(s), ...backupOf(s) }]
      : [],
  );
  const unopened = (Array.isArray(value["unopened"]) ? value["unopened"] : []).flatMap(
    (s): UnopenedSpace[] =>
      isRecord(s) && typeof s["state"] === "string" ? [{ state: s["state"], ...reasonOf(s) }] : [],
  );
  const chosen = value["default"];
  return {
    spaces,
    unopened,
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
