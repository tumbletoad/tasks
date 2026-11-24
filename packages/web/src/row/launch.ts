// The launch tile (A5 3.6, 3.9): which state it shows for the effective instance, and what a click
// on it does. Pure, so every state is a unit test.
import type { Busy, Instance, Receipt } from "../api.ts";

/**
 * What busies each agent app with one task on this machine, by instance key, as the service says
 * (`Busy`): an Open on its way, or a session that runs. An app it does not name is ready.
 */
export type BusyOf = Readonly<Record<string, Busy["state"]>>;

/**
 * The tile's states that follow the service: an Open on its way, a session that runs, or ready to
 * open. A session that ended, or a launch of another machine, blocks nothing.
 */
export type BusyTileState = "ready" | Busy["state"];

/** Every state the tile slot shows (A5 3.6's table). */
export type TileState =
  | BusyTileState
  /** The place does not resolve, or the instance is not set up on this machine. */
  | "unavailable"
  /** The effective instance has no launch route here: the slot copies the brief. */
  | "copy_only"
  /** The place is on another machine: nothing happens in v1. */
  | "elsewhere"
  /** The area is set to "no agents": an empty slot of the same width. */
  | "none";

/**
 * The service's list by task. A task whose apps are busy as before keeps its object, so its row
 * does not render again.
 */
export function busyByTask(
  list: readonly Busy[],
  before: ReadonlyMap<string, BusyOf>,
): ReadonlyMap<string, BusyOf> {
  const byTask = new Map<string, Record<string, Busy["state"]>>();
  for (const { task, instance, state } of list) {
    const of = byTask.get(task) ?? {};
    of[instance] = state;
    byTask.set(task, of);
  }
  const same = (a: BusyOf, b: BusyOf): boolean =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([instance, state]) => b[instance] === state);
  return new Map(
    [...byTask].map(([task, of]) => {
      const was = before.get(task);
      return [task, was !== undefined && same(was, of) ? was : of];
    }),
  );
}

/** The tile's state for its instance on this task. */
export const tileState = (busy: BusyOf | undefined, instance: string): BusyTileState =>
  busy?.[instance] ?? "ready";

export type TileAction = "open" | "expand" | "copy" | "none";

/**
 * What a click on the tile does (A5 3.6): Ready opens. Running expands the task, where its thread
 * shows the session and the strip opens another: a second session is a choice, never a slip.
 * Unavailable expands to where "Choose folder" or Copy is; Copy only copies the brief; Opening,
 * Elsewhere and None do nothing.
 */
export function tileClick(state: TileState): TileAction {
  switch (state) {
    case "ready":
      return "open";
    case "running":
    case "unavailable":
      return "expand";
    case "copy_only":
      return "copy";
    case "opening":
    case "elsewhere":
    case "none":
      return "none";
  }
}

/**
 * Why the tile cannot open here, when the place or the area says so. The page learns these from
 * place resolution and the area's agent setting; until those reach it, a row has none.
 */
export type LaunchBlock =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "elsewhere"; readonly machine: string }
  | { readonly kind: "none" };

/** The tile as the row shows it. */
export interface LaunchModel {
  readonly state: TileState;
  /** The effective instance; none for Copy only and None. */
  readonly instance?: Instance;
  /** Why it is unavailable, or where it opens. */
  readonly reason?: string;
  readonly machine?: string;
}

/** Why an Open was refused on its folder: nothing was started, and the person can say where. */
export interface FolderRefusal {
  readonly reason: string;
  /** The folder as the space stores it, the home as `~`; absent for the space's work folder. */
  readonly folder?: string;
  /** A marker's refusal: whose folder the launch used, the task's own or its project's. */
  readonly of?: "task" | "project";
  /** A marker's refusal: whose the folder's marker says it is instead, in the service's words. */
  readonly owners?: readonly string[];
  /** A marker's refusal: opens the task in this folder anyway, which marks it. */
  readonly anyway?: () => void;
  /** The person asked to choose another folder: the expanded task's chooser opens. */
  readonly choose?: true;
}

/**
 * The service's refusal of an Open whose agent app is registered for another space, with that
 * space's name when the service serves it; undefined for any other answer.
 */
export function homeRefusal(error: unknown): { readonly works?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const data = (error as Error & { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { field, reason, space } = data as Record<string, unknown>;
  if (field !== "instance" || reason !== "other_space") return undefined;
  return typeof space === "string" ? { works: space } : {};
}

/**
 * The service's refusal of an Open whose instance cannot open here: it is set up for other spaces,
 * or no terminal can open it, or none with the account set for it. Undefined for any other answer.
 */
export function instanceRefusal(
  error: unknown,
): "not_for_space" | "no_terminal" | "own_home" | undefined {
  if (!(error instanceof Error)) return undefined;
  const data = (error as Error & { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { field, reason } = data as Record<string, unknown>;
  if (field !== "instance") return undefined;
  return reason === "not_for_space" || reason === "no_terminal" || reason === "own_home"
    ? reason
    : undefined;
}

/** Why T3 Code cannot open the task now, from the service's refusal; undefined for another. */
export function t3Refusal(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const data = (error as Error & { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { field, reason, t3 } = data as Record<string, unknown>;
  if (field !== "instance" || reason !== "t3") return undefined;
  return typeof t3 === "string" ? t3 : "no_answer";
}

/** The reasons a folder's marker gives: the person may open the task there anyway. */
export const MARKER_REASONS: ReadonlySet<string> = new Set(["marker_missing", "marker_other"]);

/** The service's refusal of a launch on its folder (`data.field` "task"), read by its shape. */
export function folderRefusal(error: unknown): FolderRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  const data = (error as Error & { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { field, reason, folder, of, owners } = data as Record<string, unknown>;
  if (field === "instance" && reason === "other_machine") return { reason };
  if (field !== "task" || typeof reason !== "string") return undefined;
  return {
    reason,
    ...(typeof folder === "string" ? { folder } : {}),
    ...(of === "task" || of === "project" ? { of } : {}),
    ...(Array.isArray(owners)
      ? { owners: owners.filter((o): o is string => typeof o === "string") }
      : {}),
  };
}

/**
 * The words of a marker's refusal, as message values: which owner's folder it is, and why it may
 * be another folder (`missing`, `other` with the owners named, or `unread`).
 */
export function markerWords(refused: FolderRefusal): {
  of: string;
  why: string;
  owners: string;
  folder: string;
} {
  const owners = refused.owners ?? [];
  return {
    of: refused.of ?? "task",
    why: refused.reason === "marker_missing" ? "missing" : owners.length > 0 ? "other" : "unread",
    owners: owners.join(", "),
    folder: refused.folder ?? "",
  };
}

/** The instances Open opens here, in the space's order: one without a route only runs. */
export const openers = (instances: readonly Instance[]): Instance[] =>
  instances.filter((i) => i.route !== undefined);

/**
 * The instance Open or Run uses without a choice: the first of `used` the list holds (the one the
 * task last used, then the one the space last used here), else the list's first.
 */
export const chosen = (
  list: readonly Instance[],
  ...used: readonly (string | undefined)[]
): Instance | undefined => used.flatMap((key) => list.filter((i) => i.key === key))[0] ?? list[0];

/** The instance a task was last opened in, from its receipts (oldest first); Copy is none. */
export const lastOpened = (receipts: readonly Receipt[]): string | undefined =>
  receipts.findLast((r) => r.route !== "clipboard")?.instance;

/** The list in groups of one app each, in the order each app first comes, each in list order. */
export function byApp(list: readonly Instance[]): { app: string; instances: Instance[] }[] {
  const groups = new Map<string, Instance[]>();
  for (const instance of list)
    groups.set(instance.app, [...(groups.get(instance.app) ?? []), instance]);
  return [...groups].map(([app, instances]) => ({ app, instances }));
}

/**
 * The tile of a task: the instance Open uses (`chosen` from `used`), its state from what busies it
 * here, unless the place or the area blocks it.
 */
export function launchOf(
  instances: readonly Instance[],
  busy: BusyOf | undefined,
  block?: LaunchBlock,
  used: readonly (string | undefined)[] = [],
): LaunchModel {
  if (block?.kind === "none") return { state: "none" };
  const instance = chosen(openers(instances), ...used);
  if (instance === undefined) return { state: "copy_only" };
  if (block?.kind === "unavailable")
    return { state: "unavailable", instance, reason: block.reason };
  if (block?.kind === "elsewhere") return { state: "elsewhere", instance, machine: block.machine };
  return { state: tileState(busy, instance.key), instance };
}
