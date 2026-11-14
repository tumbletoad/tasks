// The launch tile (A5 3.6, 3.9): which state it shows for the effective instance, and what a click
// on it does. Pure, so every state is a unit test.
import type { Instance, Receipt, ReceiptState } from "../api.ts";

/** The tile's states that follow a receipt (A5 3.6). */
export type ReceiptTileState = "ready" | "opening" | "not_confirmed" | "connected";

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

/** The tile's state for its instance's latest receipt on this task. */
export function tileState(receipts: readonly Receipt[], instance: string): ReceiptTileState {
  const latest = receipts.filter((r) => r.instance === instance).at(-1);
  if (latest === undefined) return "ready";
  if (OPENING.includes(latest.state)) return "opening";
  // A terminal launch stays Opening in Dispatched until its shim settles it; a link launch stays
  // there until it is confirmed (A5 3.6, 3.9).
  if (latest.state === "dispatched") return latest.route === "link" ? "not_confirmed" : "opening";
  if (latest.state === "confirmed") return "connected";
  return "ready";
}

export type TileAction = "open" | "expand" | "copy" | "none";

/**
 * What a click on the tile does (A5 3.6): only Ready opens. A launch on its way or done expands the
 * task to its thread, so the tile never starts a duplicate session. Unavailable expands to where
 * "Choose folder" or Copy is; Copy only copies the brief; Elsewhere and None do nothing in v1.
 */
export function tileClick(state: TileState): TileAction {
  switch (state) {
    case "ready":
      return "open";
    case "not_confirmed":
    case "connected":
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
