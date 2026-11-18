// The launch tile (A5 3.6, 3.9): which state it shows for the effective instance, and what a click
// on it does. Pure, so every state is a unit test.
import type { Instance, Receipt, ReceiptState } from "../api.ts";

/**
 * The tile's states that follow the receipts: an Open on its way, a session the service follows as
 * running, or ready to open. A session that ended, or one the service cannot follow, blocks
 * nothing.
 */
export type ReceiptTileState = "ready" | "opening" | "running";

/** Every state the tile slot shows (A5 3.6's table). */
export type TileState =
  | ReceiptTileState
  /** The place does not resolve, or the instance is not set up on this machine. */
  | "unavailable"
  /** The effective instance has no launch route here: the slot copies the brief. */
  | "copy_only"
  /** The place is on another machine: nothing happens in v1. */
  | "elsewhere"
  /** The area is set to "no agents": an empty slot of the same width. */
  | "none";

const OPENING: readonly ReceiptState[] = ["prepared", "dispatching"];

/**
 * Whether a launch is still on its way. A terminal launch is until its shim settles it. A link
 * launch has gone once its app was asked: nothing follows it after that.
 */
const opening = (receipt: Receipt): boolean =>
  OPENING.includes(receipt.state) || (receipt.state === "dispatched" && receipt.route !== "link");

/**
 * The tile's state for its instance on this task: Opening while its latest launch is on its way,
 * Running while any of its sessions runs, else Ready.
 */
export function tileState(receipts: readonly Receipt[], instance: string): ReceiptTileState {
  const mine = receipts.filter((r) => r.instance === instance);
  const latest = mine.at(-1);
  if (latest !== undefined && opening(latest)) return "opening";
  return mine.some(isRunning) ? "running" : "ready";
}

/** Whether the service follows this launch's session as running now. */
export const isRunning = (receipt: Receipt): boolean =>
  receipt.state === "confirmed" && receipt.session === "running";

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

/**
 * The tile of a task: the effective instance (A4: the area's default, then the space's; the page
 * gets the pinned instances in order and takes the first), its state from the task's receipts,
 * unless the place or the area blocks it.
 */
export function launchOf(
  instances: readonly Instance[],
  receipts: readonly Receipt[],
  block?: LaunchBlock,
): LaunchModel {
  if (block?.kind === "none") return { state: "none" };
  const instance = instances[0];
  if (instance === undefined) return { state: "copy_only" };
  if (block?.kind === "unavailable")
    return { state: "unavailable", instance, reason: block.reason };
  if (block?.kind === "elsewhere") return { state: "elsewhere", instance, machine: block.machine };
  return { state: tileState(receipts, instance.key), instance };
}
