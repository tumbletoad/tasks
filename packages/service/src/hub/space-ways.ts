// What a person reads for a space that is not open for writing: what happened, in a few words,
// and the command that gets them out. A state whose open wrote its own message (a synced or
// network folder, a failed check or migration) keeps that one. `<folder>` stands for the space's
// folder, which `tasks space list` shows beside it: the message names no path, so it can go
// where paths do not.
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import type { SpaceReason } from "./log.ts";

const AGAIN = `${CLI_NAME} space open <folder>`;
const LATEST = `${CLI_NAME} space restore latest <folder> --to <new folder>`;

const WAYS: Partial<Record<SpaceReason, string>> = {
  needs_recovery:
    "A crash left an unfinished change beside this space's database, so it was not opened. " +
    `Recover it with: ${CLI_NAME} space recover <folder>. The folder as it was is kept beside it.`,
  missing:
    "There is no space in this folder now. If its drive is not connected, connect it, then " +
    `run: ${AGAIN}. If you moved it, open it where it is: ${CLI_NAME} space open <new folder>.`,
  locked_elsewhere:
    `Another program has this space open, such as a second ${PRODUCT_NAME} service. ` +
    `Close it there, then run: ${AGAIN}.`,
  format_too_new: `A newer version of ${PRODUCT_NAME} wrote this space. Update ${PRODUCT_NAME} to open it.`,
  linked_database:
    "The space's database file has a second name (a link), so it is not opened. " +
    `Restore its newest backup into a new folder: ${LATEST}.`,
  open_failed:
    `The space could not be opened. Try again with: ${AGAIN}. If it stays closed, restart ` +
    `the service: ${CLI_NAME} service restart. ` +
    `If it fails again, restore its newest backup into a new folder: ${LATEST}.`,
  other_space:
    "This folder holds another space than the one this machine opened there, so it is not " +
    "opened. Put the original folder back, or change the space's entry in machine.toml.",
  not_authority: "Another machine owns this space, so it is read-only here. Change it there.",
  read_only_copy:
    "This is a restored copy, read-only until you make it this machine's. Close its original " +
    `first if it is open here, then run: ${CLI_NAME} space claim <folder>.`,
};

/** The way out of `state` for `reason`, or undefined for a space that is open or opening. */
export function wayOutOf(state: string, reason: SpaceReason | undefined): string | undefined {
  if ((state !== "unavailable" && state !== "read_only") || reason === undefined) return undefined;
  return WAYS[reason];
}
